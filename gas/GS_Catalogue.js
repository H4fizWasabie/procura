/**
 * @fileoverview CATALOGUE ENGINE (EXTERNAL)
 * Handles connection to the central catalogue spreadsheet with diverse header styles.
 */

const CATALOGUE_CONFIG = {
  // Fuzzy matching keywords for common columns across different supplier sheets
  'HEADER_MAP': {
    'id':       ['sku', 'code', 'id', 'part no', 'item code', 'ref'],
    'name':     ['item name', 'description', 'product', 'item', 'desc'],
    'uom':      ['uom', 'unit', 'measure', 'pkg', 'packing', 'size'],
    'cost':     ['cost', 'price', 'rate', 'unit price', 'nett'],
    'brand':    ['brand', 'mfr', 'manufacturer', 'make'],
    'category': ['category', 'cat', 'group', 'type'],
    'bonus':    ['tier', 'bonus', 'foc', 'free', 'remarks', 'note']
  }
};

/**
 * Global Fuzzy Search across all suppliers (sheets)
 */
function apiSearchCatalogueGlobal(query) {
  assertPermission(['VIEWER', 'EDITOR', 'ADMIN']);
  if (!query || query.length < 2) return [];

  const ss = SpreadsheetApp.openById(DB_CONFIG.CATALOGUE_SS_ID);
  const sheets = ss.getSheets();
  const searchLower = query.toLowerCase().trim();
  const globalResults = [];

  sheets.forEach(sheet => {
    const sheetName = sheet.getName();
    const fullData = sheet.getDataRange().getValues();
    if (fullData.length < 2) return;

    const rawHeaders = fullData[0].map(h => String(h).toLowerCase().trim().replace(/[^a-z0-9 ]/g, ""));
    const colMap = {};

    // 1. Map columns for THIS specific sheet
    for (let targetKey in CATALOGUE_CONFIG.HEADER_MAP) {
      const keywords = CATALOGUE_CONFIG.HEADER_MAP[targetKey];
      const foundIdx = rawHeaders.findIndex(h => keywords.some(k => h === k || h.includes(k)));
      if (foundIdx > -1) colMap[targetKey] = foundIdx;
    }

    const idxName = colMap['name'];
    const idxId = colMap['id'];
    if (idxName === undefined && idxId === undefined) return;

    // 2. Scan Rows
    for (let i = 1; i < fullData.length; i++) {
      const row = fullData[i];
      const nameVal = idxName !== undefined ? String(row[idxName]) : "";
      const idVal = idxId !== undefined ? String(row[idxId]) : "";

      if (nameVal.toLowerCase().includes(searchLower) || idVal.toLowerCase().includes(searchLower)) {
        let costVal = colMap['cost'] !== undefined ? row[colMap['cost']] : 0;
        if (typeof costVal === 'string') costVal = parseFloat(costVal.replace(/[^0-9.-]/g, '')) || 0;

        globalResults.push({
          supplier: sheetName,
          id: idVal,
          name: nameVal,
          brand: colMap['brand'] !== undefined ? row[colMap['brand']] : "-",
          uom: colMap['uom'] !== undefined ? row[colMap['uom']] : "-",
          cost: costVal,
          bonus: colMap['bonus'] !== undefined ? row[colMap['bonus']] : "-"
        });
      }
      
      // Safety cap: Max 100 results total
      if (globalResults.length >= 100) break;
    }
  });

  // Sort by Cost (Lowest First)
  return globalResults.sort((a, b) => a.cost - b.cost);
}
