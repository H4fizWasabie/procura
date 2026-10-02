import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createStore } from "../store.ts";

const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE items (stock_id TEXT PRIMARY KEY, item_name TEXT, category TEXT, product_type TEXT, uom TEXT, cost REAL,
      current_stock REAL, rop REAL, purchase_policy TEXT, product_status TEXT, exclude, item_behaviour TEXT, pack_size TEXT,
      velocity_override TEXT, hospital_product_status TEXT, hospital_product_type TEXT, uom_confirmation_pending INTEGER);
    CREATE TABLE suppliers (supplier_name TEXT PRIMARY KEY);
    CREATE TABLE purchase_orders (po_id TEXT, date TEXT, supplier TEXT, department TEXT, status TEXT, ship_status TEXT, total REAL);
    CREATE TABLE purchase_order_items (id INTEGER PRIMARY KEY, po_id TEXT, stock_id TEXT, quantity REAL);
    CREATE TABLE direct_orders (order_id TEXT, date TEXT, stock_id TEXT, status TEXT);
    CREATE TABLE rfq_logs (rfq_id TEXT, date TEXT, supplier TEXT, raw_rfq_json TEXT);
    CREATE TABLE supplier_item_mappings (id INTEGER PRIMARY KEY, supplier_name TEXT, stock_id TEXT, supplier_uom TEXT, is_active INTEGER);
    INSERT INTO items VALUES ('A1','Alpha','Antibiotic','Medication','box',12.5,3,10,NULL,'Available',1,'','', '', NULL,NULL,0);
    INSERT INTO items VALUES ('B2','Beta','Antibiotic','Medication','vial',4,0,5,'routine','not-available',0,'Service','10s','2','Available','Medication',1);
    INSERT INTO suppliers VALUES ('ACME SDN BHD'), ('O''Brien Vet');
    INSERT INTO purchase_orders VALUES ('PO - 102026 - 001','${day(-2)}','ACME SDN BHD','Pharmacy','Pending Approval','Pending',20);
    INSERT INTO purchase_orders VALUES ('PO - 102026 - 002','${day(-2)}','ACME SDN BHD','Pharmacy','Approved','Received',5);
    INSERT INTO purchase_orders VALUES ('PO - 092026 - 009','${day(-60)}','ACME SDN BHD','Ward','Approved','Pending',9);
    INSERT INTO purchase_orders VALUES ('PO - 102026 - 003','${day(-1)}','ACME SDN BHD','Pharmacy','VOID','Pending',9);
    INSERT INTO purchase_order_items (po_id, stock_id, quantity) VALUES ('PO - 102026 - 001','A1',4),('PO - 102026 - 001','B2',1),
      ('PO - 102026 - 002','A1',2),('PO - 092026 - 009','A1',7),('PO - 102026 - 003','A1',1);
    INSERT INTO direct_orders VALUES ('DO-1','${day(-3)}','B2','ACTIVE'),('DO-2','${day(-3)}','A1','DELIVERED');
    INSERT INTO rfq_logs VALUES ('RFQ-102026-01','${day(-4)}','ACME SDN BHD','[{"id":"A1","n":"Alpha","q":6,"u":"box"}]');
    INSERT INTO rfq_logs VALUES ('RFQ-092026-05','${day(-50)}','ACME SDN BHD','[{"id":"B2","q":1}]');
    INSERT INTO supplier_item_mappings (supplier_name, stock_id, supplier_uom, is_active) VALUES ('ACME SDN BHD','A1','carton',1),('ACME SDN BHD','B2','x',0),('O''Brien Vet','A1','pack',1);
  `);
  return createStore(async (sql) => db.prepare(sql).all() as Record<string, unknown>[]);
}

test("items are matched by exact id and keep their NULL policy", async () => {
  const store = fixture();
  const found = await store.items(["A1", "B2", "a1"]);
  assert.deepEqual([...found.keys()].sort(), ["A1", "B2"]);
  assert.equal(found.get("A1")?.purchase_policy, null);
  assert.equal(found.get("B2")?.purchase_policy, "routine");
  assert.equal(found.get("B2")?.uom_confirmation_pending, 1);
  assert.equal(found.get("B2")?.pack_size, "10s");
  assert.equal((await store.items([])).size, 0);
  assert.deepEqual([...(await store.caseInsensitiveMatches(["a1", "zz"])).entries()], [["a1", "A1"]]);
});

test("a hostile id cannot break out of the query", async () => {
  const store = fixture();
  assert.equal((await store.items(["x'); DROP TABLE items;--"])).size, 0);
  assert.equal((await store.items(["A1"])).size, 1, "the table is intact");
});

test("suppliers, departments and supplier units", async () => {
  const store = fixture();
  assert.deepEqual(await store.suppliers(), ["ACME SDN BHD", "O'Brien Vet"]);
  assert.deepEqual(await store.departments(), ["Pharmacy", "Ward"]);
  assert.deepEqual([...(await store.supplierUoms("ACME SDN BHD", ["A1", "B2"])).entries()], [["A1", "carton"]], "inactive mappings are ignored");
  assert.deepEqual([...(await store.supplierUoms("O'Brien Vet", ["A1"])).entries()], [["A1", "pack"]], "an apostrophe in a name is safe");
});

test("on-order covers open PO lines, active direct orders and recent RFQs only", async () => {
  const store = fixture();
  const onOrder = await store.onOrder(["A1", "B2"]);
  assert.deepEqual(onOrder.get("A1")?.sort(), ["PO - 102026 - 001", "RFQ-102026-01"]);
  assert.deepEqual(onOrder.get("B2")?.sort(), ["DO-1", "PO - 102026 - 001"]);
});

test("a PO and an RFQ read back with their lines", async () => {
  const store = fixture();
  const po = await store.po("PO - 102026 - 001");
  assert.equal(po?.status, "Pending Approval");
  assert.deepEqual(po?.lines, [{ stock_id: "A1", quantity: 4 }, { stock_id: "B2", quantity: 1 }]);
  assert.equal(await store.po("nope"), null);
  assert.deepEqual((await store.rfq("RFQ-102026-01"))?.lines, [{ stock_id: "A1", quantity: 6 }]);
  assert.equal(await store.rfq("nope"), null);
});

test("recent documents for a supplier come newest first", async () => {
  const store = fixture();
  const pos = await store.recentPos("ACME SDN BHD");
  assert.equal(pos[0]?.po_id, "PO - 102026 - 003");
  assert.equal(pos.length, 4);
  assert.equal((await store.recentRfqs("ACME SDN BHD"))[0]?.rfq_id, "RFQ-092026-05");
});
