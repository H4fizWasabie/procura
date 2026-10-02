// procura/index.ts — Theoses extension for Procura.
//
// Read tools (the DB is opened -readonly by db.ts on every call):
//   procura_search_items — find items by name/stock_id/supplier/category
//   procura_item_usage   — monthly in/out movement history for one item
//   procura_po           — purchase order lookup (by PO id, or list by supplier/status)
//   procura_sql          — escape hatch: any single SELECT/WITH statement (row-capped)
//
// Write tools. They never touch the DB: they call Procura's own HTTP API as the restricted
// ASSISTANT account, so its validation and audit log stay authoritative. Procura enforces the
// permissions; this code only drafts, previews, saves, and reads back.
//   procura_preview_order       — check a PO/RFQ draft and show it; saves nothing
//   procura_create_order        — save a previewed draft (needs a user reply after the preview)
//   procura_edit_item           — one explicit single-item edit, applied at once and read back
//   procura_preview_item_edits  — check a batch or side-effect edit and show old -> new; saves nothing
//   procura_apply_item_edits    — apply a previewed batch (needs a user reply after the preview)

import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "theoses-coding-agent";
import { AmbiguousOutcomeError, loadCredentials, ProcuraClient, type ProcuraApi } from "./client.ts";
import { normalizePoLines, queryRowsCapped, resolveDbPath, type Row } from "./db.ts";
import { PreviewStore } from "./guard.ts";
import { applyItemEdits, editSingleItem, previewItemEdits, type Changes, type EditPreview, type ItemEdit } from "./items.ts";
import { createOrder, previewOrder, type OrderInput, type OrderPreview } from "./orders.ts";
import { createStore } from "./store.ts";

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

const Scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

const OrderParams = Type.Object({
  kind: Type.Union([Type.Literal("po"), Type.Literal("rfq")], { description: "po = purchase order (saved as Pending Approval), rfq = request for quotation (saved as a draft)" }),
  supplier: Type.String({ description: "Supplier name; must match an existing supplier (case-insensitive)" }),
  department: Type.Optional(Type.String({ description: "Required for a PO (e.g. Pharmacy); not used for an RFQ" })),
  date: Type.Optional(Type.String({ description: "YYYY-MM-DD; defaults to today in Kuala Lumpur" })),
  terms: Type.Optional(Type.String({ description: "PO payment terms; usually leave empty" })),
  lines: Type.Array(
    Type.Object({
      stock_id: Type.String({ description: "EXACT existing stock_id (case-sensitive); resolve with procura_search_items" }),
      qty: Type.Number({ description: "Quantity, above 0" }),
      uom: Type.Optional(Type.String({ description: "Defaults to the item's UOM" })),
      cost: Type.Optional(Type.Number({ description: "Unit cost; defaults to the item's cost" })),
    }),
    { description: "1 to 100 lines, one per item" },
  ),
});

const ChangesSchema = Type.Object({
  exclude: Type.Optional(Scalar),
  item_behaviour: Type.Optional(Scalar),
  purchase_policy: Type.Optional(Scalar),
  product_status: Type.Optional(Scalar),
  product_type: Type.Optional(Scalar),
  rop: Type.Optional(Scalar),
  velocity_override: Type.Optional(Scalar),
  pack_size: Type.Optional(Scalar),
});

const ReasonField = Type.String({ description: "Why, in the user's own words; recorded in Procura's audit log" });

const EditItemParams = Type.Object({
  stock_id: Type.String({ description: "EXACT existing stock_id" }),
  changes: ChangesSchema,
  reason: ReasonField,
});

const PreviewEditsParams = Type.Object({
  edits: Type.Array(Type.Object({ stock_id: Type.String(), changes: ChangesSchema }), { description: "1 to 100 items" }),
  reason: ReasonField,
});

const PreviewIdParams = Type.Object({
  preview_id: Type.String({ description: "The preview_id returned by the matching preview tool" }),
});

const MAX_QUERY_ROWS = 5000;

export default function procuraExtension(theoses: ExtensionAPI) {
  const dbPath = resolveDbPath();
  const store = createStore(async (sql) => queryRowsCapped(await dbPath, sql, MAX_QUERY_ROWS));
  const orderPreviews = new PreviewStore<OrderPreview>();
  const editPreviews = new PreviewStore<EditPreview>();
  let api: Promise<ProcuraApi> | undefined;

  // Credentials are read on first write, so a missing service file affects only the write tools.
  const getApi = (): Promise<ProcuraApi> => {
    api ??= loadCredentials().then((credentials) => new ProcuraClient(credentials));
    api.catch(() => {
      api = undefined;
    });
    return api;
  };

  async function writeResult(tool: string, fn: () => Promise<{ ok: boolean; text: string; extra?: Record<string, unknown> }>) {
    try {
      const out = await fn();
      return toolResult(out.text, { ok: out.ok, ...out.extra });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[procura] ${tool} failed: ${message.slice(0, 300)}`);
      const note = error instanceof AmbiguousOutcomeError ? " Check Procura before trying again." : "";
      return toolResult(`${tool} failed: ${message}${note}`, { ok: false, error: message });
    }
  }

  /** Validates a stored preview for saving: same session, fresh, unused, and a user reply since it was shown. */
  function takePreview<T>(previews: PreviewStore<T>, id: string, kind: string, ctx: ExtensionContext) {
    const sessionId = ctx.sessionManager?.getSessionId() ?? "";
    if (!sessionId) return { ok: false as const, reason: "No session context; cannot confirm the user's reply." };
    return previews.take(id.trim(), kind, sessionId, ctx.sessionManager?.getEntries() ?? []);
  }

  function sessionOf(ctx: ExtensionContext): string {
    const sessionId = ctx.sessionManager?.getSessionId() ?? "";
    if (!sessionId) throw new Error("No session context; previews cannot be tied to this conversation.");
    return sessionId;
  }

  theoses.registerTool({
    name: "procura_search_items",
    label: "Procura: Search Items",
    description:
      "Search the Procura item master (veterinary clinic procurement). Returns stock_id, item_name, current_stock, rop (reorder point), uom, category, product_type, supplier, product_status, purchase_policy (null = unclassified), item_behaviour, exclude. Use this first to resolve an item name to its exact stock_id; write tools need the exact id.",
    parameters: SearchItemsParams,
    async execute(_toolCallId: string, input: SearchItemsInput) {
      const limit = Math.min(Math.max(input.limit ?? DEFAULT_SEARCH_LIMIT, 1), 100);
      const like = `%${input.query.trim()}%`;
      const sql = `SELECT stock_id, item_name, category, product_type, uom, current_stock, rop, pack_size, product_status, purchase_policy, item_behaviour, exclude, supplier_name
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

  theoses.registerTool({
    name: "procura_preview_order",
    label: "Procura: Preview PO/RFQ",
    description:
      "Check a draft PO or RFQ and show it. Saves NOTHING. Runs the same checks Procura runs (supplier exists, exact stock_ids, purchase policy, not-available items, pending UOM change) and warns about items already on order. Show the returned text to the user verbatim, iterate on their feedback, and only after they reply with approval call procura_create_order with the preview_id. A PO is saved as Pending Approval; an RFQ as a draft. You cannot approve, send, or pay.",
    promptGuidelines: [
      "Never call procura_create_order in the same turn as procura_preview_order; the user must reply first.",
      "If the preview lists blockers, fix them or tell the user; do not work around them. Items that are not available must be created by the user in Procura.",
    ],
    parameters: OrderParams,
    async execute(_toolCallId: string, input: OrderInput, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
      return writeResult("procura_preview_order", async () => {
        const sessionId = sessionOf(ctx);
        const preview = await previewOrder(input, store);
        if (!preview.ok) return { ok: false, text: preview.text };
        const stored = orderPreviews.create("order", sessionId, preview);
        return { ok: true, text: `${preview.text}\npreview_id: ${stored.id} (valid 30 minutes)`, extra: { preview_id: stored.id } };
      });
    },
  });

  theoses.registerTool({
    name: "procura_create_order",
    label: "Procura: Save Previewed PO/RFQ",
    description:
      "Save a PO or RFQ that was previewed with procura_preview_order and that the user approved in a later message. Re-checks, saves through Procura, reads the document back, and reports the real id and status. Refused unless a user message arrived after the preview. Never retry a save whose outcome is unclear; check Procura first.",
    parameters: PreviewIdParams,
    async execute(_toolCallId: string, input: Static<typeof PreviewIdParams>, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
      return writeResult("procura_create_order", async () => {
        const result = takePreview(orderPreviews, input.preview_id, "order", ctx);
        if (!result.ok) return { ok: false, text: result.reason };
        orderPreviews.markUsed(result.preview.id);
        const saved = await createOrder(result.preview.data, { api: await getApi(), store });
        return { ok: saved.ok, text: saved.text, extra: { id: saved.id } };
      });
    },
  });

  theoses.registerTool({
    name: "procura_edit_item",
    label: "Procura: Edit One Item",
    description:
      "Apply ONE explicit edit to ONE item at once, when the user clearly asked for it (e.g. 'mark A1 as on_demand'). Editable fields: exclude (0/1), item_behaviour, purchase_policy (routine/on_demand/do_not_reorder), product_status (Available/not-available), product_type, rop, velocity_override, pack_size. A reason is required and is audited. Reads the result back and reports old -> new. Edits with side effects (Service/Asset behaviour forces ROP to 0) and anything bulk must go through procura_preview_item_edits instead. Cannot change cost, UOM, or confirm a UOM change.",
    parameters: EditItemParams,
    async execute(_toolCallId: string, input: Static<typeof EditItemParams>) {
      return writeResult("procura_edit_item", async () => {
        const edit: ItemEdit = { stock_id: input.stock_id, changes: input.changes as Changes };
        return editSingleItem(edit, input.reason, { api: await getApi(), store });
      });
    },
  });

  theoses.registerTool({
    name: "procura_preview_item_edits",
    label: "Procura: Preview Item Edits",
    description:
      "Check a batch of item edits (or one edit with side effects) and show old -> new for every field. Changes NOTHING. Show the text to the user verbatim; after they reply with approval, call procura_apply_item_edits with the preview_id. Use for any bulk change, for Service/Asset behaviour, and whenever the user has not asked for the exact edit.",
    promptGuidelines: ["Never call procura_apply_item_edits in the same turn as procura_preview_item_edits; the user must reply first."],
    parameters: PreviewEditsParams,
    async execute(_toolCallId: string, input: Static<typeof PreviewEditsParams>, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
      return writeResult("procura_preview_item_edits", async () => {
        const sessionId = sessionOf(ctx);
        const preview = await previewItemEdits(input.edits.map((e) => ({ stock_id: e.stock_id, changes: e.changes as Changes })), input.reason, store);
        if (!preview.ok) return { ok: false, text: preview.text };
        const stored = editPreviews.create("edits", sessionId, preview);
        return { ok: true, text: `${preview.text}\npreview_id: ${stored.id} (valid 30 minutes)`, extra: { preview_id: stored.id } };
      });
    },
  });

  theoses.registerTool({
    name: "procura_apply_item_edits",
    label: "Procura: Apply Previewed Item Edits",
    description:
      "Apply item edits previewed with procura_preview_item_edits and approved by the user in a later message. Re-checks against current data, edits each item through Procura's audited endpoint, and reads each one back. Refused unless a user message arrived after the preview.",
    parameters: PreviewIdParams,
    async execute(_toolCallId: string, input: Static<typeof PreviewIdParams>, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
      return writeResult("procura_apply_item_edits", async () => {
        const result = takePreview(editPreviews, input.preview_id, "edits", ctx);
        if (!result.ok) return { ok: false, text: result.reason };
        editPreviews.markUsed(result.preview.id);
        return applyItemEdits(result.preview.data, { api: await getApi(), store });
      });
    },
  });
}
