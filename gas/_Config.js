/* SCHEMA DEFINITION & SAFE INITIALIZATION
  Refactored to match Legacy Schema and prevent data corruption.
  NOTE: Filename starts with "_" to ensure it loads before other scripts.
*/

// --- SPREADSHEET CONNECTION POOL ---
// Memoized to avoid redundant SpreadsheetApp.getActiveSpreadsheet() calls
let _ssInstance = null;
function getSpreadsheet() {
  if (!_ssInstance) _ssInstance = SpreadsheetApp.getActiveSpreadsheet();
  return _ssInstance;
}

const DB_CONFIG = {
  // Map friendly names to actual Sheet names
  SHEET_PO: "PurchaseOrder",
  SHEET_ITEMS: "DB_Items",
  SHEET_SUPPLIERS: "DB_Suppliers",
  SHEET_REVIEW: "DB_OrderReview",
  SHEET_DOCS: "DB_IncomingDocs",
  SHEET_PERF: "DB_Performance",
  SHEET_USERS: "System_Users",
  SHEET_RFQ: "RFQ_Logs",
  SHEET_PRF: "DB_PRF",
  SHEET_LOGS: "System_Logs",
  SHEET_ARCHIVE: "Archive_Deleted",
  SHEET_DIRECT_ORDERS: "DirectOrder_Logs",

  // External Catalogue Spreadsheet (now read from Script Properties)
  get CATALOGUE_SS_ID() { return _getSecureConfig('CATALOGUE_SS_ID'); },

  SHEET_ANALYTICS_CACHE: "DB_Analytics_Cache",
  SHEET_TASKS: "DB_Tasks"
};

const SUPER_ADMINS = [
  'kisame350@gmail.com',
  'procurement@starlight-vet.com.my'
];

const DB_SCHEMA = {
  [DB_CONFIG.SHEET_PO]: [
    "Date", "PO ID", "Supplier", "Bill #", "Total", "Paid", "Balance",
    "Status", "Ship Status", "Quot URL", "Inv URL", "Pmt URL", "Dept", "Terms",
    "Signed URL", "Linked RFQ", "PO_Data_JSON", "Item History URL"
  ],
  [DB_CONFIG.SHEET_ITEMS]: [
    "Stock ID", "Item Name", "Cost", "UOM", "Product Type", "Category",
    "Current", "ROP", "Selling", "Last Updated", "Pack Size", "Exclude",
    "Product Status", "Velocity Override", "Supplier", "Item Behaviour"
  ],
  [DB_CONFIG.SHEET_SUPPLIERS]: [
    "Supplier Name", "Contact Person", "Phone", "Email", "Address",
    "Payment Terms", "BRN", "Account No", "Bank Name"
  ],
  [DB_CONFIG.SHEET_REVIEW]: [
    "Date", "SKU", "Name", "Supplier", "UOM", "Cost", "Actual Stock",
    "ROP", "Status", "Category", "Department", "Snooze Until"
  ],
  [DB_CONFIG.SHEET_DOCS]: [
    "Date Uploaded", "Doc Type", "Ref No", "Supplier", "ETA Date",
    "File URL", "Status"
  ],
  [DB_CONFIG.SHEET_PERF]: [
    "Timestamp", "PO ID", "Supplier Name", "Rated By", "Quality",
    "Accuracy", "Speed", "Weighted Score", "Comments"
  ],
  [DB_CONFIG.SHEET_USERS]: [
    "Email", "Role", "Name", "Department", "Last Access", "PIN", "MustChangePin"
  ],
  "RFQ_Logs": [
    "RFQ ID", "Date", "Supplier", "Items Count", "Created By", "RFQ_Data_JSON", "Signed URL"
  ],
  [DB_CONFIG.SHEET_PRF]: [
    "PRF ID", "Date", "Requester", "Department", "Status",
    "Items Count", "PRF_Data_JSON"
  ],
  [DB_CONFIG.SHEET_LOGS]: [
    "Timestamp", "User/System", "Action", "Context", "Details"
  ],
  [DB_CONFIG.SHEET_ARCHIVE]: [
    "Timestamp", "Source Sheet", "Deleted By", "Reason", "Original Data (JSON)"
  ],
  [DB_CONFIG.SHEET_ANALYTICS_CACHE]: [
    "YearMonth", "Data_JSON", "Last Updated"
  ],
  [DB_CONFIG.SHEET_DIRECT_ORDERS]: [
    "Order ID", "Date", "Stock ID", "Item Name", "Supplier", "Qty", "Ordered By", "Notes", "Status"
  ],
  [DB_CONFIG.SHEET_TASKS]: [
    "Task ID", "Title", "Notes", "Attachments", "Status", "Created By", "Created Date"
  ]
};

/**
 * Sanitize text input to prevent formula injection in Google Sheets.
 * Prefixes dangerous leading characters (=, +, -, @, tab, CR) with a single quote.
 * Returns non-string values unchanged.
 */
function sanitizeText(val) {
  if (typeof val !== 'string') return val;
  const s = val.trim();
  if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
  return s;
}

/**
 * Robust Header Mapper (Case-insensitive)
 * Returns { "stock id": 0, "item name": 1 ... }
 */
function getHeaderMap(headers) {
  const map = {};
  if (!headers || !Array.isArray(headers)) return map;
  headers.forEach((h, i) => {
    if (h) map[String(h).toLowerCase().trim()] = i;
  });
  return map;
}

/**
 * Run this function ONCE manually or via Admin Menu.
 * DO NOT run in doGet() to avoid performance lag.
 */
function initDatabaseSchema() {
  const ss = getSpreadsheet();
  const currentUser = Session.getActiveUser().getEmail();
  let results = [];

  // 1. Iterate through defined schema tables
  for (let tableName in DB_SCHEMA) {
    let sheet = ss.getSheetByName(tableName);
    let isNewSheet = false;

    // Create sheet if missing
    if (!sheet) {
      sheet = ss.insertSheet(tableName);
      isNewSheet = true;
      results.push(`Created new sheet: ${tableName}`);

      // Cleanup default rows/cols for performance
      try {
        if (sheet.getMaxRows() > 2) sheet.deleteRows(2, sheet.getMaxRows() - 1);
        if (sheet.getMaxColumns() > 2) sheet.deleteColumns(2, sheet.getMaxColumns() - 1);
      } catch (e) { }
    }

    // 2. Validate Headers (Non-Destructive)
    const definedHeaders = DB_SCHEMA[tableName];

    if (isNewSheet) {
      // It's safe to write headers directly to a new sheet
      sheet.getRange(1, 1, 1, definedHeaders.length)
        .setValues([definedHeaders])
        .setFontWeight('bold')
        .setBackground('#EFEFEF')
        .setFrozenRows(1);
    } else {
      // For existing sheets, check for MISSING columns only.
      // We do NOT overwrite existing headers to prevent data corruption.
      const actualHeadersRange = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1);
      const actualHeaders = sheet.getLastColumn() > 0 ? actualHeadersRange.getValues()[0] : [];

      const missingHeaders = definedHeaders.filter(h => !actualHeaders.includes(h));

      if (missingHeaders.length > 0) {
        // Append missing columns to the end
        const startCol = actualHeaders.length + 1;
        sheet.getRange(1, startCol, 1, missingHeaders.length)
          .setValues([missingHeaders])
          .setFontWeight('bold')
          .setBackground('#FFF3CD'); // Mark new cols with yellow

        results.push(`Updated ${tableName}: Added [${missingHeaders.join(', ')}]`);
      }
    }
  }

  // 3. Bootstrap Admin if needed
  const userSheet = ss.getSheetByName(DB_CONFIG.SHEET_USERS);
  if (userSheet && userSheet.getLastRow() === 1) {
    userSheet.appendRow([currentUser, 'ADMIN', 'Admin User', 'IT', new Date(), hashPin('0000')]);
    results.push(`Bootstrapped Admin User: ${currentUser}`);
  }

  console.log(results.join('\n'));
  return results; // Return for UI display if needed
}