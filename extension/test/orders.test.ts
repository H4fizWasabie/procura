import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrder, previewOrder, type OrderInput } from "../orders.ts";
import { ambiguous, fakeApi, fakeStore, item, ok, refused } from "./fakes.ts";

const TODAY = "2026-10-05";
const base: OrderInput = {
  kind: "po", supplier: "acme vet supply sdn bhd", department: "Pharmacy",
  lines: [{ stock_id: "A1", qty: 5 }, { stock_id: "B2", qty: 2, cost: 7.5, uom: "vial" }],
};
const goodItems = [item({ stock_id: "A1", cost: 12, current_stock: 3, rop: 10 }), item({ stock_id: "B2", uom: "box", purchase_policy: "on_demand" })];

test("a valid PO preview builds the exact payload the API will receive", async () => {
  const preview = await previewOrder(base, fakeStore({ items: goodItems, supplierUoms: { A1: "carton" } }), TODAY);
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.payload, {
    date: TODAY, department: "Pharmacy", supplier: "ACME VET SUPPLY SDN BHD", terms: "", total: 75,
    items: [
      { stock_id: "A1", item_name: "Item A1", quantity: 5, cost: 12, total: 60, uom: "box", supplier_uom: "carton" },
      { stock_id: "B2", item_name: "Item B2", quantity: 2, cost: 7.5, total: 15, uom: "vial", supplier_uom: "" },
    ],
  });
  assert.match(preview.text, /Pending Approval/);
  assert.match(preview.text, /nothing is saved yet/);
  assert.match(preview.text, /stock 3 \/ ROP 10/);
});

test("an RFQ needs no department and has no money fields", async () => {
  const preview = await previewOrder({ ...base, kind: "rfq", department: undefined }, fakeStore({ items: goodItems }), TODAY);
  assert.equal(preview.ok, true);
  assert.deepEqual(Object.keys(preview.payload ?? {}).sort(), ["date", "items", "items_count", "supplier"]);
  assert.match(preview.text, /draft/);
});

test("each blocking case is reported and nothing is built", async () => {
  const cases: [string, OrderInput, Parameters<typeof fakeStore>[0], RegExp][] = [
    ["unknown supplier with a suggestion", { ...base, supplier: "Hanavet" }, { items: goodItems, suppliers: ["HANAVET SDN BHD"] }, /Unknown supplier.*HANAVET SDN BHD/],
    ["missing department", { ...base, department: " " }, { items: goodItems }, /department is required.*Pharmacy/],
    ["unknown stock id with a case hint", { ...base, lines: [{ stock_id: "a1", qty: 1 }] }, { items: goodItems }, /case-sensitive; did you mean A1/],
    ["unknown stock id", { ...base, lines: [{ stock_id: "ZZ", qty: 1 }] }, { items: goodItems }, /Unknown stock_id ZZ/],
    ["blank stock id", { ...base, lines: [{ stock_id: " ", qty: 1 }] }, { items: goodItems }, /Every line needs a stock_id/],
    ["unclassified item", base, { items: [item({ stock_id: "A1", purchase_policy: null }), goodItems[1]!] }, /no purchase policy/],
    ["do_not_reorder item", base, { items: [item({ stock_id: "A1", purchase_policy: "do_not_reorder" }), goodItems[1]!] }, /do_not_reorder/],
    ["not-available item", base, { items: [item({ stock_id: "A1", product_status: "not-available" }), goodItems[1]!] }, /cannot override that; the user must create/],
    ["legacy Unavailable spelling", base, { items: [item({ stock_id: "A1", product_status: " Unavailable " }), goodItems[1]!] }, /not-available/],
    ["pending UOM change", base, { items: [item({ stock_id: "A1", uom_confirmation_pending: 1 }), goodItems[1]!] }, /Confirm UOM/],
    ["zero quantity", { ...base, lines: [{ stock_id: "A1", qty: 0 }] }, { items: goodItems }, /qty must be a number above 0/],
    ["negative cost", { ...base, lines: [{ stock_id: "A1", qty: 1, cost: -1 }] }, { items: goodItems }, /cost must be 0 or more/],
    ["duplicate line", { ...base, lines: [{ stock_id: "A1", qty: 1 }, { stock_id: "A1", qty: 2 }] }, { items: goodItems }, /listed twice/],
    ["no lines", { ...base, lines: [] }, { items: goodItems }, /At least one line/],
    ["bad date", { ...base, date: "05/10/2026" }, { items: goodItems }, /YYYY-MM-DD/],
  ];
  for (const [name, input, data, pattern] of cases) {
    const preview = await previewOrder(input, fakeStore(data), TODAY);
    assert.equal(preview.ok, false, name);
    assert.equal(preview.payload, null, name);
    assert.match(preview.text, pattern, name);
    assert.match(preview.text, /CANNOT SAVE/, name);
  }
});

test("too many lines is blocked", async () => {
  const lines = Array.from({ length: 101 }, (_, i) => ({ stock_id: `X${i}`, qty: 1 }));
  const preview = await previewOrder({ ...base, lines }, fakeStore({ items: [] }), TODAY);
  assert.match(preview.text, /At most 100 lines/);
});

test("an item already on order is a warning, not a blocker", async () => {
  const preview = await previewOrder(base, fakeStore({ items: goodItems, onOrder: { A1: ["PO - 102026 - 003", "RFQ-102026-04"] } }), TODAY);
  assert.equal(preview.ok, true);
  assert.match(preview.text, /already on order: PO - 102026 - 003, RFQ-102026-04/);
});

const savedPo = (status = "Pending Approval", lines = [{ stock_id: "A1", quantity: 5 }, { stock_id: "B2", quantity: 2 }]) =>
  ({ po_id: "PO - 102026 - 011", date: TODAY, supplier: "ACME VET SUPPLY SDN BHD", department: "Pharmacy", status, ship_status: "Pending", total: 75, lines });

test("creating a PO posts the previewed payload, then verifies it by reading it back", async () => {
  const store = fakeStore({ items: goodItems, pos: [savedPo()] });
  const preview = await previewOrder(base, store, TODAY);
  const api = fakeApi([ok({ po_id: "PO - 102026 - 011" })]);
  const result = await createOrder(preview, { api, store, today: TODAY });
  assert.equal(result.ok, true);
  assert.equal(result.id, "PO - 102026 - 011");
  assert.match(result.text, /saved and verified/);
  assert.match(result.text, /Pending Approval/);
  assert.equal(api.calls[0]?.path, "/api/pos");
  assert.deepEqual(api.calls[0]?.body, preview.payload);
  assert.equal("status" in (api.calls[0]?.body ?? {}), false, "the client never sends a status or an id");
  assert.equal("po_id" in (api.calls[0]?.body ?? {}), false);
});

test("an RFQ is posted to the RFQ endpoint and read back", async () => {
  const rfq = { rfq_id: "RFQ-102026-14", date: TODAY, supplier: "ACME VET SUPPLY SDN BHD", lines: [{ stock_id: "A1", quantity: 5 }, { stock_id: "B2", quantity: 2 }] };
  const store = fakeStore({ items: goodItems, rfqs: [rfq] });
  const preview = await previewOrder({ ...base, kind: "rfq" }, store, TODAY);
  const api = fakeApi([ok({ rfq_id: "RFQ-102026-14" })]);
  const result = await createOrder(preview, { api, store, today: TODAY });
  assert.equal(result.ok, true);
  assert.equal(api.calls[0]?.path, "/api/rfq");
  assert.match(result.text, /RFQ RFQ-102026-14 saved and verified/);
});

test("saving is refused when the checks stopped passing after the preview", async () => {
  const preview = await previewOrder(base, fakeStore({ items: goodItems }), TODAY);
  const changed = fakeStore({ items: [item({ stock_id: "A1", purchase_policy: "do_not_reorder" }), goodItems[1]!] });
  const api = fakeApi([]);
  const result = await createOrder(preview, { api, store: changed, today: TODAY });
  assert.equal(result.ok, false);
  assert.match(result.text, /checks no longer pass/);
  assert.equal(api.calls.length, 0, "nothing was sent");
});

test("saving is refused when an item's cost changed after the preview", async () => {
  const preview = await previewOrder(base, fakeStore({ items: goodItems }), TODAY);
  const changed = fakeStore({ items: [item({ stock_id: "A1", cost: 99 }), goodItems[1]!] });
  const api = fakeApi([]);
  const result = await createOrder(preview, { api, store: changed, today: TODAY });
  assert.equal(result.ok, false);
  assert.match(result.text, /changed since the preview/);
  assert.equal(api.calls.length, 0);
});

test("a server refusal is reported with Procura's reason", async () => {
  const store = fakeStore({ items: goodItems });
  const preview = await previewOrder(base, store, TODAY);
  const result = await createOrder(preview, { api: fakeApi([refused(400, "Item X has purchase policy do_not_reorder")]), store, today: TODAY });
  assert.equal(result.ok, false);
  assert.match(result.text, /Procura refused the PO: Item X has purchase policy do_not_reorder/);
});

test("a read-back that disagrees is flagged", async () => {
  const store = fakeStore({ items: goodItems, pos: [savedPo("Approved")] });
  const preview = await previewOrder(base, store, TODAY);
  const result = await createOrder(preview, { api: fakeApi([ok({ po_id: "PO - 102026 - 011" })]), store, today: TODAY });
  assert.equal(result.ok, true);
  assert.match(result.text, /read-back found a problem: status is Approved, expected Pending Approval/);
});

test("a save with an unknown outcome finds the matching PO and never retries", async () => {
  const store = fakeStore({ items: goodItems, pos: [savedPo()] });
  const preview = await previewOrder(base, store, TODAY);
  const api = fakeApi([ambiguous()]);
  const result = await createOrder(preview, { api, store, today: TODAY });
  assert.equal(result.ok, true);
  assert.match(result.text, /did not report back, but PO PO - 102026 - 011/);
  assert.match(result.text, /Do not save it again/);
  assert.equal(api.calls.length, 1, "no retry");
});

test("a save with an unknown outcome and no matching PO says it was probably not saved", async () => {
  const store = fakeStore({ items: goodItems, pos: [] });
  const preview = await previewOrder(base, store, TODAY);
  const api = fakeApi([ambiguous()]);
  const result = await createOrder(preview, { api, store, today: TODAY });
  assert.equal(result.ok, false);
  assert.match(result.text, /probably not saved/);
  assert.equal(api.calls.length, 1);
});

test("an unexpected error from the API client is not swallowed", async () => {
  const store = fakeStore({ items: goodItems });
  const preview = await previewOrder(base, store, TODAY);
  await assert.rejects(createOrder(preview, { api: fakeApi([new Error("login failed")]), store, today: TODAY }), /login failed/);
});
