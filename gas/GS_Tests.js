/**
 * @fileoverview REGRESSION TESTS
 * Run these functions from the GAS Editor to verify system health.
 */

function test_apiGetDashboardStats() {
  console.log("Starting Dashboard Logic Test...");
  const res = apiGetDashboardStats();

  if (!res.success) {
    console.error("FAILED: Dashboard API returned an error: " + res.error);
    return;
  }

  const d = res.data;
  console.log("SUCCESS: Dashboard API responded.");
  console.log("- Total Items Scanned: " + d.inventory.totalItems);
  console.log("- Critical Stock Count: " + d.inventory.criticalStock);
  console.log("- Pending Approvals: " + d.operations.pendingApprovals);
  console.log("- YTD Spend: " + d.financials.ytdSpend);

  if (d.ropAlerts.length > 10) {
    console.error("FAILED: ropAlerts not truncated to 10.");
  } else {
    console.log("- Alerts Truncation: OK (" + d.ropAlerts.length + ")");
  }

  // Verify objects
  if (d.ropAlerts.length > 0) {
    const item = d.ropAlerts[0];
    const requiredKeys = ['id', 'name', 'current', 'rop', 'gap', 'cost', 'health'];
    requiredKeys.forEach(k => {
      if (!(k in item)) console.error(`FAILED: Alert item missing key: ${k}`);
    });
  }

  console.log("Testing Complete.");
}

function runDeepDiagnostic() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_ITEMS);
  const data = sheet.getDataRange().getValues();
  const h = getHeaderMap(data[0]);

  console.log("Header Map:", JSON.stringify(h));

  let dashCount = 0;
  let planCount = apiGetPlanningContext().length;

  const idxId = h['stock id'];
  const idxName = h['item name'];
  const idxCur = h['current'];
  const idxRop = h['rop'];
  const idxExcl = h['exclude'];
  const idxBeh = h['item behaviour'];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const idVal = (idxId !== undefined) ? String(row[idxId] || '').trim() : '';
    const nameVal = (idxName !== undefined) ? String(row[idxName] || '').trim() : '';
    if (!idVal && !nameVal) continue;

    // Logic identical to Dashboard
    if (idxExcl !== undefined) {
      const exclVal = String(row[idxExcl]).toUpperCase();
      if (exclVal === 'TRUE' || exclVal === 'YES' || exclVal === 'EXCLUDE') continue;
    }
    if (idxBeh !== undefined) {
      const behVal = String(row[idxBeh] || '').trim();
      if (behVal !== '' && behVal !== 'Standard / Pack' && behVal !== 'In-House Use') continue;
    }
    const curr = parseFloat(row[idxCur]) || 0;
    const rop = parseFloat(row[idxRop]) || 0;
    if (rop > 0 && curr < rop) dashCount++;
  }

  console.log("DIAGNOSTIC RESULTS:");
  console.log("- Sheet Scanned: " + DB_CONFIG.SHEET_ITEMS);
  console.log("- Total Rows: " + data.length);
  console.log("- Recalculated Dash Count: " + dashCount);
  console.log("- Actual Planning API Count: " + planCount);

  if (dashCount !== planCount) {
    console.error("!!! DISCREPANCY DETECTED !!!");
  } else {
    console.log("Counts match in this logic pass.");
  }
}

function testFinancialRecalc() {
  console.log("Starting Financial Recalc Test (Movement 2099)...");
  const ss = getSpreadsheet();
  const year = 2099;
  const sheetName = `Movement ${year}`;

  // 1. Setup
  let sheet = ss.getSheetByName(sheetName);
  if (sheet) ss.deleteSheet(sheet);
  sheet = ss.insertSheet(sheetName);

  // Create Headers (Simplified)
  // Cols 1-2: ID, Name
  // Cols 3-7: Jan (In, Out, AdjIn, AdjOut, Close)
  // Cols 8-12: Feb
  // ...
  // Col 63: Cost, 64: In, 65: Out, 66: Adj, 67: Turnover, 68: Usage

  // We need to ensure headers exist for the function to not crash?
  // ensureMovementSheet checks A1. If empty, it builds headers.
  // So we can let ensureMovementSheet build the structure first.

  // But we can't export ensureMovementSheet easily if it's internal? 
  // It IS global in GS_Movement.js.
  ensureMovementSheet(year);
  sheet = ss.getSheetByName(sheetName); // Re-fetch

  // 2. Inject Dummy Data (Row 3)
  // We'll simulate 2 months of data for "TEST-ITEM"
  // Jan: In 100, Out 40, Closing 60
  // Feb: Out 20, Closing 40
  // Rest months: 0
  // Avg Closing = (60 + 40) / 2 = 50.
  // Total Out = 40 + 20 = 60.
  // Expected Turnover = 60 / 50 = 1.2.

  sheet.getRange("A3").setValue("TEST-ITEM");
  sheet.getRange("B3").setValue("Test Item");

  // Jan (Cols 3-7 -> Indices 3,4,5,6,7) -> C,D,E,F,G
  sheet.getRange(3, 3).setValue(100); // In
  sheet.getRange(3, 4).setValue(40);  // Out
  sheet.getRange(3, 7).setValue(60);  // Closing

  // Feb (Cols 8-12 -> H,I,J,K,L)
  sheet.getRange(3, 9).setValue(20);  // Out
  sheet.getRange(3, 12).setValue(40); // Closing

  // 3. Run Recalc
  console.log("Running recalculateSheetCosts...");
  recalculateSheetCosts(year);

  // 4. Verify Results (Cols 67, 68 -> BO, BP)
  // Indices 66, 67 in array.
  // Sheet column 67, 68.
  const turnover = sheet.getRange(3, 67).getValue();

  console.log(`Result Turnover: ${turnover}`);

  if (Math.abs(turnover - 1.2) < 0.01) {
    console.log("SUCCESS: Turnover Rate calculation is correct.");
  } else {
    console.error(`FAILED: Expected 1.2, got ${turnover}`);
  }

  // 5. Cleanup
  ss.deleteSheet(sheet);
  console.log("Test Cleanup Complete.");
}
