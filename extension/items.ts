// procura/items.ts -- preview and apply item edits through the assistant account.
//
// Only the fields the ASSISTANT role may edit are accepted here (the server enforces the same list).
// Every edit needs a reason, goes through Procura's audited edit endpoint, and is read back.

import { AmbiguousOutcomeError, type ProcuraApi } from "./client.ts";
import type { ItemRow, Store } from "./store.ts";

export const EDITABLE_FIELDS = [
  "exclude", "item_behaviour", "purchase_policy", "product_status", "product_type", "rop", "velocity_override", "pack_size",
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];
export type Value = string | number | boolean | null;
export type Changes = Partial<Record<EditableField, Value>>;

export interface ItemEdit {
  stock_id: string;
  changes: Changes;
}

export interface Diff {
  stock_id: string;
  name: string;
  field: EditableField | "rop (forced)";
  from: string;
  to: string;
}

export interface EditPreview {
  ok: boolean;
  reason: string;
  /** Only the fields that really change, normalised, per item. */
  edits: ItemEdit[];
  diffs: Diff[];
  blockers: string[];
  warnings: string[];
  sideEffects: string[];
  text: string;
}

export const MAX_EDITS = 100;
const BEHAVIOURS = ["Standard / Pack", "In-House Use", "Service", "Unavailable", "Asset"];
const POLICIES = ["routine", "on_demand", "do_not_reorder"];

/** Returns the normalised value, or an error message. */
function normalise(field: EditableField, value: Value): { value: Value } | { error: string } {
  const text = typeof value === "string" ? value.trim() : value;
  switch (field) {
    case "exclude": {
      const flag = text === true ? 1 : text === false ? 0 : text === "0" || text === "1" ? Number(text) : text;
      return flag === 0 || flag === 1 ? { value: flag } : { error: "exclude must be 0 or 1" };
    }
    case "item_behaviour":
      return typeof text === "string" && BEHAVIOURS.includes(text) ? { value: text } : { error: `item_behaviour must be one of: ${BEHAVIOURS.join(", ")}` };
    case "purchase_policy":
      return text === null || (typeof text === "string" && POLICIES.includes(text)) ? { value: text } : { error: `purchase_policy must be one of: ${POLICIES.join(", ")} (or null for unclassified)` };
    case "product_status":
      return text === "Available" || text === "not-available" ? { value: text } : { error: "product_status must be Available or not-available" };
    case "product_type":
      return typeof text === "string" && text !== "" ? { value: text } : { error: "product_type must be non-empty text (it must match an existing type)" };
    case "rop":
    case "velocity_override": {
      const n = typeof text === "number" ? text : Number(text);
      return text !== "" && text !== null && Number.isFinite(n) && n >= 0 ? { value: n } : { error: `${field} must be a number, 0 or more` };
    }
    case "pack_size":
      return typeof text === "string" ? { value: text } : { error: "pack_size must be text (empty clears it)" };
  }
}

function currentValue(item: ItemRow, field: EditableField): Value {
  switch (field) {
    case "exclude": return ["1", "TRUE", "YES", "EXCLUDE"].includes(item.exclude.trim().toUpperCase()) ? 1 : 0;
    case "item_behaviour": return item.item_behaviour.trim() === "" ? "Standard / Pack" : item.item_behaviour.trim();
    case "purchase_policy": return item.purchase_policy;
    case "product_status": return item.product_status;
    case "product_type": return item.product_type;
    case "rop": return item.rop;
    case "velocity_override": return item.velocity_override.trim() === "" ? 0 : Number(item.velocity_override);
    case "pack_size": return item.pack_size.trim();
  }
}

const show = (value: Value): string => (value === null ? "(unclassified)" : value === "" ? "(empty)" : String(value));
const isForcedZero = (changes: Changes): boolean => changes.item_behaviour === "Service" || changes.item_behaviour === "Asset";

export async function previewItemEdits(edits: ItemEdit[], reasonRaw: string, store: Store): Promise<EditPreview> {
  const reason = reasonRaw.trim();
  const blockers: string[] = [];
  const warnings: string[] = [];
  const sideEffects: string[] = [];
  const diffs: Diff[] = [];
  const kept: ItemEdit[] = [];

  if (!reason) blockers.push("A reason is required (use the user's own words).");
  if (edits.length === 0) blockers.push("At least one edit is required.");
  if (edits.length > MAX_EDITS) blockers.push(`At most ${MAX_EDITS} items per batch.`);
  const items = await store.items(edits.map((e) => e.stock_id.trim()));
  const seen = new Set<string>();

  for (const edit of edits) {
    const id = edit.stock_id.trim();
    const item = items.get(id);
    if (seen.has(id)) blockers.push(`[${id}] is listed twice.`);
    seen.add(id);
    if (!item) {
      blockers.push(`Unknown stock_id ${id}. Ids are exact and case-sensitive; use procura_search_items.`);
      continue;
    }
    const keys = Object.keys(edit.changes) as EditableField[];
    if (keys.length === 0) blockers.push(`[${id}] has no changes.`);
    const real: Changes = {};
    for (const field of keys) {
      if (!EDITABLE_FIELDS.includes(field)) {
        blockers.push(`[${id}] ${String(field)} cannot be edited by the assistant (allowed: ${EDITABLE_FIELDS.join(", ")}).`);
        continue;
      }
      const result = normalise(field, edit.changes[field] as Value);
      if ("error" in result) {
        blockers.push(`[${id}] ${result.error}.`);
        continue;
      }
      const from = currentValue(item, field);
      if (from === result.value) {
        warnings.push(`[${id}] ${item.item_name}: ${field} is already ${show(from)}; no change.`);
        continue;
      }
      real[field] = result.value;
      diffs.push({ stock_id: id, name: item.item_name, field, from: show(from), to: show(result.value) });
    }
    if (isForcedZero(real) && item.rop !== 0) {
      diffs.push({ stock_id: id, name: item.item_name, field: "rop (forced)", from: show(item.rop), to: "0" });
      sideEffects.push(`[${id}] ${item.item_name}: Service/Asset behaviour forces the reorder point to 0.`);
    }
    if (Object.keys(real).length > 0) kept.push({ stock_id: id, changes: real });
  }
  if (blockers.length === 0 && kept.length === 0) blockers.push("Nothing to change: every requested value already matches.");

  const out: string[] = ["Item edit preview - nothing is changed yet", `Reason: ${reason || "(missing)"}`];
  for (const diff of diffs) out.push(`- ${diff.name} [${diff.stock_id}] ${diff.field}: ${diff.from} -> ${diff.to}`);
  if (sideEffects.length) out.push("Side effects:", ...sideEffects.map((s) => `- ${s}`));
  if (warnings.length) out.push("Notes:", ...warnings.map((w) => `- ${w}`));
  if (blockers.length) out.push("CANNOT APPLY - fix these first:", ...blockers.map((b) => `- ${b}`));
  else out.push(`If applied: ${kept.length} item${kept.length === 1 ? "" : "s"} changed, each recorded in Procura's audit log with this reason.`);
  return { ok: blockers.length === 0, reason, edits: kept, diffs, blockers, warnings, sideEffects, text: out.join("\n") };
}

function matches(item: ItemRow, changes: Changes): string[] {
  const wrong: string[] = [];
  for (const field of Object.keys(changes) as EditableField[]) {
    if (currentValue(item, field) !== changes[field]) wrong.push(field);
  }
  if (isForcedZero(changes) && item.rop !== 0) wrong.push("rop");
  return wrong;
}

export interface ApplyResult {
  ok: boolean;
  text: string;
}

export async function applyItemEdits(preview: EditPreview, deps: { api: ProcuraApi; store: Store }): Promise<ApplyResult> {
  // Re-check against current data so a stale preview cannot overwrite newer values unseen.
  const again = await previewItemEdits(preview.edits, preview.reason, deps.store);
  if (!again.ok) return { ok: false, text: `Not applied: the checks no longer pass.\n${again.text}` };
  if (JSON.stringify(again.edits) !== JSON.stringify(preview.edits) || again.diffs.some((d, i) => d.from !== preview.diffs[i]?.from)) {
    return { ok: false, text: "Not applied: the items changed since the preview. Preview again so the user reviews the current values." };
  }

  const lines: string[] = [];
  let failures = 0;
  for (const edit of preview.edits) {
    const name = again.diffs.find((d) => d.stock_id === edit.stock_id)?.name ?? edit.stock_id;
    let note = "";
    try {
      const result = await deps.api.post(`/api/inventory/${encodeURIComponent(edit.stock_id)}`, { ...edit.changes, reason: preview.reason });
      if (result.status !== 200 || result.body.success !== true) {
        const why = typeof result.body.error === "string" ? result.body.error : `HTTP ${result.status}`;
        failures++;
        lines.push(`- ${name} [${edit.stock_id}] FAILED: ${why}`);
        if (result.status === 403 || result.status >= 500) {
          lines.push("Stopped: Procura refused the assistant account or reported a server error. Remaining items were not touched.");
          break;
        }
        continue;
      }
    } catch (error) {
      if (!(error instanceof AmbiguousOutcomeError)) throw error;
      note = " (the reply was lost; checked below)";
    }
    const saved = (await deps.store.items([edit.stock_id])).get(edit.stock_id);
    const wrong = saved ? matches(saved, edit.changes) : ["item missing"];
    if (wrong.length) {
      failures++;
      lines.push(`- ${name} [${edit.stock_id}] NOT CONFIRMED${note}: read-back differs on ${wrong.join(", ")}`);
    } else {
      lines.push(`- ${name} [${edit.stock_id}] applied and verified${note}: ${again.diffs.filter((d) => d.stock_id === edit.stock_id).map((d) => `${d.field} ${d.from} -> ${d.to}`).join("; ")}`);
    }
  }
  const head = failures === 0 ? `Applied ${preview.edits.length} item edit${preview.edits.length === 1 ? "" : "s"}; all verified by read-back.` : `${failures} of ${preview.edits.length} edits did not complete.`;
  return { ok: failures === 0, text: [head, ...lines].join("\n") };
}

/** One explicit, single-item edit with no side effects: preview and apply in one step. */
export async function editSingleItem(edit: ItemEdit, reason: string, deps: { api: ProcuraApi; store: Store }): Promise<ApplyResult> {
  const preview = await previewItemEdits([edit], reason, deps.store);
  if (!preview.ok) return { ok: false, text: preview.text };
  if (preview.sideEffects.length > 0) {
    return { ok: false, text: `${preview.text}\nThis edit has side effects, so it needs the preview flow: use procura_preview_item_edits and let the user confirm.` };
  }
  return applyItemEdits(preview, deps);
}
