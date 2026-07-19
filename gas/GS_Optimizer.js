/**
 * OPTIMIZER MODULE
 * Handles spreadsheet performance optimization by trimming unused rows and columns.
 */

function apiTriggerSystemCleanup() {
    assertPermission(['ADMIN']);

    const ss = getSpreadsheet();
    const report = [];

    // 1. Get all sheets from DB_CONFIG (excluding properties)
    const sheetsToClean = Object.values(DB_CONFIG).filter(val => typeof val === 'string');

    // 2. Iterate and Optimize
    sheetsToClean.forEach(sheetName => {
        const sheet = ss.getSheetByName(sheetName);
        if (!sheet) {
            report.push(`Skipped [${sheetName}]: Not found`);
            return;
        }

        const result = optimizeSheet(sheet);
        if (result) report.push(`Optimized [${sheetName}]: ${result}`);
    });

    logSystemAction('SYSTEM_OPTIMIZE', 'ADMIN', 'ALL', 'Triggered manual sheet optimization');

    return { success: true, report: report };
}

/**
 * Trims a sheet to Data Range + Buffer
 * @param {Sheet} sheet 
 * @returns {string|null} Summary of actions or null if no action needed
 */
function optimizeSheet(sheet) {
    const BUFFER_ROWS = 10;
    const BUFFER_COLS = 1; // Minimal buffer for columns

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const maxRows = sheet.getMaxRows();
    const maxCols = sheet.getMaxColumns();

    let actions = [];

    // Row Cleanup
    // Ensure we have at least BUFFER_ROWS or enough for the data
    const neededRows = Math.max(lastRow + BUFFER_ROWS, 20); // Minimum 20 rows valid
    if (maxRows > neededRows) {
        const rowsToDelete = maxRows - neededRows;
        try {
            sheet.deleteRows(neededRows + 1, rowsToDelete);
            actions.push(`Removed ${rowsToDelete} rows`);
        } catch (e) {
            console.warn(`Failed to delete rows in ${sheet.getName()}: ${e.message}`);
        }
    }

    // Column Cleanup
    // Ensure we have at least lastCol + BUFFER (but strict schema usually matches LastCol)
    const neededCols = Math.max(lastCol + BUFFER_COLS, 5); // Minimum 5 cols
    if (maxCols > neededCols) {
        const colsToDelete = maxCols - neededCols;
        try {
            sheet.deleteColumns(neededCols + 1, colsToDelete);
            actions.push(`Removed ${colsToDelete} cols`);
        } catch (e) {
            console.warn(`Failed to delete cols in ${sheet.getName()}: ${e.message}`);
        }
    }

    return actions.length > 0 ? actions.join(", ") : null;
}
