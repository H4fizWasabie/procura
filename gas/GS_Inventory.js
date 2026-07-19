// [file] GS_Inventory.js
/* INVENTORY BACKEND
   Features: Lazy Loading (Pagination), Search, and Anchor Logic (Exclude/Velocity).
   UPDATED: Optimized "Empty Search" to use Ranged Reads (Fix 1).
*/

// --- READ (With Pagination) ---
function apiGetInventory(searchTerm = "", page = 1, pageSize = 50) {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  // Fallback to "DB_Items" if config not loaded
  const sheetName = (typeof DB_CONFIG !== 'undefined') ? DB_CONFIG.SHEET_ITEMS : "DB_Items";
  const sheet = ss.getSheetByName(sheetName);

  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  // If sheet is empty or only headers
  if (lastRow < 2) return [];

  // OPTIMIZATION: Ranged Read (Only when NOT searching)
  // We want to fetch the "Newest" items, which are at the bottom.
  if (searchTerm === "") {
    // Calculate the slice from the bottom
    // Page 1: Bottom 50 rows. Page 2: Next 50 up.
    const endRow = lastRow - ((page - 1) * pageSize);
    const startRow = Math.max(2, endRow - pageSize + 1);

    // If we've scrolled past the top (header), return empty
    if (endRow < 2) return [];

    const numRows = endRow - startRow + 1;
    if (numRows < 1) return [];

    // Fetch ONLY the visible block + Headers for mapping
    const headerValues = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const dataValues = sheet.getRange(startRow, 1, numRows, sheet.getLastColumn()).getValues();

    // Process logic is same, but we iterate the small chunk in reverse order
    // to maintain "Newest First" visual
    const results = [];
    for (let i = dataValues.length - 1; i >= 0; i--) {
      results.push(packInventoryRow(dataValues[i], headerValues));
    }
    return results;
  }

  // --- FALLBACK: Search Logic (BULK READ - Single API call) ---
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  const searchLower = String(searchTerm).toLowerCase().trim();

  // PERFORMANCE: Read ALL rows in ONE API call
  const allRows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  // Filter in memory (instant for thousands of rows)
  const allMatches = [];
  for (let i = allRows.length - 1; i >= 0; i--) {
    const rowString = allRows[i].join(" ").toLowerCase();
    if (rowString.includes(searchLower)) {
      allMatches.push(packInventoryRow(allRows[i], headers));
    }
  }

  // PAGINATE THE SEARCH RESULTS IN MEMORY
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;

  return allMatches.slice(startIndex, endIndex);
}

/**
 * Returns a lightweight list of all items (ID and Name only).
 * Used for dropdowns and search lists.
 */
function apiGetInventoryBasicList() {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  const sheetName = (typeof DB_CONFIG !== 'undefined') ? DB_CONFIG.SHEET_ITEMS : "DB_Items";
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0];
  const idxId = headers.indexOf('Stock ID');
  const idxName = headers.indexOf('Item Name');
  const idxCat = headers.indexOf('Category');
  const idxStatus = headers.indexOf('Product Status');

  return data.slice(1)
    .filter(r => idxStatus === -1 || String(r[idxStatus] || '').trim().toLowerCase() !== 'unavailable')
    .map(r => ({
      'Stock ID': String(r[idxId] || ""),
      'Item Name': String(r[idxName] || ""),
      'Category': String(r[idxCat] || "")
    }));
}

// Helper to objectify rows
function packInventoryRow(row, headers) {
  let rowObj = {};
  headers.forEach((h, idx) => {
    const val = row[idx];
    if (["Exclude", "Velocity Override", "Item Behaviour"].includes(h)) {
      rowObj[h] = val !== undefined ? String(val).trim() : "";
    } else if (val instanceof Date) {
      rowObj[h] = val.toISOString().split('T')[0];
    } else {
      rowObj[h] = val;
    }
  });
  return rowObj;
}

// --- UPDATE (Anchor Logic) ---
function apiSaveInventoryItem(stockId, updates) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);
    const ss = getSpreadsheet();
    const sheetName = (typeof DB_CONFIG !== 'undefined') ? DB_CONFIG.SHEET_ITEMS : "DB_Items";
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) throw new Error("Inventory sheet not found.");

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const idIdx = headers.indexOf('Stock ID');
    const dateIdx = headers.indexOf('Last Updated');

    if (idIdx === -1) throw new Error("Stock ID column missing.");

    // PERFORMANCE: Targeted ID Column Scan
    const idColumnValues = sheet.getRange(1, idIdx + 1, lastRow, 1).getValues().flat();
    let rowIndex = -1;
    for (let i = 1; i < idColumnValues.length; i++) {
      if (String(idColumnValues[i]) === String(stockId)) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) throw new Error("Item not found.");

    // Map updates to columns
    const anchorMap = {
      'Exclude': headers.indexOf('Exclude'),
      'Velocity Override': headers.indexOf('Velocity Override'),
      'Item Behaviour': headers.indexOf('Item Behaviour'),
      'Cost': headers.indexOf('Cost'),
      'UOM': headers.indexOf('UOM'),
      'Selling': headers.indexOf('Selling'),
      'ROP': headers.indexOf('ROP'),
      'Pack Size': headers.indexOf('Pack Size')
    };

    // --- SERVICE VALIDATION ---
    // If set to Service or Asset, force ROP to 0 to prevent ghost alerts
    if (updates['Item Behaviour'] === 'Service' || updates['Item Behaviour'] === 'Asset') {
      updates['ROP'] = 0;
    }

    // PERFORMANCE: Direct Cell Writing
    for (let key in updates) {
      const colIdx = anchorMap[key];
      if (colIdx !== undefined && colIdx > -1) {
        sheet.getRange(rowIndex, colIdx + 1).setValue(updates[key]);
      }
    }

    if (dateIdx > -1) sheet.getRange(rowIndex, dateIdx + 1).setValue(new Date());

    return { success: true, message: "Inventory updated." };

  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// --- BULK IMPORT HELPERS (Preserved) ---
function apiPreviewBulkImport(rawText) {
  try {
    // Assumes GS_Core_Parser exists in your project
    const parsed = parseRawData(rawText, 'INVENTORY_MAP');
    return { success: true, stats: { count: parsed.count, columns: parsed.mapped_columns }, previewData: parsed.data.slice(0, 10) };
  } catch (e) { return { success: false, error: e.message }; }
}

function apiBulkUploadInventory(rawText) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName((typeof DB_CONFIG !== 'undefined') ? DB_CONFIG.SHEET_ITEMS : "DB_Items");

    const range = sheet.getDataRange();
    let dbValues = range.getValues();
    const dbHeaders = dbValues[0];
    const idIdx = dbHeaders.indexOf('Stock ID');
    const dateIdx = dbHeaders.indexOf('Last Updated');

    const existingMap = new Map();
    for (let i = 1; i < dbValues.length; i++) existingMap.set(String(dbValues[i][idIdx]), i);

    const parsed = parseRawData(rawText, 'INVENTORY_MAP');
    const newRows = [];
    const timestamp = new Date();

    parsed.data.forEach(item => {
      const stockId = String(item['Stock ID']);
      if (existingMap.has(stockId)) {
        const rowIndex = existingMap.get(stockId);
        parsed.mapped_columns.forEach(colName => {
          const colIdx = dbHeaders.indexOf(colName);
          if (colIdx > -1) dbValues[rowIndex][colIdx] = item[colName];
        });
        if (dateIdx > -1) dbValues[rowIndex][dateIdx] = timestamp;
      } else {
        const rowArray = dbHeaders.map(h => {
          if (h === 'Last Updated') return timestamp;
          return item[h] !== undefined ? item[h] : '';
        });
        newRows.push(rowArray);
      }
    });

    if (dbValues.length > 1) sheet.getRange(1, 1, dbValues.length, dbValues[0].length).setValues(dbValues);
    if (newRows.length > 0) sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);

    return { success: true, message: `Synced ${parsed.count} items.` };
  } catch (e) { return { success: false, error: e.message }; } finally { lock.releaseLock(); }
}