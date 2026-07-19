/* CORE SMART PARSER
   Handles fuzzy matching for raw Excel/TSV pastes.
   Updated to catch Product Type, Status, and Supplier.
*/

const PARSER_CONFIG = {
  // Target Schema Column : [ List of possible Excel Headers to match (lowercase) ]
  'INVENTORY_MAP': {
    // Core Identifiers
    'Stock ID': ['sku code', 'sku', 'stock id', 'item code', 'code', 'id', 'part no'],
    'Item Name': ['product name', 'item name', 'name', 'description', 'desc', 'product'],

    // Categorization (Fixing the missing fields)
    'Product Type': ['product type', 'type', 'p.type'],
    'Product Status': ['product status', 'status', 'state', 'availability'],
    'Category': ['category', 'cat', 'group', 'family'],

    // Economics
    'Cost': ['cost price', 'cost', 'unit cost', 'buying price', 'rate', 'price'],
    'Selling': ['selling price', 'selling', 'ssp', 'retail price', 'retail'],
    'Supplier': ['supplier', 'vendor', 'mfr', 'manufacturer'],

    // Specs
    'UOM': ['uom', 'unit', 'measure', 'pkg', 'packing'],
    'Current': ['actual stock', 'current', 'qty', 'quantity', 'balance', 'on hand', 'stock'],

    // Optional (User said these might be empty in source, but we keep mapping just in case)
    'ROP': ['rop', 'reorder point', 'min level', 'alert level']
  },

  'INVOICE_BULK_MAP': {
    'Invoice No': ['invoice_id', 'inv no', 'invoice no', 'invoice number'],
    'Supplier': ['supplier_name', 'supplier', 'vendor'],
    'Invoice Date': ['doc_date', 'date', 'invoice date', 'timestamp'],
    'Total': ['grand_total', 'total', 'amount', 'net total'],
    'JSON_Blob': ['raw_json_blob', 'json', 'data', 'line_items'],
    'DO No': ['doc_number', 'do no', 'do number', 'delivery order']
  }
};

/**
 * Parses raw text and maps it to the Target Schema.
 * Returns: { headers_found: [], data: [], preview: [] }
 */
function parseRawData(rawText, mappingKey) {
  if (!rawText || !rawText.trim()) throw new Error("Clipboard is empty.");

  const lines = rawText.trim().split(/\r\n|\n|\r/); // Handle all line break types
  if (lines.length < 2) throw new Error("Data looks too short. Include Headers!");

  // 1. Analyze Headers (Row 0)
  // Clean headers: remove special chars, lowercase
  const rawHeaders = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/[^a-z0-9 ]/g, ""));

  const schemaMap = PARSER_CONFIG[mappingKey];
  const colIndexMap = {}; // DB_Col -> CSV_Index

  // Fuzzy Match Logic
  for (let dbCol in schemaMap) {
    const keywords = schemaMap[dbCol];
    // Find index of raw header that contains any keyword
    const foundIndex = rawHeaders.findIndex(h =>
      keywords.some(k => h === k || h.includes(k)) // Exact or Partial match
    );

    if (foundIndex > -1) {
      colIndexMap[dbCol] = foundIndex;
    }
  }

  // Critical Check
  if (colIndexMap['Stock ID'] === undefined) {
    throw new Error(`CRITICAL: Could not find a 'Stock ID' or 'SKU Code' column in your paste. Found: ${rawHeaders.join(', ')}`);
  }

  // Warn about missing optional columns
  const missingCols = Object.keys(schemaMap).filter(k => colIndexMap[k] === undefined);
  if (missingCols.length > 0) {
    console.warn(`Parser: Missing optional columns: ${missingCols.join(', ')}`);
  }

  // 2. Map Data Rows
  const cleanData = [];
  const validCols = Object.keys(colIndexMap);
  const textCols = ['Item Name', 'Product Type', 'Product Status', 'Category', 'Supplier', 'UOM'];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    if (cells.length < 2) continue; // Skip empty rows

    let rowObj = {};
    let isEmpty = true;

    validCols.forEach(dbCol => {
      const idx = colIndexMap[dbCol];
      let val = (cells[idx] || "").trim();

      // Numeric Cleaning
      if (['Cost', 'Current', 'ROP', 'Selling'].includes(dbCol)) {
        // Remove currency symbols but keep decimals
        val = val.replace(/[^0-9.-]/g, '');
        val = (val === '' || isNaN(val)) ? 0 : parseFloat(val);
      }

      // Sanitize text columns
      if (textCols.includes(dbCol)) {
        val = sanitizeText(val);
      }

      rowObj[dbCol] = val;
      if (val !== "") isEmpty = false;
    });

    if (!isEmpty) cleanData.push(rowObj);
  }

  return {
    mapped_columns: validCols, // Tell UI what we found
    data: cleanData,
    count: cleanData.length
  };
}