// [file] GS_Analytics.js
/**
 * @fileoverview ANALYTICS ENGINE
 * MODULE: Analytics
 * STATUS: UPDATED V16 (Custom Range Selection + Logging)
 */

function getExecutiveMetricsRange(fromYear, fromMonth, toYear, toMonth, forceRefresh = false) {
  console.log(`Analytics Request: From ${fromMonth}/${fromYear} To ${toMonth}/${toYear}, Force=${forceRefresh}`);

  try {
    assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  } catch (e) {
    return JSON.stringify({ error: "⛔ ACCESS DENIED: " + e.message });
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = `ANALYTICS_RANGE_V1_${fromYear}${fromMonth}_${toYear}${toMonth}`;

  if (forceRefresh === false || forceRefresh === "false") {
    // 1. Check Memory Cache (Fastest)
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      console.log("Returning Memory Cached Analytics Data");
      return cachedData;
    }
  }

  // 2. Check Sheet Cache (Persistent - for past months)
  // Only applicable if asking for a CLOSED month range (e.g. not current month)
  const currentYM = new Date().getFullYear() * 100 + new Date().getMonth();
  const requestEndYM = parseInt(toYear) * 100 + parseInt(toMonth);

  // If request is strictly in the past, try loading from Sheet
  if (requestEndYM < currentYM && (forceRefresh === false || forceRefresh === "false")) {
    const sheetCache = getAnalyticsSheetCache(fromYear, fromMonth, toYear, toMonth);
    if (sheetCache) {
      console.log("Returning Sheet Cached Analytics Data");
      // Store in memory for valid duration
      cache.put(cacheKey, sheetCache, 21600); // 6 hours
      return sheetCache;
    }
  }

  console.log("Computing Fresh Analytics Data...");

  try {
    // --- 0. CALCULATE DYNAMIC WINDOW ---
    const startY = parseInt(fromYear);
    const startM = parseInt(fromMonth);
    const endY = parseInt(toYear);
    const endM = parseInt(toMonth);

    const monthWindow = [];
    const monthLabels = [];

    let curY = startY;
    let curM = startM;

    while (curY < endY || (curY === endY && curM <= endM)) {
      monthWindow.push({ m: curM, y: curY });
      monthLabels.push(_getShortMonth(curM) + " " + String(curY).slice(-2));

      curM++;
      if (curM > 11) { curM = 0; curY++; }

      // Safety break to prevent infinite loops (max 36 months)
      if (monthWindow.length > 36) break;
    }

    const ss = getSpreadsheet();
    const windowSize = monthWindow.length;

    // --- DATA STRUCTURE ---
    const result = {
      labels: monthLabels,
      finance: {
        totalSpend: 0,
        unpaidPo: 0,
        inventoryAsset: 0,
        monthlySpend: new Array(windowSize).fill(0),
        deptSpend: {}
      },
      operation: {
        poCount: 0,
        restockCost: 0,
        criticalItems: [],
        inHouseConsumption: new Array(windowSize).fill(0),
        inHouseTopItems: []
      },
      inventory: {
        valuationTrend: new Array(windowSize).fill(0),
        consumptionTrend: new Array(windowSize).fill(0),
        highMovers: [],
        deadStock: []
      },
      supplier: {
        topSuppliers: {},
        performanceRanking: [],
        radarData: { acc: 0, spd: 0, qual: 0 }
      },
      business: {
        grossRevenueTrend: new Array(windowSize).fill(0),
        productTypeSplit: {},
        topTurnoverItems: [],
        seasonalTrends: { labels: monthLabels, datasets: [] }
      }
    };

    const getWindowIdx = (m, y) => monthWindow.findIndex(w => w.m === m && w.y === y);

    // --- 1. BUILD ITEM MAP ---

    const itemMap = new Map();

    const invSheet = ss.getSheetByName(DB_CONFIG.SHEET_ITEMS);

    if (invSheet) {

      const data = invSheet.getDataRange().getValues();

      const h = getHeaderMap(data[0]);



      console.log(`Inventory Headers found: ${JSON.stringify(h)}`);



      // Match schema exactly (lower case from getHeaderMap)

      const colId = h['stock id'];

      const colCost = h['cost'];

      const colSelling = h['selling'];

      const colCurrent = h['current'];

      const colRop = h['rop'];

      const colName = h['item name'];

      const colType = h['product type'];
      const colCategory = h['category'];

      const colBehaviour = h['item behaviour'];



      if (colId > -1) {

        for (let i = 1; i < data.length; i++) {

          const row = data[i];

          const id = String(row[colId]).toUpperCase().trim();

          if (!id) continue;



          const current = parseFloat(row[colCurrent]) || 0;

          const cost = parseFloat(row[colCost]) || 0;

          const selling = parseFloat(row[colSelling]) || 0;

          const rop = parseFloat(row[colRop]) || 0;

          const name = row[colName] || 'Unknown';

          const type = row[colType] || 'Uncategorized';
          const category = (colCategory !== undefined && colCategory > -1) ? (row[colCategory] || 'Uncategorized') : 'Uncategorized';

          const behaviour = row[colBehaviour] || 'Standard / Pack';



          itemMap.set(id, { cost, selling, name, current, type, category, behaviour });

          result.finance.inventoryAsset += (current * cost);



          if (rop > 0 && current < rop) {

            const gap = rop - current;

            const estCost = gap * cost;

            result.operation.restockCost += estCost;

            result.operation.criticalItems.push({ name: name, gap: gap, cost: estCost });

          }

        }

        result.operation.criticalItems.sort((a, b) => b.cost - a.cost).splice(10);

        console.log(`Mapped ${itemMap.size} items for analytics.`);

      }

    }



    // --- 2. PROCESS POs ---

    const poSheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);

    if (poSheet) {

      const data = poSheet.getDataRange().getValues();

      const h = getHeaderMap(data[0]);



      const colPoId = h['po id'];

      const colDate = h['date'];

      const colTotal = h['total'];

      const colStatus = h['status'];

      const colDept = h['dept'];

      const colSup = h['supplier'];



      if (colPoId > -1) {

        let poCount = 0;

        for (let i = 1; i < data.length; i++) {

          const row = data[i];

          const poId = String(row[colPoId] || "").trim();

          if (!poId) continue;



          let dateVal = parsePoDateFromId(poId);

          if (!dateVal) {

            let rawDate = row[colDate];

            if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {

              dateVal = rawDate;

            } else if (typeof rawDate === 'string' && rawDate.trim() !== "") {

              dateVal = new Date(rawDate);

            }

          }



          if (!dateVal || isNaN(dateVal.getTime())) continue;



          const wIdx = getWindowIdx(dateVal.getMonth(), dateVal.getFullYear());

          if (wIdx === -1) continue;



          const total = parseFloat(row[colTotal]) || 0;

          const status = String(row[colStatus] || "");

          const dept = String(row[colDept] || 'General');

          const sup = String(row[colSup] || 'Unknown');



          if (!status.includes('VOID') && !status.includes('REJECT')) {

            result.finance.totalSpend += total;

            result.finance.monthlySpend[wIdx] += total;

            if (!result.finance.deptSpend[dept]) result.finance.deptSpend[dept] = 0;

            result.finance.deptSpend[dept] += total;

            result.operation.poCount++;

            if (!result.supplier.topSuppliers[sup]) result.supplier.topSuppliers[sup] = 0;

            result.supplier.topSuppliers[sup] += total;



            if (status === 'Pending Payment' || status === 'Approved') {

              result.finance.unpaidPo += total;

            }

            poCount++;

          }

        }

        console.log(`Processed ${poCount} Purchase Orders for trends.`);
      }
    }

    // --- 2.1 INJECT HISTORICAL DATA (2025) ---
    // User requested hardcoded legacy values for Jan-Nov 2025
    // Note: These only appear in the Monthly Trend Chart, NOT the KPI totals.
    const legacy2025 = {
      0: 32289.11, 1: 78097.61, 2: 70487.43, 3: 43317.38,
      4: 74125.33, 5: 94482.73, 6: 75682.60, 7: 54335.47,
      8: 72744.05, 9: 82888.69, 10: 92302.24
    };
    for (let m in legacy2025) {
      const idx = getWindowIdx(parseInt(m), 2025);
      if (idx !== -1) {
        result.finance.monthlySpend[idx] += legacy2025[m];
      }
    }



    // --- 3. PROCESS MOVEMENT ---

    const yearsToFetch = [...new Set(monthWindow.map(w => w.y))];

    const allItemsData = new Map();



    yearsToFetch.forEach(y => {

      const movSheetName = `Movement ${y}`;

      const movSheet = ss.getSheetByName(movSheetName);

      if (!movSheet) {

        console.warn(`Sheet missing: ${movSheetName}`);

        return;

      }



      const data = movSheet.getDataRange().getValues();

      if (data.length <= 2) return; // Header + Subheader



      console.log(`Processing ${movSheetName}, Rows: ${data.length}`);



      for (let i = 2; i < data.length; i++) {

        const row = data[i];

        const id = String(row[0] || "").toUpperCase().trim();

        if (!id) continue;



        const name = row[1] || 'Unknown';

        const meta = itemMap.get(id) || { cost: 0, selling: 0, type: 'Other', category: 'Other' };



        if (!allItemsData.has(id)) {

          allItemsData.set(id, { name, id, meta, totalOut: 0, revenue: 0, costVal: 0, monthlyData: new Array(windowSize).fill(0) });

        }

        const itemRec = allItemsData.get(id);



        for (let m = 0; m < 12; m++) {

          const wIdx = getWindowIdx(m, y);

          if (wIdx === -1) continue;



          // Jan: base=2 (IN), out=3, adjIn=4, adjOut=5, closing=6

          const base = 2 + (m * 5);

          const out = parseFloat(row[base + 1]) || 0;

          const adjOut = parseFloat(row[base + 3]) || 0;

          const closing = parseFloat(row[base + 4]) || 0;



          const totalOut = out + adjOut;



          itemRec.totalOut += totalOut;



          itemRec.monthlyData[wIdx] = totalOut;







          result.inventory.valuationTrend[wIdx] += (closing * meta.cost);



          result.inventory.consumptionTrend[wIdx] += (totalOut * meta.cost);







          if (meta.behaviour === 'In-House Use') {
            result.operation.inHouseConsumption[wIdx] += (totalOut * meta.cost);

            // Track per-item for Top 20
            if (!itemRec._inHouseMonthly) itemRec._inHouseMonthly = new Array(windowSize).fill(0);
            itemRec._inHouseMonthly[wIdx] = (itemRec._inHouseMonthly[wIdx] || 0) + (totalOut * meta.cost);
          }







          const rev = totalOut * meta.selling;

          itemRec.revenue += rev;

          result.business.grossRevenueTrend[wIdx] += rev;

        }

      }

    });

    // --- 3.1 APPLY FROZEN CONSTANTS (Jan 2025 - Mar 2026) ---
    // Surgical Fix: Prevents retrospective changes to past data when unit costs are updated in the catalogue.
    const FROZEN_DATA = {
      inHouse: {
        2025: { 0: 2600, 1: 3700, 2: 7300, 3: 6400, 4: 17300, 5: 9200, 6: 16900, 7: 7200, 8: 12700, 9: 8400, 10: 24800, 11: 8000 },
        2026: { 0: 10400, 1: 27800, 2: 32600 }
      },
      val: {
        2025: { 0: 74100, 1: 112700, 2: 166400, 3: 175700, 4: 216100, 5: 277900, 6: 312300, 7: 325100, 8: 326300, 9: 359700, 10: 320900, 11: 323200 },
        2026: { 0: 433000, 1: 403400, 2: 386400 }
      },
      cons: {
        2025: { 0: 37400, 1: 57000, 2: 52400, 3: 59500, 4: 88500, 5: 68300, 6: 82900, 7: 82000, 8: 106400, 9: 118000, 10: 154300, 11: 153800 },
        2026: { 0: 170300, 1: 177100, 2: 268200 }
      },
      rev: {
        2025: { 0: 82400, 1: 145600, 2: 112300, 3: 128300, 4: 198100, 5: 146200, 6: 172600, 7: 174000, 8: 211500, 9: 244900, 10: 340000, 11: 327900 },
        2026: { 0: 352700, 1: 365000, 2: 423500 }
      }
    };

    monthWindow.forEach((w, idx) => {
      const y = w.y, m = w.m;
      if (FROZEN_DATA.inHouse[y] && FROZEN_DATA.inHouse[y][m] !== undefined) {
        result.operation.inHouseConsumption[idx] = FROZEN_DATA.inHouse[y][m];
      }
      if (FROZEN_DATA.val[y] && FROZEN_DATA.val[y][m] !== undefined) {
        result.inventory.valuationTrend[idx] = FROZEN_DATA.val[y][m];
      }
      if (FROZEN_DATA.cons[y] && FROZEN_DATA.cons[y][m] !== undefined) {
        result.inventory.consumptionTrend[idx] = FROZEN_DATA.cons[y][m];
      }
      if (FROZEN_DATA.rev[y] && FROZEN_DATA.rev[y][m] !== undefined) {
        result.business.grossRevenueTrend[idx] = FROZEN_DATA.rev[y][m];
      }
    });

    const allItemsList = Array.from(allItemsData.values());
    allItemsList.forEach(itemRec => {
      const usageVal = itemRec.totalOut * itemRec.meta.cost;
      if (usageVal > 0) {
        if (!result.business.productTypeSplit[itemRec.meta.type]) result.business.productTypeSplit[itemRec.meta.type] = 0;
        result.business.productTypeSplit[itemRec.meta.type] += usageVal;
      }
      itemRec.costVal = usageVal;
      itemRec.isDead = (itemMap.get(itemRec.id)?.current > 0 && itemRec.totalOut === 0);
    });

    const allowedTypes = ['medicine', 'pet food', 'lab', 'test kit', 'vaccination'];
    const filterItem = (i) => {
      const t = (i.meta.type || '').toLowerCase();
      const c = (i.meta.category || '').toLowerCase();
      const isAllowed = allowedTypes.some(allowed => t.includes(allowed) || c.includes(allowed));
      const hasSurgical = t.includes('surgical') || c.includes('surgical');
      return isAllowed && !hasSurgical;
    };

    result.inventory.highMovers = [...allItemsList].filter(filterItem).sort((a, b) => b.totalOut - a.totalOut).slice(0, 10).map(i => ({ name: i.name, qty: i.totalOut, val: i.costVal }));

    const deadStockTypes = ['medicine', 'supplement', 'vaccination', 'pet food'];
    const filterDeadStock = (i) => {
      const t = (i.meta.type || '').toLowerCase();
      const c = (i.meta.category || '').toLowerCase();
      return deadStockTypes.some(dt => t.includes(dt) || c.includes(dt));
    };
    result.inventory.deadStock = allItemsList.filter(i => i.isDead && filterDeadStock(i)).slice(0, 10).map(i => ({ name: i.name }));
    result.business.topTurnoverItems = [...allItemsList].sort((a, b) => b.revenue - a.revenue).slice(0, 10).map(i => ({ name: i.name, revenue: i.revenue }));

    // Build inHouseTopItems (top 20 by total in-house RM value, with peak month)
    const inHouseList = allItemsList
      .filter(i => i._inHouseMonthly)
      .map(i => {
        const totalVal = i._inHouseMonthly.reduce((s, v) => s + v, 0);
        let peakIdx = 0;
        i._inHouseMonthly.forEach((v, idx) => { if (v > i._inHouseMonthly[peakIdx]) peakIdx = idx; });
        return { name: i.name, totalVal, peakMonth: monthLabels[peakIdx] || '-', peakVal: i._inHouseMonthly[peakIdx] || 0 };
      })
      .sort((a, b) => b.totalVal - a.totalVal)
      .slice(0, 20);
    result.operation.inHouseTopItems = inHouseList;

    const top5 = [...allItemsList].sort((a, b) => b.totalOut - a.totalOut).slice(0, 5);
    result.business.seasonalTrends.datasets = top5.map((item, idx) => ({
      label: item.name,
      data: item.monthlyData,
      borderColor: ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6'][idx],
      fill: false,
      tension: 0.4
    }));

    // --- 4. SUPPLIER SCORECARD ---
    const perfSheet = ss.getSheetByName(DB_CONFIG.SHEET_PERF || "DB_Performance");
    if (perfSheet) {
      const pData = perfSheet.getDataRange().getValues();
      const ph = getHeaderMap(pData[0]);

      console.log(`Performance Headers found: ${JSON.stringify(ph)}`);

      // Match schema (lower case)
      const colSupName = ph['supplier name'];
      const colAcc = ph['accuracy'];
      const colSpd = ph['speed'];
      const colQual = ph['quality'];

      if (colSupName > -1 && colAcc > -1) {
        const supStats = {};
        let gAcc = 0, gSpd = 0, gQual = 0, gCount = 0;

        for (let i = 1; i < pData.length; i++) {
          const row = pData[i];
          const sup = String(row[colSupName] || "Unknown").trim();
          if (!sup || sup === "Unknown") continue;

          const acc = parseFloat(row[colAcc]) || 0;
          const spd = parseFloat(row[colSpd]) || 0;
          const qual = parseFloat(row[colQual]) || 0;

          if (!supStats[sup]) supStats[sup] = { acc: 0, spd: 0, qual: 0, count: 0 };
          supStats[sup].acc += acc;
          supStats[sup].spd += spd;
          supStats[sup].qual += qual;
          supStats[sup].count++;

          gAcc += acc; gSpd += spd; gQual += qual; gCount++;
        }

        const rankList = Object.entries(supStats).map(([name, stats]) => ({
          name: name,
          avg: ((stats.acc + stats.spd + stats.qual) / (3 * stats.count)).toFixed(1),
          count: stats.count
        }));

        result.supplier.performanceRanking = rankList.sort((a, b) => b.avg - a.avg).slice(0, 10);

        if (gCount > 0) {
          result.supplier.radarData = {
            acc: (gAcc / gCount).toFixed(1),
            spd: (gSpd / gCount).toFixed(1),
            qual: (gQual / gCount).toFixed(1)
          };
        }
        console.log(`Ranked ${rankList.length} suppliers based on scorecards.`);
      }
    }

    const payload = JSON.stringify(result);
    try {
      cache.put(cacheKey, payload, 3600);
    } catch (e) {
      console.warn("Analytics Cache Error: " + e.message);
    }
    return payload;
  } catch (err) {
    console.error("CRITICAL ANALYTICS ERROR: " + err.message + "\nStack: " + err.stack);
    return JSON.stringify({ error: "Analytics Computation Failed: " + err.message });
  }
}

function _getShortMonth(idx) {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][idx];
}

function getExecutiveMetrics(year, month, forceRefresh = false) {
  // Backwards compatibility or redirect
  let fromYear = year - 1;
  let fromMonth = month + 1;
  if (fromMonth > 11) { fromMonth = 0; fromYear = year; }
  return getExecutiveMetricsRange(fromYear, fromMonth, year, month, forceRefresh);
}

// --- CACHING ENGINE ---

/**
 * Caches analytics for a specific month into DB_Analytics_Cache.
 * Designed to be run via Monthly Trigger (e.g., 1st of Feb caches Jan).
 */
function cacheMonthlyAnalytics(year, monthIdx) {
  console.log(`Starting Monthly Analytics Cache for ${monthIdx}/${year}...`);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000); // GAS max is 30s

    // 1. Calculate Single Month Data
    // We reuse the main engine but for a single month window
    const rawJson = getExecutiveMetricsRange(year, monthIdx, year, monthIdx, true);
    const data = JSON.parse(rawJson);

    if (data.error) throw new Error(data.error);

    // 2. Write to Cache Sheet
    const ss = getSpreadsheet();
    let cacheSheet = ss.getSheetByName(DB_CONFIG.SHEET_ANALYTICS_CACHE);

    // Safety: Create if missing (though initDatabaseSchema should handle this)
    if (!cacheSheet) {
      cacheSheet = ss.insertSheet(DB_CONFIG.SHEET_ANALYTICS_CACHE);
      cacheSheet.appendRow(["YearMonth", "Data_JSON", "Last Updated"]);
    }

    const ymKey = parseInt(year) * 100 + parseInt(monthIdx);
    const existingData = cacheSheet.getDataRange().getValues();
    let rowIndex = -1;

    // Check for existing row to update
    for (let i = 1; i < existingData.length; i++) {
      if (Number(existingData[i][0]) === ymKey) {
        rowIndex = i + 1;
        break;
      }
    }

    const rowData = [
      ymKey,
      JSON.stringify(data),
      new Date()
    ];

    if (rowIndex > -1) {
      cacheSheet.getRange(rowIndex, 1, 1, 3).setValues([rowData]);
      console.log(`Updated cache for ${ymKey}`);
    } else {
      cacheSheet.appendRow(rowData);
      console.log(`Created new cache entry for ${ymKey}`);
    }

    return `Successfully cached analytics for ${monthIdx}/${year}`;

  } catch (e) {
    console.error(`Cache Failed: ${e.message}`);
    logError(`cacheMonthlyAnalytics(${year}, ${monthIdx})`, e);
    return `Error: ${e.message}`;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Retrieves cached data if available for the ENTIRE requested range.
 * Current logic is simple: If request is effectively 12 months, we can try to stitch,
 * but for initial implementation, let's just support returning if the range matches a cached snapshot?
 * 
 * ACTUALLY, for simplicity in V1: 
 * If the user requests a standard range (e.g. 1 year), fetching 12 separate cache rows and merging 
 * is complex.
 * 
 * ALTERNATIVE STRATEGY used here: 
 * The `getExecutiveMetricsRange` is usually called for a 12-month rolling window.
 * The heavy part is iterating POs and Movements. 
 * 
 * If we strictly cache the "Result Object" for a specific [Start-End] window, that's easiest.
 * But window shifts every month.
 * 
 * REVISED STRATEGY:
 * We will NOT stitch months yet. We will stick to Memory Cache for custom ranges.
 * The `cacheMonthlyAnalytics` function is mostly useful if we refactor the dashboard 
 * to load "Monthly Blocks" instead of one big "Executive Summary".
 * 
 * HOWEVER, to satisfy the requirement "Create a scheduled trigger to calculate previous month's analytics and store it":
 * We will implement `cacheMonthlyAnalytics` as requested. 
 * And for `getAnalyticsSheetCache`, we'll leave it as a placeholder or implement simple checking.
 */
function getAnalyticsSheetCache(fromY, fromM, toY, toM) {
  // Placeholder: In V2, we can implement fetching cached blocks and merging.
  // For now, return null to force fresh calculation (safest) 
  // unless we build a "Merge Cached Months" logic.
  return null;
}

// --- HELPERS ---
function parsePoDateFromId(poId) {
  if (!poId) return null;
  const s = poId.trim();
  const sUp = s.toUpperCase();

  // Override 1: Any PO containing Starlight-PO-2025 → December 2025
  if (sUp.includes("STARLIGHT")) return new Date(2025, 11, 1);

  // Override 2: PO.06031025 → October 2025
  if (s.replace(/\s/g, '') === 'PO.06031025') return new Date(2025, 9, 1);

  // Rule 4: Dot/Parentheses format — PO.XXXXXXXX(MM/YYYY)
  const dotParenMatch = s.match(/PO\.\d+\((\d{1,2})\/(\d{4})\)/i);
  if (dotParenMatch) {
    const mm = parseInt(dotParenMatch[1]);
    const yyyy = parseInt(dotParenMatch[2]);
    if (mm >= 1 && mm <= 12 && yyyy >= 2020 && yyyy <= 2030) {
      return new Date(yyyy, mm - 1, 1);
    }
  }

  // Rule 2: Standard Dash — 8 digits after first dash (DDMMYYYY): digits 3-4 = month, last 4 = year
  // e.g. PO - 18122025 - 1014
  const dashEight = s.match(/-\s*(\d{8})/);
  if (dashEight) {
    const digits = dashEight[1];
    const mm = parseInt(digits.substring(2, 4));
    const yyyy = parseInt(digits.substring(4, 8));
    if (mm >= 1 && mm <= 12 && yyyy >= 2020 && yyyy <= 2030) {
      return new Date(yyyy, mm - 1, 1);
    }
  }

  // Rule 1: Standard Dash — 6 digits after first dash (MMYYYY): first 2 = month, last 4 = year
  // e.g. PO - 122025 - 201
  const dashSix = s.match(/-\s*(\d{6})/);
  if (dashSix) {
    const digits = dashSix[1];
    const mm = parseInt(digits.substring(0, 2));
    const yyyy = parseInt(digits.substring(2, 6));
    if (mm >= 1 && mm <= 12 && yyyy >= 2020 && yyyy <= 2030) {
      return new Date(yyyy, mm - 1, 1);
    }
  }

  return null;
}