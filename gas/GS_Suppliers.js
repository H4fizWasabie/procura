/* SUPPLIERS BACKEND
   Handles CRUD for DB_Suppliers.
   Key Identifier: "Supplier Name" (Column A)
*/

// --- READ ---
function apiGetSuppliers() {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);

  // PERFORMANCE: Check cache first (10 min TTL - suppliers change rarely)
  const cache = CacheService.getScriptCache();
  const cached = cache.get('SUPPLIERS');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* cache corrupted, recompute */ }
  }

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_SUPPLIERS);

  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return [];

  // PERFORMANCE: Only read the specific data block
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const result = [];
  data.forEach(row => {
    let rowObj = {};
    headers.forEach((h, idx) => {
      rowObj[h] = row[idx];
    });
    result.push(rowObj);
  });

  const sorted = result.sort((a, b) => String(a['Supplier Name']).localeCompare(String(b['Supplier Name'])));
  // Cache for 10 minutes
  try { cache.put('SUPPLIERS', JSON.stringify(sorted), 600); } catch (e) { }
  return sorted;
}

// --- WRITE (Create / Update) ---
function apiSaveSupplier(form) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);

    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_SUPPLIERS);
    if (!sheet) throw new Error("DB_Suppliers sheet not found.");

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const data = sheet.getDataRange().getValues();

    // Identify Row (Update vs New)
    // We use "original_name" to find the row in case the user Fixed a typo in the Name itself.
    const searchKey = form.original_name || form.supplier_name;
    let rowIndex = -1;

    // Find row by Name (Col 0)
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(searchKey)) {
        rowIndex = i + 1; // 1-based index
        break;
      }
    }

    const timestamp = new Date();
    const rowData = [];

    // Map Form Data to Schema Headers (with sanitization)
    headers.forEach(h => {
      switch (h) {
        case 'Supplier Name': rowData.push(sanitizeText(form.supplier_name)); break;
        case 'Contact Person': rowData.push(sanitizeText(form.contact_person)); break;
        case 'Phone': rowData.push(sanitizeText(form.phone)); break;
        case 'Email': rowData.push(sanitizeText(form.email)); break;
        case 'Address': rowData.push(sanitizeText(form.address)); break;
        case 'Payment Terms': rowData.push(sanitizeText(form.payment_terms)); break;
        case 'BRN': rowData.push(sanitizeText(form.brn)); break;
        case 'Account No': rowData.push(sanitizeText(form.account_no)); break;
        case 'Bank Name': rowData.push(sanitizeText(form.bank_name)); break;
        default: rowData.push('');
      }
    });

    if (rowIndex > -1) {
      // UPDATE
      sheet.getRange(rowIndex, 1, 1, rowData.length).setValues([rowData]);
      CacheService.getScriptCache().remove('SUPPLIERS');
      return { success: true, message: "Supplier updated successfully." };
    } else {
      // CREATE
      sheet.appendRow(rowData);
      CacheService.getScriptCache().remove('SUPPLIERS');
      return { success: true, message: "New supplier created." };
    }

  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// --- DELETE ---
function apiDeleteSupplier(supplierName) {
  assertPermission(['ADMIN']); // Strict Admin Only
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_SUPPLIERS);
    const data = sheet.getDataRange().getValues();

    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(supplierName)) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex > -1) {
      sheet.deleteRow(rowIndex);
      CacheService.getScriptCache().remove('SUPPLIERS');
      logSystemAction('SUPPLIERS', 'DELETE', supplierName, 'Supplier deleted by admin');
      return { success: true };
    } else {
      throw new Error("Supplier not found.");
    }

  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}