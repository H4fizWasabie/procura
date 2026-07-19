// [file] GS_AI.js
/**
 * @fileoverview AI INTEGRATION — FULL AGENTIC SUITE (GEMINI ENGINE)
 * MODULE: AI
 * Features: Conversation memory, dynamic schema, 10 tools, page context,
 * aggregation, date filtering, cross-sheet join, ranking, chart data,
 * snapshot cache, scheduled digest, enhanced prompt.
 * Engine: Google Gemini API with model fallback chain.
 */

// ============================================================
// LEGACY: AI Insight (Gemini Engine)
// ============================================================

function apiGetAiInsight(context, dataPayload) {
  const apiKey = _getAIKey();
  if (!apiKey) return { success: false, error: "Missing API Key. Add GEMINI_API_KEY to Script Properties." };

  let systemPrompt = `You are the AI Analyst for ProcurePilot, a system used in Malaysia. 
  Financial data is in Malaysian Ringgit (RM). 
  Stock Movement data is ALWAYS in Units/Quantities (Qty), NOT RM.`;

  if (context.toLowerCase().includes("movement")) {
    systemPrompt += `\nTASK: Analyze item movement trends.\nFORMAT: Bulleted list (max 5 points).\nIMPORTANT: All numbers are UNITS (Qty), NOT RM.\nTONE: Formal, factual.`;
  } else if (context.toLowerCase().includes("dashboard")) {
    systemPrompt += `\nTASK: Summarize key metrics and alerts.\nFORMAT: Bulleted list (max 5 points).\nCONSTRAINTS: No advice/recommendations. Just facts.`;
  } else {
    systemPrompt += `\nTASK: Provide an Executive Summary.\nFORMAT: Bulleted list (max 5 points).\nTONE: Formal, highlighting key trends/outliers.`;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Context: ${context}\nData: ${JSON.stringify(dataPayload)}` }
  ];

  const result = _callAI(messages, GEMINI_MODELS.FAST, true);
  if (result.error) return { success: false, error: result.error };
  return { success: true, answer: result.choices[0].message.content };
}


// ============================================================
// AGENTIC AI — SYSTEM PROMPT BUILDER (#2, #3, #8, #9, #10)
// ============================================================

function _buildSystemPrompt(currentView, isComplex) {
  // Compact schema with value hints
  let schemaBlock = "";
  if (typeof DB_SCHEMA !== 'undefined') {
    const lines = [];
    for (let name in DB_SCHEMA) {
      lines.push(`${name}: ${DB_SCHEMA[name].join(',')}`);
    }
    schemaBlock = lines.join('\n');
  }

  // Movement sheets
  let movementInfo = "";
  try {
    const movSheets = getSpreadsheet().getSheets().map(s => s.getName()).filter(n => /^Movement\s+\d{4}$/i.test(n)).sort();
    if (movSheets.length > 0) movementInfo = `\nMovement Sheets: ${movSheets.join(',')} — cols: StockID, ItemName, 12mo×(IN,OUT,ADJIN,ADJOUT,CLOSING), YearlySummary`;
  } catch (e) { }

  const viewHint = currentView ? `\nUser is on "${currentView}" module.` : '';

  let prompt = `You are ProcurePilot AI — the intelligent procurement analyst for STARLiGHT Veterinary Center (Malaysia). Currency: RM (Malaysian Ringgit).

DATABASE SCHEMA:
${schemaBlock}${movementInfo}
Procurement Sheets: Procurement 2024, Procurement 2025, etc — cols: Invoice No, Invoice Date, Supplier, PO No, PO Date, DO No, DO Date, Department, Date Received, Total Amount, Invoice_Data_JSON, Timestamp

DATA RELATIONSHIPS (CRITICAL FOR CROSS-SHEET QUERIES):
- PurchaseOrder.Supplier → DB_Suppliers.Supplier Name (get contact info)
- PurchaseOrder.PO_Data_JSON → DB_Items.Stock ID (line items with qty/cost)
- DB_PRF.PRF_Data_JSON → DB_Items.Stock ID (requested items)
- RFQ_Logs.Supplier → DB_Suppliers.Supplier Name
- RFQ_Logs.RFQ_Data_JSON → DB_Items.Stock ID (quoted items)
- DB_Performance.PO ID → PurchaseOrder.PO ID (link ratings to POs)
- DB_Performance.Supplier Name → DB_Suppliers.Supplier Name
- Movement sheets.Stock ID → DB_Items.Stock ID (stock movements)
- DB_OrderReview.SKU → DB_Items.Stock ID (items needing reorder)
- DB_IncomingDocs.Ref No → PurchaseOrder.PO ID or Delivery Order number

DATA VALUE REFERENCE:
- PO Status: Pending Approval, Approved, Pending Payment, Partial, Paid, Void
- PRF Status: Pending, Approved, Rejected
- RFQ Status: Draft, Sent, Received, Closed
- Product Status: Active, Unavailable, Discontinued
- Item Behaviour: Standard, Pack, In-House Use, Service
- Departments: Pharmacy, Lab, Surgery, General, Admin
- Stock Health: Current < ROP = CRITICAL (needs reorder)
- Document Types: DO (Delivery Order), Invoice, GRN (Goods Received Note)

BUSINESS LOGIC:
- ROP (Reorder Point): When Current stock < ROP, item needs reorder immediately
- Stock Health %: (Current / ROP) * 100 — below 100% means below reorder point
- Velocity: Based on monthly usage from Movement sheets (Fast/Medium/Slow)
- Lead Time: Days between PO.Date and delivery date
- Payment Terms: Net 30, Net 60, COD (Cash on Delivery)
- PO Workflow: Created → Pending Approval → Approved → Pending Payment → Paid
- PRF Workflow: Created → Pending → Approved (creates PO) or Rejected
- Movement: IN=stock received, OUT=stock used/sold, ADJIN/ADJOUT=adjustments, CLOSING=end of month balance

AVAILABLE TOOLS AND WHEN TO USE THEM:
- listSheets: Discover what data exists (use FIRST if unsure about sheet names)
- searchInventoryItem: Find items by name or Stock ID
- getSupplierInfo: Get supplier contact and payment details
- querySheet: General data query with text/date filters
- queryAdvanced: Complex queries with multiple conditions (AND logic)
- getPurchaseOrderDetails: Full PO with line items
- getPRFDetails: Purchase request details
- getRFQDetails: Quotation request details
- getItemMovementHistory: Stock movement over time
- getPerformanceScores: Supplier performance ratings
- getOrderReviewItems: Items pending reorder decisions
- getIncomingDocuments: Track delivery orders and invoices
- aggregateData: SUM/COUNT/AVERAGE with optional GROUP BY
- getTopN: Ranking queries (top/bottom N)
- joinSheets: Combine data from two sheets on matching keys
- analyzeTrend: Time-series analysis (monthly/quarterly trends)
- getDashboardKPIs: Current system KPIs
- getSnapshotSummary: Quick system overview
- detectAnomalies: Find problems and outliers
- scanSheet: Raw data read for deep analysis
- getSystemLogs: Audit trail of user actions${viewHint}

REASONING STRATEGY:
1. PLAN first — think about which tools to call and in what order before acting.
2. Use listSheets to discover data structure when unsure about sheet names or column headers.
3. Use scanSheet for raw data reads when you need to analyze patterns across many rows.
4. Cross-reference between sheets using the relationship map above.
5. Use aggregateData with GROUP BY for 'by supplier', 'by category' questions.
6. Use queryAdvanced for complex multi-condition filters.
7. Use analyzeTrend for time-based analysis ('monthly', 'yearly' comparisons).
8. When asked complex questions, break them into sub-questions and gather data step by step.
9. VERIFY your findings — if numbers seem off, double-check with a different tool or approach.
10. For "why" questions, gather context from multiple sources before concluding.

MULTI-STEP EXAMPLES:
- "Which supplier has the best value?" → aggregateData on PO totals by supplier + getPerformanceScores + joinSheets for contact info
- "What should I reorder this month?" → getOrderReviewItems + searchInventoryItem for critical items + getItemMovementHistory for trends
- "Compare this year vs last year spending" → analyzeTrend with yearly period or aggregateData with date ranges
- "Show me all POs from Supplier X over RM 1000" → queryAdvanced with multiple filters
- "What's the monthly spending trend?" → analyzeTrend with monthly period on PurchaseOrder.Total

RULES:
- ALWAYS use tools for data — NEVER guess or fabricate numbers.
- Cite Stock IDs, PO IDs, PRF IDs, and supplier names when referencing specific records.
- If a tool returns an error, try an alternative approach (different sheet name, broader search).
- Current < ROP = reorder needed.
- Use joinSheets to combine related data from different sheets.
- For JSON columns (PO_Data_JSON, PRF_Data_JSON), the tool will parse them automatically.

FORMAT:
- **Bold** key values and names.
- Use bullet points for lists, markdown tables for 3+ comparable rows.
- Be thorough but concise — explain your reasoning when the analysis is complex.
- End with 💡 Insight (if notable pattern found) and 📋 Source (sheets queried).
- End with [SUGGEST]Q1|Q2|Q3[/SUGGEST] for smart follow-up questions.`;

  if (isComplex) {
    prompt += `\nCHART: Use [CHART]{"type":"bar","title":"","labels":[],"data":[],"dataLabel":""}[/CHART] when asked to visualize. Types: bar,line. Max 12 points.`;
  }

  return prompt;
}


// ============================================================
// TOOL DEFINITIONS (11 tools)
// ============================================================

const _AI_TOOLS = [
  {
    type: "function",
    function: {
      name: "searchInventoryItem",
      description: "Search inventory (DB_Items) for items by name or Stock ID. Returns stock levels, reorder points, cost, UOM, supplier, and status.",
      parameters: {
        type: "object",
        properties: {
          itemName: { type: "string", description: "Item name, partial name, or Stock ID to search" }
        },
        required: ["itemName"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getSupplierInfo",
      description: "Get supplier contact details, payment terms, and bank info from DB_Suppliers.",
      parameters: {
        type: "object",
        properties: {
          supplierName: { type: "string", description: "Supplier or company name" }
        },
        required: ["supplierName"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "querySheet",
      description: "Read data from any sheet with optional text filter and date range. Use for POs, PRFs, RFQs, performance scores, docs, logs.",
      parameters: {
        type: "object",
        properties: {
          sheetName: { type: "string", description: "Sheet name (e.g. 'PurchaseOrder', 'DB_PRF', 'DB_Performance')" },
          searchTerm: { type: "string", description: "Optional text filter (case-insensitive)" },
          fromDate: { type: "string", description: "Optional start date (YYYY-MM-DD). Filters rows where the first Date column >= this." },
          toDate: { type: "string", description: "Optional end date (YYYY-MM-DD). Filters rows where the first Date column <= this." },
          maxResults: { type: "number", description: "Max rows to return (default 20, max 50)" }
        },
        required: ["sheetName"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getPurchaseOrderDetails",
      description: "Get full PO details by PO ID, including line items (products, quantities, costs).",
      parameters: {
        type: "object",
        properties: {
          poId: { type: "string", description: "The PO ID (e.g. 'PO - 032026 - 001')" }
        },
        required: ["poId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getItemMovementHistory",
      description: "Get monthly stock movement (IN, OUT, Adj, Closing) for an item across years.",
      parameters: {
        type: "object",
        properties: {
          stockId: { type: "string", description: "Stock ID of the item" },
          year: { type: "number", description: "Optional specific year" }
        },
        required: ["stockId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getDashboardKPIs",
      description: "Get current KPIs: YTD spend, critical stock, pending approvals, top reorder alerts.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "aggregateData",
      description: "Run SUM, COUNT, AVERAGE, MIN, or MAX on a numeric column in any sheet. Can optionally filter by another column's value. Supports GROUP BY for grouped aggregations and date range filtering. Use for 'total spend by supplier', 'average cost by category', 'count of items by department', etc.",
      parameters: {
        type: "object",
        properties: {
          sheetName: { type: "string", description: "Sheet name" },
          column: { type: "string", description: "Column header to aggregate (e.g. 'Total', 'Cost', 'Weighted Score')" },
          operation: { type: "string", description: "SUM, COUNT, AVERAGE, MIN, or MAX" },
          filterColumn: { type: "string", description: "Optional column to filter by" },
          filterValue: { type: "string", description: "Optional value to match in filterColumn" },
          groupBy: { type: "string", description: "Optional column to group results by (e.g. 'Supplier', 'Category', 'Department')" },
          dateColumn: { type: "string", description: "Optional date column for filtering (e.g. 'Date', 'Timestamp')" },
          fromDate: { type: "string", description: "Optional start date (YYYY-MM-DD)" },
          toDate: { type: "string", description: "Optional end date (YYYY-MM-DD)" }
        },
        required: ["sheetName", "column", "operation"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getTopN",
      description: "Get the top or bottom N rows from a sheet sorted by a numeric column. Use for 'top 10 most expensive items', 'cheapest products', 'highest scoring suppliers'.",
      parameters: {
        type: "object",
        properties: {
          sheetName: { type: "string", description: "Sheet name" },
          sortColumn: { type: "string", description: "Column header to sort by (must be numeric)" },
          n: { type: "number", description: "Number of rows (default 10)" },
          ascending: { type: "boolean", description: "true for lowest first, false (default) for highest first" }
        },
        required: ["sheetName", "sortColumn"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "joinSheets",
      description: "Join/correlate data from two sheets on a shared key. Use for 'which supplier has the most POs', 'PO details with supplier contact info', etc.",
      parameters: {
        type: "object",
        properties: {
          sheet1: { type: "string", description: "First sheet name" },
          sheet2: { type: "string", description: "Second sheet name" },
          joinColumn1: { type: "string", description: "Column header in sheet1 to join on (e.g. 'Supplier')" },
          joinColumn2: { type: "string", description: "Column header in sheet2 to join on (e.g. 'Supplier Name')" },
          maxResults: { type: "number", description: "Max rows (default 15)" }
        },
        required: ["sheet1", "sheet2", "joinColumn1", "joinColumn2"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getSnapshotSummary",
      description: "Get a pre-built quick summary of the entire system: item counts by category, supplier count, PO count by status, critical stock count, YTD spend. Use for broad overview questions.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "detectAnomalies",
      description: "Scan for anomalies and outliers across the system: items below ROP, zero-movement items, spending spikes, potential duplicate items, stale POs. Use when the user asks to 'find problems', 'check anomalies', 'what needs attention', or 'health check'.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", description: "Optional focus area: 'inventory', 'spending', 'suppliers', or 'all' (default)" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "listSheets",
      description: "List all available sheet names in the database with their headers and row counts. Use this FIRST when you need to discover what data exists or figure out the correct sheet/column names before querying.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "scanSheet",
      description: "Read raw data from any sheet with full row content. Returns all columns for each row. Use for deep analysis, cross-referencing, or when you need to see the actual data. Supports pagination for large sheets.",
      parameters: {
        type: "object",
        properties: {
          sheetName: { type: "string", description: "Sheet name to scan" },
          startRow: { type: "number", description: "Start row (1-indexed, row 1 = first data row after headers). Default 1." },
          maxRows: { type: "number", description: "Max rows to return (default 30, max 100)" },
          columns: { type: "string", description: "Optional comma-separated column headers to return (e.g. 'Stock ID,Item Name,Current'). Returns all if omitted." }
        },
        required: ["sheetName"]
      }
    }
  },
  // ===== NEW TOOLS FOR COMPLETE DATABASE ACCESS =====
  {
    type: "function",
    function: {
      name: "getPRFDetails",
      description: "Get Purchase Request Form (PRF) details by PRF ID. Returns requester, department, status, and line items.",
      parameters: {
        type: "object",
        properties: {
          prfId: { type: "string", description: "The PRF ID (e.g. 'PRF - 032026 - 001')" }
        },
        required: ["prfId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getRFQDetails",
      description: "Get Request for Quotation (RFQ) details by RFQ ID. Returns supplier, items, and status.",
      parameters: {
        type: "object",
        properties: {
          rfqId: { type: "string", description: "The RFQ ID (e.g. 'RFQ - 032026 - 001')" }
        },
        required: ["rfqId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getPerformanceScores",
      description: "Get supplier performance ratings and scores. Can filter by supplier name or get top performers.",
      parameters: {
        type: "object",
        properties: {
          supplierName: { type: "string", description: "Optional supplier name to filter" },
          minScore: { type: "number", description: "Optional minimum weighted score filter" },
          limit: { type: "number", description: "Max results to return (default 20)" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getOrderReviewItems",
      description: "Get items from Order Review sheet. Shows items needing reorder decisions with stock levels and ROP.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Optional status filter: 'Pending', 'Approved', 'Rejected'" },
          category: { type: "string", description: "Optional category filter" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getIncomingDocuments",
      description: "Get incoming documents (delivery orders, invoices, etc.) with status tracking.",
      parameters: {
        type: "object",
        properties: {
          docType: { type: "string", description: "Optional document type filter: 'DO', 'Invoice', 'GRN'" },
          status: { type: "string", description: "Optional status filter: 'Pending', 'Received', 'Verified'" },
          supplier: { type: "string", description: "Optional supplier name filter" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "queryAdvanced",
      description: "Advanced query with multiple filter conditions, sorting, and column selection. Use for complex queries like 'POs from Supplier X with total > 1000 in 2025'.",
      parameters: {
        type: "object",
        properties: {
          sheetName: { type: "string", description: "Sheet name to query" },
          filters: { 
            type: "array", 
            description: "Array of filter conditions: [{column, operator, value}]. Operators: eq, neq, gt, lt, gte, lte, contains, startsWith, endsWith",
            items: {
              type: "object",
              properties: {
                column: { type: "string", description: "Column header to filter on" },
                operator: { type: "string", description: "Comparison operator: eq, neq, gt, lt, gte, lte, contains, startsWith, endsWith" },
                value: { type: "string", description: "Value to compare against" }
              }
            }
          },
          sortBy: { type: "string", description: "Optional column to sort by" },
          sortOrder: { type: "string", description: "Sort order: 'asc' or 'desc' (default: desc)" },
          selectColumns: { type: "string", description: "Optional comma-separated columns to return (default: all)" },
          limit: { type: "number", description: "Max rows to return (default 30, max 100)" }
        },
        required: ["sheetName"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyzeTrend",
      description: "Analyze trends over time for any metric. Groups data by time period and calculates aggregates. Use for 'monthly spending trend', 'weekly PO count', 'quarterly inventory value'.",
      parameters: {
        type: "object",
        properties: {
          sheetName: { type: "string", description: "Sheet name" },
          dateColumn: { type: "string", description: "Column containing dates (e.g. 'Date', 'Timestamp')" },
          valueColumn: { type: "string", description: "Column with values to analyze (e.g. 'Total', 'Cost')" },
          metric: { type: "string", description: "Aggregation: SUM, COUNT, AVERAGE (default: SUM)" },
          period: { type: "string", description: "Grouping period: 'daily', 'weekly', 'monthly', 'quarterly', 'yearly' (default: monthly)" },
          fromDate: { type: "string", description: "Optional start date (YYYY-MM-DD)" },
          toDate: { type: "string", description: "Optional end date (YYYY-MM-DD)" }
        },
        required: ["sheetName", "dateColumn", "valueColumn"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getSystemLogs",
      description: "Get system audit logs showing user actions, AI queries, and system events.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Optional action filter (e.g. 'AI_QUERY', 'CREATE_PO', 'DELETE')" },
          user: { type: "string", description: "Optional user email filter" },
          limit: { type: "number", description: "Max entries to return (default 20)" }
        },
        required: []
      }
    }
  }
];


// ============================================================
// ENTRY POINT (#1 — Conversation Memory, #3 — Page Context)
// ============================================================

/**
 * @param {Object} payload - { message: string, history: [{role, content}], currentView: string }
 *   OR  {string} legacy - plain string message
 */
function askAgenticAI(payload) {
  try {
    // Check for at least one API key (OpenRouter is primary, Gemini is fallback)
    const openRouterKey = PropertiesService.getScriptProperties().getProperty('OPENROUTER_API_KEY');
    const geminiKey = _getAIKey();
    
    if (!openRouterKey && !geminiKey) {
      return { success: false, error: "AI not configured. Add OPENROUTER_API_KEY (primary) or GEMINI_API_KEY (fallback) to Script Properties." };
    }

    let userMessage, history, currentView;
    if (typeof payload === 'string') {
      userMessage = payload;
      history = [];
      currentView = '';
    } else {
      userMessage = payload.message || '';
      history = payload.history || [];
      currentView = payload.currentView || '';
    }

    if (!userMessage.trim()) return { success: false, error: "Empty message." };

    // Smart routing
    const complexity = _classifyComplexity(userMessage);
    const isComplex = complexity === 'complex';
    const modelName = isComplex ? GEMINI_MODELS.COMPLEX : GEMINI_MODELS.FAST;

    // Build optimized system prompt (shorter for simple queries)
    const systemPrompt = _buildSystemPrompt(currentView, isComplex);
    const messages = [{ role: "system", content: systemPrompt }];

    // Slim history: fewer msgs for simple, strip tags, truncate
    const slimmed = _slimHistory(history, isComplex ? 10 : 6);
    slimmed.forEach(m => messages.push(m));

    messages.push({ role: "user", content: userMessage });

    const toolsUsed = [];

    // Select only relevant tools based on query intent (performance optimization)
    const selectedTools = _selectTools(userMessage);

    // Agentic loop — all queries get tool access, thinking enabled for complex
    const MAX_ROUNDS = 8;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Truncate prior tool results to prevent token snowball
      if (round > 0) _truncatePriorToolResults(messages);

      const response = _callAI(messages, modelName, false, 2048, selectedTools, isComplex);
      if (response.error) return { success: false, error: response.error };

      const assistantMsg = response.choices[0].message;
      messages.push(assistantMsg);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        for (const toolCall of assistantMsg.tool_calls) {
          let args = {};
          try { args = JSON.parse(toolCall.function.arguments); } catch (e) { args = {}; }
          toolsUsed.push(toolCall.function.name);
          const rawResult = _dispatchTool(toolCall.function.name, args);
          const compressed = _compressResult(rawResult);
          messages.push({ role: "tool", tool_call_id: toolCall.id, _toolName: toolCall.function.name, content: JSON.stringify(compressed) });
        }
        continue;
      }

      if (assistantMsg.content) {
        _logAIAudit(userMessage, toolsUsed, true, modelName);
        return { success: true, answer: assistantMsg.content, toolsUsed: toolsUsed, model: modelName };
      }
      _logAIAudit(userMessage, toolsUsed, false, modelName);
      return { success: true, answer: "I couldn't generate a response. Please try rephrasing.", toolsUsed: toolsUsed };
    }

    _logAIAudit(userMessage, toolsUsed, true, modelName);
    return { success: true, answer: "I've completed my research but couldn't find a definitive answer. Try a more specific question.", toolsUsed: toolsUsed };

  } catch (e) {
    logError('askAgenticAI', e);
    return { success: false, error: "AI Error: " + e.message };
  }
}


// ============================================================
// TOOL DISPATCHER
// ============================================================

function _dispatchTool(name, args) {
  switch (name) {
    case 'searchInventoryItem': return _toolSearchInventory(args.itemName || "");
    case 'getSupplierInfo': return _toolGetSupplier(args.supplierName || "");
    case 'querySheet': return _toolQuerySheet(args.sheetName || "", args.searchTerm || "", args.maxResults || 10, args.fromDate || "", args.toDate || "");
    case 'getPurchaseOrderDetails': return _toolGetPODetails(args.poId || "");
    case 'getItemMovementHistory': return _toolGetMovement(args.stockId || "", args.year || null);
    case 'getDashboardKPIs': return _toolGetDashboard();
    case 'aggregateData': return _toolAggregate(args.sheetName || "", args.column || "", args.operation || "SUM", args.filterColumn || "", args.filterValue || "", args.groupBy || "", args.dateColumn || "", args.fromDate || "", args.toDate || "");
    case 'getTopN': return _toolTopN(args.sheetName || "", args.sortColumn || "", args.n || 10, args.ascending || false);
    case 'joinSheets': return _toolJoinSheets(args.sheet1 || "", args.sheet2 || "", args.joinColumn1 || "", args.joinColumn2 || "", args.maxResults || 15);
    case 'getSnapshotSummary': return _toolSnapshot();
    case 'detectAnomalies': return _toolDetectAnomalies(args.scope || 'all');
    case 'listSheets': return _toolListSheets();
    case 'scanSheet': return _toolScanSheet(args.sheetName || "", args.startRow || 1, args.maxRows || 30, args.columns || "");
    // New tools
    case 'getPRFDetails': return _toolGetPRFDetails(args.prfId || "");
    case 'getRFQDetails': return _toolGetRFQDetails(args.rfqId || "");
    case 'getPerformanceScores': return _toolGetPerformanceScores(args.supplierName || "", args.minScore || 0, args.limit || 20);
    case 'getOrderReviewItems': return _toolGetOrderReviewItems(args.status || "", args.category || "");
    case 'getIncomingDocuments': return _toolGetIncomingDocuments(args.docType || "", args.status || "", args.supplier || "");
    case 'queryAdvanced': return _toolQueryAdvanced(args.sheetName || "", args.filters || [], args.sortBy || "", args.sortOrder || "desc", args.selectColumns || "", args.limit || 30);
    case 'analyzeTrend': return _toolAnalyzeTrend(args.sheetName || "", args.dateColumn || "", args.valueColumn || "", args.metric || "SUM", args.period || "monthly", args.fromDate || "", args.toDate || "");
    case 'getSystemLogs': return _toolGetSystemLogs(args.action || "", args.user || "", args.limit || 20);
    default: return { error: "Unknown function: " + name };
  }
}


// ============================================================
// TOOL: List All Sheets (Schema Discovery)
// ============================================================

function _toolListSheets() {
  // Use caching for sheet listing (doesn't change often)
  return _getCachedOrCompute('AI_LIST_SHEETS', () => {
    const ss = getSpreadsheet();
    const sheets = ss.getSheets();
    const result = [];

    for (const sheet of sheets) {
      const name = sheet.getName();
      if (name === 'System_Users') continue; // Access denied

      const lastRow = sheet.getLastRow();
      const lastCol = sheet.getLastColumn();
      const info = { sheetName: name, totalRows: Math.max(0, lastRow - 1), totalColumns: lastCol };

      if (lastCol > 0 && lastRow > 0) {
        info.headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
      }

      result.push(info);
    }

    return { sheetsFound: result.length, sheets: result };
  }, 600); // Cache for 10 minutes
}


// ============================================================
// TOOL: Scan Sheet (Full Raw Read with Pagination)
// ============================================================

function _toolScanSheet(sheetName, startRow, maxRows, columns) {
  if (!sheetName) return { error: "Sheet name required." };
  if (['System_Users'].includes(sheetName)) return { error: "Access denied." };

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `Sheet "${sheetName}" not found.` };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return { results: [], message: "Sheet is empty.", sheetName };

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const cap = Math.min(Math.max(maxRows || 30, 1), 100);
  const dataStartRow = Math.max(1, startRow); // 1-indexed data row (after headers)
  const actualStartRow = dataStartRow + 1; // sheet row (row 2 = first data row)

  if (actualStartRow > lastRow) return { results: [], message: "Start row exceeds data range.", sheetName, totalRows: lastRow - 1 };

  const numRows = Math.min(cap, lastRow - actualStartRow + 1);
  const data = sheet.getRange(actualStartRow, 1, numRows, lastCol).getValues();

  // Column filtering
  let selectedIndices = null;
  let selectedHeaders = headers;
  if (columns && columns.trim()) {
    const requestedCols = columns.split(',').map(c => c.trim());
    selectedIndices = [];
    selectedHeaders = [];
    for (const col of requestedCols) {
      const idx = headers.indexOf(col);
      if (idx > -1) {
        selectedIndices.push(idx);
        selectedHeaders.push(col);
      }
    }
    if (selectedIndices.length === 0) {
      return { error: `None of the requested columns found. Available: ${headers.join(', ')}` };
    }
  }

  const results = data.map(row => {
    const obj = {};
    const indices = selectedIndices || headers.map((_, i) => i);
    const hdrs = selectedHeaders;
    indices.forEach((colIdx, i) => {
      const val = row[colIdx];
      // Skip JSON blob columns to save tokens
      if (headers[colIdx].endsWith('_JSON')) {
        obj[hdrs[i]] = val ? '[JSON_DATA]' : null;
      } else {
        obj[hdrs[i]] = (val instanceof Date) ? val.toISOString().split('T')[0] : val;
      }
    });
    return obj;
  });

  return {
    sheetName,
    headers: selectedHeaders,
    totalRows: lastRow - 1,
    returnedRows: results.length,
    startRow: dataStartRow,
    hasMore: (actualStartRow + numRows - 1) < lastRow,
    nextStartRow: dataStartRow + numRows,
    results
  };
}


// ============================================================
// TOOL: Search Inventory
// ============================================================

function _toolSearchInventory(itemName) {
  if (!itemName) return { results: [], message: "No item name provided." };
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName((typeof DB_CONFIG !== 'undefined') ? DB_CONFIG.SHEET_ITEMS : "DB_Items");
  if (!sheet) return { results: [], message: "Inventory sheet not found." };

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { results: [], message: "Inventory is empty." };

  const headers = data[0];
  const h = {}; headers.forEach((n, i) => { h[String(n).trim()] = i; });
  const searchLower = String(itemName).toLowerCase().trim();
  const matches = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const name = String(row[h['Item Name']] || '').toLowerCase();
    const id = String(row[h['Stock ID']] || '').toLowerCase();

    if (name.includes(searchLower) || searchLower.includes(name) || id.includes(searchLower)) {
      const current = Number(row[h['Current']] || 0);
      const rop = Number(row[h['ROP']] || 0);
      matches.push({
        stockId: String(row[h['Stock ID']] || ''), itemName: String(row[h['Item Name']] || ''),
        category: String(row[h['Category']] || ''), productType: String(row[h['Product Type']] || ''),
        currentStock: current, reorderPoint: rop, cost: Number(row[h['Cost']] || 0),
        sellingPrice: Number(row[h['Selling']] || 0), uom: String(row[h['UOM']] || ''),
        packSize: String(row[h['Pack Size']] || ''), supplier: String(row[h['Supplier']] || ''),
        productStatus: String(row[h['Product Status']] || ''),
        itemBehaviour: String(row[h['Item Behaviour']] || ''),
        stockHealth: (rop > 0 && current < rop) ? "CRITICAL" : "OK"
      });
      if (matches.length >= 8) break;
    }
  }
  return matches.length === 0
    ? { results: [], message: `No items matching "${itemName}".` }
    : { results: matches, totalFound: matches.length };
}


// ============================================================
// TOOL: Get Supplier Info
// ============================================================

function _toolGetSupplier(supplierName) {
  if (!supplierName) return { results: [], message: "No supplier name provided." };
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName((typeof DB_CONFIG !== 'undefined') ? DB_CONFIG.SHEET_SUPPLIERS : "DB_Suppliers");
  if (!sheet) return { results: [], message: "Suppliers sheet not found." };

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { results: [], message: "Empty." };
  const headers = data[0];
  const h = {}; headers.forEach((n, i) => { h[String(n).trim()] = i; });
  const searchLower = String(supplierName).toLowerCase().trim();
  const matches = [];

  for (let i = 1; i < data.length; i++) {
    const name = String(data[i][h['Supplier Name']] || '').toLowerCase();
    if (name.includes(searchLower) || searchLower.includes(name)) {
      const row = data[i];
      matches.push({
        supplierName: String(row[h['Supplier Name']] || ''), contactPerson: String(row[h['Contact Person']] || ''),
        phone: String(row[h['Phone']] || ''), email: String(row[h['Email']] || ''),
        address: String(row[h['Address']] || ''), paymentTerms: String(row[h['Payment Terms']] || ''),
        brn: String(row[h['BRN']] || ''), accountNo: String(row[h['Account No']] || ''),
        bankName: String(row[h['Bank Name']] || '')
      });
      if (matches.length >= 5) break;
    }
  }
  return matches.length === 0
    ? { results: [], message: `No suppliers matching "${supplierName}".` }
    : { results: matches, totalFound: matches.length };
}


// ============================================================
// TOOL: Universal Sheet Query (#5 — Date Filtering)
// ============================================================

function _toolQuerySheet(sheetName, searchTerm, maxResults, fromDate, toDate) {
  if (!sheetName) return { error: "Sheet name required." };
  if (['System_Users'].includes(sheetName)) return { error: "Access denied." };

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `Sheet "${sheetName}" not found.` };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { results: [], message: "Sheet is empty.", sheetName };

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const cap = Math.min(Math.max(maxResults || 20, 1), 50);

  // Find date column index for date filtering
  let dateColIdx = -1;
  if (fromDate || toDate) {
    const dateNames = ['Date', 'Timestamp', 'Date Uploaded'];
    for (const dn of dateNames) {
      const idx = headers.indexOf(dn);
      if (idx > -1) { dateColIdx = idx; break; }
    }
  }

  const parsedFrom = fromDate ? new Date(fromDate) : null;
  const parsedTo = toDate ? new Date(toDate) : null;
  // Set toDate to end of day
  if (parsedTo) parsedTo.setHours(23, 59, 59, 999);

  const data = sheet.getDataRange().getValues();
  const hasSearch = searchTerm && searchTerm.trim() !== "";
  const searchLower = hasSearch ? String(searchTerm).toLowerCase().trim() : "";
  const hasDateFilter = dateColIdx > -1 && (parsedFrom || parsedTo);
  const matches = [];

  for (let i = data.length - 1; i >= 1; i--) {
    const row = data[i];

    // Date filter
    if (hasDateFilter) {
      let cellDate = row[dateColIdx];
      if (typeof cellDate === 'string') cellDate = new Date(cellDate);
      if (cellDate instanceof Date && !isNaN(cellDate.getTime())) {
        if (parsedFrom && cellDate < parsedFrom) continue;
        if (parsedTo && cellDate > parsedTo) continue;
      } else {
        continue; // Skip rows without valid dates when date filter is active
      }
    }

    // Text search
    if (hasSearch) {
      const rowStr = row.join(" ").toLowerCase();
      if (!rowStr.includes(searchLower)) continue;
    }

    matches.push(_rowToObj(row, headers));
    if (matches.length >= cap) break;
  }

  return { sheetName, headers, totalRows: lastRow - 1, returnedRows: matches.length, results: matches };
}

function _rowToObj(row, headers) {
  const obj = {};
  headers.forEach((h, idx) => {
    const val = row[idx];
    if (h === 'PO_Data_JSON' || h === 'PRF_Data_JSON' || h === 'RFQ_Data_JSON') {
      try { obj[h + '_parsed'] = JSON.parse(val); } catch (e) { obj[h + '_parsed'] = null; }
      return;
    }
    obj[h] = (val instanceof Date) ? val.toISOString().split('T')[0] : val;
  });
  return obj;
}


// ============================================================
// TOOL: PO Details
// ============================================================

function _toolGetPODetails(poId) {
  if (!poId) return { error: "PO ID required." };
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName((typeof DB_CONFIG !== 'undefined') ? DB_CONFIG.SHEET_PO : "PurchaseOrder");
  if (!sheet) return { error: "PurchaseOrder sheet not found." };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const idIdx = headers.indexOf('PO ID');
  if (idIdx === -1) return { error: "PO ID column missing." };

  const idCol = sheet.getRange(2, idIdx + 1, lastRow - 1, 1).getValues().flat();
  const searchId = String(poId).trim();
  let foundIdx = -1;

  for (let i = 0; i < idCol.length; i++) {
    if (String(idCol[i]).trim() === searchId) { foundIdx = i; break; }
  }
  if (foundIdx === -1) {
    for (let i = idCol.length - 1; i >= 0; i--) {
      if (String(idCol[i]).toLowerCase().includes(searchId.toLowerCase())) { foundIdx = i; break; }
    }
  }
  if (foundIdx === -1) return { error: `PO "${poId}" not found.` };

  const rowData = sheet.getRange(foundIdx + 2, 1, 1, lastCol).getValues()[0];
  const result = {};
  headers.forEach((h, i) => {
    const val = rowData[i];
    if (h === 'PO_Data_JSON') {
      try {
        const items = JSON.parse(val);
        result.lineItems = items.map((item, idx) => ({
          no: idx + 1, stockId: item.id || '', name: item.n || '',
          qty: item.q || 0, unitCost: item.c || 0, total: item.t || 0, uom: item.u || 'UNIT'
        }));
      } catch (e) { result.lineItems = []; }
    } else {
      result[h] = (val instanceof Date) ? val.toISOString().split('T')[0] : val;
    }
  });
  return result;
}


// ============================================================
// TOOL: Movement History
// ============================================================

function _toolGetMovement(stockId, year) {
  if (!stockId) return { error: "Stock ID required." };
  const ss = getSpreadsheet();
  const targetId = String(stockId).trim().toUpperCase();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const timeline = [];
  const startY = year || 2024;
  const endY = year || new Date().getFullYear();

  for (let y = startY; y <= endY; y++) {
    const sheet = ss.getSheetByName(`Movement ${y}`);
    if (!sheet || sheet.getLastRow() < 3) continue;
    const data = sheet.getRange(3, 1, sheet.getLastRow() - 2, 68).getValues();
    const row = data.find(r => String(r[0]).trim().toUpperCase() === targetId);
    if (!row) continue;

    for (let m = 0; m < 12; m++) {
      const base = 2 + (m * 5);
      if (base + 4 >= row.length) break;
      const vals = { in: Number(row[base] || 0), out: Number(row[base + 1] || 0), adjIn: Number(row[base + 2] || 0), adjOut: Number(row[base + 3] || 0), closing: Number(row[base + 4] || 0) };
      if (vals.in || vals.out || vals.adjIn || vals.adjOut || vals.closing) {
        timeline.push({ period: `${months[m]} ${y}`, ...vals, netFlow: vals.in + vals.adjIn - vals.out - vals.adjOut });
      }
    }
    if (row.length >= 68) {
      timeline.push({ period: `SUMMARY ${y}`, unitCost: Number(row[62] || 0), totalIn: Number(row[63] || 0), totalOut: Number(row[64] || 0), totalAdj: Number(row[65] || 0), turnoverRate: Number(row[66] || 0), usageValueRM: Number(row[67] || 0) });
    }
  }
  return timeline.length === 0
    ? { stockId, message: `No movement data for "${stockId}".`, timeline: [] }
    : { stockId, timeline, periodsFound: timeline.length };
}


// ============================================================
// TOOL: Dashboard KPIs
// ============================================================

function _toolGetDashboard() {
  try {
    const result = apiGetDashboardStats();
    if (!result.success) return { error: result.error || "Failed." };
    const d = result.data;
    return {
      ytdSpend_RM: d.financials.ytdSpend,
      pendingApprovals: d.operations.pendingApprovals,
      pendingPayment: d.operations.pendingPayment,
      totalInventoryItems: d.inventory.totalItems,
      criticalStockCount: d.inventory.criticalStock,
      top10ReorderAlerts: d.ropAlerts.map(a => ({
        stockId: a.id, name: a.name, currentStock: a.current,
        reorderPoint: a.rop, gap: a.gap, estimatedCostRM: a.cost,
        healthPercent: Math.round(a.health)
      }))
    };
  } catch (e) { return { error: "Dashboard error: " + e.message }; }
}


// ============================================================
// TOOL #4: Aggregation
// ============================================================

function _toolAggregate(sheetName, column, operation, filterColumn, filterValue) {
  if (!sheetName || !column) return { error: "sheetName and column required." };
  if (['System_Users'].includes(sheetName)) return { error: "Access denied." };

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `Sheet "${sheetName}" not found.` };

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { error: "Sheet is empty." };

  const headers = data[0].map(h => String(h).trim());
  const colIdx = headers.indexOf(column);
  if (colIdx === -1) return { error: `Column "${column}" not found. Available: ${headers.join(', ')}` };

  const filterIdx = filterColumn ? headers.indexOf(filterColumn) : -1;
  const filterLower = filterValue ? String(filterValue).toLowerCase().trim() : "";
  const op = String(operation).toUpperCase();

  const values = [];
  for (let i = 1; i < data.length; i++) {
    // Apply filter
    if (filterIdx > -1 && filterLower) {
      const cellVal = String(data[i][filterIdx] || '').toLowerCase().trim();
      if (!cellVal.includes(filterLower)) continue;
    }

    const raw = data[i][colIdx];
    const num = (typeof raw === 'number') ? raw : parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
    if (!isNaN(num)) values.push(num);
  }

  if (values.length === 0) return { result: 0, operation: op, column, rowsMatched: 0, message: "No numeric values found." };

  let result;
  switch (op) {
    case 'SUM': result = values.reduce((a, b) => a + b, 0); break;
    case 'COUNT': result = values.length; break;
    case 'AVERAGE': result = values.reduce((a, b) => a + b, 0) / values.length; break;
    case 'MIN': result = Math.min(...values); break;
    case 'MAX': result = Math.max(...values); break;
    default: return { error: `Unknown operation "${op}". Use SUM, COUNT, AVERAGE, MIN, MAX.` };
  }

  return {
    sheetName, column, operation: op, result: Math.round(result * 100) / 100,
    rowsMatched: values.length,
    filter: filterColumn ? `${filterColumn} contains "${filterValue}"` : "none"
  };
}


// ============================================================
// TOOL #7: Top-N Ranking
// ============================================================

function _toolTopN(sheetName, sortColumn, n, ascending) {
  if (!sheetName || !sortColumn) return { error: "sheetName and sortColumn required." };
  if (['System_Users'].includes(sheetName)) return { error: "Access denied." };

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `Sheet "${sheetName}" not found.` };

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { error: "Sheet is empty." };

  const headers = data[0].map(h => String(h).trim());
  const sortIdx = headers.indexOf(sortColumn);
  if (sortIdx === -1) return { error: `Column "${sortColumn}" not found. Available: ${headers.join(', ')}` };

  const cap = Math.min(Math.max(n || 10, 1), 50);
  const rows = [];

  for (let i = 1; i < data.length; i++) {
    const raw = data[i][sortIdx];
    const num = (typeof raw === 'number') ? raw : parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
    if (!isNaN(num)) {
      rows.push({ _sortVal: num, ..._rowToObj(data[i], headers) });
    }
  }

  rows.sort((a, b) => ascending ? a._sortVal - b._sortVal : b._sortVal - a._sortVal);
  const topRows = rows.slice(0, cap);
  topRows.forEach((r, i) => { r._rank = i + 1; delete r._sortVal; });

  return { sheetName, sortColumn, order: ascending ? "ascending" : "descending", results: topRows, totalEligible: rows.length };
}


// ============================================================
// TOOL #6: Cross-Sheet Join
// ============================================================

function _toolJoinSheets(sheet1Name, sheet2Name, joinCol1, joinCol2, maxResults) {
  if (!sheet1Name || !sheet2Name || !joinCol1 || !joinCol2) return { error: "All params required." };
  if (['System_Users'].includes(sheet1Name) || ['System_Users'].includes(sheet2Name)) return { error: "Access denied." };

  const ss = getSpreadsheet();
  const s1 = ss.getSheetByName(sheet1Name);
  const s2 = ss.getSheetByName(sheet2Name);
  if (!s1) return { error: `Sheet "${sheet1Name}" not found.` };
  if (!s2) return { error: `Sheet "${sheet2Name}" not found.` };

  const d1 = s1.getDataRange().getValues();
  const d2 = s2.getDataRange().getValues();
  if (d1.length < 2 || d2.length < 2) return { error: "One or both sheets are empty." };

  const h1 = d1[0].map(h => String(h).trim());
  const h2 = d2[0].map(h => String(h).trim());
  const idx1 = h1.indexOf(joinCol1);
  const idx2 = h2.indexOf(joinCol2);
  if (idx1 === -1) return { error: `Column "${joinCol1}" not in ${sheet1Name}. Available: ${h1.join(', ')}` };
  if (idx2 === -1) return { error: `Column "${joinCol2}" not in ${sheet2Name}. Available: ${h2.join(', ')}` };

  // Index sheet2 by join key
  const s2Index = new Map();
  for (let i = 1; i < d2.length; i++) {
    const key = String(d2[i][idx2] || '').toLowerCase().trim();
    if (key && !s2Index.has(key)) {
      s2Index.set(key, _rowToObj(d2[i], h2));
    }
  }

  const cap = Math.min(maxResults || 15, 30);
  const joined = [];

  for (let i = d1.length - 1; i >= 1; i--) {
    const key = String(d1[i][idx1] || '').toLowerCase().trim();
    if (!key) continue;

    const match = s2Index.get(key);
    if (match) {
      const row1 = _rowToObj(d1[i], h1);
      // Prefix sheet2 columns to avoid collision
      const combined = { ...row1 };
      for (const k in match) {
        combined[`${sheet2Name}.${k}`] = match[k];
      }
      joined.push(combined);
      if (joined.length >= cap) break;
    }
  }

  return {
    joinedOn: `${sheet1Name}.${joinCol1} = ${sheet2Name}.${joinCol2}`,
    results: joined,
    matchedRows: joined.length
  };
}


// ============================================================
// TOOL #11: Snapshot Summary Cache
// ============================================================

function _toolSnapshot() {
  // Check cache first (10 min TTL)
  const cache = CacheService.getScriptCache();
  const cached = cache.get('AI_SNAPSHOT');
  if (cached) { try { return JSON.parse(cached); } catch (e) { } }

  const ss = getSpreadsheet();
  const snap = {};

  // Inventory summary
  try {
    const iSheet = ss.getSheetByName(DB_CONFIG.SHEET_ITEMS);
    if (iSheet) {
      const iData = iSheet.getDataRange().getValues();
      const iH = iData[0].map(h => String(h).trim());
      const catIdx = iH.indexOf('Category');
      const curIdx = iH.indexOf('Current');
      const ropIdx = iH.indexOf('ROP');
      const statusIdx = iH.indexOf('Product Status');

      const byCat = {};
      let total = 0, critical = 0, unavailable = 0;

      for (let i = 1; i < iData.length; i++) {
        total++;
        const cat = String(iData[i][catIdx] || 'Uncategorized');
        byCat[cat] = (byCat[cat] || 0) + 1;
        if (statusIdx > -1 && String(iData[i][statusIdx]).toLowerCase() === 'unavailable') unavailable++;
        const cur = Number(iData[i][curIdx] || 0);
        const rop = Number(iData[i][ropIdx] || 0);
        if (rop > 0 && cur < rop) critical++;
      }
      snap.inventory = { totalItems: total, criticalStock: critical, unavailable, byCategory: byCat };
    }
  } catch (e) { snap.inventory = { error: e.message }; }

  // Supplier count
  try {
    const sSheet = ss.getSheetByName(DB_CONFIG.SHEET_SUPPLIERS);
    if (sSheet) snap.supplierCount = Math.max(0, sSheet.getLastRow() - 1);
  } catch (e) { }

  // PO summary
  try {
    const pSheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
    if (pSheet && pSheet.getLastRow() > 1) {
      const pData = pSheet.getDataRange().getValues();
      const pH = pData[0].map(h => String(h).trim());
      const sIdx = pH.indexOf('Status');
      const byStatus = {};
      for (let i = 1; i < pData.length; i++) {
        const st = String(pData[i][sIdx] || 'Unknown');
        byStatus[st] = (byStatus[st] || 0) + 1;
      }
      snap.purchaseOrders = { total: pData.length - 1, byStatus };
    }
  } catch (e) { }

  // PRF count
  try {
    const prfSheet = ss.getSheetByName(DB_CONFIG.SHEET_PRF);
    if (prfSheet) snap.purchaseRequests = Math.max(0, prfSheet.getLastRow() - 1);
  } catch (e) { }

  // RFQ count
  try {
    const rfqSheet = ss.getSheetByName('RFQ_Logs');
    if (rfqSheet) snap.rfqCount = Math.max(0, rfqSheet.getLastRow() - 1);
  } catch (e) { }

  // Cache for 10 minutes
  try { cache.put('AI_SNAPSHOT', JSON.stringify(snap), 600); } catch (e) { }
  return snap;
}


// ============================================================
// #15: Scheduled Digest Email
// ============================================================

/**
 * Set this as a daily time-driven trigger in GAS Editor:
 * Triggers -> Add Trigger -> aiDailyDigest -> Time-driven -> Day timer
 */
function aiDailyDigest() {
  try {
    const apiKey = _getAIKey();
    if (!apiKey) { console.log("AI Digest: No API key."); return; }

    // Gather snapshot data
    const snapshot = _toolSnapshot();
    const dashboard = _toolGetDashboard();

    const prompt = `Generate a concise daily procurement health digest email for the team. 
Include:
1. System overview (total items, suppliers, POs)
2. Critical stock alerts (items below reorder point)
3. Pending actions (approvals, payments)
4. YTD spend summary
5. One actionable recommendation

Here is today's data:
SNAPSHOT: ${JSON.stringify(snapshot)}
DASHBOARD: ${JSON.stringify(dashboard)}

Format as a clean HTML email body with inline styles. Use a professional, clean design.`;

    const messages = [
      { role: "system", content: "You are ProcurePilot's automated report generator. Output clean HTML for email." },
      { role: "user", content: prompt }
    ];

    const response = _callAI(messages, GEMINI_MODELS.FAST, true);
    if (response.error) { console.error("Digest error: " + response.error); return; }

    const htmlBody = response.choices[0].message.content;

    // Send to admins
    const recipients = (typeof SUPER_ADMINS !== 'undefined') ? SUPER_ADMINS.join(',') : Session.getActiveUser().getEmail();
    MailApp.sendEmail({
      to: recipients,
      subject: `📊 ProcurePilot Daily Digest — ${new Date().toLocaleDateString()}`,
      htmlBody: htmlBody
    });

    console.log("Daily digest sent to: " + recipients);
  } catch (e) {
    console.error("Digest failed: " + e.message);
  }
}


// ============================================================
// TOOL #17: Anomaly Detection
// ============================================================

function _toolDetectAnomalies(scope) {
  const anomalies = { critical: [], warnings: [], info: [] };
  const ss = getSpreadsheet();

  // --- INVENTORY ANOMALIES ---
  if (scope === 'all' || scope === 'inventory') {
    try {
      const iSheet = ss.getSheetByName(DB_CONFIG.SHEET_ITEMS);
      if (iSheet) {
        const iData = iSheet.getDataRange().getValues();
        const iH = iData[0].map(h => String(h).trim());
        const idIdx = iH.indexOf('Stock ID');
        const nameIdx = iH.indexOf('Item Name');
        const curIdx = iH.indexOf('Current');
        const ropIdx = iH.indexOf('ROP');
        const costIdx = iH.indexOf('Cost');
        const statusIdx = iH.indexOf('Product Status');
        const behIdx = iH.indexOf('Item Behaviour');

        const nameCounts = {};

        for (let i = 1; i < iData.length; i++) {
          const row = iData[i];
          const id = String(row[idIdx] || '');
          const name = String(row[nameIdx] || '').trim();
          const cur = Number(row[curIdx] || 0);
          const rop = Number(row[ropIdx] || 0);
          const cost = Number(row[costIdx] || 0);
          const status = String(row[statusIdx] || '');
          const beh = String(row[behIdx] || '');

          if (!name) continue;

          // Below ROP
          if (rop > 0 && cur < rop && beh !== 'Service') {
            const severity = cur === 0 ? 'critical' : 'critical';
            anomalies[severity].push({
              type: 'BELOW_ROP',
              item: `${id} — ${name}`,
              detail: `Current: ${cur}, ROP: ${rop}, Gap: ${rop - cur}`,
              impact: `Estimated restock cost: RM ${((rop - cur) * cost).toFixed(2)}`
            });
          }

          // Zero stock with active status
          if (cur === 0 && status !== 'Unavailable' && status !== 'Discontinued' && beh !== 'Service') {
            anomalies.warnings.push({
              type: 'ZERO_STOCK',
              item: `${id} — ${name}`,
              detail: `Status: ${status || 'Active'}, but stock is 0`
            });
          }

          // Potential duplicates (same name)
          const normName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (normName.length > 3) {
            if (nameCounts[normName]) nameCounts[normName].push(id);
            else nameCounts[normName] = [id];
          }

          // Negative stock
          if (cur < 0) {
            anomalies.critical.push({
              type: 'NEGATIVE_STOCK',
              item: `${id} — ${name}`,
              detail: `Current stock is ${cur} (negative)`
            });
          }

          // High cost with zero stock
          if (cur === 0 && cost > 50 && beh !== 'Service') {
            anomalies.info.push({
              type: 'HIGH_COST_OUT_OF_STOCK',
              item: `${id} — ${name}`,
              detail: `Unit cost: RM ${cost.toFixed(2)}, currently out of stock`
            });
          }
        }

        // Check duplicates
        for (const key in nameCounts) {
          if (nameCounts[key].length > 1) {
            anomalies.warnings.push({
              type: 'POTENTIAL_DUPLICATE',
              item: nameCounts[key].join(', '),
              detail: `${nameCounts[key].length} items share similar names`
            });
          }
        }
      }
    } catch (e) { anomalies.info.push({ type: 'SCAN_ERROR', detail: 'Inventory: ' + e.message }); }
  }

  // --- SPENDING ANOMALIES ---
  if (scope === 'all' || scope === 'spending') {
    try {
      const pSheet = ss.getSheetByName(DB_CONFIG.SHEET_PO);
      if (pSheet && pSheet.getLastRow() > 1) {
        const pData = pSheet.getDataRange().getValues();
        const pH = pData[0].map(h => String(h).trim());
        const pIdIdx = pH.indexOf('PO ID');
        const pTotalIdx = pH.indexOf('Total');
        const pStatusIdx = pH.indexOf('Status');
        const pDateIdx = pH.indexOf('Date');

        const totals = [];
        let staleCount = 0;
        const now = new Date();

        for (let i = 1; i < pData.length; i++) {
          const total = Number(pData[i][pTotalIdx] || 0);
          const status = String(pData[i][pStatusIdx] || '').toUpperCase();
          const poId = String(pData[i][pIdIdx] || '');

          if (total > 0 && status !== 'VOID') totals.push({ poId, total });

          // Stale POs (pending > 30 days)
          if (status === 'PENDING APPROVAL' || status === 'PENDING PAYMENT') {
            let poDate = pData[i][pDateIdx];
            if (poDate instanceof Date) {
              const daysSince = Math.floor((now - poDate) / 86400000);
              if (daysSince > 30) {
                staleCount++;
                if (staleCount <= 5) {
                  anomalies.warnings.push({
                    type: 'STALE_PO',
                    item: poId,
                    detail: `${status} for ${daysSince} days (RM ${total.toFixed(2)})`
                  });
                }
              }
            }
          }
        }

        // Spending spikes (POs > 2x average)
        if (totals.length > 5) {
          const avgTotal = totals.reduce((s, t) => s + t.total, 0) / totals.length;
          const threshold = avgTotal * 2.5;
          totals.filter(t => t.total > threshold).slice(-3).forEach(t => {
            anomalies.info.push({
              type: 'SPENDING_SPIKE',
              item: t.poId,
              detail: `RM ${t.total.toFixed(2)} (avg is RM ${avgTotal.toFixed(2)})`
            });
          });
        }
      }
    } catch (e) { anomalies.info.push({ type: 'SCAN_ERROR', detail: 'Spending: ' + e.message }); }
  }

  // --- ZERO MOVEMENT ITEMS ---
  if (scope === 'all' || scope === 'inventory') {
    try {
      const currentYear = new Date().getFullYear();
      const movSheet = ss.getSheetByName(`Movement ${currentYear}`);
      if (movSheet && movSheet.getLastRow() > 2) {
        const movData = movSheet.getRange(3, 1, movSheet.getLastRow() - 2, 62).getValues();
        let zeroCount = 0;

        for (let r = 0; r < movData.length; r++) {
          const id = String(movData[r][0] || '').trim();
          if (!id) continue;

          let hasAnyMovement = false;
          for (let c = 2; c < 62; c++) {
            if (Number(movData[r][c] || 0) !== 0) { hasAnyMovement = true; break; }
          }

          if (!hasAnyMovement) {
            zeroCount++;
            if (zeroCount <= 5) {
              anomalies.info.push({
                type: 'ZERO_MOVEMENT',
                item: id,
                detail: `No IN/OUT/ADJ recorded for entire ${currentYear}`
              });
            }
          }
        }
        if (zeroCount > 5) {
          anomalies.info.push({ type: 'ZERO_MOVEMENT_SUMMARY', detail: `${zeroCount} total items with zero movement in ${currentYear}` });
        }
      }
    } catch (e) { }
  }

  return {
    totalAnomalies: anomalies.critical.length + anomalies.warnings.length + anomalies.info.length,
    critical: anomalies.critical.slice(0, 5),
    warnings: anomalies.warnings.slice(0, 5),
    info: anomalies.info.slice(0, 5)
  };
}


// ============================================================
// NEW TOOL: Get PRF Details
// ============================================================
function _toolGetPRFDetails(prfId) {
  if (!prfId) return { error: "PRF ID required." };
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PRF);
  if (!sheet) return { error: "DB_PRF sheet not found." };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { error: "No PRF data found." };

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const idIdx = headers.indexOf('PRF ID');
  if (idIdx === -1) return { error: "PRF ID column missing." };

  const idCol = sheet.getRange(2, idIdx + 1, lastRow - 1, 1).getValues().flat();
  const searchId = String(prfId).trim();
  let foundIdx = -1;

  for (let i = 0; i < idCol.length; i++) {
    if (String(idCol[i]).trim() === searchId) { foundIdx = i; break; }
  }
  if (foundIdx === -1) {
    for (let i = idCol.length - 1; i >= 0; i--) {
      if (String(idCol[i]).toLowerCase().includes(searchId.toLowerCase())) { foundIdx = i; break; }
    }
  }
  if (foundIdx === -1) return { error: `PRF "${prfId}" not found.` };

  const rowData = sheet.getRange(foundIdx + 2, 1, 1, lastCol).getValues()[0];
  const result = {};
  headers.forEach((h, i) => {
    const val = rowData[i];
    if (h === 'PRF_Data_JSON') {
      try {
        const items = JSON.parse(val);
        result.lineItems = items.map((item, idx) => ({
          no: idx + 1, stockId: item.id || '', name: item.n || '',
          qty: item.q || 0, estimatedCost: item.c || 0, total: item.t || 0, uom: item.u || 'UNIT'
        }));
      } catch (e) { result.lineItems = []; }
    } else {
      result[h] = (val instanceof Date) ? val.toISOString().split('T')[0] : val;
    }
  });
  return result;
}


// ============================================================
// NEW TOOL: Get RFQ Details
// ============================================================
function _toolGetRFQDetails(rfqId) {
  if (!rfqId) return { error: "RFQ ID required." };
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName('RFQ_Logs');
  if (!sheet) return { error: "RFQ_Logs sheet not found." };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { error: "No RFQ data found." };

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const idIdx = headers.indexOf('RFQ ID');
  if (idIdx === -1) return { error: "RFQ ID column missing." };

  const idCol = sheet.getRange(2, idIdx + 1, lastRow - 1, 1).getValues().flat();
  const searchId = String(rfqId).trim();
  let foundIdx = -1;

  for (let i = 0; i < idCol.length; i++) {
    if (String(idCol[i]).trim() === searchId) { foundIdx = i; break; }
  }
  if (foundIdx === -1) {
    for (let i = idCol.length - 1; i >= 0; i--) {
      if (String(idCol[i]).toLowerCase().includes(searchId.toLowerCase())) { foundIdx = i; break; }
    }
  }
  if (foundIdx === -1) return { error: `RFQ "${rfqId}" not found.` };

  const rowData = sheet.getRange(foundIdx + 2, 1, 1, lastCol).getValues()[0];
  const result = {};
  headers.forEach((h, i) => {
    const val = rowData[i];
    if (h === 'RFQ_Data_JSON') {
      try {
        const items = JSON.parse(val);
        result.lineItems = items.map((item, idx) => ({
          no: idx + 1, stockId: item.id || '', name: item.n || '',
          qty: item.q || 0, uom: item.u || 'UNIT'
        }));
      } catch (e) { result.lineItems = []; }
    } else {
      result[h] = (val instanceof Date) ? val.toISOString().split('T')[0] : val;
    }
  });
  return result;
}


// ============================================================
// NEW TOOL: Get Performance Scores
// ============================================================
function _toolGetPerformanceScores(supplierName, minScore, limit) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_PERF);
  if (!sheet) return { error: "DB_Performance sheet not found." };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { results: [], message: "No performance data found." };

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const supplierIdx = headers.indexOf('Supplier Name');
  const scoreIdx = headers.indexOf('Weighted Score');
  const cap = Math.min(Math.max(limit || 20, 1), 50);
  const minScoreVal = minScore || 0;
  const searchSupplier = supplierName ? String(supplierName).toLowerCase().trim() : '';

  const results = [];
  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    const supplier = String(row[supplierIdx] || '');
    const score = Number(row[scoreIdx] || 0);

    if (searchSupplier && !supplier.toLowerCase().includes(searchSupplier)) continue;
    if (score < minScoreVal) continue;

    const obj = {};
    headers.forEach((h, idx) => {
      const val = row[idx];
      obj[h] = (val instanceof Date) ? val.toISOString().split('T')[0] : val;
    });
    results.push(obj);
    if (results.length >= cap) break;
  }

  return { results, totalFound: results.length, filter: searchSupplier ? `Supplier: ${supplierName}` : 'All suppliers' };
}


// ============================================================
// NEW TOOL: Get Order Review Items
// ============================================================
function _toolGetOrderReviewItems(status, category) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_REVIEW);
  if (!sheet) return { error: "DB_OrderReview sheet not found." };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { results: [], message: "No order review data found." };

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const statusIdx = headers.indexOf('Status');
  const catIdx = headers.indexOf('Category');
  const searchStatus = status ? String(status).toLowerCase().trim() : '';
  const searchCat = category ? String(category).toLowerCase().trim() : '';

  const results = [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowStatus = String(row[statusIdx] || '').toLowerCase();
    const rowCat = String(row[catIdx] || '').toLowerCase();

    if (searchStatus && !rowStatus.includes(searchStatus)) continue;
    if (searchCat && !rowCat.includes(searchCat)) continue;

    const obj = {};
    headers.forEach((h, idx) => {
      const val = row[idx];
      obj[h] = (val instanceof Date) ? val.toISOString().split('T')[0] : val;
    });

    // Add stock health indicator
    const current = Number(row[headers.indexOf('Actual Stock')] || 0);
    const rop = Number(row[headers.indexOf('ROP')] || 0);
    obj.stockHealth = (rop > 0 && current < rop) ? 'CRITICAL' : 'OK';
    if (rop > 0) obj.healthPercent = Math.round((current / rop) * 100);

    results.push(obj);
  }

  return { results, totalFound: results.length, filters: { status, category } };
}


// ============================================================
// NEW TOOL: Get Incoming Documents
// ============================================================
function _toolGetIncomingDocuments(docType, status, supplier) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_DOCS);
  if (!sheet) return { error: "DB_IncomingDocs sheet not found." };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { results: [], message: "No incoming documents found." };

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const typeIdx = headers.indexOf('Doc Type');
  const statusIdx = headers.indexOf('Status');
  const suppIdx = headers.indexOf('Supplier');
  const searchType = docType ? String(docType).toLowerCase().trim() : '';
  const searchStatus = status ? String(status).toLowerCase().trim() : '';
  const searchSupplier = supplier ? String(supplier).toLowerCase().trim() : '';

  const results = [];
  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    const rowType = String(row[typeIdx] || '').toLowerCase();
    const rowStatus = String(row[statusIdx] || '').toLowerCase();
    const rowSupplier = String(row[suppIdx] || '').toLowerCase();

    if (searchType && !rowType.includes(searchType)) continue;
    if (searchStatus && !rowStatus.includes(searchStatus)) continue;
    if (searchSupplier && !rowSupplier.includes(searchSupplier)) continue;

    const obj = {};
    headers.forEach((h, idx) => {
      const val = row[idx];
      obj[h] = (val instanceof Date) ? val.toISOString().split('T')[0] : val;
    });
    results.push(obj);
    if (results.length >= 30) break;
  }

  return { results, totalFound: results.length, filters: { docType, status, supplier } };
}


// ============================================================
// NEW TOOL: Advanced Query with Multiple Filters
// ============================================================
function _toolQueryAdvanced(sheetName, filters, sortBy, sortOrder, selectColumns, limit) {
  if (!sheetName) return { error: "Sheet name required." };
  if (['System_Users'].includes(sheetName)) return { error: "Access denied." };

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `Sheet "${sheetName}" not found.` };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { results: [], message: "Sheet is empty.", sheetName };

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  // Parse select columns
  let selectedIndices = null;
  let selectedHeaders = headers;
  if (selectColumns && selectColumns.trim()) {
    const requestedCols = selectColumns.split(',').map(c => c.trim());
    selectedIndices = [];
    selectedHeaders = [];
    for (const col of requestedCols) {
      const idx = headers.indexOf(col);
      if (idx > -1) {
        selectedIndices.push(idx);
        selectedHeaders.push(col);
      }
    }
  }

  const cap = Math.min(Math.max(limit || 30, 1), 100);
  const results = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    let matches = true;

    // Apply filters
    if (filters && filters.length > 0) {
      for (const filter of filters) {
        const colIdx = headers.indexOf(filter.column);
        if (colIdx === -1) { matches = false; break; }

        const cellVal = row[colIdx];
        const filterVal = filter.value;
        const op = (filter.operator || 'eq').toLowerCase();

        let cellStr = String(cellVal || '').toLowerCase();
        let filterStr = String(filterVal || '').toLowerCase();

        // Try numeric comparison
        const cellNum = parseFloat(cellVal);
        const filterNum = parseFloat(filterVal);
        const isNumeric = !isNaN(cellNum) && !isNaN(filterNum);

        switch (op) {
          case 'eq':
            if (isNumeric ? cellNum !== filterNum : cellStr !== filterStr) matches = false;
            break;
          case 'neq':
            if (isNumeric ? cellNum === filterNum : cellStr === filterStr) matches = false;
            break;
          case 'gt':
            if (!isNumeric || cellNum <= filterNum) matches = false;
            break;
          case 'lt':
            if (!isNumeric || cellNum >= filterNum) matches = false;
            break;
          case 'gte':
            if (!isNumeric || cellNum < filterNum) matches = false;
            break;
          case 'lte':
            if (!isNumeric || cellNum > filterNum) matches = false;
            break;
          case 'contains':
            if (!cellStr.includes(filterStr)) matches = false;
            break;
          case 'startswith':
            if (!cellStr.startsWith(filterStr)) matches = false;
            break;
          case 'endswith':
            if (!cellStr.endsWith(filterStr)) matches = false;
            break;
        }
        if (!matches) break;
      }
    }

    if (matches) {
      const obj = {};
      const indices = selectedIndices || headers.map((_, idx) => idx);
      indices.forEach((colIdx, idx) => {
        const val = row[colIdx];
        obj[selectedHeaders[idx]] = (val instanceof Date) ? val.toISOString().split('T')[0] : val;
      });
      results.push(obj);
    }
  }

  // Sort results
  if (sortBy && headers.indexOf(sortBy) > -1) {
    const sortIdx = selectedHeaders.indexOf(sortBy);
    if (sortIdx > -1) {
      const isAsc = (sortOrder || 'desc').toLowerCase() === 'asc';
      results.sort((a, b) => {
        const aVal = parseFloat(a[sortBy]) || 0;
        const bVal = parseFloat(b[sortBy]) || 0;
        return isAsc ? aVal - bVal : bVal - aVal;
      });
    }
  }

  return {
    sheetName,
    headers: selectedHeaders,
    totalRows: lastRow - 1,
    returnedRows: Math.min(results.length, cap),
    filters: filters || [],
    results: results.slice(0, cap)
  };
}


// ============================================================
// NEW TOOL: Trend Analysis
// ============================================================
function _toolAnalyzeTrend(sheetName, dateColumn, valueColumn, metric, period, fromDate, toDate) {
  if (!sheetName || !dateColumn || !valueColumn) return { error: "sheetName, dateColumn, and valueColumn required." };

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `Sheet "${sheetName}" not found.` };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { results: [], message: "Sheet is empty." };

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const dateIdx = headers.indexOf(dateColumn);
  const valueIdx = headers.indexOf(valueColumn);

  if (dateIdx === -1) return { error: `Date column "${dateColumn}" not found. Available: ${headers.join(', ')}` };
  if (valueIdx === -1) return { error: `Value column "${valueColumn}" not found. Available: ${headers.join(', ')}` };

  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const metricOp = (metric || 'SUM').toUpperCase();
  const periodType = (period || 'monthly').toLowerCase();

  const parsedFrom = fromDate ? new Date(fromDate) : null;
  const parsedTo = toDate ? new Date(toDate) : null;
  if (parsedTo) parsedTo.setHours(23, 59, 59, 999);

  // Group data by period
  const groups = {};

  for (let i = 0; i < data.length; i++) {
    let cellDate = data[i][dateIdx];
    if (typeof cellDate === 'string') cellDate = new Date(cellDate);
    if (!(cellDate instanceof Date) || isNaN(cellDate.getTime())) continue;

    if (parsedFrom && cellDate < parsedFrom) continue;
    if (parsedTo && cellDate > parsedTo) continue;

    const value = parseFloat(data[i][valueIdx]) || 0;

    // Determine period key
    let periodKey;
    const year = cellDate.getFullYear();
    const month = cellDate.getMonth();
    const quarter = Math.floor(month / 3) + 1;

    switch (periodType) {
      case 'daily':
        periodKey = cellDate.toISOString().split('T')[0];
        break;
      case 'weekly':
        const weekStart = new Date(cellDate);
        weekStart.setDate(cellDate.getDate() - cellDate.getDay());
        periodKey = weekStart.toISOString().split('T')[0];
        break;
      case 'monthly':
        periodKey = `${year}-${String(month + 1).padStart(2, '0')}`;
        break;
      case 'quarterly':
        periodKey = `${year}-Q${quarter}`;
        break;
      case 'yearly':
        periodKey = `${year}`;
        break;
      default:
        periodKey = `${year}-${String(month + 1).padStart(2, '0')}`;
    }

    if (!groups[periodKey]) groups[periodKey] = [];
    groups[periodKey].push(value);
  }

  // Calculate aggregates
  const results = Object.keys(groups).sort().map(periodKey => {
    const values = groups[periodKey];
    let aggregate;

    switch (metricOp) {
      case 'SUM':
        aggregate = values.reduce((a, b) => a + b, 0);
        break;
      case 'COUNT':
        aggregate = values.length;
        break;
      case 'AVERAGE':
        aggregate = values.reduce((a, b) => a + b, 0) / values.length;
        break;
      case 'MIN':
        aggregate = Math.min(...values);
        break;
      case 'MAX':
        aggregate = Math.max(...values);
        break;
      default:
        aggregate = values.reduce((a, b) => a + b, 0);
    }

    return {
      period: periodKey,
      value: Math.round(aggregate * 100) / 100,
      dataPoints: values.length
    };
  });

  return {
    sheetName,
    dateColumn,
    valueColumn,
    metric: metricOp,
    period: periodType,
    totalPeriods: results.length,
    results
  };
}


// ============================================================
// NEW TOOL: Get System Logs
// ============================================================
function _toolGetSystemLogs(action, user, limit) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(DB_CONFIG.SHEET_LOGS);
  if (!sheet) return { error: "System_Logs sheet not found." };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { results: [], message: "No logs found." };

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const actionIdx = headers.indexOf('Action');
  const userIdx = headers.indexOf('User/System');
  const cap = Math.min(Math.max(limit || 20, 1), 50);
  const searchAction = action ? String(action).toLowerCase().trim() : '';
  const searchUser = user ? String(user).toLowerCase().trim() : '';

  const results = [];
  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    const rowAction = String(row[actionIdx] || '').toLowerCase();
    const rowUser = String(row[userIdx] || '').toLowerCase();

    if (searchAction && !rowAction.includes(searchAction)) continue;
    if (searchUser && !rowUser.includes(searchUser)) continue;

    const obj = {};
    headers.forEach((h, idx) => {
      const val = row[idx];
      obj[h] = (val instanceof Date) ? val.toISOString().replace('T', ' ').substring(0, 19) : val;
    });
    results.push(obj);
    if (results.length >= cap) break;
  }

  return { results, totalFound: results.length, filters: { action, user } };
}


// ============================================================
// ENHANCED: Aggregate Data with GROUP BY and Date Filtering
// ============================================================
function _toolAggregate(sheetName, column, operation, filterColumn, filterValue, groupBy, dateColumn, fromDate, toDate) {
  if (!sheetName || !column) return { error: "sheetName and column required." };
  if (['System_Users'].includes(sheetName)) return { error: "Access denied." };

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `Sheet "${sheetName}" not found.` };

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { error: "Sheet is empty." };

  const headers = data[0].map(h => String(h).trim());
  const colIdx = headers.indexOf(column);
  if (colIdx === -1) return { error: `Column "${column}" not found. Available: ${headers.join(', ')}` };

  const filterIdx = filterColumn ? headers.indexOf(filterColumn) : -1;
  const filterLower = filterValue ? String(filterValue).toLowerCase().trim() : "";
  const groupByIdx = groupBy ? headers.indexOf(groupBy) : -1;
  const dateIdx = dateColumn ? headers.indexOf(dateColumn) : -1;
  const op = String(operation).toUpperCase();

  const parsedFrom = fromDate ? new Date(fromDate) : null;
  const parsedTo = toDate ? new Date(toDate) : null;
  if (parsedTo) parsedTo.setHours(23, 59, 59, 999);

  // If GROUP BY is specified, return grouped results
  if (groupByIdx > -1) {
    const groups = {};

    for (let i = 1; i < data.length; i++) {
      const row = data[i];

      // Apply date filter
      if (dateIdx > -1 && (parsedFrom || parsedTo)) {
        let cellDate = row[dateIdx];
        if (typeof cellDate === 'string') cellDate = new Date(cellDate);
        if (cellDate instanceof Date && !isNaN(cellDate.getTime())) {
          if (parsedFrom && cellDate < parsedFrom) continue;
          if (parsedTo && cellDate > parsedTo) continue;
        } else {
          continue;
        }
      }

      // Apply filter
      if (filterIdx > -1 && filterLower) {
        const cellVal = String(row[filterIdx] || '').toLowerCase().trim();
        if (!cellVal.includes(filterLower)) continue;
      }

      const groupKey = String(row[groupByIdx] || 'Unknown');
      const raw = row[colIdx];
      const num = (typeof raw === 'number') ? raw : parseFloat(String(raw).replace(/[^0-9.-]/g, ''));

      if (!isNaN(num)) {
        if (!groups[groupKey]) groups[groupKey] = [];
        groups[groupKey].push(num);
      }
    }

    const results = Object.keys(groups).map(key => {
      const values = groups[key];
      let result;

      switch (op) {
        case 'SUM': result = values.reduce((a, b) => a + b, 0); break;
        case 'COUNT': result = values.length; break;
        case 'AVERAGE': result = values.reduce((a, b) => a + b, 0) / values.length; break;
        case 'MIN': result = Math.min(...values); break;
        case 'MAX': result = Math.max(...values); break;
        default: result = values.reduce((a, b) => a + b, 0);
      }

      return { group: key, value: Math.round(result * 100) / 100, count: values.length };
    });

    // Sort by value descending
    results.sort((a, b) => b.value - a.value);

    return {
      sheetName, column, operation: op, groupBy,
      totalGroups: results.length,
      filter: filterColumn ? `${filterColumn} contains "${filterValue}"` : "none",
      dateRange: fromDate || toDate ? `${fromDate || 'start'} to ${toDate || 'end'}` : "all",
      results
    };
  }

  // No GROUP BY - return single aggregate
  const values = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    // Apply date filter
    if (dateIdx > -1 && (parsedFrom || parsedTo)) {
      let cellDate = row[dateIdx];
      if (typeof cellDate === 'string') cellDate = new Date(cellDate);
      if (cellDate instanceof Date && !isNaN(cellDate.getTime())) {
        if (parsedFrom && cellDate < parsedFrom) continue;
        if (parsedTo && cellDate > parsedTo) continue;
      } else {
        continue;
      }
    }

    // Apply filter
    if (filterIdx > -1 && filterLower) {
      const cellVal = String(row[filterIdx] || '').toLowerCase().trim();
      if (!cellVal.includes(filterLower)) continue;
    }

    const raw = row[colIdx];
    const num = (typeof raw === 'number') ? raw : parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
    if (!isNaN(num)) values.push(num);
  }

  if (values.length === 0) return { result: 0, operation: op, column, rowsMatched: 0, message: "No numeric values found." };

  let result;
  switch (op) {
    case 'SUM': result = values.reduce((a, b) => a + b, 0); break;
    case 'COUNT': result = values.length; break;
    case 'AVERAGE': result = values.reduce((a, b) => a + b, 0) / values.length; break;
    case 'MIN': result = Math.min(...values); break;
    case 'MAX': result = Math.max(...values); break;
    default: return { error: `Unknown operation "${op}". Use SUM, COUNT, AVERAGE, MIN, MAX.` };
  }

  return {
    sheetName, column, operation: op, result: Math.round(result * 100) / 100,
    rowsMatched: values.length,
    filter: filterColumn ? `${filterColumn} contains "${filterValue}"` : "none",
    dateRange: fromDate || toDate ? `${fromDate || 'start'} to ${toDate || 'end'}` : "all"
  };
}


// ============================================================
// #37: Audit Log
// ============================================================

function _logAIAudit(question, toolsUsed, success, modelUsed) {
  try {
    const ss = getSpreadsheet();
    const logSheet = ss.getSheetByName('System_Logs');
    if (!logSheet) return;

    const user = Session.getActiveUser().getEmail() || 'unknown';
    const timestamp = new Date();
    const toolsList = toolsUsed.length > 0 ? toolsUsed.join(', ') : 'none';

    // Truncate question for log
    const q = String(question).substring(0, 200);

    logSheet.appendRow([
      timestamp,
      'AI_QUERY',
      user,
      q,
      toolsList,
      success ? 'SUCCESS' : 'NO_ANSWER',
      toolsUsed.length,
      modelUsed || 'unknown'
    ]);
  } catch (e) {
    // Silent fail — audit logging should never break the main flow
  }
}


// ============================================================
// CACHING LAYER FOR PERFORMANCE
// ============================================================

/**
 * Get cached sheet data or fetch fresh if cache expired.
 * @param {string} sheetName - Sheet name
 * @param {number} ttlSeconds - Cache TTL in seconds (default 5 minutes)
 * @returns {Object} Sheet data with headers and rows
 */
function _getCachedSheetData(sheetName, ttlSeconds = 300) {
  const cache = CacheService.getScriptCache();
  const cacheKey = `SHEET_${sheetName}`;
  
  try {
    const cached = cache.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && parsed._cachedAt && (Date.now() - parsed._cachedAt) < ttlSeconds * 1000) {
        return parsed;
      }
    }
  } catch (e) { /* Cache miss or parse error */ }

  // Fetch fresh data
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return null;

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { headers: [], rows: [], _cachedAt: Date.now() };

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];

  const data = { headers, rows, _cachedAt: Date.now() };

  // Cache for specified TTL (max 6 minutes for GAS)
  try {
    const cacheStr = JSON.stringify(data);
    if (cacheStr.length < 100000) { // GAS cache limit ~100KB
      cache.put(cacheKey, cacheStr, Math.min(ttlSeconds, 360));
    }
  } catch (e) { /* Cache write failed, continue anyway */ }

  return data;
}

/**
 * Invalidate cache for a specific sheet.
 * @param {string} sheetName - Sheet name to invalidate
 */
function _invalidateSheetCache(sheetName) {
  try {
    const cache = CacheService.getScriptCache();
    cache.remove(`SHEET_${sheetName}`);
  } catch (e) { /* Silent fail */ }
}

/**
 * Get cached aggregate result or compute fresh.
 * @param {string} cacheKey - Unique cache key
 * @param {Function} computeFn - Function to compute result if cache miss
 * @param {number} ttlSeconds - Cache TTL (default 2 minutes)
 * @returns {*} Cached or computed result
 */
function _getCachedOrCompute(cacheKey, computeFn, ttlSeconds = 120) {
  const cache = CacheService.getScriptCache();
  
  try {
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) { /* Cache miss */ }

  const result = computeFn();
  
  try {
    const cacheStr = JSON.stringify(result);
    if (cacheStr.length < 100000) {
      cache.put(cacheKey, cacheStr, Math.min(ttlSeconds, 360));
    }
  } catch (e) { /* Cache write failed */ }

  return result;
}


// ============================================================
// TOKEN OPTIMIZATION UTILITIES
// ============================================================

/**
 * Slim conversation history: strip [SUGGEST]/[CHART] tags, truncate long messages, cap count.
 */
function _slimHistory(history, cap) {
  if (!history || history.length === 0) return [];
  const sliced = history.slice(-(cap || 10));
  return sliced.map(m => {
    if (m.role !== 'user' && m.role !== 'assistant') return null;
    let content = m.content || '';
    // Strip rendering tags (useless in history)
    content = content.replace(/\[SUGGEST\].*?\[\/SUGGEST\]/gs, '');
    content = content.replace(/\[CHART\].*?\[\/CHART\]/gs, '');
    // Truncate long assistant messages
    if (m.role === 'assistant' && content.length > 400) {
      content = content.substring(0, 400) + '...';
    }
    return { role: m.role, content: content.trim() };
  }).filter(m => m && m.content);
}

/**
 * Select only relevant tools based on query intent. Returns filtered tool array.
 */
function _selectTools(msg) {
  if (!msg) return _AI_TOOLS;
  const lower = msg.toLowerCase();

  const toolSets = {
    inventory: ['searchInventoryItem', 'getItemMovementHistory', 'aggregateData', 'getTopN'],
    supplier: ['getSupplierInfo', 'joinSheets', 'querySheet'],
    purchasing: ['querySheet', 'getPurchaseOrderDetails', 'aggregateData', 'getTopN'],
    overview: ['getSnapshotSummary', 'getDashboardKPIs'],
    anomaly: ['detectAnomalies', 'getSnapshotSummary']
  };

  const intentKeywords = {
    inventory: ['stock', 'inventory', 'item', 'reorder', 'rop', 'restock', 'movement', 'closing', 'medicine', 'drug', 'syringe', 'product', 'category'],
    supplier: ['supplier', 'vendor', 'contact', 'who supplies', 'payment terms'],
    purchasing: ['po ', 'po-', 'purchase order', 'prf', 'rfq', 'spend', 'cost', 'budget', 'invoice', 'payment'],
    overview: ['dashboard', 'kpi', 'overview', 'summary', 'how many', 'total', 'snapshot'],
    anomaly: ['anomaly', 'anomalies', 'health check', 'problem', 'issue', 'detect', 'scan', 'attention', 'wrong']
  };

  // Find matching intents
  const matchedTools = new Set();
  let matched = false;
  for (const [intent, keywords] of Object.entries(intentKeywords)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        toolSets[intent].forEach(t => matchedTools.add(t));
        matched = true;
        break;
      }
    }
  }

  // Fallback: send all tools if no intent matched
  if (!matched) return _AI_TOOLS;

  // Filter to only matched tools
  return _AI_TOOLS.filter(t => matchedTools.has(t.function.name));
}

/**
 * Strip null/undefined/empty fields from tool results to save tokens.
 */
function _compressResult(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(_compressResult);
  if (typeof obj !== 'object') return obj;

  const clean = {};
  for (const key in obj) {
    const val = obj[key];
    if (val === null || val === undefined || val === '' || val === 'N/A') continue;
    if (Array.isArray(val) && val.length === 0) continue;
    clean[key] = (typeof val === 'object') ? _compressResult(val) : val;
  }
  return clean;
}

/**
 * Truncate prior tool results in the message array to prevent token snowball.
 * Only keeps the first 600 chars of each tool result from earlier rounds.
 */
function _truncatePriorToolResults(messages) {
  // Find the last assistant message index (current round boundary)
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
  }
  if (lastAssistantIdx < 0) return;

  // Truncate tool results BEFORE the last assistant message
  for (let i = 0; i < lastAssistantIdx; i++) {
    if (messages[i].role === 'tool' && messages[i].content && messages[i].content.length > 600) {
      messages[i].content = messages[i].content.substring(0, 600) + '...(truncated)';
    }
  }
}


// ============================================================
// GEMINI API — SMART ROUTING ENGINE WITH FALLBACK
// ============================================================

const GEMINI_MODELS = {
  FAST: 'gemini-2.5-flash-lite',    // Cheapest — simple queries, digest, insight (supports thinking)
  COMPLEX: 'gemini-2.5-flash',      // More capable — agentic tool-calling, deep analysis
  FALLBACK: 'gemini-2.5-flash'      // Stable versioned fallback
};

// OpenRouter model options (Primary AI)
const OPENROUTER_MODELS = {
  PRIMARY: 'openrouter/hunter-alpha',      // Main model for all queries
  SECONDARY: 'openrouter/healer-alpha',    // Fallback if primary fails
};

const _GEMINI_FALLBACK_CHAIN = [
  GEMINI_MODELS.FAST,
  GEMINI_MODELS.COMPLEX,
  GEMINI_MODELS.FALLBACK
];

function _getAIKey() {
  return PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
}

/**
 * Classify user message complexity for smart model routing.
 * Returns 'complex' if the message likely needs data tools, 'simple' otherwise.
 */
function _classifyComplexity(msg) {
  if (!msg) return 'simple';
  const lower = msg.toLowerCase();

  const complexKeywords = [
    'stock', 'inventory', 'supplier', 'purchase', 'order', 'po ', 'po-',
    'cost', 'spend', 'budget', 'price', 'total', 'amount',
    'reorder', 'rop', 'restock', 'critical', 'shortage',
    'movement', 'in/out', 'closing', 'adjustment',
    'anomaly', 'anomalies', 'health check', 'scan', 'detect',
    'chart', 'compare', 'top ', 'bottom ', 'rank', 'highest', 'lowest',
    'how many', 'how much', 'average', 'count', 'sum',
    'prf', 'rfq', 'invoice', 'performance', 'scorecard',
    'category', 'item', 'product', 'medicine', 'drug', 'syringe',
    'dashboard', 'kpi', 'metric', 'overview', 'summary', 'report',
    'find', 'search', 'show', 'list', 'get', 'query', 'look up',
    'which', 'what is', 'who supplies', 'when was'
  ];

  for (const kw of complexKeywords) {
    if (lower.includes(kw)) return 'complex';
  }

  return 'simple';
}

/**
 * Convert OpenAI-style messages array to Gemini contents + systemInstruction.
 */
function _convertToGeminiFormat(messages) {
  let systemInstruction = null;
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = { parts: [{ text: msg.content }] };
    } else if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] });
    } else if (msg.role === 'assistant') {
      const parts = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch (e) { }
          parts.push({ functionCall: { name: tc.function.name, args: args } });
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts: parts });
    } else if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: msg._toolName || 'tool', response: { result: msg.content } } }]
      });
    }
  }
  return { systemInstruction, contents };
}

/**
 * Convert OpenAI-style tool definitions to Gemini functionDeclarations.
 */
function _convertToolsToGemini(tools) {
  if (!tools || tools.length === 0) return null;
  const declarations = tools.map(t => {
    const fn = t.function;
    const params = fn.parameters || {};
    // Gemini requires 'type: "OBJECT"' at the top level
    const schema = {
      type: 'OBJECT',
      properties: params.properties || {},
      required: params.required || []
    };
    return { name: fn.name, description: fn.description, parameters: schema };
  });
  return [{ functionDeclarations: declarations }];
}

/**
 * OpenRouter API caller - Primary AI provider.
 * Uses OpenAI-compatible format directly (no conversion needed).
 */
function _callOpenRouter(apiKey, messages, modelName, skipTools, maxTokens, toolsOverride) {
  const model = modelName || OPENROUTER_MODELS.PRIMARY;

  const payload = {
    model: model,
    messages: messages,
    temperature: 0.2,
    max_tokens: maxTokens || 1200
  };

  if (!skipTools) {
    const rawTools = toolsOverride || _AI_TOOLS;
    if (rawTools && rawTools.length > 0) {
      payload.tools = rawTools;
      payload.tool_choice = 'auto';
    }
  }

  try {
    const response = UrlFetchApp.fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'HTTP-Referer': 'https://starlight-procurement.com',
        'X-Title': 'ProcurePilot AI'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    const json = JSON.parse(response.getContentText());

    if (code >= 400) {
      return { error: `OpenRouter Error (${code}): ${json.error?.message || JSON.stringify(json)}` };
    }

    if (!json.choices || json.choices.length === 0) {
      return { error: 'OpenRouter returned empty response.' };
    }

    // OpenRouter returns OpenAI-compatible format - return directly
    return {
      choices: json.choices,
      model: json.model || model
    };

  } catch (e) {
    return { error: 'OpenRouter exception: ' + e.message };
  }
}

/**
 * Unified AI caller with automatic fallback chain:
 * 1. OpenRouter Hunter Alpha (primary)
 * 2. OpenRouter Healer Alpha (secondary)
 * 3. Gemini (final fallback)
 */
function _callAI(messages, modelName, skipTools, maxTokens, toolsOverride, enableThinking) {
  const openRouterKey = PropertiesService.getScriptProperties().getProperty('OPENROUTER_API_KEY');
  const geminiKey = _getAIKey();

  // Try OpenRouter models first (primary provider)
  if (openRouterKey) {
    // Try Hunter Alpha first
    const hunterResult = _callOpenRouter(openRouterKey, messages, OPENROUTER_MODELS.PRIMARY, skipTools, maxTokens, toolsOverride);
    if (!hunterResult.error) return hunterResult;

    console.warn('Hunter Alpha failed: ' + hunterResult.error + '. Trying Healer Alpha...');

    // Try Healer Alpha as fallback
    const healerResult = _callOpenRouter(openRouterKey, messages, OPENROUTER_MODELS.SECONDARY, skipTools, maxTokens, toolsOverride);
    if (!healerResult.error) return healerResult;

    console.warn('Healer Alpha failed: ' + healerResult.error + '. Falling back to Gemini...');
  }

  // Final fallback to Gemini
  if (geminiKey) {
    return _callGemini(geminiKey, messages, modelName, skipTools, maxTokens, toolsOverride, enableThinking);
  }

  return { error: "All AI providers failed. Check OPENROUTER_API_KEY and GEMINI_API_KEY in Script Properties." };
}

/**
 * Core Gemini API caller with automatic model fallback.
 * Converts OpenAI-style messages/tools to Gemini format, calls the API,
 * and normalizes the response back to OpenAI-style for compatibility.
 */
function _callGemini(apiKey, messages, modelName, skipTools, maxTokens, toolsOverride, enableThinking) {
  const startModel = modelName || GEMINI_MODELS.FAST;

  // Build fallback chain starting from the requested model
  const startIdx = _GEMINI_FALLBACK_CHAIN.indexOf(startModel);
  const modelsToTry = startIdx >= 0
    ? _GEMINI_FALLBACK_CHAIN.slice(startIdx)
    : [startModel, ..._GEMINI_FALLBACK_CHAIN];

  // Store tool name mapping for tool responses
  const enrichedMessages = messages.map(m => {
    if (m.role === 'tool' && m.tool_call_id) {
      return { ...m, _toolName: m._toolName || 'tool' };
    }
    return m;
  });

  for (const tryModel of modelsToTry) {
    try {
      const { systemInstruction, contents } = _convertToGeminiFormat(enrichedMessages);

      const payload = {
        contents: contents,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: maxTokens || 1200
        }
      };

      // Enable thinking for Gemini 2.5 Flash (dramatically improves reasoning)
      if (enableThinking && tryModel.includes('2.5')) {
        payload.generationConfig.thinkingConfig = { thinkingBudget: 2048 };
      }

      if (systemInstruction) payload.systemInstruction = systemInstruction;

      if (!skipTools) {
        const rawTools = toolsOverride || _AI_TOOLS;
        const geminiTools = _convertToolsToGemini(rawTools);
        if (geminiTools) payload.tools = geminiTools;
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${tryModel}:generateContent?key=${apiKey}`;

      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      const code = response.getResponseCode();
      const json = JSON.parse(response.getContentText());

      // Rate limit or server error → try next model
      if (code === 429 || code >= 500) {
        console.warn(`Gemini ${tryModel} returned ${code}, trying fallback...`);
        continue;
      }

      if (json.error) {
        // Quota/rate errors → fallback
        if (json.error.code === 429 || json.error.code >= 500) {
          console.warn(`Gemini ${tryModel} error ${json.error.code}: ${json.error.message}, trying fallback...`);
          continue;
        }
        return { error: 'Gemini Error: ' + (json.error.message || JSON.stringify(json.error)) };
      }

      if (!json.candidates || json.candidates.length === 0) {
        return { error: 'AI returned empty response.' };
      }

      // Normalize Gemini response → OpenAI-compatible format for our agentic loop
      return _normalizeGeminiResponse(json, tryModel);

    } catch (e) {
      console.error(`Gemini ${tryModel} exception: ${e.message}`);
      continue;
    }
  }

  return { error: 'All Gemini models failed. Please try again later.' };
}

/**
 * Normalize Gemini API response to OpenAI-compatible format.
 * This allows the existing agentic loop to work without changes.
 */
function _normalizeGeminiResponse(geminiJson, modelUsed) {
  const candidate = geminiJson.candidates[0];
  const parts = candidate.content ? candidate.content.parts : [];

  let textContent = '';
  const toolCalls = [];

  for (const part of parts) {
    // Skip internal thinking parts from Gemini 2.5 thinking mode
    if (part.thought) continue;
    if (part.text) {
      textContent += part.text;
    }
    if (part.functionCall) {
      toolCalls.push({
        id: 'call_' + Utilities.getUuid(),
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {})
        }
      });
    }
  }

  const message = {
    role: 'assistant',
    content: textContent || null
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    choices: [{ message: message }],
    model: modelUsed
  };
}