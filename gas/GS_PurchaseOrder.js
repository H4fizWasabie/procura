// [file] GS_PurchaseOrder.js
/* PURCHASE ORDER BACKEND
   Handles PO CRUD, ID Generation, JSON Packing, and PDF Generation.
   FIXED: Windowed History Read (Fix 4), Strict Date Saving (Fix 3).
*/

const PO_CONFIG = {
  get FOLDER_ID() { return _getSecureConfig('PO_FOLDER_ID'); },
  get LOGO_ID() { return _getSecureConfig('PO_LOGO_ID'); },
  get SIGN_ID() { return _getSecureConfig('PO_SIGN_ID'); },
  COMPANY_INFO: {
    name: "STARLiGHT Veterinary Medical Center",
    addr1: "No. 30, Jalan Sulaiman 1",
    addr2: "Taman Ampang Hilir",
    addr3: "68000 Ampang Jaya, Selangor"
  }
};

// --- CONTEXT & CRUD ---
function apiGetPOContext() {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  return {
    suppliers: apiGetSuppliers(),
    items: apiGetInventoryBasicList(),
    history: apiGetPOHistory(),
    newPoId: generateNextPoId(false)
  };
}

// --- HISTORY FETCH (OPTIMIZED - Fix 4) ---
function apiGetPOHistory() {
  // PERFORMANCE: Check cache first (5-minute TTL)
  const cache = CacheService.getScriptCache();
  const cached = cache.get('PO_HISTORY');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* cache corrupted, recompute */ }
  }

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  // Ensure we have at least headers (row 1) and data
  if (lastRow < 2) return [];

  // OPTIMIZATION: Incremental loading — only read rows newer than last cache
  const limit = 500;
  const startRow = Math.max(2, lastRow - limit + 1);
  const numRows = lastRow - startRow + 1;

  // Safety check
  if (numRows < 1) return [];

  // 1. Fetch Header Map
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idxId = headers.indexOf('PO ID');
  const idxDate = headers.indexOf('Date');
  const idxJson = headers.indexOf('PO_Data_JSON');

  if (idxId === -1) return [];

  // 2. Fetch Data Block (only read columns we need for history list)
  const neededCols = ['Date', 'PO ID', 'Supplier', 'Total', 'Status', 'Ship Status', 'Dept', 'Terms', 'PO_Data_JSON', 'Bill #', 'Signed URL', 'Inv URL', 'Pmt URL', 'Item History URL'];
  const colIndices = neededCols.map(h => headers.indexOf(h)).filter(i => i > -1);
  const minCol = Math.min(...colIndices);
  const maxCol = Math.max(...colIndices);
  const numCols = maxCol - minCol + 1;

  const data = sheet.getRange(startRow, minCol + 1, numRows, numCols).getValues();

  // Map absolute column index to relative index within subset
  const absToRel = {};
  colIndices.forEach(absIdx => { absToRel[absIdx] = absIdx - minCol; });

  const result = [];

  // Loop Backwards (Newest First)
  // Note: data index 0 corresponds to startRow
  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    const relIdIdx = absToRel[idxId];
    const poId = String(row[relIdIdx] || "").trim();

    // SKIP EMPTY ROWS
    if (!poId) continue;

    let rowObj = {};
    neededCols.forEach(h => {
      const absIdx = headers.indexOf(h);
      if (absIdx === -1 || absToRel[absIdx] === undefined) return;
      const relIdx = absToRel[absIdx];
      const val = row[relIdx];

      if (h === 'Date') {
        rowObj[h] = (val instanceof Date) ? val.toISOString().split('T')[0] : val;
      } else {
        rowObj[h] = val;
      }
    });

    // Parse Items JSON safely
    const relJsonIdx = absToRel[idxJson];
    try {
      rowObj['Items'] = (relJsonIdx !== undefined && row[relJsonIdx]) ? JSON.parse(row[relJsonIdx]) : [];
    } catch (e) {
      rowObj['Items'] = [];
    }

    result.push(rowObj);
  }
  // Cache for 5 minutes
  try { cache.put('PO_HISTORY', JSON.stringify(result), 300); } catch (e) { }
  return result;
}

// --- FETCH SINGLE PO (OPTIMIZED) ---
function apiGetPOFullDetails(poId) {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
  if (!sheet) return { success: false, error: "Sheet missing" };

  const lastRow = sheet.getLastRow();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idxId = headers.indexOf('PO ID');

  // PERFORMANCE: Targeted ID Column Scan
  const idColumn = sheet.getRange(1, idxId + 1, lastRow, 1).getValues().flat();
  const rowIndex = idColumn.indexOf(poId);

  if (rowIndex === -1) return { success: false, error: "PO Not Found" };

  const rowData = sheet.getRange(rowIndex + 1, 1, 1, headers.length).getValues()[0];

  let items = [];
  try { items = JSON.parse(rowData[headers.indexOf('PO_Data_JSON')]); } catch (e) { }

  let dateVal = rowData[headers.indexOf('Date')];
  if (dateVal instanceof Date) {
    dateVal = dateVal.toISOString().split('T')[0];
  }

  return {
    success: true,
    data: {
      id: poId,
      date: dateVal,
      dept: rowData[headers.indexOf('Dept')],
      supplier: rowData[headers.indexOf('Supplier')],
      terms: rowData[headers.indexOf('Terms')],
      bill_no: rowData[headers.indexOf('Bill #')],
      total: rowData[headers.indexOf('Total')],
      items: items
    }
  };
}

// --- ID GENERATOR (ATOMIC COUNTER) ---
function generateNextPoId(commit) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
    if (!sheet) return "PO-ERROR";

    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    const prefix = `PO - ${mm}${yyyy} - `;
    const counterKey = `PO_SEQ_${mm}${yyyy}`;
    const props = PropertiesService.getScriptProperties();

    // Always seed from actual sheet data (source of truth)
    let seq = 0;
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const idxId = headers.indexOf('PO ID');
      if (idxId > -1) {
        const ids = sheet.getRange(2, idxId + 1, lastRow - 1, 1).getValues().flat();
        ids.forEach(id => {
          const sId = String(id || "").trim();
          const match = sId.match(new RegExp(`^PO\\s*-\\s*${mm}${yyyy}\\s*-\\s*(\\d+)$`, 'i'));
          if (match) { const n = parseInt(match[1], 10); if (n > seq) seq = n; }
        });
      }
    }

    // Sync stored counter to match sheet (resets if drifted)
    props.setProperty(counterKey, seq.toString());

    // Preview mode: return next ID without committing the counter
    if (!commit) {
      return prefix + String(seq + 1).padStart(3, '0');
    }

    // Commit mode: increment counter and save
    seq++;
    props.setProperty(counterKey, seq.toString());
    return prefix + String(seq).padStart(3, '0');
  } catch (e) {
    return "PO-ERROR";
  } finally {
    lock.releaseLock();
  }
}

// --- SAVE PO (OPTIMIZED) ---
function apiSavePurchaseOrder(form) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
    const lastRow = sheet.getLastRow();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    const idxId = headers.indexOf('PO ID');
    let poId = form.po_id;

    // PERFORMANCE: Targeted Row Lookup
    const idColumn = sheet.getRange(1, idxId + 1, lastRow || 1, 1).getValues().flat();
    let rowIndex = idColumn.indexOf(poId) + 1;

    // New PO: generate a fresh committed sequential ID
    if (rowIndex === 0) {
      poId = generateNextPoId(true);
    }

    let saveDate = new Date();
    if (form.date) {
      saveDate = new Date(form.date);
      if (isNaN(saveDate.getTime())) saveDate = new Date();
    }

    const itemsBlob = form.items.map(item => ({
      id: item.stockId || '',
      n: item.name,
      q: Number(item.qty),
      c: Number(item.cost),
      t: Number(item.total),
      u: item.uom || 'UNIT'
    }));

    // PERFORMANCE: Read existing row once (avoids multiple getValue() calls in loop)
    const existingRow = (rowIndex > 1)
      ? sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0]
      : null;

    const rowData = [];
    headers.forEach((h, colIdx) => {
      switch (h) {
        case 'Date': rowData.push(saveDate); break;
        case 'PO ID': rowData.push(poId); break;
        case 'Supplier': rowData.push(sanitizeText(form.supplier)); break;
        case 'Bill #': rowData.push(sanitizeText(form.bill_no || '')); break;
        case 'Total': rowData.push(form.total); break;
        case 'Status':
          rowData.push(existingRow ? existingRow[headers.indexOf('Status')] : 'Pending Approval');
          break;
        case 'Ship Status':
          rowData.push(existingRow ? existingRow[headers.indexOf('Ship Status')] : 'Pending');
          break;
        case 'Dept': rowData.push(sanitizeText(form.dept)); break;
        case 'Terms': rowData.push(sanitizeText(form.terms)); break;
        case 'PO_Data_JSON': rowData.push(JSON.stringify(itemsBlob)); break;
        case 'Quot URL':
        case 'Inv URL':
        case 'Signed URL':
        case 'Pmt URL':
          rowData.push(existingRow ? existingRow[headers.indexOf(h)] : '');
          break;
        default: rowData.push('');
      }
    });

    if (rowIndex > 1) {
      sheet.getRange(rowIndex, 1, 1, rowData.length).setValues([rowData]);
    } else {
      sheet.appendRow(rowData);
    }

    // Invalidate caches on PO write
    CacheService.getScriptCache().remove('PO_HISTORY');
    CacheService.getScriptCache().remove('DASH_STATS');
    return { success: true, poId: poId, message: "PO Saved successfully" };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// --- UPDATE STATUS ---
function apiUpdatePOStatus(poId, newStatus, type) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idxId = headers.indexOf('PO ID');
    const colName = type === 'PMT' ? 'Status' : 'Ship Status';
    const colIdx = headers.indexOf(colName);

    if (idxId === -1 || colIdx === -1) throw new Error("Columns not found");

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idxId]) === String(poId)) {
        sheet.getRange(i + 1, colIdx + 1).setValue(newStatus);
        CacheService.getScriptCache().remove('PO_HISTORY');
        CacheService.getScriptCache().remove('DASH_STATS');
        return { success: true };
      }
    }
    throw new Error("PO ID not found");
  } catch (e) { return { success: false, error: e.message }; } finally { lock.releaseLock(); }
}

// --- VOID PO ---
function apiVoidPurchaseOrder(poId) {
  assertPermission(['EDITOR', 'ADMIN']);
  return apiUpdatePOStatus(poId, 'VOID', 'PMT');
}

// --- PDF GENERATION ---
  function apiGeneratePoPdf(poId) {
    const startTime = Date.now();
    console.log(`[PDF] ========== FUNCTION START ==========`);
    console.log(`[PDF] Function called with poId: ${poId}`);
    console.log(`[PDF] poId type: ${typeof poId}`);
    console.log(`[PDF] poId value: ${JSON.stringify(poId)}`);
    console.log(`[PDF] Arguments length: ${arguments.length}`);
    console.log(`[PDF] Arguments: ${JSON.stringify(arguments)}`);
    
    try {
      console.log(`[PDF] Calling assertPermission...`);
      assertPermission(['EDITOR', 'ADMIN']);
      console.log(`[PDF] Permission check passed`);
    } catch (permError) {
      console.error(`[PDF] Permission check failed: ${permError.message}`);
      return { success: false, error: `Permission denied: ${permError.message}` };
    }

    try {
      console.log(`[PDF] Starting PDF generation for PO: ${poId}`);
      
      // Check config (warnings only - we have fallbacks)
      const folderId = PO_CONFIG.FOLDER_ID;
      const logoId = PO_CONFIG.LOGO_ID;
      const signId = PO_CONFIG.SIGN_ID;

      console.log(`[PDF] Config check - Folder: ${folderId ? 'OK' : 'MISSING (will use fallback)'}, Logo: ${logoId ? 'OK' : 'MISSING (will use placeholder)'}, Sign: ${signId ? 'OK' : 'MISSING (will use placeholder)'}`);

      if (!folderId) {
        console.warn(`[PDF] PO_FOLDER_ID not configured - will use spreadsheet parent folder`);
      }
      if (!logoId) {
        console.warn(`[PDF] PO_LOGO_ID not configured - logo will be missing from PDF`);
      }
      if (!signId) {
        console.warn(`[PDF] PO_SIGN_ID not configured - signature will be missing from PDF`);
      }

      // --- STEP 1: Fetch PO Data ---
      const ss = getSpreadsheet();
      const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
      if (!sheet) {
        return { success: false, error: "Database error: Purchase Order sheet not found. Contact admin." };
      }
      
      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const idxId = headers.indexOf('PO ID');

      let poRow = null;
      let rowIndex = -1;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][idxId]) === String(poId)) {
          poRow = data[i];
          rowIndex = i + 1;
          break;
        }
      }
      if (!poRow) {
        return { success: false, error: `PO not found: "${poId}" does not exist in the database.` };
      }

      // --- STEP 2: Fetch Supplier Details ---
      const supSheet = ss.getSheetByName(DB_CONFIG.SHEET_SUPPLIERS);
      const supData = supSheet.getDataRange().getValues();
      const supHeaders = supData[0];
      const supplierName = poRow[headers.indexOf('Supplier')];
      let supDetails = {};

      for (let i = 1; i < supData.length; i++) {
        if (String(supData[i][0]).trim().toLowerCase() === String(supplierName).trim().toLowerCase()) {
          supDetails.contact = supData[i][supHeaders.indexOf('Contact Person')] || '';
          supDetails.addr = supData[i][supHeaders.indexOf('Address')] || '';
          supDetails.phone = supData[i][supHeaders.indexOf('Phone')] || '';
          supDetails.brn = supData[i][supHeaders.indexOf('BRN')] || '';
          supDetails.bank = supData[i][supHeaders.indexOf('Bank Name')] || '';
          supDetails.acc = supData[i][supHeaders.indexOf('Account No')] || '';
          break;
        }
      }

      // --- STEP 3: Parse Items ---
      let items = [];
      try { items = JSON.parse(poRow[headers.indexOf('PO_Data_JSON')]); } catch (e) { }

      const grid = items.map((item, idx) => ({
        no: idx + 1,
        desc: item.n,
        qty: item.q,
        cost: Number(item.c).toFixed(2),
        total: Number(item.t).toFixed(2)
      }));

      const TARGET_ROWS = 15;
      while (grid.length < TARGET_ROWS) {
        grid.push({ no: '', desc: '', qty: '', cost: '', total: '' });
      }

      const layout = {
        isTight: true,
        pageMargin: '0.4in',
        headerMargin: '10px',
        fontSize: '9pt',
        tdPadding: '3px',
        tdHeight: '20px'
      };

      // --- STEP 4: Get Images with error handling ---
      const getBase64Str = (id) => {
        try {
          console.log(`[PDF] Getting base64 for file: ${id}`);
          const blob = DriveApp.getFileById(id).getBlob();
          const base64 = Utilities.base64Encode(blob.getBytes());
          console.log(`[PDF] Successfully got base64 for ${id}, length: ${base64.length}`);
          return base64;
        } catch (e) {
          console.error(`[PDF] Failed to get file ${id}: ${e.message}`);
          return "";
        }
      };

      const getImgTag = (id) => {
        try {
          console.log(`[PDF] Getting image tag for file: ${id}`);
          const blob = DriveApp.getFileById(id).getBlob();
          const imgTag = `<img src="data:${blob.getContentType()};base64,${Utilities.base64Encode(blob.getBytes())}" style="max-height:80px; max-width:200px;" />`;
          console.log(`[PDF] Successfully created image tag for ${id}`);
          return imgTag;
        } catch (e) {
          console.error(`[PDF] Failed to get image ${id}: ${e.message}`);
          return "";
        }
      };

      console.log(`[PDF] Creating images object...`);
      const images = {
        logo: getImgTag(logoId),
        signData: getBase64Str(signId)
      };
      console.log(`[PDF] Images object created - Logo: ${images.logo ? 'OK' : 'EMPTY'}, Sign: ${images.signData ? 'OK' : 'EMPTY'}`);

      // Strict Date for PDF
      let rawDate = poRow[headers.indexOf('Date')];
      if (!(rawDate instanceof Date)) rawDate = new Date();

      const templateData = {
        poId: poId,
        displayDate: rawDate.toISOString().split('T')[0],
        department: poRow[headers.indexOf('Dept')],
        paymentTerms: poRow[headers.indexOf('Terms')],
        supplierName: supplierName,
        supplierContact: supDetails.contact,
        supplierAddress: supDetails.addr,
        supplierPhone: supDetails.phone,
        supplierBRN: supDetails.brn,
        supplierBank: supDetails.bank,
        supplierAcc: supDetails.acc,
        totalAmount: Number(poRow[headers.indexOf('Total')]).toFixed(2),
        todaySignature: new Date().toLocaleDateString()
      };

      // --- STEP 5: Create and evaluate template ---
      console.log(`[PDF] Creating template from Template_PO...`);
      let template;
      try {
        template = HtmlService.createTemplateFromFile('Template_PO');
        console.log(`[PDF] Template created successfully`);
      } catch (templateError) {
        console.error(`[PDF] Failed to create template: ${templateError.message}`);
        return { success: false, error: `Template error: Could not load PDF template. Contact admin.` };
      }
      
      template.layout = layout;
      template.images = images;
      template.data = templateData;
      template.myInfo = PO_CONFIG.COMPANY_INFO;
      template.grid = grid;

      console.log(`[PDF] Evaluating template...`);
      let evaluated;
      try {
        evaluated = template.evaluate();
        console.log(`[PDF] Template evaluated successfully`);
      } catch (evalError) {
        console.error(`[PDF] Failed to evaluate template: ${evalError.message}`);
        console.error(`[PDF] Eval error stack: ${evalError.stack}`);
        return { success: false, error: `Template error: Failed to generate PDF content. Contact admin.` };
      }
      
      // --- STEP 6: Convert to PDF blob ---
      console.log(`[PDF] Converting to PDF...`);
      let blob;
      try {
        blob = evaluated.getBlob().getAs(MimeType.PDF).setName(`${poId}.pdf`);
        console.log(`[PDF] PDF blob created successfully, size: ${blob.getBytes().length} bytes`);
      } catch (pdfError) {
        console.error(`[PDF] Failed to convert to PDF: ${pdfError.message}`);
        console.error(`[PDF] PDF error stack: ${pdfError.stack}`);
        return { success: false, error: `PDF error: Failed to convert to PDF format. Contact admin.` };
      }

      // --- STEP 7: Get target folder with fallback ---
      console.log(`[PDF] Getting folder: ${folderId}`);
      let folder = null;
      let folderUsed = 'configured';
      
      if (folderId) {
        try {
          folder = DriveApp.getFolderById(folderId);
        } catch (e) {
          console.warn(`[PDF] PO_FOLDER_ID not accessible: ${e.message}`);
          folder = null;
        }
      }
      
      if (!folder) {
        try {
          const ssFile = DriveApp.getFileById(ss.getId());
          folder = ssFile.getParents().next();
          folderUsed = 'spreadsheet parent';
        } catch (e) {
          folder = DriveApp.getRootFolder();
          folderUsed = 'root';
        }
      }
      console.log(`[PDF] Using ${folderUsed} folder`);

      // --- STEP 8: Delete existing files with graceful error handling ---
      try {
        const existingFiles = folder.getFilesByName(`${poId}.pdf`);
        while (existingFiles.hasNext()) {
          const oldFile = existingFiles.next();
          try {
            oldFile.setTrashed(true);
            console.log(`[PDF] Trashed existing file: ${oldFile.getName()}`);
          } catch (trashError) {
            console.warn(`[PDF] Could not trash old file (will use timestamp suffix): ${trashError.message}`);
            // Fallback: append timestamp to avoid name conflict
            poId = `${poId}_${new Date().getTime()}`;
            blob.setName(`${poId}.pdf`);
          }
        }
      } catch (listError) {
        // Graceful degradation: can't list files, but can still create
        console.warn(`[PDF] Could not list files in folder (skipping duplicate check): ${listError.message}`);
        // Fallback: use timestamp to avoid name conflict
        poId = `${poId}_${new Date().getTime()}`;
        blob.setName(`${poId}.pdf`);
      }

      // --- STEP 9: Create file with folder fallback ---
      console.log(`[PDF] Creating file in folder...`);
      let file;
      try {
        file = folder.createFile(blob);
        console.log(`[PDF] File created: ${file.getName()}`);
      } catch (createError) {
        console.warn(`[PDF] Failed to create in ${folderUsed} folder: ${createError.message}`);
        console.log(`[PDF] Trying spreadsheet parent folder as fallback...`);
        
        // Fallback to spreadsheet parent folder
        try {
          const ssFile = DriveApp.getFileById(ss.getId());
          const fallbackFolder = ssFile.getParents().next();
          file = fallbackFolder.createFile(blob);
          folderUsed = 'spreadsheet parent (fallback)';
          console.log(`[PDF] File created in fallback folder: ${file.getName()}`);
        } catch (fallbackError) {
          console.error(`[PDF] Fallback also failed: ${fallbackError.message}`);
          return { 
            success: false, 
            error: `Storage error: Cannot save PDF to Drive. Your account may lack write permission to the PO folder. Please contact admin to grant Editor access to the PO folder.` 
          };
        }
      }
      
      // --- STEP 10: Set sharing (graceful) ---
      try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        console.log(`[PDF] Sharing set to ANYONE_WITH_LINK`);
      } catch (shareError) {
        console.warn(`[PDF] Could not set sharing (may be restricted by Workspace): ${shareError.message}`);
      }
      
      console.log(`[PDF] File created successfully: ${file.getUrl()}`);

      const urlColIdx = headers.indexOf('Signed URL');
      if (urlColIdx > -1) sheet.getRange(rowIndex, urlColIdx + 1).setValue(file.getUrl());

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[PDF] PDF generation completed successfully for ${poId} (${elapsed}s)`);
      return {
        success: true,
        url: file.getUrl(),
        base64: Utilities.base64Encode(blob.getBytes())
      };

    } catch (e) {
      console.error(`[PDF] Error generating PDF for ${poId}: ${e.message}`);
      console.error(`[PDF] Stack trace: ${e.stack}`);
      
      // Provide user-friendly error messages based on common failure patterns
      let userMessage = e.message;
      if (e.message.includes('Access denied') || e.message.includes('Forbidden')) {
        userMessage = `Google Drive permission error. Your account "${Session.getActiveUser().getEmail()}" may lack permission to access the PO folder (${folderId || 'configured folder'}). Please ask admin to ensure this folder is shared with Editor access.`;
      }
      
      return { success: false, error: userMessage };
    }
  }

/**
 * UTILITY: Master Doc Sync
 * Scans folder for PO IDs and matches them to Signed URL, Inv URL, or Quot URL.
 * Uses Sheet PO IDs as Source of Truth.
 */
function apiSyncAllDocuments() {
  assertPermission(['ADMIN']);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);
    const folderId = PO_CONFIG.FOLDER_ID;
    const folder = DriveApp.getFolderById(folderId);
    const files = folder.getFilesByType(MimeType.PDF);

    const ss = getSpreadsheet();
    const poSheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
    if (!poSheet) throw new Error("PO Sheet not found.");

    const poData = poSheet.getDataRange().getValues();
    const poHeaders = poData[0];
    const idxId = poHeaders.indexOf('PO ID');
    const idxSigned = poHeaders.indexOf('Signed URL');
    const idxInv = poHeaders.indexOf('Inv URL');
    const idxQuot = poHeaders.indexOf('Quot URL');
    const idxPmt = poHeaders.indexOf('Pmt URL');

    if (idxId === -1) throw new Error("PO ID column missing.");

    // 1. Index Drive Files
    const driveFiles = [];
    while (files.hasNext()) {
      const f = files.next();
      let rawName = f.getName().toUpperCase();
      // Remove extension for matching purposes to avoid false boundary matches
      rawName = rawName.replace(/\.PDF$/, '');

      driveFiles.push({
        name: rawName,
        url: f.getUrl()
      });
    }

    // 2. Pre-index Procurement Sheets to avoid reading them in a loop
    // Store actual data array so we can batch write later
    const procSheetsData = new Map(); // sheetName -> { sheet, data, pIdxPo, pIdxUrl }
    const procurementIndex = new Map(); // PO ID -> [{sheetName, rowIndex, colIndex, currentUrl}]
    
    const procSheets = ss.getSheets().filter(s => s.getName().startsWith("Procurement "));

    procSheets.forEach(pSheet => {
      const pData = pSheet.getDataRange().getValues();
      const pHeaders = pData[0];
      const pIdxPo = pHeaders.indexOf('PO No');
      const pIdxUrl = pHeaders.indexOf('Doc URL');

      if (pIdxPo > -1 && pIdxUrl > -1) {
        procSheetsData.set(pSheet.getName(), {
          sheet: pSheet,
          data: pData,
          pIdxPo: pIdxPo,
          pIdxUrl: pIdxUrl
        });

        for (let j = 1; j < pData.length; j++) {
          const pPoId = String(pData[j][pIdxPo]).trim().toUpperCase();
          if (pPoId) {
            if (!procurementIndex.has(pPoId)) procurementIndex.set(pPoId, []);
            procurementIndex.get(pPoId).push({ 
              sheetName: pSheet.getName(), 
              rowIndex: j, 
              colIndex: pIdxUrl, 
              currentUrl: pData[j][pIdxUrl] 
            });
          }
        }
      }
    });

    let stats = { signed: 0, inv: 0, quot: 0, pmt: 0, proc: 0 };
    const missingDocs = [];
    let poSheetModified = false;
    const modifiedProcSheets = new Set();

    // Helper to escape regex specials in PO ID
    const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 3. Process each PO record
    for (let i = 1; i < poData.length; i++) {
      const poId = String(poData[i][idxId]).trim();
      if (!poId) continue;

      const poIdUpper = poId.toUpperCase();
      const escapedPoId = escapeRegExp(poIdUpper);

      // Find all files that contain this PO ID surrounded by boundaries
      // e.g. (^|[^A-Z0-9])PO-2026-001($|[^A-Z0-9])
      const poIdRegex = new RegExp('(^|[^A-Z0-9])' + escapedPoId + '($|[^A-Z0-9])');
      const matches = driveFiles.filter(f => poIdRegex.test(f.name));

      if (matches.length === 0) {
        missingDocs.push(poId);
        continue;
      }

      matches.forEach(file => {
        // Determine Type by Priority (most specific first)
        let type = 'SIGNED';
        const fileNameUpper = file.name;
        if (fileNameUpper.includes('_PAYMENT_RECEIPT') || fileNameUpper.includes('PAYMENT_RECEIPT_') || fileNameUpper.includes('_PMT')) type = 'PMT';
        else if (fileNameUpper.includes('_INVOICE') || fileNameUpper.includes('INVOICE_') || fileNameUpper.startsWith('INV_')) type = 'INV';
        else if (fileNameUpper.includes('_QUOTATION') || fileNameUpper.includes('QUOTATION_') || fileNameUpper.includes('_QUOT')) type = 'QUOT';

        // A. Update PurchaseOrder Sheet Data Array
        if (type === 'INV' && idxInv > -1) {
          const currentInvUrl = poData[i][idxInv];
          if (!currentInvUrl || currentInvUrl !== file.url) {
            poData[i][idxInv] = file.url;
            poSheetModified = true;
            stats.inv++;
          }
        } else if (type === 'QUOT' && idxQuot > -1) {
          const currentQuotUrl = poData[i][idxQuot];
          if (!currentQuotUrl || currentQuotUrl !== file.url) {
            poData[i][idxQuot] = file.url;
            poSheetModified = true;
            stats.quot++;
          }
        } else if (type === 'SIGNED' && idxSigned > -1) {
          const currentSignedUrl = poData[i][idxSigned];
          if (!currentSignedUrl || currentSignedUrl !== file.url) {
            poData[i][idxSigned] = file.url;
            poSheetModified = true;
            stats.signed++;
          }
        } else if (type === 'PMT' && idxPmt > -1) {
          const currentPmtUrl = poData[i][idxPmt];
          if (!currentPmtUrl || currentPmtUrl !== file.url) {
            poData[i][idxPmt] = file.url;
            poSheetModified = true;
            stats.pmt++;
          }
        }

        // B. Update Procurement Sheets Data Arrays
        if (type === 'INV' && procurementIndex.has(poIdUpper)) {
          const targets = procurementIndex.get(poIdUpper);
          targets.forEach(t => {
            if (!t.currentUrl || t.currentUrl !== file.url) {
              const sheetDataObj = procSheetsData.get(t.sheetName);
              if (sheetDataObj) {
                sheetDataObj.data[t.rowIndex][t.colIndex] = file.url;
                t.currentUrl = file.url;
                modifiedProcSheets.add(t.sheetName);
                stats.proc++;
              }
            }
          });
        }
      });
    }

    // 4. Batch Write Updates
    if (poSheetModified) {
      poSheet.getRange(1, 1, poData.length, poData[0].length).setValues(poData);
    }

    modifiedProcSheets.forEach(sheetName => {
      const pInfo = procSheetsData.get(sheetName);
      if (pInfo && pInfo.sheet && pInfo.data) {
        pInfo.sheet.getRange(1, 1, pInfo.data.length, pInfo.data[0].length).setValues(pInfo.data);
      }
    });

    const missingLog = missingDocs.length > 0 ? `\nNo files found for: ${missingDocs.slice(0, 5).join(', ')}...` : "";

    return {
      success: true,
      message: `Sync Complete.\n- Signed POs: ${stats.signed}\n- Invoices: ${stats.inv}\n- Quotations: ${stats.quot}\n- Proc. Items: ${stats.proc}${missingLog}`
    };

  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// Keep for compatibility but redirect to master sync
function apiSyncSignedPoUrls() {
  return apiSyncAllDocuments();
}

// --- UPLOAD PO ATTACHMENT ---
function apiUploadPoAttachment(poId, fileType, base64Data, mimeType, fileName) {
  assertPermission(['EDITOR', 'ADMIN']);
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idxId = headers.indexOf('PO ID');
    
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
        if (String(data[i][idxId]) === String(poId)) {
            rowIndex = i + 1;
            break;
        }
    }
    if (rowIndex === -1) throw new Error("PO ID not found");

    // Get folder with fallback
    const folderId = PO_CONFIG.FOLDER_ID;
    let folder = null;
    let folderUsed = 'configured';
    
    if (folderId) {
      try {
        folder = DriveApp.getFolderById(folderId);
        console.log(`[PO-UPLOAD] Using configured folder: ${folderId}`);
      } catch (e) {
        console.warn(`[PO-UPLOAD] PO_FOLDER_ID (${folderId}) not accessible: ${e.message}`);
        folder = null;
      }
    }
    
    // Fallback to spreadsheet's parent folder
    if (!folder) {
      try {
        const ssFile = DriveApp.getFileById(ss.getId());
        folder = ssFile.getParents().next();
        folderUsed = 'spreadsheet parent';
        console.log(`[PO-UPLOAD] Using spreadsheet parent folder: ${folder.getName()}`);
      } catch (e) {
        console.warn(`[PO-UPLOAD] Could not get spreadsheet parent: ${e.message}`);
        folder = DriveApp.getRootFolder();
        folderUsed = 'root';
      }
    }

    // Remove existing file with same name
    console.log(`[PO-UPLOAD] Checking for existing files named: ${fileName}`);
    const existing = folder.getFilesByName(fileName);
    while (existing.hasNext()) {
      const oldFile = existing.next();
      try {
        oldFile.setTrashed(true);
        console.log(`[PO-UPLOAD] Deleted existing file: ${oldFile.getName()}`);
      } catch (e) {
        console.warn(`[PO-UPLOAD] Could not trash existing file: ${e.message}`);
      }
    }

    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName);
    const file = folder.createFile(blob);
    
    // Try to set sharing, but don't fail if blocked
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      console.log(`[PO-UPLOAD] Sharing set to ANYONE_WITH_LINK`);
    } catch (shareError) {
      console.warn(`[PO-UPLOAD] Could not set sharing (may be restricted): ${shareError.message}`);
    }
    
    console.log(`[PO-UPLOAD] File uploaded to ${folderUsed} folder: ${file.getUrl()}`);

    // Determine target column based on file type
    let targetHeader;
    if (fileType === 'PO') {
      targetHeader = 'Signed URL';
    } else if (fileType === 'INV') {
      targetHeader = 'Inv URL';
    } else if (fileType === 'PMT') {
      targetHeader = 'Pmt URL';
    } else if (fileType === 'HIST') {
      targetHeader = 'Item History URL';
    }

    const urlColIdx = headers.indexOf(targetHeader);
    if (urlColIdx > -1) {
        sheet.getRange(rowIndex, urlColIdx + 1).setValue(file.getUrl());
    }

    // Auto-status updates based on file type
    if (fileType === 'PO') {
      const statusColIdx = headers.indexOf('Status');
      if (statusColIdx > -1) {
        sheet.getRange(rowIndex, statusColIdx + 1).setValue('Approved');
        console.log(`[PO-UPLOAD] Auto-approved status for ${poId}`);
      }
    }

    // If uploading a Payment Receipt, auto-set status to 'Paid'
    if (fileType === 'PMT') {
      const statusColIdx = headers.indexOf('Status');
      if (statusColIdx > -1) {
        sheet.getRange(rowIndex, statusColIdx + 1).setValue('Paid');
        console.log(`[PO-UPLOAD] Auto-set status to Paid for ${poId}`);
      }
    }

    CacheService.getScriptCache().remove('PO_HISTORY');
    
    return {
        success: true,
        url: file.getUrl(),
        message: "File uploaded successfully."
    };
  } catch (e) {
    console.error(`[PO-UPLOAD] Error: ${e.message}`);
    return { success: false, error: e.message };
  }
}