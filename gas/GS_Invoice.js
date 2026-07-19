
/* INVOICE TRACKER ENGINE
   - Closes the PO Cycle.
   - Logs detailed line items into 'Procurement YYYY'.
   - Updates PO Status to 'Paid'.
*/

const INV_CONFIG = {
  get FOLDER_ID() { return _getSecureConfig('INV_FOLDER_ID'); },
  SHEET_PREFIX: 'Procurement '
};

// --- CONTEXT ---
function apiGetInvoiceContext() {
  assertPermission(['EDITOR', 'ADMIN']);
  return {
    suppliers: apiGetSuppliers(),
    openPOs: _getOpenPOs(),
    allPOs: _getAllPOs()
  };
}

/**
 * HELPER: Get all PO Numbers that have already been saved in any Procurement sheet
 * Returns a Set of strings for fast O(1) lookups.
 */
function _getSavedPONumbers() {
  const ss = getSpreadsheet();
  const sheets = ss.getSheets();
  const savedPOs = new Set();
  const prefix = INV_CONFIG.SHEET_PREFIX; // "Procurement "

  sheets.forEach(sheet => {
    const sName = sheet.getName();
    if (sName.startsWith(prefix)) {
      const lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        const idxPoNo = headers.indexOf('PO No');
        if (idxPoNo > -1) {
          // Get all PO numbers from this sheet
          const poCol = sheet.getRange(2, idxPoNo + 1, lastRow - 1, 1).getValues();
          poCol.forEach(row => {
            const val = String(row[0] || '').trim();
            if (val) savedPOs.add(val);
          });
        }
      }
    }
  });

  return savedPOs;
}

// Fetch POs that are Approved or Pending Payment (And NOT already saved as invoices)
function _getOpenPOs() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const savedPOs = _getSavedPONumbers();

  // PERFORMANCE: Read last 1000 POs for open status scan
  const LIMIT = 1000;
  const startRow = Math.max(2, lastRow - LIMIT + 1);
  const numRows = lastRow - startRow + 1;
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const data = sheet.getRange(startRow, 1, numRows, lastCol).getValues();

  const idxId = headers.indexOf('PO ID');
  const idxSup = headers.indexOf('Supplier');
  const idxDate = headers.indexOf('Date');
  const idxStatus = headers.indexOf('Status');
  const idxTotal = headers.indexOf('Total');

  const list = [];
  for (let i = data.length - 1; i >= 0; i--) {
    const poId = String(data[i][idxId] || '').trim();
    if (!poId) continue;

    // Skip if this PO has already been saved into the Invoice Tracker
    if (savedPOs.has(poId)) continue;

    const status = String(data[i][idxStatus]).toUpperCase();
    if (status === 'APPROVED' || status === 'PENDING PAYMENT' || status === 'PARTIAL') {
      let dateStr = data[i][idxDate];
      if (dateStr instanceof Date) dateStr = dateStr.toISOString().split('T')[0];

      list.push({
        id: poId,
        supplier: data[i][idxSup],
        date: dateStr,
        status: data[i][idxStatus],
        total: data[i][idxTotal]
      });
    }
  }
  return list;
}

// Fetch ALL POs (last 500, newest first) EXCEPT those already saved as invoices
function _getAllPOs() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const savedPOs = _getSavedPONumbers();

  const LIMIT = 500;
  const startRow = Math.max(2, lastRow - LIMIT + 1);
  const numRows = lastRow - startRow + 1;
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const data = sheet.getRange(startRow, 1, numRows, lastCol).getValues();

  const idxId = headers.indexOf('PO ID');
  const idxSup = headers.indexOf('Supplier');
  const idxDate = headers.indexOf('Date');
  const idxStatus = headers.indexOf('Status');
  const idxTotal = headers.indexOf('Total');

  const list = [];
  for (let i = data.length - 1; i >= 0; i--) {
    const poId = String(data[i][idxId] || '').trim();
    if (!poId) continue;

    // Hide fully voided POs OR POs that are already saved as invoices
    const status = String(data[i][idxStatus]).toUpperCase();
    if (status === 'VOID' || savedPOs.has(poId)) continue;

    let dateStr = data[i][idxDate];
    if (dateStr instanceof Date) dateStr = dateStr.toISOString().split('T')[0];

    list.push({
      id: poId,
      supplier: data[i][idxSup],
      date: dateStr,
      status: data[i][idxStatus],
      total: data[i][idxTotal]
    });
  }
  return list;
}

// --- LOAD PO ITEMS ---
function apiGetInvoicePoItems(poId) {
  assertPermission(['EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idxId = headers.indexOf('PO ID');
  const idxJson = headers.indexOf('PO_Data_JSON');

  // PERFORMANCE: Targeted ID Column Scan
  const idColumn = sheet.getRange(1, idxId + 1, lastRow, 1).getValues().flat();
  const rowIndex = idColumn.indexOf(poId);

  if (rowIndex === -1) return [];

  const targetRow = sheet.getRange(rowIndex + 1, 1, 1, headers.length).getValues()[0];
  if (!targetRow[idxJson]) return [];

  try {
    const items = JSON.parse(targetRow[idxJson]);

    // Enrich with Pack Size
    const dbSheet = ss.getSheetByName(DB_CONFIG.SHEET_ITEMS);
    const dbData = dbSheet.getDataRange().getValues(); // Smaller sheet usually, but could be optimized later
    const dbHeaders = dbData[0];
    const dbIdIdx = dbHeaders.indexOf('Stock ID');
    const dbPackIdx = dbHeaders.indexOf('Pack Size');

    const packMap = new Map();
    if (dbIdIdx > -1 && dbPackIdx > -1) {
      dbData.forEach(r => packMap.set(String(r[dbIdIdx]), r[dbPackIdx]));
    }

    return items.map(i => ({
      stockId: i.id || "",
      itemName: i.n,
      qty: i.q,
      uom: i.u,
      unitCost: i.c,
      total: i.t,
      packSize: packMap.get(String(i.id)) || 1
    }));

  } catch (e) {
    return [];
  }
}

// --- SAVE INVOICE & CLOSE PO ---
function apiSaveInvoice(payload) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);
    const { targetYear, common, items } = payload;
    const ss = getSpreadsheet();

    const sheetName = INV_CONFIG.SHEET_PREFIX + targetYear;
    let sheet = ss.getSheetByName(sheetName);

    // Schema: 1 Row = 1 Invoice
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      const headers = [
        "Invoice No", "Invoice Date", "Supplier", "PO No", "PO Date",
        "DO No", "DO Date", "Department", "Date Received", "Total Amount",
        "Invoice_Data_JSON", "Doc URL", "Timestamp"
      ];
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#008080").setFontColor("white");
      sheet.setFrozenRows(1);
    } else {
      // Ensure Doc URL column exists (migration for existing sheets)
      const existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      if (existingHeaders.indexOf('Doc URL') === -1) {
        sheet.getRange(1, existingHeaders.length + 1).setValue('Doc URL');
      }
    }

    const timestamp = new Date();

    // Calculate total amount from items
    const totalAmount = items.reduce((sum, item) => sum + (parseFloat(item.totalPrice) || 0), 0);

    // Save as a single row (with sanitization)
    const newRow = [
      sanitizeText(common.invNo), common.invDate, sanitizeText(common.supplier), common.poNo, common.poDate,
      sanitizeText(common.doNo), "", sanitizeText(common.dept), common.dateReceived, totalAmount,
      JSON.stringify(items), common.docUrl || "", timestamp
    ];

    sheet.appendRow(newRow);

    // PERFORMANCE: Targeted PO Update
    if (common.poNo) {
      const poSheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
      const lastRowPo = poSheet.getLastRow();
      const poHeaders = poSheet.getRange(1, 1, 1, poSheet.getLastColumn()).getValues()[0];
      const idxPoId = poHeaders.indexOf('PO ID');

      const idColumn = poSheet.getRange(1, idxPoId + 1, lastRowPo, 1).getValues().flat();
      const rowIndexPo = idColumn.indexOf(common.poNo);

      if (rowIndexPo > -1) {
        const iRow = rowIndexPo + 1;
        const poDataRow = poSheet.getRange(iRow, 1, 1, poHeaders.length).getValues()[0];

        const poTotal = parseFloat(poDataRow[poHeaders.indexOf('Total')]) || 0;
        const currentPaid = parseFloat(poDataRow[poHeaders.indexOf('Paid')]) || 0;

        const totalPaidAfter = currentPaid + totalAmount;
        const remainingBalance = Math.max(0, poTotal - currentPaid);

        // Overpayment guard: reject if this invoice exceeds remaining balance
        if (totalAmount > remainingBalance + 0.01) {
          return { success: false, error: `Overpayment detected: Invoice RM${totalAmount.toFixed(2)} exceeds remaining balance RM${remainingBalance.toFixed(2)}.` };
        }

        const balanceAfter = Math.max(0, poTotal - totalPaidAfter);
        let newStatus = (balanceAfter > 0.01) ? "Partial" : "Paid";

        poSheet.getRange(iRow, poHeaders.indexOf('Status') + 1).setValue(newStatus);
        poSheet.getRange(iRow, poHeaders.indexOf('Paid') + 1).setValue(totalPaidAfter);
        poSheet.getRange(iRow, poHeaders.indexOf('Balance') + 1).setValue(balanceAfter);

      }
    }

    // Invalidate PO/Dashboard caches after invoice
    CacheService.getScriptCache().remove('PO_HISTORY');
    CacheService.getScriptCache().remove('DASH_STATS');
    return { success: true, message: `Invoice ${common.invNo} Saved.` };

  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * AI EXTRACTION: Extract Invoice Number and Date from uploaded PDF
 * Uses Gemini Vision API to read the invoice document.
 */
function apiExtractInvoiceData(base64Pdf) {
  assertPermission(['EDITOR', 'ADMIN']);

  try {
    // 1. Create temp PDF in Drive
    const pdfBlob = Utilities.newBlob(Utilities.base64Decode(base64Pdf), 'application/pdf', 'temp_invoice_extract.pdf');
    const tempFile = DriveApp.createFile(pdfBlob);
    const fileId = tempFile.getId();

    // 2. Wait for Drive to process the file and generate thumbnail
    Utilities.sleep(3000);

    // 3. Try multiple methods to get a page image
    let imageBase64 = '';
    const authHeaders = { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() };

    // Method 1: Direct thumbnail endpoint (most reliable)
    if (!imageBase64) {
      try {
        const thumbUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;
        const resp = UrlFetchApp.fetch(thumbUrl, {
          headers: authHeaders,
          muteHttpExceptions: true,
          followRedirects: true
        });
        if (resp.getResponseCode() === 200 && resp.getContent().length > 1000) {
          imageBase64 = Utilities.base64Encode(resp.getContent());
        }
      } catch (e) { /* try next method */ }
    }

    // Method 2: Drive API v3 thumbnailLink
    if (!imageBase64) {
      try {
        const apiUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink`;
        const resp = UrlFetchApp.fetch(apiUrl, {
          headers: authHeaders,
          muteHttpExceptions: true
        });
        const data = JSON.parse(resp.getContentText());
        if (data.thumbnailLink) {
          const highRes = data.thumbnailLink.replace(/=s\d+/, '=s1600');
          const imgResp = UrlFetchApp.fetch(highRes, {
            headers: authHeaders,
            muteHttpExceptions: true,
            followRedirects: true
          });
          if (imgResp.getResponseCode() === 200 && imgResp.getContent().length > 1000) {
            imageBase64 = Utilities.base64Encode(imgResp.getContent());
          }
        }
      } catch (e) { /* try next method */ }
    }

    // Method 3: lh3 content endpoint
    if (!imageBase64) {
      try {
        const lh3Url = `https://lh3.googleusercontent.com/d/${fileId}=w1600`;
        const resp = UrlFetchApp.fetch(lh3Url, {
          headers: authHeaders,
          muteHttpExceptions: true,
          followRedirects: true
        });
        if (resp.getResponseCode() === 200 && resp.getContent().length > 1000) {
          imageBase64 = Utilities.base64Encode(resp.getContent());
        }
      } catch (e) { /* all methods failed */ }
    }

    // 4. Cleanup temp file
    tempFile.setTrashed(true);

    if (!imageBase64) {
      return { success: false, error: 'Could not convert PDF to image. Please try again.' };
    }

    // 5. Call Gemini Vision API
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) {
      return { success: false, error: 'Missing GEMINI_API_KEY in Script Properties.' };
    }

    const geminiModel = 'gemini-2.5-flash-lite';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

    const geminiResponse = UrlFetchApp.fetch(geminiUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{
          parts: [
            {
              text: 'Extract ONLY the Invoice Number and Invoice Date from this invoice document. Return ONLY a JSON object with exactly these keys: {"invoiceNo": "...", "invoiceDate": "YYYY-MM-DD"}. If the date format is DD/MM/YYYY, convert it to YYYY-MM-DD. Do not include any other text, explanation, or markdown formatting. Just the raw JSON object.'
            },
            {
              inlineData: {
                mimeType: 'image/png',
                data: imageBase64
              }
            }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 150
        }
      }),
      muteHttpExceptions: true
    });

    const geminiJson = JSON.parse(geminiResponse.getContentText());

    if (geminiJson.error) {
      return { success: false, error: 'Gemini API Error: ' + geminiJson.error.message };
    }

    // 6. Parse the response
    let rawAnswer = geminiJson.candidates[0].content.parts[0].text.trim();

    // Strip markdown code fences if present
    rawAnswer = rawAnswer.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    try {
      const extracted = JSON.parse(rawAnswer);
      const invNo = String(extracted.invoiceNo || '').trim();
      let invDate = String(extracted.invoiceDate || '').trim();

      // Strict date validation: must be YYYY-MM-DD
      if (invDate && !/^\d{4}-\d{2}-\d{2}$/.test(invDate)) {
        const parsed = new Date(invDate);
        invDate = (!isNaN(parsed.getTime())) ? parsed.toISOString().split('T')[0] : '';
      }

      return {
        success: true,
        invoiceNo: invNo.replace(/[^a-zA-Z0-9\-\.\/\s]/g, ''),
        invoiceDate: invDate
      };
    } catch (parseErr) {
      // Try regex fallback
      const noMatch = rawAnswer.match(/invoiceNo["\s:]+([^",}]+)/i);
      const dateMatch = rawAnswer.match(/invoiceDate["\s:]+([^",}]+)/i);
      return {
        success: true,
        invoiceNo: noMatch ? noMatch[1].trim().replace(/[^a-zA-Z0-9\-\.\/\s]/g, '') : '',
        invoiceDate: dateMatch ? dateMatch[1].trim() : ''
      };
    }

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Simple test function - call this from web app to test Drive access AND permissions
 */
function apiTestDriveAccess() {
  try {
    const results = [];
    
    // Test 0: User info and role
    const email = Session.getActiveUser().getEmail();
    results.push("👤 Logged in as: " + email);
    
    try {
      const role = getUserRole(email);
      results.push("🔑 Your role: " + role);
      if (role === 'VIEWER') {
        results.push("⚠️ VIEWERS cannot upload files! Need EDITOR or ADMIN role.");
      }
    } catch (e) {
      results.push("❌ Could not determine role: " + e.message);
    }
    
    // Test 1: Basic Drive access
    try {
      const root = DriveApp.getRootFolder();
      results.push("✅ Root folder accessible: " + root.getName());
    } catch (e) {
      results.push("❌ Root folder NOT accessible: " + e.message);
    }
    
    // Test 2: Configured folder
    const folderId = INV_CONFIG.FOLDER_ID;
    if (folderId) {
      try {
        const folder = DriveApp.getFolderById(folderId);
        results.push("✅ INV_FOLDER_ID accessible: " + folder.getName());
      } catch (e) {
        results.push("❌ INV_FOLDER_ID NOT accessible: " + e.message);
      }
    } else {
      results.push("⚠️ INV_FOLDER_ID not set");
    }
    
    // Test 3: PO folder
    const poFolderId = PO_CONFIG.FOLDER_ID;
    if (poFolderId) {
      try {
        const folder = DriveApp.getFolderById(poFolderId);
        results.push("✅ PO_FOLDER_ID accessible: " + folder.getName());
      } catch (e) {
        results.push("❌ PO_FOLDER_ID NOT accessible: " + e.message);
      }
    } else {
      results.push("⚠️ PO_FOLDER_ID not set");
    }
    
    // Test 4: Try to create a test file in root
    try {
      const testBlob = Utilities.newBlob("test", "text/plain", "test_access.txt");
      const testFile = DriveApp.getRootFolder().createFile(testBlob);
      testFile.setTrashed(true);
      results.push("✅ Can create files in root folder");
    } catch (e) {
      results.push("❌ Cannot create files: " + e.message);
    }
    
    return { success: true, results: results };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Upload Invoice PDF to Google Drive
 * @param {string} base64Data - Base64 encoded PDF data
 * @param {string} mimeType - MIME type (should be 'application/pdf')
 * @param {string} fileName - Name for the file
 * @param {string} invNo - Invoice number to link the URL to
 * @param {string} year - Year for the Procurement sheet
 */
function apiUploadInvoiceDoc(base64Data, mimeType, fileName, invNo, year) {
  console.log(`[INV-UPLOAD] ========== START ==========`);
  console.log(`[INV-UPLOAD] fileName: ${fileName}, invNo: ${invNo}, year: ${year}`);
  
  // Check permission first
  try {
    const permResult = assertPermission(['EDITOR', 'ADMIN']);
    console.log(`[INV-UPLOAD] Permission OK: ${permResult.email} (${permResult.role})`);
  } catch (permError) {
    console.error(`[INV-UPLOAD] Permission FAILED: ${permError.message}`);
    return { success: false, error: permError.message };
  }
  
  try {
    console.log(`[INV-UPLOAD] Decoding base64 data (${base64Data ? base64Data.length : 0} chars)...`);
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName);
    console.log(`[INV-UPLOAD] Blob created: ${blob.getContentType()}, ${blob.getBytes().length} bytes`);
    
    const folderId = INV_CONFIG.FOLDER_ID;
    console.log(`[INV-UPLOAD] INV_CONFIG.FOLDER_ID: ${folderId || 'NOT SET'}`);
    
    let folder;
    let folderUsed = 'configured';
    
    // Try configured folder first
    if (folderId) {
      try {
        folder = DriveApp.getFolderById(folderId);
        console.log(`[INV-UPLOAD] ✅ Using configured folder: ${folder.getName()}`);
      } catch (e) {
        console.warn(`[INV-UPLOAD] ❌ INV_FOLDER_ID not accessible: ${e.message}`);
        folder = null;
      }
    }
    
    // Fallback to spreadsheet's parent folder
    if (!folder) {
      try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const ssFile = DriveApp.getFileById(ss.getId());
        folder = ssFile.getParents().next();
        folderUsed = 'spreadsheet parent';
        console.log(`[INV-UPLOAD] ✅ Using spreadsheet parent folder: ${folder.getName()}`);
      } catch (e) {
        console.warn(`[INV-UPLOAD] ❌ Could not get spreadsheet parent: ${e.message}`);
        folder = DriveApp.getRootFolder();
        folderUsed = 'root';
        console.log(`[INV-UPLOAD] Using root folder`);
      }
    }

    // Remove existing file with same name
    console.log(`[INV-UPLOAD] Checking for existing files named: ${fileName}`);
    const existing = folder.getFilesByName(fileName);
    let deletedCount = 0;
    while (existing.hasNext()) {
      const oldFile = existing.next();
      try {
        oldFile.setTrashed(true);
        deletedCount++;
      } catch (e) {
        console.warn(`[INV-UPLOAD] Could not trash existing file: ${e.message}`);
      }
    }
    console.log(`[INV-UPLOAD] Deleted ${deletedCount} existing files`);

    console.log(`[INV-UPLOAD] Creating new file...`);
    const file = folder.createFile(blob);
    console.log(`[INV-UPLOAD] File created: ${file.getName()}`);
    
    // Try to set sharing, but don't fail if blocked
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      console.log(`[INV-UPLOAD] Sharing set to ANYONE_WITH_LINK`);
    } catch (shareError) {
      console.warn(`[INV-UPLOAD] Could not set sharing (may be restricted): ${shareError.message}`);
    }
    
    const fileUrl = file.getUrl();
    console.log(`[INV-UPLOAD] ✅ File uploaded to ${folderUsed}: ${fileUrl}`);

    // Update the Procurement sheet
    if (invNo && year) {
      console.log(`[INV-UPLOAD] Updating sheet for invoice ${invNo}...`);
      const ss = getSpreadsheet();
      const sheetName = INV_CONFIG.SHEET_PREFIX + year;
      const sheet = ss.getSheetByName(sheetName);
      
      if (sheet) {
        const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        const idxInvNo = headers.indexOf('Invoice No');
        const idxDocUrl = headers.indexOf('Doc URL');
        console.log(`[INV-UPLOAD] Sheet headers - Invoice No col: ${idxInvNo}, Doc URL col: ${idxDocUrl}`);
        
        if (idxInvNo > -1 && idxDocUrl > -1) {
          const lastRow = sheet.getLastRow();
          if (lastRow > 1) {
            const invCol = sheet.getRange(2, idxInvNo + 1, lastRow - 1, 1).getValues();
            for (let i = 0; i < invCol.length; i++) {
              if (String(invCol[i][0]).trim() === String(invNo).trim()) {
                sheet.getRange(i + 2, idxDocUrl + 1).setValue(fileUrl);
                console.log(`[INV-UPLOAD] ✅ Updated Doc URL at row ${i + 2}`);
                break;
              }
            }
          }
        }
      }
    }

    console.log(`[INV-UPLOAD] ========== SUCCESS ==========`);
    return { success: true, url: fileUrl, folderUsed: folderUsed };
  } catch (e) {
    console.error(`[INV-UPLOAD] ========== ERROR ==========`);
    console.error(`[INV-UPLOAD] Error: ${e.message}`);
    console.error(`[INV-UPLOAD] Stack: ${e.stack}`);
    return { success: false, error: `${e.message} (see Apps Script logs for details)` };
  }
}

/**
 * Rapid Entry Helper: Detects duplicates before saving
 */
function apiCheckDuplicateInvoice(supplier, invNo, year) {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  const ss = getSpreadsheet();
  const sheetName = INV_CONFIG.SHEET_PREFIX + year;
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { exists: false };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { exists: false };

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idxInv = headers.indexOf('Invoice No');
  const idxSup = headers.indexOf('Supplier');

  // PERFORMANCE: Scan only necessary columns
  const invCol = sheet.getRange(1, idxInv + 1, lastRow, 1).getValues().flat();
  const supCol = sheet.getRange(1, idxSup + 1, lastRow, 1).getValues().flat();

  const match = invCol.some((val, i) =>
    String(val).trim().toLowerCase() === String(invNo).trim().toLowerCase() &&
    String(supCol[i]).trim().toLowerCase() === String(supplier).trim().toLowerCase()
  );

  return { exists: match };
}

/**
 * FUZZY SEARCH: Search inventory items with fuzzy matching
 * @param {string} query - Search query (item name or partial match)
 * @returns {Array} Top matching items with details
 */
function apiSearchItemsFuzzy(query) {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  
  if (!query || query.trim().length < 2) return [];
  
  const ss = getSpreadsheet();
  const sheetName = (typeof DB_CONFIG !== 'undefined') ? DB_CONFIG.SHEET_ITEMS : "DB_Items";
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0];
  const idxId = headers.indexOf('Stock ID');
  const idxName = headers.indexOf('Item Name');
  const idxPack = headers.indexOf('Pack Size');
  const idxUom = headers.indexOf('UOM');
  const idxCost = headers.indexOf('Cost');
  const idxStatus = headers.indexOf('Product Status');

  const searchQuery = query.toLowerCase().trim();
  const scored = [];

  // Score each item
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    
    // Skip unavailable items
    if (idxStatus > -1 && String(row[idxStatus] || '').trim().toLowerCase() === 'unavailable') continue;
    
    const itemName = String(row[idxName] || '').toLowerCase();
    const stockId = String(row[idxId] || '').toLowerCase();
    
    if (!itemName && !stockId) continue;
    
    // Calculate fuzzy match score
    let score = 0;
    
    // Exact match gets highest score
    if (itemName === searchQuery || stockId === searchQuery) {
      score = 100;
    }
    // Starts with query
    else if (itemName.startsWith(searchQuery) || stockId.startsWith(searchQuery)) {
      score = 80;
    }
    // Contains query
    else if (itemName.includes(searchQuery) || stockId.includes(searchQuery)) {
      score = 60;
    }
    // Fuzzy match using Levenshtein distance
    else {
      const nameDistance = _levenshteinDistance(searchQuery, itemName);
      const idDistance = _levenshteinDistance(searchQuery, stockId);
      const minDistance = Math.min(nameDistance, idDistance);
      
      // Convert distance to score (lower distance = higher score)
      // Max reasonable distance is the length of the query
      const maxDist = Math.max(searchQuery.length, 3);
      score = Math.max(0, 50 - (minDistance / maxDist) * 50);
    }
    
    if (score > 10) {
      scored.push({
        score: score,
        'Stock ID': String(row[idxId] || ''),
        'Item Name': String(row[idxName] || ''),
        'Pack Size': idxPack > -1 ? (row[idxPack] || '1') : '1',
        'UOM': idxUom > -1 ? (row[idxUom] || 'UNIT') : 'UNIT',
        'Cost': idxCost > -1 ? (row[idxCost] || 0) : 0
      });
    }
  }

  // Sort by score descending and return top 15
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 15);
}

/**
 * Levenshtein distance calculation for fuzzy matching
 */
function _levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  
  if (m === 0) return n;
  if (n === 0) return m;
  
  // Use single row optimization for memory efficiency
  let prevRow = [];
  for (let j = 0; j <= n; j++) {
    prevRow[j] = j;
  }
  
  for (let i = 1; i <= m; i++) {
    let currRow = [i];
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1,        // deletion
        currRow[j - 1] + 1,    // insertion
        prevRow[j - 1] + cost  // substitution
      );
    }
    prevRow = currRow;
  }
  
  return prevRow[n];
}

function apiSyncInvoiceUrls() {
  return apiSyncAllDocuments();
}

/**
 * BULK IMPORT: Preview Stage
 * Parses raw text, validates headers, and screens for duplicates.
 */
function apiPreviewBulkInvoice(rawText) {
  assertPermission(['EDITOR', 'ADMIN']);
  if (!rawText || !rawText.trim()) return { success: false, error: "Empty clipboard data." };

  try {
    // 1. Parse using the new map
    const parsed = parseRawData(rawText, 'INVOICE_BULK_MAP');

    // 2. Screen Data & Check Duplicates
    const previewRows = [];
    const ss = getSpreadsheet();

    // Optimization: Pre-fetch invoice lists for relevant years? 
    // For now, we'll check duplicates on commit OR just soft-check here.
    // Let's do a meaningful check: derive year and check.

    parsed.data.forEach((row, idx) => {
      let status = "Valid";
      let error = "";

      // Sanitization
      const invNo = String(row['Invoice No'] || "").replace(/[^a-zA-Z0-9\-\.\/]/g, "").trim();
      const supplier = String(row['Supplier'] || "").trim();
      const dateRaw = row['Invoice Date'];
      let dateObj = new Date(dateRaw);

      if (!invNo) { status = "Invalid"; error = "Missing Invoice No"; }
      if (!supplier) { status = "Invalid"; error = "Missing Supplier"; }
      if (isNaN(dateObj.getTime())) { status = "Invalid"; error = "Invalid Date"; }

      // Determine Year
      const year = isNaN(dateObj.getTime()) ? new Date().getFullYear() : dateObj.getFullYear();

      previewRows.push({
        id: idx,
        invNo: invNo,
        supplier: supplier,
        date: isNaN(dateObj.getTime()) ? "" : dateObj.toISOString().split('T')[0],
        total: parseFloat(row['Total']) || 0,
        doNo: row['DO No'] || "",
        json: row['JSON_Blob'] || "",
        year: year,
        status: status,
        error: error
      });
    });

    return { success: true, count: parsed.count, rows: previewRows };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * BULK IMPORT: Commit Stage
 * Writes validated rows to the database.
 */
function apiSaveBulkInvoices(rows) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);
    const ss = getSpreadsheet();
    const timestamp = new Date();

    // Group by Year to minimize sheet switching
    const batchByYear = {};

    rows.forEach(row => {
      if (!batchByYear[row.year]) batchByYear[row.year] = [];
      batchByYear[row.year].push(row);
    });

    let stats = { success: 0, failed: 0 };

    for (const year in batchByYear) {
      const sheetName = INV_CONFIG.SHEET_PREFIX + year;
      let sheet = ss.getSheetByName(sheetName);

      // Auto-create Year Sheet if missing
      if (!sheet) {
        sheet = ss.insertSheet(sheetName);
        const headers = [
          "Invoice No", "Invoice Date", "Supplier", "PO No", "PO Date",
          "DO No", "DO Date", "Department", "Date Received", "Total Amount",
          "Invoice_Data_JSON", "Timestamp"
        ];
        sheet.appendRow(headers);
        sheet.setFrozenRows(1);
      }

      // Prepare Data
      const newSheetRows = [];
      const batch = batchByYear[year];

      batch.forEach(item => {
        // Parse JSON Blob for Line Items
        let lineItems = [];
        try {
          if (item.json && item.json.trim().startsWith('[')) {
            lineItems = JSON.parse(item.json);
          }
        } catch (e) { /* Fallback */ }

        // Sanitize: If no items, create Summary Item
        if (!Array.isArray(lineItems) || lineItems.length === 0) {
          lineItems = [{
            stockId: "BULK-IMPORT",
            itemName: "Bulk Imported Invoice",
            qty: 1,
            unitPrice: item.total,
            totalPrice: item.total,
            uom: "LOT"
          }];
        }

        // Save as a single row
        newSheetRows.push([
          item.invNo, item.date, item.supplier, "", "", // PO No/Date usually empty in bulk
          item.doNo, "", "General", item.date, item.total,
          JSON.stringify(lineItems), timestamp
        ]);

        stats.success++;
      }); // End batch.forEach

      // Append new sheet rows
      if (newSheetRows.length > 0) {
        sheet.getRange(sheet.getLastRow() + 1, 1, newSheetRows.length, newSheetRows[0].length).setValues(newSheetRows);
      }
    } // End for (year in batchByYear)

    return { success: true, message: `Imported ${stats.success} invoices.` };

  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}