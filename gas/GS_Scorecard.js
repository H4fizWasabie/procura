// [file] GS_Scorecard.js
/**
 * @fileoverview SUPPLIER SCORECARD ENGINE
 * MODULE: Scorecard
 * DESCRIPTION: Handles fetching rateable POs and saving performance metrics.
 * UPDATED: Aligned with Case-Insensitive Header Mapping and Central Schema.
 */

// --- READ: GET PENDING REVIEWS ---
function apiGetScorecardContext() {
  assertPermission(['EDITOR', 'ADMIN']);

  const ss = getSpreadsheet();

  // 1. Fetch Existing Scores (To exclude them)
  const perfSheetName = DB_CONFIG.SHEET_PERF || "DB_Performance";
  let perfSheet = ss.getSheetByName(perfSheetName);

  // Create if missing using Schema
  if (!perfSheet) {
    initDatabaseSchema(); // Use centralized schema enforcer
    perfSheet = ss.getSheetByName(perfSheetName);
  }

  const perfData = perfSheet.getDataRange().getValues();
  const ph = getHeaderMap(perfData[0]);
  const scoredPoIds = new Set();

  const colScoredPoId = ph['po id'];
  if (colScoredPoId > -1) {
    for (let i = 1; i < perfData.length; i++) {
      const val = String(perfData[i][colScoredPoId]).trim();
      if (val) scoredPoIds.add(val);
    }
  }

  // 2. Fetch POs
  const poSheetName = DB_CONFIG.SHEET_PO || "PurchaseOrder";
  const poSheet = ss.getSheetByName(poSheetName);
  if (!poSheet) return { pending: [] };

  const poData = poSheet.getDataRange().getValues();
  const h = getHeaderMap(poData[0]);

  const pending = [];

  // Match keys from getHeaderMap (which are lowercase)
  const colPoId = h['po id'];
  const colStatus = h['status'];
  const colSup = h['supplier'];
  const colDate = h['date'];
  const colBill = h['bill #'];
  const colInvUrl = h['inv url'];
  const colTotal = h['total'];

  if (colPoId > -1 && colStatus > -1 && colSup > -1) {
    // Iterate backwards (newest first)
    for (let i = poData.length - 1; i >= 1; i--) {
      const row = poData[i];
      const poId = String(row[colPoId] || "").trim();
      if (!poId) continue;

      const status = String(row[colStatus] || "").toUpperCase();
      const invUrl = (colInvUrl > -1) ? row[colInvUrl] : "";

      // LOGIC: Show if Paid/Partial/Approved AND Has Invoice AND Not yet scored
      const isComplete = (status === 'PAID' || status === 'PARTIAL' || (status === 'APPROVED' && invUrl));

      if (isComplete && !scoredPoIds.has(poId)) {
        pending.push({
          poId: poId,
          supplier: row[colSup],
          date: formatDate(row[colDate]),
          billNo: (colBill > -1) ? row[colBill] : "",
          invUrl: invUrl,
          total: (colTotal > -1) ? row[colTotal] : 0
        });
      }
    }
  }

  return { pending: pending };
}

// --- WRITE: SAVE SCORE ---
function apiSaveScorecard(form) {
  assertPermission(['EDITOR', 'ADMIN']);
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(5000);
    const ss = getSpreadsheet();
    const sheetName = DB_CONFIG.SHEET_PERF || "DB_Performance";
    const sheet = ss.getSheetByName(sheetName);

    if (!sheet) throw new Error("Performance DB missing");

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const h = getHeaderMap(headers);
    const user = Session.getActiveUser().getEmail();
    const timestamp = new Date();
    const avg = (parseInt(form.acc) + parseInt(form.spd) + parseInt(form.qual)) / 3;

    // Use SCHEMA defined row mapping
    const newRow = new Array(headers.length).fill("");

    // Map form fields to schema columns
    if (h['timestamp'] > -1) newRow[h['timestamp']] = timestamp;
    if (h['po id'] > -1) newRow[h['po id']] = form.poId;
    if (h['supplier name'] > -1) newRow[h['supplier name']] = sanitizeText(form.supplier);
    if (h['rated by'] > -1) newRow[h['rated by']] = user;
    if (h['quality'] > -1) newRow[h['quality']] = form.qual;
    if (h['accuracy'] > -1) newRow[h['accuracy']] = form.acc;
    if (h['speed'] > -1) newRow[h['speed']] = form.spd;
    if (h['weighted score'] > -1) newRow[h['weighted score']] = avg.toFixed(2);
    if (h['comments'] > -1) newRow[h['comments']] = sanitizeText(form.comment);

    sheet.appendRow(newRow);

    logSystemAction('SCORECARD', 'SAVE', form.poId, `Rated ${form.supplier} - Avg: ${avg.toFixed(2)}`);

    return { success: true, message: "Scorecard submitted successfully." };

  } catch (e) {
    console.error("Scorecard Save Error: " + e.message);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// --- UTILS ---
function formatDate(d) {
  if (d instanceof Date) return d.toLocaleDateString();
  if (!d) return "-";
  return String(d);
}