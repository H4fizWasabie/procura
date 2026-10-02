// Test doubles: a fake Procura data store and a fake API, so the logic is tested without a database or server.

import { AmbiguousOutcomeError, type ApiResult, type ProcuraApi } from "../client.ts";
import type { ItemRow, PoRecord, RfqRecord, Store } from "../store.ts";

export function item(overrides: Partial<ItemRow> & { stock_id: string }): ItemRow {
  return {
    item_name: `Item ${overrides.stock_id}`, category: "Antibiotic", product_type: "Medication", uom: "box", cost: 10,
    current_stock: 2, rop: 10, purchase_policy: "routine", product_status: "Available", exclude: "0",
    item_behaviour: "", pack_size: "", velocity_override: "", hospital_product_status: null, hospital_product_type: null,
    uom_confirmation_pending: 0, ...overrides,
  };
}

export interface FakeData {
  items: ItemRow[];
  suppliers?: string[];
  departments?: string[];
  onOrder?: Record<string, string[]>;
  supplierUoms?: Record<string, string>;
  pos?: PoRecord[];
  rfqs?: RfqRecord[];
}

export function fakeStore(data: FakeData): Store {
  const byId = (ids: string[]) => new Map(data.items.filter((i) => ids.includes(i.stock_id)).map((i) => [i.stock_id, i]));
  return {
    async items(ids: string[]) { return byId(ids); },
    async caseInsensitiveMatches(ids: string[]) {
      const out = new Map<string, string>();
      for (const id of ids) {
        const hit = data.items.find((i) => i.stock_id.toLowerCase() === id.toLowerCase());
        if (hit) out.set(id, hit.stock_id);
      }
      return out;
    },
    async suppliers() { return data.suppliers ?? ["ACME VET SUPPLY SDN BHD", "HANAVET SDN BHD"]; },
    async departments() { return data.departments ?? ["Pharmacy", "Ward"]; },
    async onOrder(ids: string[]) {
      return new Map(Object.entries(data.onOrder ?? {}).filter(([id]) => ids.includes(id)));
    },
    async supplierUoms(_supplier: string, ids: string[]) {
      return new Map(Object.entries(data.supplierUoms ?? {}).filter(([id]) => ids.includes(id)));
    },
    async po(poId: string) { return (data.pos ?? []).find((p) => p.po_id === poId) ?? null; },
    async rfq(rfqId: string) { return (data.rfqs ?? []).find((r) => r.rfq_id === rfqId) ?? null; },
    async recentPos(supplier: string) { return (data.pos ?? []).filter((p) => p.supplier === supplier); },
    async recentRfqs(supplier: string) { return (data.rfqs ?? []).filter((r) => r.supplier === supplier); },
  } as unknown as Store;
}

export interface Call {
  path: string;
  body: Record<string, unknown>;
}

/** Scripted API: each post returns the next result, or throws it when it is an Error. */
export function fakeApi(script: (ApiResult | Error)[], onPost?: (call: Call) => void): ProcuraApi & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async post(path: string, body: unknown): Promise<ApiResult> {
      const call = { path, body: body as Record<string, unknown> };
      calls.push(call);
      onPost?.(call);
      const next = script.shift();
      if (!next) throw new Error("fakeApi: no scripted response left");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

export const ok = (body: Record<string, unknown> = {}): ApiResult => ({ status: 200, body: { success: true, ...body } });
export const refused = (status: number, error: string): ApiResult => ({ status, body: { success: false, error } });
export const ambiguous = (): Error => new AmbiguousOutcomeError("no reply");

/** Mimics Procura's edit endpoint on the fake data, so a read-back sees the change. */
export function applyEdit(data: FakeData, call: Call): void {
  const id = decodeURIComponent(call.path.replace("/api/inventory/", ""));
  const row = data.items.find((i) => i.stock_id === id);
  if (!row) return;
  const { reason: _reason, ...fields } = call.body;
  for (const [key, value] of Object.entries(fields)) {
    (row as unknown as Record<string, unknown>)[key] = key === "exclude" ? String(value) : value;
  }
  if (fields.item_behaviour === "Service" || fields.item_behaviour === "Asset") row.rop = 0;
}
