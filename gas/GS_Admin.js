// [file] GS_Admin.js
/**
 * @fileoverview ADMIN CONTROLLER
 * MODULE: Admin
 * DESCRIPTION: User Management, System Health, Maintenance Tools, and Auto-Reminders.
 * STATUS: UPDATED (Added Manual Auth Trigger)
 */

const ADMIN_CONFIG = {
  // Sensitive credentials moved to PropertiesService via GS_SecureConfig.js
  // Run setupSecureConfig() once from GAS editor to seed defaults.
  EMAIL_TARGET: "procurement@starlight-vet.com.my",
  EMAIL_CC: "kisame350@gmail.com"
};

// --- 1. USER MANAGEMENT (GATED) ---
function apiAdminGetUsers() {
  assertPermission(['ADMIN']);
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_USERS);
  if (!sheet) return [];
  return sheet.getDataRange().getValues();
}

function apiAdminSaveUser(adminPwd, userData) {
  const currentUser = Session.getActiveUser().getEmail();
  const masterEmail = _getSecureConfig('MASTER_EMAIL');
  if (!masterEmail || currentUser.toLowerCase() !== masterEmail.toLowerCase()) {
    return { success: false, error: "⛔ ACCESS DENIED: Only Master Admin can manage users." };
  }
  const storedHash = _getSecureConfig('ADMIN_GATE_HASH');
  if (!storedHash || hashPin(String(adminPwd).trim()) !== storedHash) {
    return { success: false, error: "⛔ WRONG PASSWORD: Action blocked." };
  }

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_USERS);
  const data = sheet.getDataRange().getValues();

  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === String(userData.email).toLowerCase()) {
      rowIndex = i + 1;
      break;
    }
  }

  const row = [
    userData.email,
    userData.role,
    sanitizeText(userData.name),
    sanitizeText(userData.dept),
    (rowIndex > -1) ? data[rowIndex - 1][4] : new Date(),
    userData.pin
  ];

  if (rowIndex > -1) {
    sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    CacheService.getScriptCache().remove(`ROLE_${userData.email}`); // Force role refresh
    return { success: true, message: `User ${userData.email} updated.` };
  } else {
    sheet.appendRow(row);
    CacheService.getScriptCache().remove(`ROLE_${userData.email}`); // Force role refresh
    return { success: true, message: `User ${userData.email} added.` };
  }
}

// --- 2. SYSTEM HEALTH SCANNER ---
function apiAdminScanDatabase() {
  assertPermission(['ADMIN']);
  const ss = getSpreadsheet();
  const report = [];

  const targets = [
    { name: DB_CONFIG.SHEET_PO, col: 'PO_Data_JSON' },
    { name: DB_CONFIG.SHEET_PRF, col: 'PRF_Data_JSON' },
    { name: DB_CONFIG.SHEET_RFQ, col: 'RFQ_Data_JSON' }
  ];

  targets.forEach(t => {
    const sheet = ss.getSheetByName(t.name);
    if (!sheet) return;

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const colIdx = headers.indexOf(t.col);

    if (colIdx === -1) {
      report.push({ type: 'WARN', loc: t.name, msg: `Column ${t.col} not found. Skipping JSON check.` });
      return;
    }

    for (let i = 1; i < data.length; i++) {
      const cellVal = data[i][colIdx];
      if (cellVal && String(cellVal).trim() !== "") {
        try {
          JSON.parse(cellVal);
        } catch (e) {
          const rowNum = i + 1;
          const id = data[i][0] || "Unknown ID";
          report.push({
            type: 'CRITICAL',
            loc: `${t.name} (Row ${rowNum})`,
            id: id,
            msg: `Corrupted JSON: ${e.message.substring(0, 50)}...`
          });
        }
      }
    }
  });

  if (report.length === 0) {
    return { success: true, clean: true, message: "✅ Scan Complete. No integrity issues found." };
  }
  return { success: true, clean: false, report: report };
}

// --- 3. MAINTENANCE TOOLS ---
function apiAdminMaintenance(action) {
  assertPermission(['ADMIN']);
  const ss = getSpreadsheet();

  try {
    switch (action) {
      case 'FIX_HEADERS':
        if (typeof initDatabaseSchema === 'function') {
          initDatabaseSchema();
          return { success: true, message: "✅ Headers aligned with Schema." };
        }
        return { success: false, error: "Schema builder function missing." };

      case 'CLEAN_SHEETS':
        const validSheets = Object.values(DB_CONFIG);
        const allSheets = ss.getSheets();
        let removed = [];
        allSheets.forEach(s => {
          const sName = s.getName();
          if (!validSheets.includes(sName) && !sName.startsWith("Movement ")) {
            if (sName.includes("Copy of") || sName.includes("Sheet")) {
              s.setName("ARCHIVED_" + sName);
              s.hideSheet();
              removed.push(sName);
            }
          }
        });
        return { success: true, message: `✅ Cleanup: Archived ${removed.length} sheets (${removed.join(', ')})` };

      case 'SETUP_TRIGGER':
        // Setup All Triggers
        return setupTriggers();

      case 'SETUP_SECURE_CONFIG':
        // Initialize Script Properties with default values
        if (typeof setupSecureConfig === 'function') {
          return setupSecureConfig();
        }
        return { success: false, error: "setupSecureConfig function missing." };

      case 'CHECK_CONFIG':
        // Check if secure config is properly set up
        return checkSecureConfig();

      case 'GET_CURRENT_CONFIG':
        // Get current config values for display
        return getCurrentConfig();

      default:
        return { success: false, error: "Unknown Action" };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Dedicated function to update folder IDs
 */
function apiUpdateFolderIds(newIds) {
  assertPermission(['ADMIN']);
  try {
    const props = PropertiesService.getScriptProperties();
    const updated = [];
    
    // Handle both object and string input
    let idsToUpdate = newIds;
    if (typeof newIds === 'string') {
      try {
        idsToUpdate = JSON.parse(newIds);
      } catch (e) {
        return { success: false, error: "Invalid JSON format for newIds" };
      }
    }
    
    if (!idsToUpdate || typeof idsToUpdate !== 'object') {
      return { success: false, error: "newIds must be an object" };
    }
    
    for (const [key, value] of Object.entries(idsToUpdate)) {
      if (value && String(value).trim()) {
        props.setProperty(key, String(value).trim());
        updated.push(key);
        // Clear cache
        delete _secureConfigCache[key];
      }
    }
    
    return { 
      success: true, 
      message: `Updated ${updated.length} config keys: ${updated.join(', ')}`,
      updated: updated
    };
  } catch (e) {
    console.error(`[UPDATE_FOLDER_IDS] Error: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Get current config values (for admin display)
 */
function getCurrentConfig() {
  assertPermission(['ADMIN']);
  const keys = ['PO_FOLDER_ID', 'PO_LOGO_ID', 'PO_SIGN_ID', 'INV_FOLDER_ID', 'RFQ_LOGO_ID'];
  const config = {};
  
  keys.forEach(key => {
    config[key] = _getSecureConfig(key) || 'NOT SET';
  });
  
  return { success: true, config: config };
}

/**
 * Update folder IDs in Script Properties
 */
function updateFolderIds(newIds) {
  assertPermission(['ADMIN']);
  try {
    const props = PropertiesService.getScriptProperties();
    const updated = [];
    
    for (const [key, value] of Object.entries(newIds)) {
      if (value && value.trim()) {
        props.setProperty(key, value.trim());
        updated.push(key);
        // Clear cache
        delete _secureConfigCache[key];
      }
    }
    
    return { 
      success: true, 
      message: `Updated ${updated.length} config keys: ${updated.join(', ')}`,
      updated: updated
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Check if secure config is properly set up
 * Enhanced: Also verifies Drive files exist and are accessible
 */
function checkSecureConfig() {
  const requiredKeys = ['PO_FOLDER_ID', 'PO_LOGO_ID', 'PO_SIGN_ID', 'INV_FOLDER_ID', 'RFQ_LOGO_ID'];
  const missing = [];
  const present = [];
  const errors = [];
  const details = {};

  requiredKeys.forEach(key => {
    const val = _getSecureConfig(key);
    if (!val) {
      missing.push(key);
      details[key] = { status: 'MISSING', value: null };
    } else {
      present.push(key);
      details[key] = { status: 'SET', value: val };
      
      // Verify Drive file/folder exists
      try {
        if (key.includes('FOLDER_ID')) {
          const folder = DriveApp.getFolderById(val);
          details[key].driveName = folder.getName();
          details[key].driveStatus = 'ACCESSIBLE';
        } else {
          const file = DriveApp.getFileById(val);
          details[key].driveName = file.getName();
          details[key].driveStatus = 'ACCESSIBLE';
          details[key].mimeType = file.getBlob().getContentType();
        }
      } catch (e) {
        details[key].driveStatus = 'ERROR: ' + e.message;
        errors.push(`${key}: ${e.message}`);
      }
    }
  });

  // Also check email configs
  const emailKeys = ['EMAIL_APPROVER_TIER1', 'EMAIL_APPROVER_TIER2', 'EMAIL_FINANCE'];
  emailKeys.forEach(key => {
    const val = _getSecureConfig(key);
    details[key] = { status: val ? 'SET' : 'MISSING', value: val || null };
  });

  if (missing.length > 0 || errors.length > 0) {
    let message = '';
    if (missing.length > 0) {
      message += `⚠️ Missing config keys: ${missing.join(', ')}. `;
    }
    if (errors.length > 0) {
      message += `❌ Drive access errors: ${errors.join('; ')}.`;
    }
    return {
      success: false,
      message: message,
      missing: missing,
      present: present,
      errors: errors,
      details: details
    };
  }

  return {
    success: true,
    message: `✅ All required configuration is present and accessible.`,
    present: present,
    details: details
  };
}

// --- 4. REMINDER LOGIC (Manual & Auto) ---

// Manual Trigger (Admin Button)
function apiAdminTriggerReminder() {
  assertPermission(['ADMIN']);
  return sendDailyDigest();
}

// Auto Trigger (Script) - NO Permission check needed here as it runs as system
function onAutoReminder() {
  const today = new Date();
  const day = today.getDay(); // 0 = Sun, 6 = Sat

  // Skip Weekends
  if (day === 0 || day === 6) {
    console.log("Weekend - Skipping Reminder");
    return;
  }

  sendDailyDigest();
}

// Core Email Logic
function sendDailyDigest() {
  const ss = getSpreadsheet();
  const poSheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
  if (!poSheet) return { success: false, error: "PO Sheet missing" };

  const data = poSheet.getDataRange().getValues();
  const h = getHeaderMap(data[0]);

  const pendingApproval = [];
  const pendingPayment = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = String(row[h['Status']]);
    const id = row[h['PO ID']];
    const sup = row[h['Supplier']];
    const total = parseFloat(row[h['Total']]).toFixed(2);

    if (status === 'Pending Approval') {
      pendingApproval.push(`<li><strong>${id}</strong>: ${sup} (RM ${total})</li>`);
    } else if (status === 'Pending Payment') {
      pendingPayment.push(`<li><strong>${id}</strong>: ${sup} (RM ${total})</li>`);
    }
  }

  if (pendingApproval.length === 0 && pendingPayment.length === 0) {
    return { success: true, message: "No pending items. Email skipped." };
  }

  let htmlBody = `
    <h3>ProcurePilot: Daily Digest</h3>
    <p>Good morning, here is the status of pending items for ${new Date().toLocaleDateString()}.</p>
    
    <div style="margin-bottom:20px;">
      <h4 style="color:#d35400;">⚠️ Pending Approval (${pendingApproval.length})</h4>
      ${pendingApproval.length > 0 ? `<ul>${pendingApproval.join('')}</ul>` : '<p><i>None</i></p>'}
    </div>

    <div style="margin-bottom:20px;">
      <h4 style="color:#2980b9;">💸 Pending Payment (${pendingPayment.length})</h4>
      ${pendingPayment.length > 0 ? `<ul>${pendingPayment.join('')}</ul>` : '<p><i>None</i></p>'}
    </div>
    
    <hr>
    <p style="font-size:0.8rem; color:#666;">Generated by ProcurePilot System.</p>
  `;

  MailApp.sendEmail({
    to: ADMIN_CONFIG.EMAIL_TARGET,
    cc: ADMIN_CONFIG.EMAIL_CC,
    subject: `[ACTION REQUIRED] ProcurePilot Daily Reminder - ${new Date().toLocaleDateString()}`,
    htmlBody: htmlBody
  });

  return { success: true, message: "📧 Reminder email sent successfully." };
}

// --- TRIGGER SETUP ---
function setupDailyTrigger() {
  // Delete existing to prevent duplicates
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onAutoReminder') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create new 8am trigger
  ScriptApp.newTrigger('onAutoReminder')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .create();

  return { success: true, message: "✅ Auto-Reminder scheduled daily at 8:00 AM." };
}

// --- 5. MONTHLY ANALYTICS TRIGGER ---
function triggerMonthlyAnalytics() {
  const today = new Date();
  // We want to cache the PREVIOUS month
  // If today is Feb 1st, we cache Jan.
  let year = today.getFullYear();
  let month = today.getMonth() - 1;

  if (month < 0) {
    month = 11;
    year--;
  }

  if (typeof cacheMonthlyAnalytics === 'function') {
    const res = cacheMonthlyAnalytics(year, month);
    console.log("Monthly Trigger Result: " + res);
  } else {
    console.error("cacheMonthlyAnalytics function missing.");
  }
}

function setupTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  let reminderFound = false;
  let analyticsFound = false;

  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'onAutoReminder') reminderFound = true;
    if (t.getHandlerFunction() === 'triggerMonthlyAnalytics') analyticsFound = true;
  });

  const results = [];

  if (!reminderFound) {
    ScriptApp.newTrigger('onAutoReminder').timeBased().everyDays(1).atHour(8).create();
    results.push("Daily Reminder: Created");
  } else {
    results.push("Daily Reminder: Exists");
  }

  if (!analyticsFound) {
    ScriptApp.newTrigger('triggerMonthlyAnalytics').timeBased().onMonthDay(1).atHour(1).create();
    results.push("Monthly Analytics: Created");
  } else {
    results.push("Monthly Analytics: Exists");
  }

  return { success: true, message: results.join(', ') };
}

/**
 * ONE-TIME SETUP: Grant Admin Access to Procurement Email
 * Run this function manually from the Script Editor.
 */
function grantProcurementAdmin() {
  const targetEmail = "procurement@starlight-vet.com.my";
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_USERS);

  if (!sheet) {
    console.error("System_Users sheet not found. Run initDatabaseSchema() first.");
    return;
  }

  const data = sheet.getDataRange().getValues();
  let found = false;
  let rowIndex = -1;

  console.log(`🔍 Searching for ${targetEmail} in ${data.length} rows...`);

  for (let i = 1; i < data.length; i++) {
    const rowEmail = String(data[i][0]).trim();
    if (rowEmail.toLowerCase() === targetEmail.toLowerCase()) {
      found = true;
      rowIndex = i + 1;
      console.log(`✅ Found user at Row ${rowIndex}. Current Role: ${data[i][1]}`);
      break;
    }
  }

  if (found) {
    // Update existing user to ADMIN
    const range = sheet.getRange(rowIndex, 2);
    range.setValue("ADMIN");
    SpreadsheetApp.flush(); // Force write
    console.log(`✅ EXECUTED: Set Row ${rowIndex} Col 2 to "ADMIN".`);

    // Verify
    const verify = sheet.getRange(rowIndex, 2).getValue();
    console.log(`🔍 VERIFICATION: Row ${rowIndex} Role is now: [${verify}]`);

  } else {
    // Create new user
    const newUser = [
      targetEmail,
      "ADMIN",
      "Procurement Admin",
      "Procurement",
      new Date(),
      hashPin("0000"), // Default PIN
      false // MustChangePin
    ];
    sheet.appendRow(newUser);
    SpreadsheetApp.flush();
    console.log(`✅ Created new ADMIN user: ${targetEmail}`);
  }

  // FORCE CACHE CLEAR
  const cacheKey = 'ROLE_' + targetEmail.toLowerCase();
  CacheService.getScriptCache().remove(cacheKey);
  console.log(`🗑️ Cache Cleared: ${cacheKey}`);
}

function debugUserAccess() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_USERS);
  const data = sheet.getDataRange().getValues();

  console.log("--- DEBUG USER ACCESS ---");
  console.log("ActiveUser (Session): [" + Session.getActiveUser().getEmail() + "]");
  console.log("EffectiveUser: [" + Session.getEffectiveUser().getEmail() + "]");

  console.log("--- DB USERS ---");
  data.forEach((row, i) => {
    if (i === 0) return; // headers
    console.log(`Row ${i + 1}: [${row[0]}] Role: [${row[1]}] MustChangePin: [${row[6]}]`);
  });
  console.log("-------------------------");
}