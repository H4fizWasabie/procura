/* MOVEMENT TOOLS (ANOMALY FIXER)
   - Heavy & Precise Normalization Logic.
   - Scans ALL historical years (2024 -> Current).
   - Normalizes IN/OUT/ADJ/CLOSING for all months prior to conversion.
   - Clears the "Adjustment Spike" at the conversion month.
   - AUTO-CALCULATES ROP immediately after fixing.
*/

// --- ANOMALY SCANNER ---
function apiScanForAnomalies() {
  assertPermission(['EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  const currentYear = new Date().getFullYear();
  const anomalies = [];

  // We scan Current and Previous Year for active conversion triggers
  const yearsToScan = [currentYear, currentYear - 1];

  yearsToScan.forEach(year => {
    const sheet = ss.getSheetByName(`Movement ${year}`);
    if (!sheet) return;

    // Fast Read: Check if data exists
    const lastRow = Math.max(sheet.getLastRow(), 3);
    const lastCol = sheet.getLastColumn();
    if (lastRow < 3 || lastCol < 60) return;

    const data = sheet.getRange(3, 1, lastRow - 2, lastCol).getValues();

    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      const sku = String(row[0]);
      const name = String(row[1]);

      for (let m = 0; m < 12; m++) {
        const base = 2 + (m * 5);
        if (base + 4 >= row.length) break;

        const adjOut = Number(row[base + 3] || 0);
        const closing = Number(row[base + 4] || 0);

        // DETECTION LOGIC:
        // Large Adj Out (>100) followed by small Closing
        // Ratio > 10 implies shifting decimal place or unit (e.g. 1000 -> 20)
        if (adjOut > 100 && closing > 0) {
          const ratio = adjOut / closing;
          if (ratio > 10) {
            anomalies.push({
              id: sku,
              name: name,
              year: year,
              monthIdx: m,
              monthLabel: _getMonthName(m),
              adjOut: adjOut,
              closing: closing,
              ratio: ratio.toFixed(1)
            });
          }
        }
      }
    }
  });

  return anomalies;
}

// --- HEAVY NORMALIZATION ENGINE ---
function apiNormalizeItemHistory(payload) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);
    const { stockId, conversionYear, conversionMonthIdx, packSize } = payload;

    if (!packSize || packSize < 1) throw new Error("Invalid Pack Size");

    const ss = getSpreadsheet();

    // 1. DISCOVER ALL MOVEMENT SHEETS
    const allSheets = ss.getSheets();
    const movementSheets = [];
    allSheets.forEach(s => {
      if (s.getName().startsWith("Movement 20")) {
        movementSheets.push({
          name: s.getName(),
          year: parseInt(s.getName().replace("Movement ", "")),
          sheet: s
        });
      }
    });

    // 2. SORT CHRONOLOGICALLY (Oldest First) -> 2024, 2025, 2026
    movementSheets.sort((a, b) => a.year - b.year);

    let log = [];

    // 3. EXECUTE NORMALIZATION
    movementSheets.forEach(entry => {
      const { year, sheet } = entry;
      const targetYear = parseInt(conversionYear);
      const targetMonth = parseInt(conversionMonthIdx);

      // Safety: Don't touch future years relative to conversion
      if (year > targetYear) return;

      const data = sheet.getDataRange().getValues();
      let rowIndex = -1;

      // Find Item Row
      for (let i = 2; i < data.length; i++) {
        if (String(data[i][0]) === String(stockId)) {
          rowIndex = i;
          break;
        }
      }

      if (rowIndex === -1) return; // Item not in this year sheet

      const row = data[rowIndex];
      let rowModified = false;

      // Loop Months 0 (Jan) to 11 (Dec)
      for (let m = 0; m < 12; m++) {
        const base = 2 + (m * 5);
        if (base + 4 >= row.length) break;

        // LOGIC GATES
        const isPastYear = (year < targetYear);
        const isPastMonth = (year === targetYear && m < targetMonth);
        const isTriggerMonth = (year === targetYear && m === targetMonth);

        // A) PAST TIMELINE: NORMALIZE
        // If it's a previous year OR a previous month in current year -> Divide by Pack Size
        if (isPastYear || isPastMonth) {

          // Function to normalize value safely
          const norm = (val) => {
            const v = Number(val);
            if (isNaN(v) || v === 0) return val;
            return Number((v / packSize).toFixed(2));
          };

          row[base] = norm(row[base]);     // IN
          row[base + 1] = norm(row[base + 1]);   // OUT
          row[base + 2] = norm(row[base + 2]);   // ADJ IN
          row[base + 3] = norm(row[base + 3]);   // ADJ OUT
          row[base + 4] = norm(row[base + 4]);   // CLOSING

          rowModified = true;
        }

        // B) TRIGGER MONTH: PARTIAL NORMALIZATION
        // The "In" was likely in Units (1000), but "Closing" is already Packs (20).
        // We must normalize In/Out/AdjIn to Packs, CLEAR the AdjOut (phantom fix), and KEEP Closing (already packs).
        else if (isTriggerMonth) {

          // Function to normalize value safely
          const norm = (val) => {
            const v = Number(val);
            if (isNaN(v) || v === 0) return val;
            return Number((v / packSize).toFixed(2));
          };

          row[base] = norm(row[base]);      // IN (Units -> Packs)
          row[base + 1] = norm(row[base + 1]); // OUT (Units -> Packs)
          row[base + 2] = norm(row[base + 2]); // ADJ IN (Units -> Packs)
          row[base + 3] = 0; // Clear ADJ OUT (The phantom spike)
          // CLOSE: Do NOT normalize, it is already low (Packs).

          rowModified = true;
          log.push(`Normalized Flow & Cleared Spike in ${year}-${_getMonthName(m)}`);
        }
      }

      // Write Row Back
      if (rowModified) {
        sheet.getRange(rowIndex + 1, 1, 1, row.length).setValues([row]);
      }
    });

    // 4. IMMEDIATE ROP RECALCULATION
    // Now that history is clean, ROP must be updated to reflect "Packs" usage, not "Units" usage.
    let ropMsg = "";
    if (typeof autoCalculateROP === 'function') {
      ropMsg = "\n" + autoCalculateROP();
    }

    return {
      success: true,
      message: `Normalized history (2024-${conversionYear}) by factor ${packSize}.${ropMsg}`
    };

  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

function _getMonthName(idx) {
  const m = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return m[idx] || "";
}

// --- FINANCIAL HEALTH TOOLS ---

function apiScanFinancialAnomalies(year) {
  assertPermission(['EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(`Movement ${year}`);
  if (!sheet) return [];

  const lastRow = Math.max(sheet.getLastRow(), 3);
  // Ensure we have enough columns. Financials are at cols 63-68 (indices 62-67).
  const lastCol = sheet.getLastColumn();
  if (lastCol < 68) return [];

  const data = sheet.getRange(3, 1, lastRow - 2, lastCol).getValues();
  const anomalies = [];

  // Indices based on GS_Movement logic
  // 66: Turnover Rate
  // 67: Usage Value

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const id = row[0];
    const name = row[1];

    // Safety check
    if (!id || row.length < 68) continue;

    const turnover = Number(row[66] || 0);
    const usageVal = Number(row[67] || 0);

    // Logic 1: Negative Value (Impossible)
    if (usageVal < 0) {
      anomalies.push({ id, name, type: 'Negative Value', val: usageVal, limit: 0 });
    }
    // Logic 2: Excessive Turnover (e.g. > 50 times/year implies data error or extreme outlier)
    else if (turnover > 50) {
      anomalies.push({ id, name, type: 'High Turnover', val: turnover, limit: 50 });
    }
    // Logic 3: Zero Value but Active Turnover
    else if (usageVal === 0 && turnover > 0) {
      anomalies.push({ id, name, type: 'Zero Value / Active', val: 0, limit: 0 });
    }
  }

  return anomalies;
}

function apiRecalculateFinancialsOnly(year) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    // Calls the shared logic in GS_Movement.js
    if (typeof recalculateSheetCosts !== 'function') throw new Error("Recalc function missing.");
    const result = recalculateSheetCosts(year);
    return { success: true, message: result };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

function apiUpdateItemMovementHistory(stockId, year, monthlyData) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(`Movement ${year}`);
    if (!sheet) throw new Error(`Sheet Movement ${year} not found.`);

    const lastRow = Math.max(sheet.getLastRow(), 3);
    const idList = sheet.getRange(3, 1, lastRow - 2, 1).getValues().flat();
    const rowIndex = idList.indexOf(String(stockId));

    if (rowIndex === -1) throw new Error("Item not found in this year.");

    // rowIndex is 0-based relative to the range starting at row 3.
    // So actual sheet row is rowIndex + 3.
    const actualRow = rowIndex + 3;
    const rowValues = sheet.getRange(actualRow, 1, 1, sheet.getLastColumn()).getValues()[0];

    // Apply updates
    monthlyData.forEach(m => {
      const idx = m.monthIdx; // 0-11
      if (idx >= 0 && idx < 12) {
        const base = 2 + (idx * 5);
        if (base + 4 < rowValues.length) {
          // Update only if provided (allows partial updates if needed, though UI sends all)
          if (m.in !== undefined) rowValues[base] = Number(m.in);
          if (m.out !== undefined) rowValues[base + 1] = Number(m.out);
          if (m.adjIn !== undefined) rowValues[base + 2] = Number(m.adjIn);
          if (m.adjOut !== undefined) rowValues[base + 3] = Number(m.adjOut);
          if (m.closing !== undefined) rowValues[base + 4] = Number(m.closing);
        }
      }
    });

    sheet.getRange(actualRow, 1, 1, rowValues.length).setValues([rowValues]);

    // Trigger recalc for this specific row/year if possible, or just return
    // Ideally we recalculate the summary cols for this row immediately
    // Re-using logic from recalculateSheetCosts but for single row would be best, 
    // but for now we trust the user or they can hit "Recalculate".

    return { success: true, message: "History updated." };

  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// --- CLOSING BALANCE INTEGRITY ---

function apiScanMonthlyCliffAnomalies(fromYear, fromMonth, toYear, toMonth) {
  assertPermission(['EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();

  const fY = Number(fromYear), fM = Number(fromMonth);
  const tY = Number(toYear), tM = Number(toMonth);
  const fromVal = fY * 12 + fM;
  const toVal = tY * 12 + tM;

  const anomalies = [];

  // Iterate over each month in the range
  for (let v = fromVal; v <= toVal; v++) {
    const year = Math.floor(v / 12);
    const monthIdx = v % 12;

    const sheet = ss.getSheetByName(`Movement ${year}`);
    if (!sheet) continue;

    const lastRow = Math.max(sheet.getLastRow(), 3);
    const lastCol = sheet.getLastColumn();
    if (lastCol < 60) continue;

    const data = sheet.getRange(3, 1, lastRow - 2, lastCol).getValues();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const id = String(row[0]);
      const name = String(row[1]);
      if (!id) continue;

      const base = 2 + (monthIdx * 5);
      if (base + 4 >= row.length) continue;

      const valIn = Number(row[base] || 0);
      const valOut = Number(row[base + 1] || 0);
      const valAdjIn = Number(row[base + 2] || 0);
      const valAdjOut = Number(row[base + 3] || 0);
      const closing = Number(row[base + 4] || 0);

      const totalIn = valIn + valAdjIn;
      const totalOut = valOut + valAdjOut;

      const isHighVolume = totalIn > 50;
      const isLowClosing = closing >= 0 && closing <= 20;
      const highRatio = (totalIn / (closing || 1)) > 5;

      if (isHighVolume && isLowClosing && highRatio) {
        anomalies.push({
          id: id,
          name: name,
          year: year,
          monthIdx: monthIdx,
          monthLabel: _getMonthName(monthIdx),
          in: totalIn,
          out: totalOut,
          closing: closing,
          ratio: (totalIn / (closing || 1)).toFixed(1)
        });
      }
    }
  }

  return anomalies.sort((a, b) => b.ratio - a.ratio);
}

