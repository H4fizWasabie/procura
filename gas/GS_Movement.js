/* MOVEMENT ENGINE
   Handles Yearly Movement Sheets, Bulk Uploads, and ROP Analysis.
   UPDATED: INTEGRATED "ANCHOR" COLUMNS (Exclude, Velocity Override).
*/

const MOV_CONFIG = {
  START_YEAR: 2024,
  MAX_HISTORY_MONTHS: 36,
  TOTAL_COLS: 68,

  // Weighted Velocity (scans all 3 years)
  VELOCITY_LOOKBACK_MONTHS: 36,

  // Payment-Aware Lead Time (this IS the buffer)
  SUPPLIER_LEAD_DAYS: 7,
  PAYMENT_DELAY_DAYS: 18,
  SAFETY_BUFFER_DAYS: 5,

  // Dynamic Cap Thresholds (Turnover Rate from Movement sheets)
  TURNOVER_FAST_THRESHOLD: 0.50,
  TURNOVER_SLOW_THRESHOLD: 0.10,
  CAP_FAST_MONTHS: 1.5,
  CAP_MEDIUM_MONTHS: 1.5,
  CAP_SLOW_MONTHS: 2.0
};

// --- CONTEXT ---
function apiGetMovementContext() {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  return {
    items: apiGetInventoryBasicList(),
    years: _getAvailableMovementYears()
  };
}

function _getAvailableMovementYears() {
  const ss = getSpreadsheet();
  const sheets = ss.getSheets();
  const years = new Set();
  const regex = /^Movement\s+(\d{4})\s*$/i;

  sheets.forEach(s => {
    const match = s.getName().match(regex);
    if (match) years.add(match[1]);
  });

  const currentYear = new Date().getFullYear();
  for (let y = MOV_CONFIG.START_YEAR; y <= currentYear + 1; y++) {
    years.add(String(y));
  }

  return Array.from(years).sort().reverse();
}

// --- SHEET MANAGEMENT ---
function ensureMovementSheet(year) {
  const ss = getSpreadsheet();
  const sheetName = `Movement ${year}`;

  let sheet = null;
  const sheets = ss.getSheets();
  const regex = new RegExp(`^Movement\\s+${year}\\s*$`, 'i');
  for (const s of sheets) {
    if (regex.test(s.getName())) { sheet = s; break; }
  }

  if (!sheet) {
    try {
      sheet = ss.insertSheet(sheetName);
    } catch (e) {
      throw new Error(`Failed to create sheet "Movement ${year}": ${e.message}`);
    }
  }

  const currentCols = sheet.getMaxColumns();
  if (currentCols < MOV_CONFIG.TOTAL_COLS) {
    sheet.insertColumnsAfter(currentCols, MOV_CONFIG.TOTAL_COLS - currentCols);
  }

  if (sheet.getRange("A1").getValue() === "") {
    const months = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

    sheet.getRange("A1:A2").merge().setValue("Stock ID").setVerticalAlignment("middle").setFontWeight("bold");
    sheet.getRange("B1:B2").merge().setValue("Item Name").setVerticalAlignment("middle").setFontWeight("bold");

    months.forEach((month, idx) => {
      const startCol = 3 + (idx * 5);
      sheet.getRange(1, startCol, 1, 5).merge().setValue(month).setHorizontalAlignment("center").setFontWeight("bold").setBackground("#e0e0e0");
      const subCols = [["IN", "OUT", "ADJ IN", "ADJ OUT", "REPORT CLOSING"]];
      sheet.getRange(2, startCol, 1, 5).setValues(subCols).setFontWeight("bold").setBackground("#f3f4f6");
    });

    const summaryStart = 63;
    const summaryCols = ["Unit Cost", "Total IN", "Total OUT", "Total ADJ", "Turnover Rate", "Usage Value (RM)"];
    sheet.getRange(1, summaryStart, 1, summaryCols.length).merge().setValue("YEARLY SUMMARY").setHorizontalAlignment("center").setFontWeight("bold").setBackground("#ffe0b2");
    sheet.getRange(2, summaryStart, 1, summaryCols.length).setValues([summaryCols]).setFontWeight("bold").setBackground("#fff3e0");

    sheet.setFrozenRows(2);
    sheet.setFrozenColumns(2);
  }

  return sheet;
}

// --- PRE-SAVE CHECK ---
function apiCheckMovementDataExists(year, monthIdx, uploadType) {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  const sheetName = `Movement ${year}`;
  const sheet = ss.getSheetByName(sheetName);

  if (!sheet || sheet.getLastRow() < 3) {
    return { exists: false, count: 0 };
  }

  const mIdx = parseInt(monthIdx);
  const baseColIdx = 2 + (mIdx * 5);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthName = months[mIdx] || '';

  let checkSheetCol, numCols;
  if (uploadType === 'FLOW') {
    checkSheetCol = baseColIdx + 1; // Sheet col for IN (1-indexed: 3 for Jan)
    numCols = 4;                    // IN, OUT, ADJ IN, ADJ OUT
  } else {
    checkSheetCol = baseColIdx + 5; // Sheet col for REPORT CLOSING (1-indexed: 7 for Jan)
    numCols = 1;
  }

  // Read only the relevant columns for that month
  const lastRow = sheet.getLastRow();
  const numRows = lastRow - 2; // Skip header rows
  const values = sheet.getRange(3, checkSheetCol, numRows, numCols).getValues();

  let count = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < values[i].length; j++) {
      if (values[i][j] !== '' && values[i][j] !== null && values[i][j] !== 0) {
        count++;
        break; // Count each row only once
      }
    }
  }

  return { exists: count > 0, count: count, monthName: monthName, year: year };
}

// --- BULK SAVE ---
function apiSaveBulkMovement(payload) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);
    const { year, monthIdx, items, uploadType } = payload;
    const sheet = ensureMovementSheet(year);

    const lastRow = Math.max(sheet.getLastRow(), 2);
    const fullRange = sheet.getRange(1, 1, lastRow, MOV_CONFIG.TOTAL_COLS);
    let values = fullRange.getValues();

    const idMap = new Map();
    for (let i = 2; i < values.length; i++) {
      const key = String(values[i][0]).trim().toUpperCase();
      if (key) idMap.set(key, i);
    }

    const baseColIdx = 2 + (parseInt(monthIdx) * 5);
    let rowsAdded = 0;

    items.forEach(item => {
      const skuRaw = String(item.id);
      const skuKey = skuRaw.trim().toUpperCase();
      let rowIndex = idMap.get(skuKey);

      if (rowIndex === undefined) {
        rowIndex = values.length;
        const newRow = new Array(MOV_CONFIG.TOTAL_COLS).fill("");
        newRow[0] = skuRaw;
        newRow[1] = item.name;
        values.push(newRow);
        idMap.set(skuKey, rowIndex);
        rowsAdded++;
      }

      while (values[rowIndex].length < MOV_CONFIG.TOTAL_COLS) values[rowIndex].push("");

      // Sanitize item name on new rows
      if (rowIndex === values.length - 1 && rowsAdded > 0) {
        values[rowIndex][1] = sanitizeText(item.name);
      }

      if (uploadType === 'FLOW') {
        values[rowIndex][baseColIdx] = item.in;
        values[rowIndex][baseColIdx + 1] = item.out;
        values[rowIndex][baseColIdx + 2] = item.adjIn;
        values[rowIndex][baseColIdx + 3] = item.adjOut;
      } else {
        values[rowIndex][baseColIdx + 4] = item.closing;
      }
    });

    if (values.length > 0) {
      sheet.getRange(1, 1, values.length, MOV_CONFIG.TOTAL_COLS).setValues(values);
    }

    return { success: true, message: `Updated ${items.length} items. (${rowsAdded} new)` };

  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// --- ANALYSIS TOOLS ---
function apiGetHistoricalMovementForItem(stockId) {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  const timeline = [];
  const currentYear = new Date().getFullYear();
  const targetId = String(stockId).trim().toUpperCase();

  // Fetch ALL years from START_YEAR to Current Year + 1
  for (let y = MOV_CONFIG.START_YEAR; y <= currentYear + 1; y++) {
    const sheetName = `Movement ${y}`;
    const sheet = ss.getSheetByName(sheetName);
    if (sheet && sheet.getLastRow() > 2) {
      const data = sheet.getRange(3, 1, sheet.getLastRow() - 2, MOV_CONFIG.TOTAL_COLS).getValues();
      const row = data.find(r => String(r[0]).trim().toUpperCase() === targetId);

      if (row) {
        for (let m = 0; m < 12; m++) {
          const base = 2 + (m * 5);
          if (base + 4 < row.length) {
            const hasData = (row[base] !== "" || row[base + 1] !== "" || row[base + 2] !== "" || row[base + 3] !== "" || row[base + 4] !== "");
            if (hasData) {
              timeline.push({
                year: y,
                month: m + 1,
                label: `${y}-${String(m + 1).padStart(2, '0')}`,
                in: Number(row[base] || 0),
                out: Number(row[base + 1] || 0),
                adjIn: Number(row[base + 2] || 0),
                adjOut: Number(row[base + 3] || 0),
                closing: Number(row[base + 4] || 0)
              });
            }
          }
        }
      }
    }
  }

  timeline.sort((a, b) => a.label.localeCompare(b.label));

  // Fetch cost & selling price from DB_Items
  let itemCost = 0, itemSelling = 0;
  const invSheet = ss.getSheetByName(DB_CONFIG.SHEET_ITEMS);
  if (invSheet) {
    const invData = invSheet.getDataRange().getValues();
    const h = invData[0];
    const idIdx = h.findIndex(c => c.toString().trim().toUpperCase() === 'STOCK ID');
    const costIdx = h.findIndex(c => c.toString().trim().toUpperCase() === 'COST');
    const sellIdx = h.findIndex(c => c.toString().trim().toUpperCase() === 'SELLING');
    if (idIdx > -1) {
      const row = invData.slice(1).find(r => String(r[idIdx]).trim().toUpperCase() === targetId);
      if (row) {
        itemCost = Number(row[costIdx] || 0);
        itemSelling = Number(row[sellIdx] || 0);
      }
    }
  }

  return { stockId: stockId, timeline: timeline, itemCost: itemCost, itemSelling: itemSelling };
}

// --- MAINTENANCE & ROP ---
function apiTriggerMaintenance(year) {
  assertPermission(['ADMIN']);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const log = [];
    log.push(recalculateSheetCosts(year));
    log.push(autoCalculateROP());
    return { success: true, report: log.join("\n\n") };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

function recalculateSheetCosts(year) {
  const sheet = ensureMovementSheet(year);
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const range = sheet.getRange(1, 1, lastRow, MOV_CONFIG.TOTAL_COLS);
  const data = range.getValues();

  const ss = getSpreadsheet();
  const invSheet = ss.getSheetByName(DB_CONFIG.SHEET_ITEMS);
  const invData = invSheet.getDataRange().getValues();
  const costMap = new Map();
  const invHeaders = invData[0];
  const costIdx = invHeaders.findIndex(h => h.trim() === "Cost");

  if (costIdx > -1) {
    invData.slice(1).forEach(r => {
      const key = String(r[0]).trim().toUpperCase();
      costMap.set(key, Number(r[costIdx] || 0));
    });
  }

  let updatedCount = 0;

  for (let i = 2; i < data.length; i++) {
    const row = data[i];
    const id = String(row[0]).trim().toUpperCase();
    if (!id) continue;

    const cost = costMap.get(id) || 0;

    let totalIn = 0, totalOut = 0, totalAdj = 0, totalAdjOut = 0;
    let sumClosing = 0;
    let monthsWithData = 0;

    for (let m = 0; m < 12; m++) {
      const base = 2 + (m * 5);
      // Safety check for row length
      if (base + 4 >= row.length) break;

      const valIn = Number(row[base] || 0);
      const valOut = Number(row[base + 1] || 0);
      const valAdjIn = Number(row[base + 2] || 0);
      const valAdjOut = Number(row[base + 3] || 0);
      const valClosing = Number(row[base + 4] || 0);

      totalIn += valIn;
      totalOut += valOut;
      totalAdj += (valAdjIn - valAdjOut);
      totalAdjOut += valAdjOut;

      if (valClosing > 0 || valIn > 0 || valOut > 0) {
        sumClosing += valClosing;
        monthsWithData++;
      }
    }

    const avgStock = monthsWithData > 0 ? (sumClosing / monthsWithData) : 0;
    const turnoverRate = avgStock > 0 ? ((totalOut + totalAdjOut) / avgStock) : 0;
    const usageValue = (totalOut + totalAdjOut) * cost;

    row[62] = cost;
    row[63] = totalIn;
    row[64] = totalOut;
    row[65] = totalAdj;
    row[66] = Number(turnoverRate.toFixed(2));
    row[67] = Number(usageValue.toFixed(2));
    updatedCount++;
  }

  range.setValues(data);
  logSystemAction('MOVEMENT', 'RECALC', `Year ${year}`, `Updated financials for ${updatedCount} items.`);
  return `Financials updated for ${year}.`;
}

// --- ROP ENGINE v2 (Weighted Velocity + Payment-Aware Lead Time) ---
function autoCalculateROP() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const ss = getSpreadsheet();
    const dbSheet = ss.getSheetByName(DB_CONFIG.SHEET_ITEMS);
    if (!dbSheet) return "DB_Items missing.";

    const dbData = dbSheet.getDataRange().getValues();
    const dbHeaders = dbData[0];

    const ropIdx = dbHeaders.findIndex(h => h.trim().toUpperCase() === "ROP");
    const idIdx = dbHeaders.findIndex(h => h.trim().toUpperCase() === "STOCK ID");
    const excludeIdx = dbHeaders.findIndex(h => h.trim().toUpperCase() === "EXCLUDE");
    const velIdx = dbHeaders.findIndex(h => h.trim().toUpperCase() === "VELOCITY OVERRIDE");
    const idxBeh = dbHeaders.findIndex(h => h.trim().toUpperCase() === "ITEM BEHAVIOUR");

    if (ropIdx === -1 || idIdx === -1) return "Error: ROP or Stock ID column missing.";

    // 1. DISCOVER MOVEMENT SHEETS
    const allSheets = ss.getSheets();
    const sheetMap = new Map();
    const regex = /^Movement\s+(\d{4})\s*$/i;
    allSheets.forEach(s => {
      const match = s.getName().match(regex);
      if (match) sheetMap.set(parseInt(match[1]), s);
    });

    // 2. WEIGHTED HISTORY SCAN (last N months)
    // Stores per-SKU array of { monthsAgo, usage }
    const usageMap = new Map();
    const cursorDate = new Date();
    cursorDate.setDate(1);
    cursorDate.setMonth(cursorDate.getMonth() - 1);
    const lookback = MOV_CONFIG.VELOCITY_LOOKBACK_MONTHS;
    const sheetsReadSet = new Set();

    for (let i = 0; i < lookback; i++) {
      const targetYear = cursorDate.getFullYear();
      const targetMonth = cursorDate.getMonth();
      if (targetYear < MOV_CONFIG.START_YEAR) break;

      const sheet = sheetMap.get(targetYear);
      if (sheet) {
        if (!sheet.tempData) {
          const lastRow = Math.max(sheet.getLastRow(), 2);
          if (lastRow >= 3) {
            sheet.tempData = sheet.getRange(3, 1, lastRow - 2, MOV_CONFIG.TOTAL_COLS).getValues();
            sheetsReadSet.add(targetYear);
          }
        }
        if (sheet.tempData) {
          const baseCol = 2 + (targetMonth * 5);
          for (let r = 0; r < sheet.tempData.length; r++) {
            const row = sheet.tempData[r];
            if (!row[0]) continue;
            const sku = String(row[0]).trim().toUpperCase();
            const inVal = Number(row[baseCol]) || 0;
            const outVal = Number(row[baseCol + 1]) || 0;
            const adjOutVal = Number(row[baseCol + 3]) || 0;
            const closingVal = Number(row[baseCol + 4]) || 0;
            const usage = outVal + adjOutVal;
            const isActive = (inVal > 0 || outVal > 0 || adjOutVal > 0 || closingVal > 0);

            if (!usageMap.has(sku)) usageMap.set(sku, { points: [], lifecycleStart: -1 });
            const record = usageMap.get(sku);
            record.points.push({ monthsAgo: i, usage });
            if (isActive && i > record.lifecycleStart) record.lifecycleStart = i;
          }
        }
      }
      cursorDate.setMonth(cursorDate.getMonth() - 1);
    }

    // 3. COMPUTE & WRITE ROP
    // ROP = 2 months (1 month safety stock + 1 month ordering stock)
    const ROP_MONTHS = 2;
    const ropColumnUpdates = [];
    let updateCount = 0, itemsCalculated = 0, itemsExcluded = 0, itemsOverridden = 0;

    for (let r = 1; r < dbData.length; r++) {
      const sku = String(dbData[r][idIdx]).trim().toUpperCase();
      let newROP = 0;

      // ANCHOR: Service / Exclude bypass
      let skip = false;
      if (idxBeh !== -1 && String(dbData[r][idxBeh]).trim() === "Service") skip = true;
      if (!skip && excludeIdx > -1) {
        const val = String(dbData[r][excludeIdx]).toUpperCase();
        if (val === "TRUE" || val === "YES" || val === "EXCLUDE") skip = true;
      }

      if (skip) {
        itemsExcluded++;
      } else {
        let velocity = 0;
        let usedOverride = false;

        // Velocity Override
        if (velIdx > -1) {
          const ov = parseFloat(dbData[r][velIdx]);
          if (!isNaN(ov) && ov > 0) {
            velocity = ov;
            usedOverride = true;
            itemsOverridden++;
          }
        }

        // Weighted velocity from history
        if (!usedOverride && usageMap.has(sku)) {
          velocity = _calcWeightedVelocity(usageMap.get(sku));
          if (velocity > 0) itemsCalculated++;
        }

        // ROP = ceil(velocity * ROP_MONTHS) — 1 month safety + 1 month ordering
        newROP = Math.ceil(velocity * ROP_MONTHS);
      }

      ropColumnUpdates.push([newROP]);
      if (Number(dbData[r][ropIdx]) != newROP) updateCount++;
    }

    if (ropColumnUpdates.length > 0) {
      dbSheet.getRange(2, ropIdx + 1, ropColumnUpdates.length, 1).setValues(ropColumnUpdates);
      return `ROP SUCCESS (v3 — 2-Month Policy):
      - Scanned Years: ${Array.from(sheetsReadSet).join(', ')}
      - ROP Policy: ${ROP_MONTHS} months (1 month safety + 1 month ordering)
      - Calculated via History: ${itemsCalculated}
      - Calculated via Override: ${itemsOverridden}
      - Excluded Items: ${itemsExcluded}
      - Total Rows Updated: ${updateCount}`;
    }

    return "ROP Calc complete. No data found.";
  } catch (e) {
    return `Error calculating ROP: ${e.message}`;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Lifecycle-Aware Weighted Velocity.
 * 50% last 3m, 30% months 4-6, 20% months 7+.
 * Only counts months within the item's actual lifecycle (first activity to present).
 */
function _calcWeightedVelocity(record) {
  const { points, lifecycleStart } = record;
  if (lifecycleStart === -1) return 0;

  // Only include months within the item's lifecycle
  const activeData = points.filter(d => d.monthsAgo <= lifecycleStart);
  if (activeData.length === 0) return 0;

  const buckets = [
    { from: 0, to: 2, weight: 0.50 },
    { from: 3, to: 5, weight: 0.30 },
    { from: 6, to: 35, weight: 0.20 }
  ];
  let totalWV = 0, totalW = 0;
  for (const b of buckets) {
    const entries = activeData.filter(d => d.monthsAgo >= b.from && d.monthsAgo <= b.to);
    if (entries.length > 0) {
      const avg = entries.reduce((s, e) => s + e.usage, 0) / entries.length;
      totalWV += avg * b.weight;
      totalW += b.weight;
    }
  }
  return totalW > 0 ? totalWV / totalW : 0;
}