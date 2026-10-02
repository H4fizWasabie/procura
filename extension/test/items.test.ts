import assert from "node:assert/strict";
import { test } from "node:test";
import { applyItemEdits, editSingleItem, previewItemEdits } from "../items.ts";
import { ambiguous, applyEdit, fakeApi, fakeStore, item, ok, refused, type FakeData } from "./fakes.ts";

const A = item({ stock_id: "A1", rop: 8, purchase_policy: null, exclude: "1", item_behaviour: "" });
const store = (...items: ReturnType<typeof item>[]) => fakeStore({ items: items.length ? items : [A] });

test("a policy change previews as old -> new with the reason", async () => {
  const preview = await previewItemEdits([{ stock_id: "A1", changes: { purchase_policy: "on_demand" } }], "ordered recently", store());
  assert.equal(preview.ok, true);
  assert.match(preview.text, /Item A1 \[A1\] purchase_policy: \(unclassified\) -> on_demand/);
  assert.match(preview.text, /Reason: ordered recently/);
  assert.deepEqual(preview.edits, [{ stock_id: "A1", changes: { purchase_policy: "on_demand" } }]);
});

test("validation rejects bad values, unknown fields, unknown items and a missing reason", async () => {
  const cases: [string, Parameters<typeof previewItemEdits>[0], string, RegExp][] = [
    ["bad policy", [{ stock_id: "A1", changes: { purchase_policy: "sometimes" } }], "r", /purchase_policy must be one of/],
    ["empty policy string", [{ stock_id: "A1", changes: { purchase_policy: "" } }], "r", /purchase_policy must be one of/],
    ["bad behaviour", [{ stock_id: "A1", changes: { item_behaviour: "In House Use" } }], "r", /item_behaviour must be one of/],
    ["bad status", [{ stock_id: "A1", changes: { product_status: "Unavailable" } }], "r", /Available or not-available/],
    ["bad exclude", [{ stock_id: "A1", changes: { exclude: 2 } }], "r", /exclude must be 0 or 1/],
    ["null exclude", [{ stock_id: "A1", changes: { exclude: null } }], "r", /exclude must be 0 or 1/],
    ["negative rop", [{ stock_id: "A1", changes: { rop: -1 } }], "r", /rop must be a number, 0 or more/],
    ["empty rop", [{ stock_id: "A1", changes: { rop: "" } }], "r", /rop must be a number/],
    ["empty product_type", [{ stock_id: "A1", changes: { product_type: " " } }], "r", /product_type must be non-empty/],
    ["forbidden field", [{ stock_id: "A1", changes: { cost: 5 } as never }], "r", /cost cannot be edited by the assistant/],
    ["forbidden confirm action", [{ stock_id: "A1", changes: { confirm_uom: true } as never }], "r", /confirm_uom cannot be edited/],
    ["unknown item", [{ stock_id: "NOPE", changes: { rop: 1 } }], "r", /Unknown stock_id NOPE/],
    ["no changes", [{ stock_id: "A1", changes: {} }], "r", /has no changes/],
    ["missing reason", [{ stock_id: "A1", changes: { rop: 1 } }], "  ", /reason is required/],
    ["duplicate item", [{ stock_id: "A1", changes: { rop: 1 } }, { stock_id: "A1", changes: { rop: 2 } }], "r", /listed twice/],
    ["empty batch", [], "r", /At least one edit/],
  ];
  for (const [name, edits, reason, pattern] of cases) {
    const preview = await previewItemEdits(edits, reason, store());
    assert.equal(preview.ok, false, name);
    assert.match(preview.text, pattern, name);
    assert.match(preview.text, /CANNOT APPLY/, name);
  }
});

test("a value that already matches is a no-op, and an all-no-op request is refused", async () => {
  const preview = await previewItemEdits([{ stock_id: "A1", changes: { rop: 8, exclude: true } }], "r", store());
  assert.equal(preview.ok, false);
  assert.match(preview.text, /rop is already 8; no change/);
  assert.match(preview.text, /exclude is already 1; no change/);
  assert.match(preview.text, /Nothing to change/);
});

test("Service or Asset behaviour reports the forced ROP side effect", async () => {
  const preview = await previewItemEdits([{ stock_id: "A1", changes: { item_behaviour: "Service" } }], "not a stock item", store());
  assert.equal(preview.ok, true);
  assert.match(preview.text, /rop \(forced\): 8 -> 0/);
  assert.equal(preview.sideEffects.length, 1);
});

test("a single explicit edit is applied at once and verified by read-back", async () => {
  const data: FakeData = { items: [item({ stock_id: "A1", rop: 8 })] };
  const api = fakeApi([ok()], (call) => applyEdit(data, call));
  const result = await editSingleItem({ stock_id: "A1", changes: { rop: 12 } }, "seasonal demand", { api, store: fakeStore(data) });
  assert.equal(result.ok, true);
  assert.match(result.text, /applied and verified.*rop 8 -> 12/);
  assert.equal(api.calls[0]?.path, "/api/inventory/A1");
  assert.deepEqual(api.calls[0]?.body, { rop: 12, reason: "seasonal demand" }, "only the changed field and the reason are sent");
});

test("a single edit with side effects is sent to the preview flow instead", async () => {
  const api = fakeApi([]);
  const result = await editSingleItem({ stock_id: "A1", changes: { item_behaviour: "Asset" } }, "r", { api, store: store() });
  assert.equal(result.ok, false);
  assert.match(result.text, /needs the preview flow/);
  assert.equal(api.calls.length, 0);
});

test("a batch applies each item and reports the read-back for each", async () => {
  const data: FakeData = { items: [item({ stock_id: "A1", purchase_policy: null }), item({ stock_id: "B2", purchase_policy: null })] };
  const store = fakeStore(data);
  const preview = await previewItemEdits(
    [{ stock_id: "A1", changes: { purchase_policy: "on_demand" } }, { stock_id: "B2", changes: { purchase_policy: "routine" } }], "classify", store);
  const api = fakeApi([ok(), ok()], (call) => applyEdit(data, call));
  const result = await applyItemEdits(preview, { api, store });
  assert.equal(result.ok, true);
  assert.match(result.text, /Applied 2 item edits; all verified by read-back/);
  assert.match(result.text, /Item A1 \[A1\] applied and verified: purchase_policy \(unclassified\) -> on_demand/);
  assert.deepEqual(api.calls.map((c) => c.path), ["/api/inventory/A1", "/api/inventory/B2"]);
});

test("Service behaviour is verified together with its forced ROP", async () => {
  const data: FakeData = { items: [item({ stock_id: "A1", rop: 8 })] };
  const store = fakeStore(data);
  const preview = await previewItemEdits([{ stock_id: "A1", changes: { item_behaviour: "Service" } }], "not stocked", store);
  const result = await applyItemEdits(preview, { api: fakeApi([ok()], (call) => applyEdit(data, call)), store });
  assert.equal(result.ok, true);
  assert.match(result.text, /rop \(forced\) 8 -> 0/);
});

test("a stale preview is refused when the item changed since", async () => {
  const preview = await previewItemEdits([{ stock_id: "A1", changes: { rop: 20 } }], "r", store(item({ stock_id: "A1", rop: 8 })));
  const api = fakeApi([]);
  const result = await applyItemEdits(preview, { api, store: store(item({ stock_id: "A1", rop: 15 })) });
  assert.equal(result.ok, false);
  assert.match(result.text, /changed since the preview/);
  assert.equal(api.calls.length, 0);
});

test("a read-back that differs is reported as not confirmed", async () => {
  const s = store(item({ stock_id: "A1", rop: 8 }));
  const preview = await previewItemEdits([{ stock_id: "A1", changes: { rop: 12 } }], "r", s);
  const result = await applyItemEdits(preview, { api: fakeApi([ok()]), store: s });
  assert.equal(result.ok, false);
  assert.match(result.text, /NOT CONFIRMED: read-back differs on rop/);
});

test("a 403 stops the batch and leaves the remaining items untouched", async () => {
  const s = store(item({ stock_id: "A1", rop: 8 }), item({ stock_id: "B2", rop: 8 }));
  const preview = await previewItemEdits([{ stock_id: "A1", changes: { rop: 12 } }, { stock_id: "B2", changes: { rop: 12 } }], "r", s);
  const api = fakeApi([refused(403, "ASSISTANT cannot edit rop")]);
  const result = await applyItemEdits(preview, { api, store: s });
  assert.equal(result.ok, false);
  assert.match(result.text, /FAILED: ASSISTANT cannot edit rop/);
  assert.match(result.text, /Stopped: Procura refused the assistant account/);
  assert.equal(api.calls.length, 1);
});

test("a 400 on one item is reported and the next item is still attempted", async () => {
  const data: FakeData = { items: [item({ stock_id: "A1", product_type: "Medication" }), item({ stock_id: "B2", rop: 8 })] };
  const s = fakeStore(data);
  const preview = await previewItemEdits([{ stock_id: "A1", changes: { product_type: "Brand New" } }, { stock_id: "B2", changes: { rop: 12 } }], "r", s);
  const api = fakeApi([refused(400, "product_type must match an existing value"), ok()], (call) => { if (call.path.endsWith("/B2")) applyEdit(data, call); });
  const result = await applyItemEdits(preview, { api, store: s });
  assert.equal(api.calls.length, 2);
  assert.match(result.text, /1 of 2 edits did not complete/);
  assert.match(result.text, /FAILED: product_type must match an existing value/);
});

test("a lost reply is checked by read-back instead of retried", async () => {
  const s = store(item({ stock_id: "A1", rop: 8 }));
  const preview = await previewItemEdits([{ stock_id: "A1", changes: { rop: 12 } }], "r", s);
  const api = fakeApi([ambiguous()]);
  const result = await applyItemEdits(preview, { api, store: s });
  assert.equal(api.calls.length, 1);
  assert.match(result.text, /the reply was lost; checked below/);
  assert.match(result.text, /NOT CONFIRMED/);
});
