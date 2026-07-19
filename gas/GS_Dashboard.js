// [file] GS_Dashboard.js
/**
 * @fileoverview DASHBOARD ENGINE (COMMAND CENTER)
 * ARCHITECTURE: Self-contained headers, robust date parsing, and error-proof column finding.
 * UPDATED: Removed "Band-Aid" Date Parser (Fix 3). Enforcing strict Data types.
 */

function apiGetDashboardStats() {
  // 1. Permission Check
  try {
    const email = Session.getActiveUser().getEmail();
    if (!email) throw new Error("No User");
  } catch (e) {
    return { success: false, error: "Auth Error" };
  }

  // PERFORMANCE: Check cache first (5-minute TTL)
  const cache = CacheService.getScriptCache();
  const cached = cache.get('DASH_STATS');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* cache corrupted, recompute */ }
  }

  const ss = getSpreadsheet();
  const result = {
    financials: { ytdSpend: 0 },
    operations: { pendingApprovals: 0, pendingPayment: 0 },
    inventory: { criticalStock: 0, totalItems: 0 },
    ropAlerts: []
  };

  try {
    const currentYear = new Date().getFullYear();

    // Guard: Ensure DB_CONFIG is loaded
    if (typeof DB_CONFIG === 'undefined') {
      return { success: false, error: "System Error: DB_CONFIG not loaded. Check _Config.js file order." };
    }

    // =========================================================================
    // A. PROCUREMENT SCAN (PO ID = Source of Truth)
    // =========================================================================
    const poSheetName = DB_CONFIG.SHEET_PO;
    const poSheet = ss.getSheetByName(poSheetName);

    if (poSheet) {
      const lastRow = poSheet.getLastRow();
      if (lastRow > 1) {
        // PERFORMANCE: Read only last 1000 POs for dashboard metrics
        const LIMIT = 1000;
        const startRow = Math.max(2, lastRow - LIMIT + 1);
        const numRows = lastRow - startRow + 1;
        const lastCol = poSheet.getLastColumn();

        const data = poSheet.getRange(startRow, 1, numRows, lastCol).getValues();
        const h = getHeaderMap(poSheet.getRange(1, 1, 1, lastCol).getValues()[0]);

        const idxID = h['po id'];
        const idxDate = h['date'];
        const idxTotal = h['total'];
        const idxStatus = h['status'];

        for (let i = 0; i < data.length; i++) {
          const row = data[i];

          // CRITICAL: Stop comparison if index is missing to prevent 'undefined' string matches
          if (idxID === undefined || idxStatus === undefined) continue;

          const poId = String(row[idxID] || "").trim();
          const status = String(row[idxStatus] || "").toUpperCase();

          if (!poId || status === 'VOID' || status === 'CANCELLED') continue;

          if (status === 'PENDING APPROVAL') {
            result.operations.pendingApprovals++;
          } else if (status === 'PENDING PAYMENT') {
            result.operations.pendingPayment++;
          }

          if (status === 'APPROVED' || status === 'PAID' || status === 'PARTIAL') {
            if (idxDate === undefined || idxTotal === undefined) continue;

            let dateVal = row[idxDate];
            if (typeof dateVal === 'string' && dateVal.includes('-')) {
              dateVal = new Date(dateVal);
            }

            if (dateVal instanceof Date && !isNaN(dateVal.getTime())) {
              if (dateVal.getFullYear() === currentYear) {
                const totalRaw = String(row[idxTotal] || "0").replace(/[^0-9.-]+/g, "");
                const total = parseFloat(totalRaw) || 0;
                result.financials.ytdSpend += total;
              }
            }
          }
        }
      }
    }

    // =========================================================================
    // B. INVENTORY SCAN (Critical Items)
    // =========================================================================
    const itemSheetName = (typeof DB_CONFIG !== 'undefined') ? DB_CONFIG.SHEET_ITEMS : "DB_Items";
    const itemSheet = ss.getSheetByName(itemSheetName);

    if (itemSheet) {
      const iData = itemSheet.getDataRange().getValues();
      if (iData.length > 1) {
        const h = getHeaderMap(iData[0]);

        const idxId = h['stock id'];
        const idxName = h['item name'];
        const idxCost = h['cost'];
        const idxCurr = h['current'];
        const idxRop = h['rop'];
        const idxExcl = h['exclude'];
        const idxBeh = h['item behaviour'];

        // Only proceed if we found the critical columns
        if (idxCurr !== undefined && idxRop !== undefined) {
          for (let i = 1; i < iData.length; i++) {
            const row = iData[i];

            // PERFORMANCE & SAFETY: Skip Malformed Rows
            if (idxId === undefined || idxName === undefined) continue;
            const idVal = String(row[idxId] || "").trim();
            const nameVal = String(row[idxName] || "").trim();
            if (!idVal && !nameVal) continue;

            result.inventory.totalItems++;

            // --- NOISE REDUCTION FILTERS (MATCHES PLANNING) ---

            // 1. Check EXCLUDE ANCHOR
            if (idxExcl !== undefined) {
              const exclVal = String(row[idxExcl]).toUpperCase();
              if (exclVal === 'TRUE' || exclVal === 'YES' || exclVal === 'EXCLUDE') continue;
            }

            // 2. Check BEHAVIOUR (Only "Standard / Pack", "In-House Use" or Empty trigger alerts)
            if (idxBeh !== undefined) {
              const behVal = String(row[idxBeh] || "").trim();
              if (behVal !== "" && behVal !== "Standard / Pack" && behVal !== "In-House Use") continue;
            }

            const curr = parseFloat(row[idxCurr]) || 0;
            const dbRop = parseFloat(row[idxRop]) || 0;
            const velOv = (h['velocity override'] !== undefined) ? Number(row[h['velocity override']]) || 0 : 0;

            const rop = velOv > 0 ? velOv : dbRop;

            // 3. Skip if ROP is not defined or 0
            if (rop <= 0) continue;

            // Calculate Safety Stock
            const effectiveLeadMonths = (MOV_CONFIG.SUPPLIER_LEAD_DAYS + MOV_CONFIG.PAYMENT_DELAY_DAYS + MOV_CONFIG.SAFETY_BUFFER_DAYS) / 30;
            const estVelocity = effectiveLeadMonths > 0 ? dbRop / effectiveLeadMonths : 0;
            const safetyStockMonths = (MOV_CONFIG.PAYMENT_DELAY_DAYS + MOV_CONFIG.SAFETY_BUFFER_DAYS) / 30;
            const safetyStockQty = velOv > 0 ? velOv : Math.ceil(estVelocity * safetyStockMonths);

            // 4. CRITICAL LOGIC: Current <= Safety Stock
            if (curr <= safetyStockQty) {
              result.inventory.criticalStock++;

              const gap = rop - curr;
              // Defensive cost extraction
              const rawCost = (idxCost !== undefined) ? String(row[idxCost] || "0") : "0";
              const cost = parseFloat(rawCost.replace(/[^0-9.-]+/g, "")) || 0;
              const impact = gap * cost;
              const health = (curr / rop) * 100;

              result.ropAlerts.push({
                id: idVal || "N/A",
                name: nameVal || "Unknown",
                current: curr,
                rop: rop,
                safetyStockQty: safetyStockQty,
                gap: gap,
                cost: impact,
                health: health
              });
            }
          }

          // Sort by URGENCY (Lowest Health % first)
          result.ropAlerts.sort((a, b) => a.health - b.health);

          if (result.ropAlerts.length > 10) {
            result.ropAlerts = result.ropAlerts.slice(0, 10);
          }
        }
      }
    }

    const response = { success: true, data: result };
    // Cache result for 5 minutes
    try { cache.put('DASH_STATS', JSON.stringify(response), 300); } catch (e) { }
    return response;

  } catch (e) {
    return { success: false, error: e.message };
  }
}