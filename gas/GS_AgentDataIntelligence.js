// [file] GS_AgentDataIntelligence.js
/**
 * @fileoverview AGENT DATA INTELLIGENCE MODULE
 * MODULE: Agentic AI
 * STATUS: NEW (Phase 1 & Phase 2)
 *
 * Provides specialized, token-efficient Data API endpoints
 * exclusively for the Agentic AI to read database schema and execute raw queries.
 */

/**
 * PHASE 1: Schema Discovery API
 * Returns all active sheet names, their headers, and an inferred 
 * data type based on the first data row.
 * 
 * @returns {string} JSON Payload of the database schema configuration
 */
function apiAgent_GetSchema() {
    try {
        if (typeof assertPermission === 'function') {
            assertPermission(['ADMIN', 'EDITOR']); // strict requirement
        }

        const ss = getSpreadsheet();
        const sheets = ss.getSheets();
        const schema = {};

        // Focus on Core DB Sheets
        const targetSheets = [
            DB_CONFIG.SHEET_ITEMS,
            DB_CONFIG.SHEET_PO,
            DB_CONFIG.SHEET_RFQ,
            DB_CONFIG.SHEET_INVOICE,
            DB_CONFIG.SHEET_SUPPLIERS,
            // Fetch Movement sheets dynamically based on what exists
            ...sheets.map(s => s.getName()).filter(name => name.startsWith('Movement '))
        ];

        sheets.forEach(sheet => {
            const name = sheet.getName();
            if (targetSheets.includes(name) || targetSheets.includes(DB_CONFIG[name])) {
                const dataRange = sheet.getDataRange();
                const lastRow = dataRange.getLastRow();
                const lastCol = dataRange.getLastColumn();

                if (lastRow > 0 && lastCol > 0) {
                    // Get headers (Row 1)
                    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

                    // Get Sample Data (Row 2, if exists)
                    let sampleRow = null;
                    if (lastRow > 1) {
                        sampleRow = sheet.getRange(2, 1, 1, lastCol).getValues()[0];
                    }

                    const columns = {};
                    headers.forEach((h, index) => {
                        let headerName = String(h).trim();
                        if (!headerName) headerName = `Column_${index + 1}`;

                        let type = 'String';
                        if (sampleRow) {
                            const val = sampleRow[index];
                            if (val instanceof Date) {
                                type = 'Date';
                            } else if (typeof val === 'number') {
                                type = 'Number';
                            } else if (typeof val === 'boolean') {
                                type = 'Boolean';
                            }
                        }

                        columns[headerName] = { index: index, type: type };
                    });

                    schema[name] = {
                        rowCount: lastRow - 1, // minus header
                        columnCount: lastCol,
                        columns: columns
                    };
                }
            }
        });

        return JSON.stringify({ status: "success", schema: schema });

    } catch (e) {
        return JSON.stringify({ status: "error", message: e.message });
    }
}

/**
 * PHASE 2: Universal Data Extraction API
 * Allows the AI Agent to query explicit columns from a sheet,
 * filtered by basic conditions, returned efficiently as CSV or minimal JSON.
 * 
 * @param {string} payload - Stringified JSON configuration 
 *    e.g. { sheet: "DB_Items", cols: ["Stock ID", "Current", "ROP"], limit: 100 }
 * @returns {string} Token-optimized JSON payload
 */
function apiAgent_QueryDatabase(payloadString) {
    try {
        if (typeof assertPermission === 'function') {
            assertPermission(['ADMIN', 'EDITOR']);
        }

        const config = JSON.parse(payloadString);

        if (!config.sheet) {
            throw new Error("Missing required 'sheet' parameter");
        }

        const ss = getSpreadsheet();
        const sheet = ss.getSheetByName(config.sheet);

        if (!sheet) {
            throw new Error(`Sheet not found: ${config.sheet}`);
        }

        const dataRange = sheet.getDataRange();
        const rawData = dataRange.getValues();

        if (rawData.length <= 1) {
            return JSON.stringify({ status: "success", data: "No data rows found.", count: 0 });
        }

        const rawHeaders = rawData[0];
        const headers = rawHeaders.map(h => String(h).trim().toLowerCase());

        const targetCols = config.cols || null;
        // array of target column indicies
        const validIndexes = [];
        const outHeaders = [];

        if (targetCols && Array.isArray(targetCols) && targetCols.length > 0) {
            targetCols.forEach(colName => {
                const idx = headers.indexOf(String(colName).toLowerCase());
                if (idx !== -1) {
                    validIndexes.push(idx);
                    outHeaders.push(rawHeaders[idx]);
                }
            });
        } else {
            // Take all if none specified
            rawHeaders.forEach((h, i) => {
                validIndexes.push(i);
                outHeaders.push(h);
            });
        }

        if (validIndexes.length === 0) {
            throw new Error("None of the requested columns exist in this sheet.");
        }

        const results = [];
        const limit = config.limit || 500; // default safeguard

        // Basic processing loop
        for (let i = 1; i < rawData.length; i++) {
            // limit cap
            if (results.length >= limit) break;

            const row = rawData[i];

            // Check basic skip conditions (can be expanded later for filtering)
            let skipRow = false;

            if (!skipRow) {
                const mappedRow = {};
                validIndexes.forEach((colIdx, resIdx) => {
                    mappedRow[outHeaders[resIdx]] = row[colIdx];
                });
                results.push(mappedRow);
            }
        }

        return JSON.stringify({
            status: "success",
            sheet: config.sheet,
            returnedCols: outHeaders,
            count: results.length,
            data: results // returning list of objects for ease of agent use
        });

    } catch (e) {
        return JSON.stringify({ status: "error", message: e.message });
    }
}

/**
 * PHASE 3: Automated Computation Sandbox
 * Executes pre-defined Map-Reduce aggregations server-side to bypass
 * token limitations of massive datasets.
 * 
 * @param {string} payloadString - { sheet: "Sheet1", groupBy: "dept", sumCol: "total" }
 * @returns {string} Aggregated JSON result
 */
function apiAgent_ExecuteCompute(payloadString) {
    try {
        if (typeof assertPermission === 'function') {
            assertPermission(['ADMIN', 'EDITOR']);
        }

        const config = JSON.parse(payloadString);
        if (!config.sheet || !config.groupBy || !config.sumCol) {
            throw new Error("Missing required parameters: sheet, groupBy, sumCol");
        }

        const ss = getSpreadsheet();
        const sheet = ss.getSheetByName(config.sheet);
        if (!sheet) throw new Error(`Sheet not found: ${config.sheet}`);

        const data = sheet.getDataRange().getValues();
        if (data.length <= 1) return JSON.stringify({ status: "success", result: {} });

        const headers = data[0].map(h => String(h).trim().toLowerCase());
        const groupIdx = headers.indexOf(String(config.groupBy).toLowerCase());
        const sumIdx = headers.indexOf(String(config.sumCol).toLowerCase());

        if (groupIdx === -1 || sumIdx === -1) {
            throw new Error("Invalid column headers provided for groupBy or sumCol");
        }

        const results = {};

        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            const groupKey = String(row[groupIdx] || "Unknown").trim();
            const sumVal = parseFloat(row[sumIdx]) || 0;

            if (!results[groupKey]) {
                results[groupKey] = 0;
            }
            results[groupKey] += sumVal;
        }

        return JSON.stringify({
            status: "success",
            sheet: config.sheet,
            operation: "SUM",
            groupBy: config.groupBy,
            result: results
        });

    } catch (e) {
        return JSON.stringify({ status: "error", message: e.message });
    }
}

/**
 * PHASE 4: Memory Summarization (RAG Stub)
 * Analyzes recent PO and Movement sheets, creating English summary strings
 * stored in DB_Agent_Memories to act as a vector-searchable index.
 * 
 * Note: Designed to be called by a Time-Driven Trigger weekly.
 */
function buildAgentMemoriesWeekly() {
    console.log("Building Agentic Memories...");
    const ss = getSpreadsheet();
    let memorySheet = ss.getSheetByName("DB_Agent_Memories");

    if (!memorySheet) {
        memorySheet = ss.insertSheet("DB_Agent_Memories");
        memorySheet.appendRow(["Timestamp", "Category", "Memory_Summary"]);
        memorySheet.setFrozenRows(1);
    }

    try {
        // Example RAG chunk generation: High-Value POs
        const poSheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
        if (poSheet) {
            const data = poSheet.getDataRange().getValues();
            const h = getHeaderMap ? getHeaderMap(data[0]) : null;

            if (h && h['po id'] > -1 && h['total'] > -1 && h['status'] > -1) {
                for (let i = Math.max(1, data.length - 50); i < data.length; i++) {
                    const row = data[i];
                    const total = parseFloat(row[h['total']]) || 0;
                    if (total > 5000) { // Threshold for "Memory"
                        const poId = row[h['po id']];
                        const status = row[h['status']];
                        const summary = `High value purchase order ${poId} was created with a total of $${total}. Current status is ${status}.`;
                        memorySheet.appendRow([new Date(), "HIGH_VALUE_PO", summary]);
                    }
                }
            }
        }

        // Example RAG chunk generation: Critical Inventory
        const inventorySheet = ss.getSheetByName(DB_CONFIG.SHEET_ITEMS);
        if (inventorySheet) {
            const data = inventorySheet.getDataRange().getValues();
            const h = getHeaderMap ? getHeaderMap(data[0]) : null;

            if (h && h['stock id'] > -1 && h['current'] > -1 && h['rop'] > -1) {
                for (let i = 1; i < data.length; i++) {
                    const row = data[i];
                    const name = row[h['item name']];
                    const current = parseFloat(row[h['current']]) || 0;
                    const rop = parseFloat(row[h['rop']]) || 0;

                    if (rop > 0 && current === 0) {
                        const summary = `Critical out-of-stock event: ${name} hit 0 inventory (ROP was ${rop}).`;
                        memorySheet.appendRow([new Date(), "STOCKOUT", summary]);
                    }
                }
            }
        }

        return "Memories built successfully.";
    } catch (err) {
        console.error("Memory Build Error: " + err.message);
        return "Error: " + err.message;
    }
}

/**
 * Endpoint for the AI to query the semantic memory cache.
 */
function apiAgent_QueryMemories(categoryFilter = null) {
    try {
        const ss = getSpreadsheet();
        const memorySheet = ss.getSheetByName("DB_Agent_Memories");
        if (!memorySheet) return JSON.stringify({ status: "success", data: [] });

        const data = memorySheet.getDataRange().getValues();
        const results = [];

        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            const cat = row[1];
            const mem = row[2];

            if (!categoryFilter || categoryFilter === cat) {
                results.push({ timestamp: row[0], category: cat, summary: mem });
            }
        }

        // Return latest 50 memory chunks
        return JSON.stringify({ status: "success", count: results.length, data: results.reverse().slice(0, 50) });

    } catch (e) {
        return JSON.stringify({ status: "error", message: e.message });
    }
}

/**
 * PHASE 5: Specialized Movement Query (Date Range & Aggregation)
 * Solves the AI's inability to parse "blank headers" and paginate across multiple years.
 * 
 * @param {string} payloadString - { "startMonth": 9, "startYear": 2025, "endMonth": 2, "endYear": 2026 }
 * @returns {string} Highly aggregated movement data (Total IN, OUT, ADJ OUT per item)
 */
function apiAgent_QueryMovementRange(payloadString) {
    try {
        if (typeof assertPermission === 'function') {
            assertPermission(['ADMIN', 'EDITOR']);
        }

        const config = JSON.parse(payloadString);
        let { startMonth, startYear, endMonth, endYear } = config;

        // Convert 1-indexed (Jan=1) to 0-indexed (Jan=0) if the AI sends it that way.
        // Assuming AI sends 1-indexed for standard human queries (Sept = 9)
        startMonth = parseInt(startMonth) - 1;
        endMonth = parseInt(endMonth) - 1;
        startYear = parseInt(startYear);
        endYear = parseInt(endYear);

        if (isNaN(startMonth) || isNaN(startYear) || isNaN(endMonth) || isNaN(endYear)) {
            throw new Error("Missing or invalid date range parameters. Use 1-indexed months (e.g. Sept = 9).");
        }

        const ss = getSpreadsheet();
        const results = {}; // Map of stockId -> { name, totalOut, totalAdjOut }

        // Determine which years to scan
        const yearsToFetch = [];
        for (let y = startYear; y <= endYear; y++) {
            yearsToFetch.push(y);
        }

        yearsToFetch.forEach(y => {
            const movSheetName = `Movement ${y}`;
            const movSheet = ss.getSheetByName(movSheetName);

            if (!movSheet) return; // Skip if year doesn't exist

            const data = movSheet.getDataRange().getValues();
            if (data.length <= 2) return; // Skip if empty (Header + Subheader)

            for (let i = 2; i < data.length; i++) {
                const row = data[i];
                const id = String(row[0] || "").toUpperCase().trim();
                const name = String(row[1] || "Unknown");

                if (!id) continue;

                if (!results[id]) {
                    results[id] = { id: id, name: name, totalOut: 0, totalAdjOut: 0, totalIn: 0 };
                }

                // Iterate through months 0-11
                for (let m = 0; m < 12; m++) {
                    // Check if month falls within the requested range
                    const isAfterStart = (y > startYear) || (y === startYear && m >= startMonth);
                    const isBeforeEnd = (y < endYear) || (y === endYear && m <= endMonth);

                    if (isAfterStart && isBeforeEnd) {
                        // Formula from GS_Analytics logic:
                        // Jan: base=2 (IN), out=3, adjIn=4, adjOut=5, closing=6
                        const baseIdx = 2 + (m * 5);

                        const inQty = parseFloat(row[baseIdx]) || 0;
                        const outQty = parseFloat(row[baseIdx + 1]) || 0;
                        const adjOutQty = parseFloat(row[baseIdx + 3]) || 0;

                        results[id].totalIn += inQty;
                        results[id].totalOut += outQty;
                        results[id].totalAdjOut += adjOutQty;
                    }
                }
            }
        });

        // Convert object to array for easy sorting/filtering by AI
        const finalArray = Object.values(results);

        return JSON.stringify({
            status: "success",
            queryRange: `${startMonth + 1}/${startYear} to ${endMonth + 1}/${endYear}`,
            count: finalArray.length,
            data: finalArray
        });

    } catch (e) {
        return JSON.stringify({ status: "error", message: e.message });
    }
}
