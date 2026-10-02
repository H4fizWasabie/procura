// procura/orders.ts -- preview and create POs and RFQs through the assistant account.
//
// previewOrder() saves nothing: it runs the checks the server will run and shows the result.
// createOrder() re-checks, saves through the API, then reads the document back.

import { AmbiguousOutcomeError, type ProcuraApi } from "./client.ts";
import type { ItemRow, PoRecord, RfqRecord, Store } from "./store.ts";

export interface OrderLineInput {
  stock_id: string;
  qty: number;
  uom?: string;
  cost?: number;
}

export interface OrderInput {
  kind: "po" | "rfq";
  supplier: string;
  department?: string;
  date?: string;
  terms?: string;
  lines: OrderLineInput[];
}

export interface Finding {
  stock_id?: string;
  message: string;
}

export interface OrderPreview {
  ok: boolean;
  kind: "po" | "rfq";
  input: OrderInput;
  payload: Record<string, unknown> | null;
  blockers: Finding[];
  warnings: Finding[];
  text: string;
}

export const MAX_LINES = 100;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const tag = (finding: Finding): string => (finding.stock_id ? `[${finding.stock_id}] ` : "");

/** Today's date in Kuala Lumpur as YYYY-MM-DD. */
export function todayKul(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(now);
}

function blockersForItem(id: string, item: ItemRow): Finding[] {
  const out: Finding[] = [];
  const label = `${item.item_name} [${id}]`;
  if (item.purchase_policy === null || item.purchase_policy === "") {
    out.push({ stock_id: id, message: `${label} has no purchase policy (unclassified). Set routine or on_demand first.` });
  } else if (item.purchase_policy !== "routine" && item.purchase_policy !== "on_demand") {
    out.push({ stock_id: id, message: `${label} has purchase policy ${item.purchase_policy}. Change the policy first.` });
  }
  const status = item.product_status.trim().toLowerCase();
  if (status === "not-available" || status === "unavailable") {
    out.push({ stock_id: id, message: `${label} is marked not-available. An assistant cannot override that; the user must create this order in Procura.` });
  }
  if (item.uom_confirmation_pending === 1) {
    out.push({ stock_id: id, message: `${label} has a pending UOM change. The user must press Confirm UOM in the item editor first.` });
  }
  return out;
}

export async function previewOrder(rawInput: OrderInput, store: Store, today: string = todayKul()): Promise<OrderPreview> {
  const input: OrderInput = {
    kind: rawInput.kind,
    supplier: rawInput.supplier.trim(),
    department: rawInput.department?.trim() || undefined,
    date: rawInput.date?.trim() || today,
    terms: rawInput.terms?.trim() || undefined,
    lines: rawInput.lines.map((line) => ({ ...line, stock_id: line.stock_id.trim() })),
  };
  const blockers: Finding[] = [];
  const warnings: Finding[] = [];
  const kindLabel = input.kind === "po" ? "PO" : "RFQ";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? "")) blockers.push({ message: "date must be YYYY-MM-DD." });
  if (input.lines.length === 0) blockers.push({ message: "At least one line is required." });
  if (input.lines.length > MAX_LINES) blockers.push({ message: `At most ${MAX_LINES} lines per document.` });
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (!Number.isFinite(line.qty) || line.qty <= 0) blockers.push({ stock_id: line.stock_id, message: "qty must be a number above 0." });
    if (line.cost !== undefined && (!Number.isFinite(line.cost) || line.cost < 0)) blockers.push({ stock_id: line.stock_id, message: "cost must be 0 or more." });
    if (seen.has(line.stock_id)) blockers.push({ stock_id: line.stock_id, message: "listed twice; combine the quantities into one line." });
    seen.add(line.stock_id);
  }

  // supplier: must be an existing supplier so a typo cannot create a new one by accident
  let supplier = input.supplier;
  if (!supplier) {
    blockers.push({ message: "supplier is required." });
  } else {
    const suppliers = await store.suppliers();
    const exact = suppliers.find((name) => name.trim().toLowerCase() === supplier.toLowerCase());
    if (exact) {
      supplier = exact;
    } else {
      const near = suppliers.filter((name) => name.toLowerCase().includes(supplier.toLowerCase().split(/\s+/)[0] ?? "")).slice(0, 5);
      blockers.push({ message: `Unknown supplier "${supplier}".${near.length ? ` Did you mean: ${near.join("; ")}?` : ""}` });
    }
  }
  if (input.kind === "po" && !input.department) {
    const known = await store.departments();
    blockers.push({ message: `department is required for a PO.${known.length ? ` Used so far: ${known.join(", ")}.` : ""}` });
  }

  const ids = input.lines.map((line) => line.stock_id).filter((id) => id !== "");
  for (const line of input.lines) if (line.stock_id === "") blockers.push({ message: "Every line needs a stock_id from the item master." });
  const items = await store.items(ids);
  const hints = await store.caseInsensitiveMatches(ids.filter((id) => !items.has(id)));
  for (const id of ids) {
    const item = items.get(id);
    if (!item) {
      const hint = hints.get(id);
      blockers.push({ stock_id: id, message: `Unknown stock_id ${id}.${hint ? ` Ids are case-sensitive; did you mean ${hint}?` : " Use procura_search_items to find the exact id."}` });
      continue;
    }
    blockers.push(...blockersForItem(id, item));
  }

  const onOrder = await store.onOrder([...items.keys()]);
  for (const [id, refs] of onOrder) {
    warnings.push({ stock_id: id, message: `${items.get(id)?.item_name ?? id} is already on order: ${[...new Set(refs)].join(", ")}.` });
  }
  const supplierUoms = supplier ? await store.supplierUoms(supplier, [...items.keys()]) : new Map<string, string>();

  const rows = input.lines.flatMap((line) => {
    const item = items.get(line.stock_id);
    if (!item) return [];
    const cost = line.cost ?? item.cost;
    return [{ line, item, uom: line.uom?.trim() || item.uom, cost, total: round2(line.qty * cost), supplierUom: supplierUoms.get(line.stock_id) ?? "" }];
  });

  let payload: Record<string, unknown> | null = null;
  if (blockers.length === 0) {
    payload = input.kind === "po"
      ? {
          date: input.date, department: input.department, supplier, terms: input.terms ?? "",
          total: round2(rows.reduce((sum, r) => sum + r.total, 0)),
          items: rows.map((r) => ({ stock_id: r.line.stock_id, item_name: r.item.item_name, quantity: r.line.qty, cost: r.cost, total: r.total, uom: r.uom, supplier_uom: r.supplierUom })),
        }
      : {
          date: input.date, supplier, items_count: rows.length,
          items: rows.map((r) => ({ stock_id: r.line.stock_id, item_name: r.item.item_name, uom: r.uom, qty: r.line.qty })),
        };
  }

  const out: string[] = [`${kindLabel} preview - nothing is saved yet`];
  out.push(`Supplier: ${supplier || "(none)"} | Date: ${input.date}${input.kind === "po" ? ` | Department: ${input.department ?? "(none)"}` : ""}`);
  rows.forEach((r, i) => {
    const money = input.kind === "po" ? ` @ ${fmt(r.cost)} = ${fmt(r.total)}` : "";
    const supUom = r.supplierUom && r.supplierUom !== r.uom ? ` (supplier unit: ${r.supplierUom})` : "";
    out.push(`${i + 1}. ${r.item.item_name} [${r.line.stock_id}]: ${fmt(r.line.qty)} ${r.uom}${money}${supUom} | stock ${fmt(r.item.current_stock)} / ROP ${fmt(r.item.rop)}`);
  });
  if (input.kind === "po") out.push(`Total: ${fmt(round2(rows.reduce((sum, r) => sum + r.total, 0)))}. Quantities are in stock units; no pack conversion is applied.`);
  if (warnings.length) out.push("Warnings:", ...warnings.map((w) => `- ${tag(w)}${w.message}`));
  if (blockers.length) {
    out.push("CANNOT SAVE - fix these first:", ...blockers.map((b) => `- ${tag(b)}${b.message}`));
  } else {
    out.push(input.kind === "po"
      ? "If saved, this PO is created as Pending Approval; only the user can approve it in Procura."
      : "If saved, this RFQ is stored as a draft; sending it to the supplier stays a manual step.");
  }
  return { ok: blockers.length === 0, kind: input.kind, input, payload, blockers, warnings, text: out.join("\n") };
}

export interface CreateResult {
  ok: boolean;
  id?: string;
  text: string;
}

function sameLines(expected: { stock_id: string; qty: number }[], actual: { stock_id: string; quantity: number }[]): boolean {
  const key = (id: string, qty: number) => `${id}|${qty}`;
  const a = expected.map((l) => key(l.stock_id, l.qty)).sort();
  const b = actual.map((l) => key(l.stock_id, l.quantity)).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function createOrder(preview: OrderPreview, deps: { api: ProcuraApi; store: Store; today?: string }): Promise<CreateResult> {
  const kindLabel = preview.kind === "po" ? "PO" : "RFQ";
  // Re-check: items, policy or availability may have changed since the preview.
  const again = await previewOrder(preview.input, deps.store, deps.today);
  if (!again.ok) return { ok: false, text: `Not saved: the checks no longer pass.\n${again.text}` };
  if (JSON.stringify(again.payload) !== JSON.stringify(preview.payload)) {
    return { ok: false, text: "Not saved: item details changed since the preview (name, unit or cost). Preview again so the user reviews the current values." };
  }

  const path = preview.kind === "po" ? "/api/pos" : "/api/rfq";
  const expected = preview.input.lines.map((l) => ({ stock_id: l.stock_id, qty: l.qty }));
  let id = "";
  try {
    const result = await deps.api.post(path, preview.payload);
    if (result.status !== 200 || result.body.success !== true) {
      const reason = typeof result.body.error === "string" ? result.body.error : `HTTP ${result.status}`;
      return { ok: false, text: `Procura refused the ${kindLabel}: ${reason}` };
    }
    id = String(result.body.po_id ?? result.body.rfq_id ?? "");
  } catch (error) {
    if (!(error instanceof AmbiguousOutcomeError)) throw error;
    // Never retry blindly: look for a document that matches before telling the user anything.
    const supplier = String(preview.payload?.supplier ?? "");
    const recent: (PoRecord | RfqRecord)[] = preview.kind === "po" ? await deps.store.recentPos(supplier) : await deps.store.recentRfqs(supplier);
    const match = recent.find((doc) => sameLines(expected, doc.lines) && doc.date === preview.input.date);
    if (match) {
      const matchId = "po_id" in match ? match.po_id : match.rfq_id;
      return { ok: true, id: matchId, text: `The save did not report back, but ${kindLabel} ${matchId} for ${supplier} with these lines exists. Treat it as saved and verify it in Procura. Do not save it again.` };
    }
    return { ok: false, text: `The save did not report back and no matching ${kindLabel} was found for ${supplier}. It was probably not saved. Check Procura before trying again.` };
  }
  if (!id) return { ok: false, text: `Procura accepted the ${kindLabel} but returned no id. Check Procura before trying again.` };

  // Read it back.
  const problems: string[] = [];
  if (preview.kind === "po") {
    const saved = await deps.store.po(id);
    if (!saved) problems.push("could not be read back");
    else {
      if (saved.status !== "Pending Approval") problems.push(`status is ${saved.status}, expected Pending Approval`);
      if (!sameLines(expected, saved.lines)) problems.push("saved lines differ from the preview");
    }
  } else {
    const saved = await deps.store.rfq(id);
    if (!saved) problems.push("could not be read back");
    else if (!sameLines(expected, saved.lines)) problems.push("saved lines differ from the preview");
  }
  const note = preview.kind === "po" ? "It is Pending Approval; the user approves it in Procura." : "It is a draft; sending it to the supplier is manual.";
  if (problems.length) return { ok: true, id, text: `${kindLabel} ${id} was saved, but the read-back found a problem: ${problems.join("; ")}. Tell the user to check it in Procura.` };
  return { ok: true, id, text: `${kindLabel} ${id} saved and verified (${expected.length} line${expected.length === 1 ? "" : "s"}). ${note}` };
}
