// procura/store.ts -- the read-only questions the write tools ask the Procura database.
// All SQL lives here so the order and item logic can be tested against a fake store, and
// this file against a real SQLite fixture. Everything goes through the injected read-only query.

import type { Row } from "./db.ts";

export type Query = (sql: string) => Promise<Row[]>;

export interface ItemRow {
  stock_id: string;
  item_name: string;
  category: string;
  product_type: string;
  uom: string;
  cost: number;
  current_stock: number;
  rop: number;
  purchase_policy: string | null;
  product_status: string;
  exclude: string;
  item_behaviour: string;
  pack_size: string;
  velocity_override: string;
  hospital_product_status: string | null;
  hospital_product_type: string | null;
  uom_confirmation_pending: number;
}

export interface DocumentLine {
  stock_id: string;
  quantity: number;
}

export interface PoRecord {
  po_id: string;
  date: string;
  supplier: string;
  department: string;
  status: string;
  ship_status: string;
  total: number;
  lines: DocumentLine[];
}

export interface RfqRecord {
  rfq_id: string;
  date: string;
  supplier: string;
  lines: DocumentLine[];
}

const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const list = (values: string[]): string => values.map(quote).join(",");
const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function toItem(row: Row): ItemRow {
  return {
    stock_id: text(row.stock_id),
    item_name: text(row.item_name),
    category: text(row.category),
    product_type: text(row.product_type),
    uom: text(row.uom),
    cost: num(row.cost),
    current_stock: num(row.current_stock),
    rop: num(row.rop),
    purchase_policy: row.purchase_policy === null || row.purchase_policy === undefined ? null : text(row.purchase_policy),
    product_status: text(row.product_status),
    exclude: text(row.exclude),
    item_behaviour: text(row.item_behaviour),
    pack_size: text(row.pack_size),
    velocity_override: text(row.velocity_override),
    hospital_product_status: row.hospital_product_status === null || row.hospital_product_status === undefined ? null : text(row.hospital_product_status),
    hospital_product_type: row.hospital_product_type === null || row.hospital_product_type === undefined ? null : text(row.hospital_product_type),
    uom_confirmation_pending: num(row.uom_confirmation_pending),
  };
}

function rfqIds(raw: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(text(raw) || "[]");
    return Array.isArray(parsed)
      ? parsed.map((entry) => text((entry as Record<string, unknown>)?.id)).filter((id) => id !== "")
      : [];
  } catch {
    return [];
  }
}

export function createStore(query: Query) {
  return {
    /** Items by exact stock_id (the primary key, so the match is case-sensitive). */
    async items(ids: string[]): Promise<Map<string, ItemRow>> {
      const out = new Map<string, ItemRow>();
      if (ids.length === 0) return out;
      const rows = await query(`SELECT stock_id, item_name, category, product_type, uom, cost, current_stock, rop,
        purchase_policy, product_status, exclude, item_behaviour, pack_size, velocity_override,
        hospital_product_status, hospital_product_type, uom_confirmation_pending
        FROM items WHERE stock_id IN (${list(ids)})`);
      for (const row of rows) out.set(text(row.stock_id), toItem(row));
      return out;
    },

    /** Stock ids that match an unknown id only when case is ignored (a hint for typos). */
    async caseInsensitiveMatches(ids: string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      if (ids.length === 0) return out;
      const rows = await query(`SELECT stock_id FROM items WHERE lower(stock_id) IN (${list(ids.map((id) => id.toLowerCase()))})`);
      for (const row of rows) {
        const exact = text(row.stock_id);
        for (const id of ids) if (id.toLowerCase() === exact.toLowerCase()) out.set(id, exact);
      }
      return out;
    },

    async suppliers(): Promise<string[]> {
      return (await query("SELECT supplier_name FROM suppliers ORDER BY supplier_name")).map((r) => text(r.supplier_name));
    },

    /** Departments already used on POs, most used first. */
    async departments(): Promise<string[]> {
      const rows = await query(`SELECT department, COUNT(*) AS n FROM purchase_orders
        WHERE TRIM(COALESCE(department,'')) <> '' GROUP BY department ORDER BY n DESC LIMIT 8`);
      return rows.map((r) => text(r.department));
    },

    /** Open orders per stock_id from the last 30 days: PO lines, active direct orders and RFQs. */
    async onOrder(ids: string[]): Promise<Map<string, string[]>> {
      const out = new Map<string, string[]>();
      const add = (id: string, ref: string) => out.set(id, [...(out.get(id) ?? []), ref]);
      if (ids.length === 0) return out;
      const lines = await query(`SELECT poi.stock_id AS sid, po.po_id AS ref
        FROM purchase_order_items poi JOIN purchase_orders po ON po.po_id = poi.po_id
        WHERE poi.stock_id IN (${list(ids)}) AND COALESCE(po.ship_status,'') NOT IN ('Received','Delivered')
          AND COALESCE(po.status,'') <> 'VOID' AND substr(COALESCE(po.date,''),1,10) > date('now','-30 day')
        UNION ALL
        SELECT stock_id AS sid, order_id AS ref FROM direct_orders
        WHERE stock_id IN (${list(ids)}) AND status = 'ACTIVE' AND substr(COALESCE(date,''),1,10) > date('now','-30 day')`);
      for (const row of lines) add(text(row.sid), text(row.ref));
      const rfqs = await query(`SELECT rfq_id, raw_rfq_json FROM rfq_logs WHERE substr(COALESCE(date,''),1,10) > date('now','-30 day')`);
      for (const row of rfqs) for (const id of rfqIds(row.raw_rfq_json)) if (ids.includes(id)) add(id, text(row.rfq_id));
      return out;
    },

    /** The supplier's own unit label for an item, when a mapping exists. */
    async supplierUoms(supplier: string, ids: string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      if (ids.length === 0) return out;
      const rows = await query(`SELECT stock_id, supplier_uom FROM supplier_item_mappings
        WHERE supplier_name = ${quote(supplier)} AND stock_id IN (${list(ids)}) AND COALESCE(is_active,1) = 1
          AND TRIM(COALESCE(supplier_uom,'')) <> '' ORDER BY id`);
      for (const row of rows) if (!out.has(text(row.stock_id))) out.set(text(row.stock_id), text(row.supplier_uom));
      return out;
    },

    async po(poId: string): Promise<PoRecord | null> {
      const head = (await query(`SELECT po_id, date, supplier, department, status, ship_status, total
        FROM purchase_orders WHERE po_id = ${quote(poId)} LIMIT 1`))[0];
      if (!head) return null;
      const lines = await query(`SELECT stock_id, quantity FROM purchase_order_items WHERE po_id = ${quote(poId)} ORDER BY id`);
      return {
        po_id: text(head.po_id), date: text(head.date), supplier: text(head.supplier), department: text(head.department),
        status: text(head.status), ship_status: text(head.ship_status), total: num(head.total),
        lines: lines.map((r) => ({ stock_id: text(r.stock_id), quantity: num(r.quantity) })),
      };
    },

    async rfq(rfqId: string): Promise<RfqRecord | null> {
      const head = (await query(`SELECT rfq_id, date, supplier, raw_rfq_json FROM rfq_logs WHERE rfq_id = ${quote(rfqId)} LIMIT 1`))[0];
      if (!head) return null;
      let lines: DocumentLine[] = [];
      try {
        const parsed: unknown = JSON.parse(text(head.raw_rfq_json) || "[]");
        if (Array.isArray(parsed)) {
          lines = parsed.map((entry) => ({ stock_id: text((entry as Row).id), quantity: num((entry as Row).q) }));
        }
      } catch {
        lines = [];
      }
      return { rfq_id: text(head.rfq_id), date: text(head.date), supplier: text(head.supplier), lines };
    },

    /** The newest POs for a supplier, used to reconcile a save whose outcome is unknown. */
    async recentPos(supplier: string): Promise<PoRecord[]> {
      const ids = await query(`SELECT po_id FROM purchase_orders WHERE supplier = ${quote(supplier)} ORDER BY rowid DESC LIMIT 5`);
      const out: PoRecord[] = [];
      for (const row of ids) {
        const record = await this.po(text(row.po_id));
        if (record) out.push(record);
      }
      return out;
    },

    async recentRfqs(supplier: string): Promise<RfqRecord[]> {
      const ids = await query(`SELECT rfq_id FROM rfq_logs WHERE supplier = ${quote(supplier)} ORDER BY rowid DESC LIMIT 5`);
      const out: RfqRecord[] = [];
      for (const row of ids) {
        const record = await this.rfq(text(row.rfq_id));
        if (record) out.push(record);
      }
      return out;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
