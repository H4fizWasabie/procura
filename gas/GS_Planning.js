/* PLANNING ENGINE v2
   Tiered ordering with dynamic stock caps based on Turnover Rate.
   Items 100-120% ROP are hidden from planning view.
*/

function apiGetPlanningContext() {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_ITEMS);
  const data = sheet.getDataRange().getValues();
  const h = getHeaderMap(data[0]);

  const idxId = h['stock id'];
  const idxName = h['item name'];
  const idxCat = h['category'];
  const idxCur = h['current'];
  const idxRop = h['rop'];
  const idxCost = h['cost'];
  const idxSup = h['supplier'];
  const idxUom = h['uom'];
  const idxExcl = h['exclude'];
  const idxBeh = h['item behaviour'];
  const idxStatus = h['product status'];

  const pipelineIds = _getProcurementPipelineStockIds();
  const turnoverMap = _getTurnoverRates();
  const effectiveLeadMonths = (MOV_CONFIG.SUPPLIER_LEAD_DAYS + MOV_CONFIG.PAYMENT_DELAY_DAYS + MOV_CONFIG.SAFETY_BUFFER_DAYS) / 30;
  const planningData = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    const idVal = (idxId !== undefined) ? String(row[idxId] || "").trim() : "";
    const nameVal = (idxName !== undefined) ? String(row[idxName] || "").trim() : "";
    if (!idVal && !nameVal) continue;

    if (pipelineIds.has(idVal)) continue;

    // Noise Filters
    if (idxExcl !== undefined) {
      const exclVal = String(row[idxExcl]).toUpperCase();
      if (exclVal === 'TRUE' || exclVal === 'YES' || exclVal === 'EXCLUDE') continue;
    }
    if (idxBeh !== undefined) {
      const behVal = String(row[idxBeh] || "").trim().toLowerCase();
      if (behVal === "asset" || behVal === "service" || behVal === "exclude") continue;
      if (behVal !== "" && behVal !== "standard / pack" && behVal !== "in-house use") continue;
    }
    if (idxStatus !== undefined) {
      const statusVal = String(row[idxStatus] || "").trim().toLowerCase();
      if (statusVal === "unavailable") continue;
    }
    // Skip surgical items
    const pType = (h['product type'] !== undefined) ? String(row[h['product type']] || "").toLowerCase() : "";
    const cat = (idxCat !== undefined) ? String(row[idxCat] || "").toLowerCase() : "";
    if (pType.includes("surgical") || cat.includes("surgical")) continue;

    const current = Number(row[idxCur]) || 0;
    const dbRop = Number(row[idxRop]) || 0;
    const velOv = (h['velocity override'] !== undefined) ? Number(row[h['velocity override']]) || 0 : 0;

    // If override is present, it directly becomes the ROP and Safety Stock target
    const rop = velOv > 0 ? velOv : dbRop;

    // Only show items BELOW ROP (100-120% zone removed)
    if (rop > 0 && current < rop) {
      const health = (current / rop) * 100;
      const cost = Number(row[idxCost]) || 0;

      // Turnover-based velocity classification
      const turnoverRate = turnoverMap.get(idVal.toUpperCase()) || 0;
      const velocityClass = _getVelocityClass(turnoverRate);
      const capMonths = _getCapMonths(velocityClass);

      // Estimate velocity from the original database ROP
      // ROP now uses 2-month policy (1 month safety + 1 month ordering)
      const ROP_MONTHS = 2;
      const estVelocity = ROP_MONTHS > 0 ? dbRop / ROP_MONTHS : 0;

      // If override, Max Stock Cap is also the override value so it replenishes up to 5
      const maxStockQty = velOv > 0 ? velOv : Math.ceil(estVelocity * capMonths);

      // Tiered ordering based on Safety Stock
      // Safety Stock = 1 month (covers payment delays + lead time + safety buffer)
      const safetyStockMonths = 1.0;
      const safetyStockQty = velOv > 0 ? velOv : Math.ceil(estVelocity * safetyStockMonths);

      let orderTarget, status, suggested;

      if (current <= safetyStockQty) {
        status = 'CRITICAL';
        // Trigger activated: Suggest max capacity
        suggested = Math.max(0, maxStockQty - current);
      } else {
        status = 'REORDER';
        // Below ROP but hasn't reached Safety Stock trigger yet
        suggested = 0;
      }

      planningData.push({
        id: idVal,
        name: nameVal,
        category: row[idxCat],
        productType: (h['product type'] !== undefined) ? row[h['product type']] : "",
        supplier: row[idxSup],
        uom: row[idxUom],
        current,
        rop,
        cost,
        suggested,
        health,
        status,
        safetyStockQty,
        velocityClass,
        capMonths,
        turnoverRate
      });
    }
  }

  planningData.sort((a, b) => a.health - b.health);
  return planningData;
}

// --- TURNOVER RATE HELPERS ---

/** Fetches Turnover Rate from most recent Movement sheets (current year, fallback to previous). */
function _getTurnoverRates() {
  const ss = getSpreadsheet();
  const turnoverMap = new Map();
  const currentYear = new Date().getFullYear();

  // Read previous year first, then current year overwrites
  for (const year of [currentYear - 1, currentYear]) {
    const sheet = ss.getSheetByName(`Movement ${year}`);
    if (sheet && sheet.getLastRow() > 2) {
      const data = sheet.getRange(3, 1, sheet.getLastRow() - 2, MOV_CONFIG.TOTAL_COLS).getValues();
      for (const row of data) {
        const sku = String(row[0]).trim().toUpperCase();
        if (sku) {
          const tr = Number(row[66]) || 0; // Turnover Rate = column 67 (index 66)
          if (tr > 0) turnoverMap.set(sku, tr);
        }
      }
    }
  }
  return turnoverMap;
}

function _getVelocityClass(turnoverRate) {
  if (turnoverRate >= MOV_CONFIG.TURNOVER_FAST_THRESHOLD) return 'FAST';
  if (turnoverRate < MOV_CONFIG.TURNOVER_SLOW_THRESHOLD) return 'SLOW';
  return 'MEDIUM';
}

function _getCapMonths(velocityClass) {
  switch (velocityClass) {
    case 'FAST': return MOV_CONFIG.CAP_FAST_MONTHS;
    case 'SLOW': return MOV_CONFIG.CAP_SLOW_MONTHS;
    default: return MOV_CONFIG.CAP_MEDIUM_MONTHS;
  }
}

/**
 * Identifies items currently "in flight" (Recent RFQs or Open POs).
 * Used to prevent double-ordering in the Planning Module.
 */
function _getProcurementPipelineStockIds() {
  const ss = getSpreadsheet();
  const pipeline = new Set();
  const now = new Date();
  const LookbackDays = 7; // 1 week lookback for RFQs

  // 1. SCAN DIRECT ORDERS (Recent Only)
  const directOrderIds = _getDirectOrderPipelineStockIds();
  directOrderIds.forEach(id => pipeline.add(id));

  // 2. SCAN RFQ_LOGS (Recent Only)
  const rfqSheet = ss.getSheetByName(DB_CONFIG.SHEET_RFQ);
  if (rfqSheet) {
    const rfqData = rfqSheet.getDataRange().getValues();
    const rfqHeaders = rfqData[0].map(h => String(h).toLowerCase());
    const idxDate = rfqHeaders.indexOf('date');
    const idxJson = rfqHeaders.indexOf('rfq_data_json');

    if (idxDate > -1 && idxJson > -1) {
      for (let i = 1; i < rfqData.length; i++) {
        const rowDate = new Date(rfqData[i][idxDate]);
        const ageDays = (now - rowDate) / (1000 * 60 * 60 * 24);

        if (ageDays <= LookbackDays) {
          try {
            const items = JSON.parse(rfqData[i][idxJson]);
            items.forEach(item => { if (item.id) pipeline.add(String(item.id)); });
          } catch (e) { }
        }
      }
    }
  }

  // 2. SCAN PURCHASE ORDERS (Open/Pending Only)
  const poSheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
  if (poSheet) {
    const poData = poSheet.getDataRange().getValues();
    const poHeaders = poData[0].map(h => String(h).toLowerCase());
    const idxShipStatus = poHeaders.indexOf('ship status');
    const idxStatus = poHeaders.indexOf('status');
    const idxJson = poHeaders.indexOf('po_data_json');

    if (idxJson > -1) {
      for (let i = 1; i < poData.length; i++) {
        const shipStatus = String(poData[i][idxShipStatus] || "").trim();
        const status = String(poData[i][idxStatus] || "").trim();

        // Skip Received and Voided POs
        if (shipStatus === 'Received' || status === 'VOID') continue;

        try {
          const items = JSON.parse(poData[i][idxJson]);
          items.forEach(item => { if (item.id) pipeline.add(String(item.id)); });
        } catch (e) { }
      }
    }
  }

  return pipeline;
}

// --- DIRECT ORDER FUNCTIONS ---

/**
 * Mark items as ordered directly (bypassing RFQ).
 * Logs to DirectOrder_Logs sheet with 1-week exclusion.
 * @param {Array} items - Array of {stockId, name, supplier, qty}
 * @param {string} notes - Optional notes for the order
 * @returns {Object} - {success, orderId, itemCount}
 */
function apiMarkItemOrdered(itemsOrObj, notesOrForce, maybeForce) {
  assertPermission(['EDITOR', 'ADMIN']);

  // Handle both call patterns: (items, notes) and ({items, notes}, force)
  let items, notes;
  if (Array.isArray(itemsOrObj)) {
    items = itemsOrObj;
    notes = notesOrForce;
  } else if (itemsOrObj && itemsOrObj.items) {
    items = itemsOrObj.items;
    notes = itemsOrObj.notes;
  } else {
    throw new Error("No items provided for ordering.");
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new Error("No items provided for ordering.");
  }

  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(DB_CONFIG.SHEET_DIRECT_ORDERS);

  // Create sheet if it doesn't exist
  if (!sheet) {
    sheet = ss.insertSheet(DB_CONFIG.SHEET_DIRECT_ORDERS);
    const headers = DB_SCHEMA[DB_CONFIG.SHEET_DIRECT_ORDERS];
    sheet.getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setFontWeight('bold')
      .setBackground('#EFEFEF')
      .setFrozenRows(1);
  }

  const now = new Date();
  const orderId = _generateDirectOrderId(sheet);
  const userEmail = Session.getActiveUser().getEmail();
  const rows = [];

  items.forEach(item => {
    rows.push([
      orderId,
      now,
      sanitizeText(String(item.stockId || "")),
      sanitizeText(String(item.name || "")),
      sanitizeText(String(item.supplier || "")),
      Number(item.qty) || 0,
      userEmail,
      sanitizeText(String(notes || "")),
      'ACTIVE'
    ]);
  });

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }

  return { success: true, orderId: orderId, itemCount: items.length };
}

/**
 * Generate a sequential Direct Order ID (DO-YYYY-NNN).
 */
function _generateDirectOrderId(sheet) {
  const year = new Date().getFullYear();
  const prefix = `DO-${year}-`;

  if (sheet.getLastRow() <= 1) return prefix + "001";

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  let maxSeq = 0;

  data.forEach(row => {
    const id = String(row[0] || "");
    if (id.startsWith(prefix)) {
      const seq = parseInt(id.replace(prefix, ""), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });

  return prefix + String(maxSeq + 1).padStart(3, '0');
}

/**
 * Cancel a direct order by setting its status to CANCELLED.
 * @param {string} orderId - The Order ID to cancel
 * @returns {Object} - {success, cancelledCount}
 */
function apiCancelDirectOrder(orderIdOrObj, maybeForce) {
  assertPermission(['EDITOR', 'ADMIN']);

  // Handle both call patterns: (orderId) and ({orderId}, force)
  let orderId;
  if (typeof orderIdOrObj === 'string') {
    orderId = orderIdOrObj;
  } else if (orderIdOrObj && orderIdOrObj.orderId) {
    orderId = orderIdOrObj.orderId;
  } else {
    throw new Error("Order ID is required.");
  }

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_DIRECT_ORDERS);
  if (!sheet || sheet.getLastRow() <= 1) throw new Error("No direct orders found.");

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).toLowerCase());
  const idxOrderId = headers.indexOf('order id');
  const idxStatus = headers.indexOf('status');

  if (idxOrderId === -1 || idxStatus === -1) throw new Error("DirectOrder_Logs sheet missing required columns.");

  let cancelledCount = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idxOrderId]) === String(orderId) && String(data[i][idxStatus]).toUpperCase() === 'ACTIVE') {
      sheet.getRange(i + 1, idxStatus + 1).setValue('CANCELLED');
      cancelledCount++;
    }
  }

  if (cancelledCount === 0) throw new Error(`Order ${orderId} not found or already cancelled.`);

  return { success: true, cancelledCount: cancelledCount };
}

/**
 * Get all active direct orders from the last 7 days.
 * @returns {Array} - Array of order objects grouped by Order ID
 */
function apiGetDirectOrders() {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_DIRECT_ORDERS);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).toLowerCase());
  const h = {};
  headers.forEach((hdr, i) => h[hdr] = i);

  const now = new Date();
  const lookbackMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  const ordersMap = {};

  for (let i = 1; i < data.length; i++) {
    const status = String(data[i][h['status']] || "").toUpperCase();
    if (status !== 'ACTIVE') continue;

    const orderDate = new Date(data[i][h['date']]);
    if ((now - orderDate) > lookbackMs) continue;

    const orderId = String(data[i][h['order id']]);
    if (!ordersMap[orderId]) {
      ordersMap[orderId] = {
        orderId: orderId,
        date: orderDate,
        orderedBy: data[i][h['ordered by']],
        notes: data[i][h['notes']],
        items: []
      };
    }

    ordersMap[orderId].items.push({
      stockId: data[i][h['stock id']],
      name: data[i][h['item name']],
      supplier: data[i][h['supplier']],
      qty: data[i][h['qty']]
    });
  }

  return Object.values(ordersMap).sort((a, b) => b.date - a.date);
}

/**
 * Scan DirectOrder_Logs for items ordered within 7 days.
 * Returns a Set of stock IDs to exclude from planning.
 */
function _getDirectOrderPipelineStockIds() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_DIRECT_ORDERS);
  if (!sheet || sheet.getLastRow() <= 1) return new Set();

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).toLowerCase());
  const h = {};
  headers.forEach((hdr, i) => h[hdr] = i);

  const now = new Date();
  const lookbackMs = 7 * 24 * 60 * 60 * 1000;
  const pipeline = new Set();

  for (let i = 1; i < data.length; i++) {
    const status = String(data[i][h['status']] || "").toUpperCase();
    if (status !== 'ACTIVE') continue;

    const orderDate = new Date(data[i][h['date']]);
    if ((now - orderDate) > lookbackMs) continue;

    const stockId = String(data[i][h['stock id']] || "").trim();
    if (stockId) pipeline.add(stockId);
  }

  return pipeline;
}
