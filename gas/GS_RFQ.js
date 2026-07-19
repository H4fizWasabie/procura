/* RFQ BACKEND
   Handles Request for Quotation Logic
*/

const RFQ_CONFIG = {
  get FOLDER_ID() { return 'slGOHHOwO2FY2fNj008hYQW12ZGgNXY4'; }, // Starlight folder (same as PO/Invoice)
  get LOGO_ID() { return _getSecureConfig('RFQ_LOGO_ID'); }
};

// --- CONTEXT ---
function apiGetRFQContext() {
  assertPermission(['EDITOR', 'ADMIN']);
  return {
    suppliers: apiGetSuppliers(),
    items: apiGetInventoryBasicList(),
    newId: generateNextRfqId()
  };
}

function generateNextRfqId() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName('RFQ_Logs');
    if (!sheet) return "RFQ-ERROR";

    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    const prefix = `RFQ-${mm}${yyyy}-`;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return prefix + "01";

    // PERFORMANCE: Read ONLY the last 50 IDs
    const LOOKBACK = 50;
    const startRow = Math.max(2, lastRow - LOOKBACK + 1);
    const numRows = lastRow - startRow + 1;

    const ids = sheet.getRange(startRow, 1, numRows, 1).getValues().flat();
    let maxSeq = 0;

    ids.forEach(id => {
      const sId = String(id || "").trim();
      const match = sId.match(new RegExp(`^RFQ-${mm}${yyyy}-(\\d+)$`, 'i'));
      if (match) {
        const seqNumber = parseInt(match[1], 10);
        if (seqNumber > maxSeq) maxSeq = seqNumber;
      }
    });

    return prefix + String(maxSeq + 1).padStart(2, '0');
  } catch (e) {
    return "RFQ-ERROR";
  } finally {
    lock.releaseLock();
  }
}

// --- SAVE / UPDATE (OPTIMIZED) ---
function apiSaveRFQ(form) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName('RFQ_Logs');
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

    let rfqId = form.rfq_id;

    // PERFORMANCE: Targeted ID Column Scan
    const idColumn = sheet.getRange(1, 1, lastRow || 1, 1).getValues().flat();
    const rowIndex = idColumn.indexOf(rfqId) + 1;

    const timestamp = new Date();
    const itemsBlob = form.items.map(item => ({
      id: item.stockId || '',
      n: item.name,
      u: item.uom,
      q: item.qty
    }));

    const rowData = [];
    headers.forEach(h => {
      switch (h) {
        case 'RFQ ID': rowData.push(rfqId); break;
        case 'Date': rowData.push(timestamp); break;
        case 'Supplier': rowData.push(sanitizeText(form.supplier)); break;
        case 'Items Count': rowData.push(form.items.length); break;
        case 'Created By': rowData.push(Session.getActiveUser().getEmail()); break;
        case 'RFQ_Data_JSON': rowData.push(JSON.stringify(itemsBlob)); break;
        case 'Signed URL':
          if (rowIndex > 1) rowData.push(sheet.getRange(rowIndex, headers.indexOf(h) + 1).getValue());
          else rowData.push('');
          break;
        default: rowData.push('');
      }
    });

    if (rowIndex > 1) {
      sheet.getRange(rowIndex, 1, 1, rowData.length).setValues([rowData]);
    } else {
      sheet.appendRow(rowData);
    }

    return { success: true, message: "RFQ Saved" };

  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// --- LOAD FOR EDIT (OPTIMIZED) ---
function apiGetRFQDetails(rfqId) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName('RFQ_Logs');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: false, error: "No data" };

  // PERFORMANCE: Targeted ID Column Scan
  const idColumn = sheet.getRange(1, 1, lastRow, 1).getValues().flat();
  const rowIndex = idColumn.indexOf(rfqId);

  if (rowIndex === -1) return { success: false, error: "RFQ Not Found" };

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rowData = sheet.getRange(rowIndex + 1, 1, 1, headers.length).getValues()[0];

  let items = [];
  try { items = JSON.parse(rowData[headers.indexOf('RFQ_Data_JSON')]); } catch (e) { }

  return {
    success: true,
    data: {
      rfq_id: rfqId,
      supplier: rowData[headers.indexOf('Supplier')],
      items: items
    }
  };
}

// --- PDF GENERATOR ---
function apiGenerateRfqPdf(rfqId) {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName('RFQ_Logs');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    // 1. Fetch RFQ
    let row = null;
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(rfqId)) {
        row = data[i];
        rowIndex = i + 1;
        break;
      }
    }
    if (!row) throw new Error("RFQ not found");

    // 2. Parse Items
    let items = [];
    try { items = JSON.parse(row[headers.indexOf('RFQ_Data_JSON')]); } catch (e) { }

    // Map items for Template
    const grid = items.map(i => ({
      id: i.id,
      name: i.n,
      uom: i.u,
      qty: i.q
    }));

    // 3. Logo
    const getBase64 = (id) => {
      try {
        const blob = DriveApp.getFileById(id).getBlob();
        return `<img src="data:${blob.getContentType()};base64,${Utilities.base64Encode(blob.getBytes())}" style="max-height:60px;" />`;
      } catch (e) { return ""; }
    };

    // 4. Render Template
    const template = HtmlService.createTemplateFromFile('Template_RFQ');
    template.data = {
      rfqId: rfqId,
      supplierName: row[headers.indexOf('Supplier')],
      items: grid
    };
    template.dateStr = new Date().toLocaleDateString();
    template.logo = getBase64(RFQ_CONFIG.LOGO_ID);

    const blob = template.evaluate().getBlob().getAs(MimeType.PDF).setName(`${rfqId}.pdf`);

    // 5. Save & Replace - with error handling for folder access
    let fileUrl = '';
    try {
      const folder = DriveApp.getFolderById(RFQ_CONFIG.FOLDER_ID);
      const existing = folder.getFilesByName(`${rfqId}.pdf`);
      while (existing.hasNext()) existing.next().setTrashed(true);

      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      fileUrl = file.getUrl();

      // Save URL
      const urlCol = headers.indexOf('Signed URL');
      if (urlCol > -1) sheet.getRange(rowIndex, urlCol + 1).setValue(fileUrl);
    } catch (driveError) {
      // If folder access fails, return the PDF blob URL for download
      console.error("Drive folder access error:", driveError.message);
      // Create a temporary blob URL for download
      const blobUrl = 'data:application/pdf;base64,' + Utilities.base64Encode(blob.getBytes());
      fileUrl = blobUrl;
    }

    return { success: true, url: fileUrl, isBlob: fileUrl.startsWith('data:') };

  } catch (e) {
    return { success: false, error: e.message };
  }
}
