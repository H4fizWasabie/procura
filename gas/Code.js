/* PROCURETRACK V1 - CORE SERVER LOGIC 
  Handles routing, template serving, and initialization.
  UPDATED: Added Auto-Bootstrap Check in doGet (Fix 3).
*/

// --- 1. SERVING THE APP ---

function doGet(e) {
  // --- BOOTSTRAP GUARD (Fix 3) ---
  // Ensure DB_CONFIG is loaded and sheets exist.
  try {
    if (typeof DB_CONFIG === 'undefined') {
      return HtmlService.createHtmlOutput("CRITICAL ERROR: _Config.js not loaded. Check file order.");
    }

    const ss = getSpreadsheet();
    const userSheet = ss.getSheetByName(DB_CONFIG.SHEET_USERS);

    // If System_Users is missing, we assume it's a fresh install.
    if (!userSheet) {
      initDatabaseSchema(); // Run the schema builder
    }
  } catch (err) {
    console.error("Bootstrap Error: " + err.message);
  }
  // ------------------------------

  // 1. Serve Index
  let template = HtmlService.createTemplateFromFile('Index');

  // 2. Inject Initial User Data for UI State (Reset on load to force login)
  const currentUser = Session.getActiveUser().getEmail();

  template.currentUser = currentUser;
  template.userRole = 'NONE'; // Force login screen on every fresh load

  return template.evaluate()
    .setTitle('ProcurePilot')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// --- 2. INCLUDE HELPER ---
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// --- 3. SERVER-SIDE UTILITIES ---

function getScriptUrl() {
  return ScriptApp.getService().getUrl();
}

function logSystemAction(action, module, id, details) {
  const ss = getSpreadsheet();
  // Safe logging - if log sheet missing, fails silently to avoid breaking app
  // Check if DB_CONFIG exists before logging to prevent crash
  if (typeof DB_CONFIG !== 'undefined') {
    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_LOGS);
    if (sheet) {
      const user = Session.getActiveUser().getEmail();
      const timestamp = new Date();
      sheet.appendRow([timestamp, user, action, module, id, details]);

      // Log Rotation (Prevent unbounded growth)
      if (Math.random() < 0.1) { // 10% chance to check to avoid checking every time
        const lastRow = sheet.getLastRow();
        const MAX_LOGS = 2000;
        if (lastRow > MAX_LOGS) {
          const deleteCount = lastRow - MAX_LOGS + 100; // Delete extra + buffer
          // Keep header (row 1), delete from row 2
          sheet.deleteRows(2, deleteCount);
        }
      }
    }
  }
}

/**
 * Standardized Error Logging
 * Logs context and stack trace to System_Logs
 */
function logError(context, errorObj) {
  try {
    const ss = getSpreadsheet();
    if (typeof DB_CONFIG === 'undefined') return;

    const sheet = ss.getSheetByName(DB_CONFIG.SHEET_LOGS);
    if (!sheet) return;

    const timestamp = new Date();
    const user = Session.getActiveUser().getEmail();
    const msg = errorObj.message || String(errorObj);
    const stack = errorObj.stack || "No Stack Trace";

    // Append to log
    sheet.appendRow([timestamp, user, "ERROR", context, `${msg}\nStack: ${stack}`]);
    console.error(`[${context}] ${msg}`);
  } catch (e) {
    console.error("Critical: Failed to log error. " + e.message);
  }
}