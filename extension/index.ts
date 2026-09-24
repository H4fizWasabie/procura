// procura/index.ts — Theoses extension exposing read-only Procura DB queries.
//
// Tools:
//   procura_search_items — find items by name/stock_id/supplier/category
//   procura_item_usage   — monthly in/out movement history for one item
//   procura_po           — purchase order lookup (by PO id, or list by supplier/status)
//   procura_sql          — escape hatch: any single SELECT/WITH statement (row-capped)
//
// The DB is opened -readonly by db.ts on every call. There is deliberately no
// write path: mutations belong to the Procura app so its audit tables stay
// authoritative.

import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "theoses-coding-agent";
import { normalizePoLines, queryRowsCapped, resolveDbPath, type Row } from "./db.ts";

const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_SQL_MAX_ROWS = 100;
const MAX_SQL_MAX_ROWS = 500;
const DEFAULT_PO_LIMIT = 10;

const compact = (value: unknown): string => JSON.stringify(value);

function truncateText(text: string, max = 6000): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated, full data in details]`;
}

function toolResult(text: string, details: unknown) {
  return {
    content: [{ type: "text" as const, text: truncateText(text) }],
    details,
  };
}

async function guarded(tool: string, dbPathPromise: Promise<string>, fn: (dbPath: string) => Promise<unknown>) {
  try {
    const dbPath = await dbPathPromise;
    const details = await fn(dbPath);
    return toolResult(compact(details), details);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The error goes back to the model as an ordinary result (isError is unset), so the core [tool] line reports
    // it as ok. Log it here so the journal shows which tool failed and why.
    console.error(`[procura] ${tool} failed: ${message.slice(0, 300)}`);
    return toolResult(compact({ error: message }), { error: message });
  }
}

const SearchItemsParams = Type.Object({
  query: Type.String({ description: "Item name fragment, stock_id, supplier or category (case-insensitive, substring match)" }),
  limit: Type.Optional(Type.Number({ description: `Max results (default ${DEFAULT_SEARCH_LIMIT})` })),
});
type SearchItemsInput = Static<typeof SearchItemsParams>;

const ItemUsageParams = Type.Object({
  stock_id: Type.String({ description: "Exact stock_id (e.g. M24064IM-100) or an item name — names are auto-resolved" }),
  months: Type.Optional(Type.Number({ description: "How many recent months of movements to return (default 6)" })),
});
type ItemUsageInput = Static<typeof ItemUsageParams>;

const PoParams = Type.Object({
  po_id: Type.Optional(Type.String({ description: 'Exact PO id, e.g. "PO - 072026 - 001" (fuzzy match if not exact). Returns header + line items.' })),
  supplier: Type.Optional(Type.String({ description: "List POs for a supplier (substring match)" })),
  status: Type.Optional(Type.String({ description: 'Filter list results by status, e.g. "Paid", "Pending Payment"' })),
  limit: Type.Optional(Type.Number({ description: `Max POs listed (default ${DEFAULT_PO_LIMIT})` })),
});
type PoInput = Static<typeof PoParams>;

const SqlParams = Type.Object({
  query: Type.String({ description: "Single SELECT or WITH statement against the Procura schema" }),
  max_rows: Type.Optional(Type.Number({ description: `Row cap (default ${DEFAULT_SQL_MAX_ROWS}, max ${MAX_SQL_MAX_ROWS})` })),
});
type SqlInput = Static<typeof SqlParams>;

export default function procuraExtension(theoses: ExtensionAPI) {
  const dbPath = resolveDbPath();

  theoses.registerTool({
    name: "procura_search_items",
    label: "Procura: Search Items",
    description:
      "Search the Procura item master (veterinary clinic procurement). Returns stock_id, item_name, current_stock, rop (reorder point), uom, category, supplier, product_status. Use this first to resolve an item name to its stock_id.",
    parameters: SearchItemsParams,
    async execute(_toolCallId: string, input: SearchItemsInput) {
      const limit = Math.min(Math.max(input.limit ?? DEFAULT_SEARCH_LIMIT, 1), 100);
      const like = `%${input.query.trim()}%`;
      const sql = `SELECT stock_id, item_name, category, uom, current_stock, rop, pack_size, product_status, supplier_name
FROM items
WHERE item_name LIKE '${like.replace(/'/g, "''")}'
   OR stock_id LIKE '${like.replace(/'/g, "''")}'
   OR supplier_name LIKE '${like.replace(/'/g, "''")}'
   OR category LIKE '${like.replace(/'/g, "''")}'
ORDER BY (product_status = 'Available') DESC, item_name
LIMIT ${limit};`;
      return guarded("procura_search_items", dbPath, async (path) => {
        const rows = await queryRowsCapped(path, sql, limit);
        return rows.length ? rows : { result: [], note: `No items matched "${input.query}". Try a shorter fragment.` };
      });
    },
  });

  theoses.registerTool({
    name: "procura_item_usage",
    label: "Procura: Item Usage History",
    description:
      "Monthly stock movement history (in_qty, out_qty, adjustments, closing) for one item, newest first, plus the item's current_stock and rop. Pass a stock_id; an item name is auto-resolved via search.",
    parameters: ItemUsageParams,
    async execute(_toolCallId: string, input: ItemUsageInput) {
      const months = Math.min(Math.max(input.months ?? 6, 1), 36);
      return guarded("procura_item_usage", dbPath, async (path) => {
        const key = input.stock_id.trim().replace(/'/g, "''");
        const items = await queryRowsCapped(
          path,
          `SELECT stock_id, item_name, uom, current_stock, rop, product_status, category FROM items
WHERE stock_id = '${key}' OR item_name = '${key}' LIMIT 2;`,
          2,
        );
        let item = items[0];
        if (!item) {
          const fuzzy = await queryRowsCapped(
            path,
            `SELECT stock_id, item_name, uom, current_stock, rop, product_status, category FROM items
WHERE item_name LIKE '%${key}%' ORDER BY (product_status = 'Available') DESC LIMIT 2;`,
            2,
          );
          if (fuzzy.length === 1) item = fuzzy[0];
          else if (!fuzzy.length) return { error: `No item found for "${input.stock_id}". Use procura_search_items to find the stock_id.` };
          else return { error: `Ambiguous name "${input.stock_id}". Use procura_search_items to pick the exact stock_id.`, candidates: fuzzy };
        }
        const stockId = String(item.stock_id).replace(/'/g, "''");
        const movements = await queryRowsCapped(
          path,
          `SELECT year, month, in_qty, out_qty, adj_in, adj_out, report_closing
FROM stock_movements WHERE stock_id = '${stockId}'
ORDER BY year DESC, month DESC LIMIT ${months};`,
          months,
        );
        return { item, recent_months: movements };
      });
    },
  });

  theoses.registerTool({
    name: "procura_po",
    label: "Procura: Purchase Order Lookup",
    description:
      "Purchase order access. With po_id: full PO (header + line items). Without: list recent POs, optionally filtered by supplier (substring) and status (Paid / Pending Payment / VOID).",
    parameters: PoParams,
    async execute(_toolCallId: string, input: PoInput) {
      return guarded("procura_po", dbPath, async (path) => {
        if (input.po_id) {
          const id = input.po_id.trim().replace(/'/g, "''");
          let header = (
            await queryRowsCapped(
              path,
              `SELECT po_id, date, supplier, department, status, ship_status, total, paid, balance, bill_no, terms, invoice_date
FROM purchase_orders WHERE po_id = '${id}' LIMIT 1;`,
              1,
            )
          )[0];
          if (!header) {
            header = (
              await queryRowsCapped(
                path,
                `SELECT po_id, date, supplier, department, status, ship_status, total, paid, balance, bill_no, terms, invoice_date
FROM purchase_orders WHERE po_id LIKE '%${id}%' ORDER BY date DESC LIMIT 1;`,
                1,
              )
            )[0];
          }
          if (!header) return { error: `No PO found for "${input.po_id}".` };
          const exactId = String(header.po_id).replace(/'/g, "''");
          let lines = await queryRowsCapped(
            path,
            `SELECT item_name, quantity, uom, cost, total, stock_id, pack_size
FROM purchase_order_items WHERE po_id = '${exactId}' ORDER BY id;`,
            200,
          );
          if (!lines.length) {
            const raw = (
              await queryRowsCapped(path, `SELECT raw_po_json FROM purchase_orders WHERE po_id = '${exactId}' LIMIT 1;`, 1)
            )[0]?.raw_po_json;
            if (typeof raw === "string" && raw) {
              try {
                lines = normalizePoLines(raw);
              } catch {
                lines = [];
              }
            }
          }
          return { purchase_order: header, line_items: lines };
        }

        const limit = Math.min(Math.max(input.limit ?? DEFAULT_PO_LIMIT, 1), 100);
        const conditions: string[] = [];
        if (input.supplier) conditions.push(`supplier LIKE '%${input.supplier.trim().replace(/'/g, "''")}%'`);
        if (input.status) conditions.push(`status = '${input.status.trim().replace(/'/g, "''")}'`);
        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        return queryRowsCapped(
          path,
          `SELECT po_id, date, supplier, status, ship_status, total, department FROM purchase_orders ${where}
ORDER BY date DESC LIMIT ${limit};`,
          limit,
        );
      });
    },
  });

  theoses.registerTool({
    name: "procura_sql",
    label: "Procura: Raw SQL (read-only)",
    description:
      "Run ONE read-only SELECT/WITH statement against the Procura SQLite DB. Use the intent tools (procura_search_items / procura_item_usage / procura_po) first; fall back to this for questions they don't cover. Schema: items(stock_id PK), suppliers(supplier_name PK), purchase_orders(po_id PK), purchase_order_items(po_id FK), stock_movements(stock_id, year, month), invoices, direct_orders, supplier_item_mappings, catalogue_items, analytics_config, settings.",
    parameters: SqlParams,
    async execute(_toolCallId: string, input: SqlInput) {
      const maxRows = Math.min(Math.max(input.max_rows ?? DEFAULT_SQL_MAX_ROWS, 1), MAX_SQL_MAX_ROWS);
      return guarded("procura_sql", dbPath, async (path) => {
        const rows = await queryRowsCapped(path, input.query, maxRows);
        return rows.length ? rows : { result: [] };
      });
    },
  });
}
