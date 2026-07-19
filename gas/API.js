/*
  BACKEND API & SECURITY
  Handles data read/write with LockService.
  Refactored for Legacy Schema Compliance (JSON Packing).
  UPDATED: Implemented CacheService for User Roles (Fix 2).
*/

// --- SECURITY MIDDLEWARE ---

function getUserRole(email) {
  if (!email) return 'NONE';

  // 0. SUPER ADMINS (Defined in _Config.js)
  if (typeof SUPER_ADMINS !== 'undefined' && SUPER_ADMINS.includes(String(email).toLowerCase())) {
    return 'ADMIN';
  }

  // 1. CACHE CHECK (PERFORMANCE FIX)
  const cache = CacheService.getScriptCache();
  const cachedRole = cache.get(`ROLE_${email}`);

  if (cachedRole) {
    return cachedRole;
  }

  // 2. SHEET LOOKUP (FALLBACK)
  const ss = getSpreadsheet();
  // Check if DB_CONFIG exists (Safety for Load Order)
  const sheetName = (typeof DB_CONFIG !== 'undefined') ? DB_CONFIG.SHEET_USERS : "System_Users";
  const sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    // If sheet missing, strict fail. Bootstrap will handle creation later.
    return 'NONE';
  }

  const data = sheet.getDataRange().getValues();
  let role = 'NONE';

  // Header is row 0. Loop to find Email (Col 0) -> Role (Col 1)
  // We assume Row 1 is headers based on Schema
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === String(email).toLowerCase()) {
      role = data[i][1]; // Role
      break;
    }
  }

  // 3. WRITE TO CACHE (6 Hours)
  cache.put(`ROLE_${email}`, role, 21600);

  return role;
}

function assertPermission(allowedRoles) {
  const email = Session.getActiveUser().getEmail();
  const role = getUserRole(email);
  if (!allowedRoles.includes(role)) {
    throw new Error(`Access Denied: User ${email} with role ${role} does not have permission.`);
  }
  return { email, role };
}

// --- READ OPERATIONS ---

/**
 * Consolidated master data for app startup
 */
function apiGetAppBootstrapData() {
  const email = Session.getActiveUser().getEmail();
  const role = getUserRole(email);

  return {
    user: { email, role },
    suppliers: apiGetSuppliers(),
    items: apiGetInventory("", 1, 500), // First 500 items for lookup
    dashboard: apiGetDashboardStats(),  // Pre-fetch dashboard stats
    timestamp: Date.now()
  };
}

function apiGetRequests() {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PRF);
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // PERFORMANCE: Read only headers + last 1000 rows
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  const LIMIT = 1000;
  const startRow = Math.max(2, lastRow - LIMIT + 1);
  const numRows = lastRow - startRow + 1;
  const data = sheet.getRange(startRow, 1, numRows, lastCol).getValues();

  const idxJSON = headers.indexOf('PRF_Data_JSON');
  const idxID = headers.indexOf('PRF ID');
  const idxDate = headers.indexOf('Date');
  const idxReq = headers.indexOf('Requester');
  const idxDept = headers.indexOf('Department');
  const idxStatus = headers.indexOf('Status');

  const result = [];
  // Process backwards for newest first
  for (let i = data.length - 1; i >= 0; i--) {
    let row = {};
    const rowData = data[i];

    row['ID'] = rowData[idxID];
    row['Created_At'] = rowData[idxDate] instanceof Date ? rowData[idxDate].toISOString().split('T')[0] : rowData[idxDate];
    row['Requester_Email'] = rowData[idxReq];
    row['Department'] = rowData[idxDept];
    row['Status'] = rowData[idxStatus];

    let details = {};
    try {
      const jsonString = rowData[idxJSON];
      if (jsonString && jsonString.startsWith('{')) {
        details = JSON.parse(jsonString);
      }
    } catch (e) { }

    row['Title'] = details.title || 'Untitled';
    row['Description'] = details.description || '';
    row['Supplier_Name'] = details.supplier || '';
    row['Currency'] = details.currency || '';
    row['Total_Value'] = details.value || 0;
    row['Comments'] = details.comments || '';

    result.push(row);
  }
  return result;
}

function apiGetUsers() {
  assertPermission(['ADMIN']);
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_USERS);
  return sheet.getDataRange().getValues();
}

function apiGetSystemLogs() {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_LOGS);
  if (!sheet) return [];

  const data = sheet.getRange(Math.max(1, sheet.getLastRow() - 15), 1, Math.min(sheet.getLastRow(), 15), 6).getValues();
  // Schema: Timestamp, User, Action, Module, ID, Details
  return data.reverse().map(r => ({
    time: r[0] instanceof Date ? r[0].toLocaleTimeString() : String(r[0]),
    user: String(r[1]).split('@')[0],
    action: r[2],
    details: r[5]
  }));
}

/**
 * Returns the HTML content of a module for lazy-loading
 */
// apiGetModuleHtml removed — all modules are now pre-bundled in Index.html
// for instant page switching (no server roundtrip needed).

// --- WRITE OPERATIONS ---

function apiSaveRequest(formData) {
  // Only Editors and Admins can create/edit
  const userObj = assertPermission(['EDITOR', 'ADMIN']);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    const ss = getSpreadsheet();
    // SCHEMA MAP: DB_PRF
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PRF);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    // Determine ID
    let isNew = !formData.ID;
    let rowId = -1;
    let recordId = formData.ID || Utilities.getUuid();

    if (!isNew) {
      // Find existing row by PRF ID
      const rowCount = sheet.getLastRow() - 1;
      if (rowCount < 1) throw new Error('No records exist to update.');
      const ids = sheet.getRange(2, headers.indexOf('PRF ID') + 1, rowCount, 1).getValues().flat();
      const relativeIndex = ids.indexOf(recordId);
      if (relativeIndex > -1) {
        rowId = relativeIndex + 2;
      } else {
        throw new Error('Record ID not found for update.');
      }
    } else {
      rowId = sheet.getLastRow() + 1;
    }

    // Prepare Data
    const timestamp = new Date();

    // PACK NON-SCHEMA FIELDS INTO JSON
    const packedData = {
      title: formData.title,
      description: formData.description,
      supplier: formData.supplier,
      currency: formData.currency,
      value: formData.value,
      comments: formData.comments,
      last_updated: timestamp.toISOString()
    };

    const rowData = [];
    headers.forEach(header => {
      switch (header) {
        case 'PRF ID': rowData.push(recordId); break;
        case 'Date':
          if (isNew) rowData.push(timestamp);
          else rowData.push(sheet.getRange(rowId, headers.indexOf('Date') + 1).getValue());
          break;
        case 'Requester':
          if (isNew) rowData.push(userObj.email);
          else rowData.push(sheet.getRange(rowId, headers.indexOf('Requester') + 1).getValue());
          break;
        case 'Department': rowData.push(formData.department); break;
        case 'Status': rowData.push(formData.status || 'Draft'); break;
        case 'Items Count': rowData.push(1); break; // Default 1 for simple request
        case 'PRF_Data_JSON': rowData.push(JSON.stringify(packedData)); break;
        default: rowData.push('');
      }
    });

    // Write
    if (isNew) {
      sheet.appendRow(rowData);
    } else {
      sheet.getRange(rowId, 1, 1, rowData.length).setValues([rowData]);
    }

    logSystemAction(isNew ? 'CREATE_PRF' : 'UPDATE_PRF', 'DB_PRF', recordId, `Status: ${formData.status}`);

    return { success: true, id: recordId };

  } catch (e) {
    logError('apiSaveRequest', e);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

function apiDeleteRequest(id) {
  assertPermission(['ADMIN']);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);

    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PRF);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const colIdx = headers.indexOf('PRF ID') + 1;

    const ids = sheet.getRange(2, colIdx, sheet.getLastRow() - 1, 1).getValues().flat();
    const index = ids.indexOf(id);

    if (index > -1) {
      sheet.deleteRow(index + 2);
      logSystemAction('DELETE_PRF', 'DB_PRF', id, 'Deleted by Admin');
      return { success: true };
    }
    return { success: false, error: 'ID not found' };

  } catch (e) {
    logError('apiDeleteRequest', e);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}