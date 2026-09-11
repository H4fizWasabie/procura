package planning

import (
	"testing"
	"time"

	"procura/internal/core"
)

func testDB(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	db, err := core.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	return &Service{DB: db}
}

func mustExec(t *testing.T, s *Service, q string, args ...interface{}) {
	t.Helper()
	if _, err := s.DB.Exec(q, args...); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}

func freezeNow(t *testing.T, when time.Time) {
	t.Helper()
	original := nowFn
	nowFn = func() time.Time { return when }
	t.Cleanup(func() { nowFn = original })
}

// seedItem inserts a plannable item.
func seedItem(t *testing.T, s *Service, id string, current, rop float64) {
	mustExec(t, s, `INSERT INTO items (stock_id, item_name, current_stock, rop, cost, uom) VALUES (?,?,?,?,?,?)`,
		id, "Item "+id, current, rop, 10.0, "UNIT")
}

// seedUsage writes movement rows relative to the last complete month:
// offsets 0 = last complete month, 1 = the one before, etc.
func seedUsage(t *testing.T, s *Service, id string, outs ...float64) {
	base := lastCompleteMonthIdx()
	for i, out := range outs {
		idx := base - i
		mustExec(t, s, `INSERT INTO stock_movements (stock_id, year, month, out_qty) VALUES (?,?,?,?)`,
			id, idx/12, idx%12, out)
	}
}

// setVelocity persists the weighted velocity RecalcROP would compute (#9).
func setVelocity(t *testing.T, s *Service, id string, v float64) {
	mustExec(t, s, `UPDATE items SET velocity = ? WHERE stock_id = ?`, v, id)
}

func find(t *testing.T, items []Item, id string) Item {
	t.Helper()
	for _, it := range items {
		if it.ID == id {
			return it
		}
	}
	t.Fatalf("item %s not in plan", id)
	return Item{}
}

func TestSteadyUsageHighConfidence(t *testing.T) {
	s := testDB(t)
	seedItem(t, s, "A", 2, 10)
	setVelocity(t, s, "A", 5)     // as RecalcROP would persist
	seedUsage(t, s, "A", 5, 5, 5) // 3 active recent months → HIGH

	items := s.Plan()
	it := find(t, items, "A")
	if it.Confidence != ConfHigh {
		t.Errorf("confidence = %v, want HIGH", it.Confidence)
	}
	if it.Velocity != 5 {
		t.Errorf("velocity = %v, want 5", it.Velocity)
	}
	// target = 5*2=10; suggested = ceil(10-2-0) = 8
	if it.Suggested != 8 {
		t.Errorf("suggested = %v, want 8", it.Suggested)
	}
	if it.Status != StatusCritical { // safety = ceil(5*1)=5, current 2 ≤ 5
		t.Errorf("status = %v, want CRITICAL", it.Status)
	}
}

func TestSparseUsageWidensAndLowConfidence(t *testing.T) {
	s := testDB(t)
	seedItem(t, s, "B", 1, 10)
	setVelocity(t, s, "B", 2)              // weighted model's output; sparse recent data
	seedUsage(t, s, "B", 6, 0, 0, 6, 0, 0) // only 2 active in recent window

	items := s.Plan()
	it := find(t, items, "B")
	if it.Confidence != ConfLow {
		t.Errorf("confidence = %v, want LOW", it.Confidence)
	}
	if it.Velocity != 2 {
		t.Errorf("velocity = %v, want 2", it.Velocity)
	}
}

func TestNewItemAtialTargetReview(t *testing.T) {
	s := testDB(t)
	mustExec(t, s, `INSERT INTO items (stock_id, item_name, current_stock, rop, initial_stock_target) VALUES ('C','Item C',3,10,20)`)

	items := s.Plan()
	it := find(t, items, "C")
	if it.Status != StatusReview || it.Confidence != ConfManual {
		t.Errorf("status/conf = %v/%v, want REVIEW/MANUAL", it.Status, it.Confidence)
	}
	// target = human-set 20 → suggested = ceil(20-3) = 17 (honest: derives from human number)
	if it.Suggested != 17 {
		t.Errorf("suggested = %v, want 17", it.Suggested)
	}
}

func TestZeroVelocityBelowROPGetsProxy(t *testing.T) {
	s := testDB(t)
	mustExec(t, s, `INSERT INTO items (stock_id, item_name, current_stock, rop) VALUES ('D','Item D',1,10)`)
	seedUsage(t, s, "D", 0, 0, 0, 0, 0, 0, 4, 4) // history exists but nothing recent

	items := s.Plan()
	it := find(t, items, "D")
	if it.Confidence != ConfLow || it.Velocity != 5 { // proxy rop/2 = 5
		t.Errorf("conf/velocity = %v/%v, want LOW/5", it.Confidence, it.Velocity)
	}
	if it.Suggested != 9 { // ceil(5*2 - 1)
		t.Errorf("suggested = %v, want 9", it.Suggested)
	}
}

func TestVelocityOverrideWins(t *testing.T) {
	s := testDB(t)
	mustExec(t, s, `INSERT INTO items (stock_id, item_name, current_stock, rop, velocity_override) VALUES ('E','Item E',5,10,'7')`)

	items := s.Plan()
	it := find(t, items, "E")
	if it.Velocity != 7 || it.Confidence != ConfHigh {
		t.Errorf("velocity/conf = %v/%v, want 7/HIGH", it.Velocity, it.Confidence)
	}
	// safety = ceil(7); current 5 ≤ 7 → CRITICAL; target 14 − 5 = 9
	if it.Status != StatusCritical {
		t.Errorf("status = %v, want CRITICAL", it.Status)
	}
	if it.Suggested != 9 {
		t.Errorf("suggested = %v, want 9", it.Suggested)
	}
}

func TestIncomingNettingSuppressesSuggestion(t *testing.T) {
	s := testDB(t)
	freezeNow(t, time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC))
	seedItem(t, s, "F", 2, 10)
	seedUsage(t, s, "F", 5, 5, 5)
	mustExec(t, s, `INSERT INTO purchase_orders (po_id, date, status, ship_status, raw_po_json) VALUES ('PO-X','2026-09-05','Approved','Pending','[{"id":"F","n":"Item F","q":9}]')`)
	mustExec(t, s, `INSERT INTO purchase_order_items (po_id, item_name, quantity, stock_id) VALUES ('PO-X','Item F',9,'F')`)
	mustExec(t, s, `INSERT INTO purchase_orders (po_id, date, status, ship_status) VALUES ('PO-Y','2026-09-05','Approved','Delivered')`)
	mustExec(t, s, `INSERT INTO purchase_order_items (po_id, item_name, quantity, stock_id) VALUES ('PO-Y','Item F',4,'F')`)

	items := s.Plan()
	it := find(t, items, "F")
	if !it.OnOrder || it.IncomingQty != 9 {
		t.Fatalf("incoming = %v/%v, want on-order with qty 9", it.OnOrder, it.IncomingQty)
	}
	// target 10 − current 2 − incoming 9 = −1 → no suggestion, but still visible
	if it.Suggested != 0 {
		t.Errorf("suggested = %v, want 0 (covered)", it.Suggested)
	}
}

func TestHealthyOnOrderItemExcluded(t *testing.T) {
	s := testDB(t)
	freezeNow(t, time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC))
	seedItem(t, s, "G", 50, 10) // 500% health
	mustExec(t, s, `INSERT INTO direct_orders (order_id, date, stock_id, item_name, quantity, status) VALUES ('DO-T','2026-09-05','G','Item G',3,'ACTIVE')`)

	items := s.Plan()
	for _, it := range items {
		if it.ID == "G" {
			t.Fatalf("healthy on-order item remained in plan: %+v", it)
		}
	}
}

func TestIncomingLinksExpireAfter30Days(t *testing.T) {
	s := testDB(t)
	freezeNow(t, time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC))

	seedItem(t, s, "OLD-PO", 50, 10)
	mustExec(t, s, `INSERT INTO purchase_orders (po_id, date, status, ship_status) VALUES ('PO-OLD','2026-08-07','Approved','Pending')`)
	mustExec(t, s, `INSERT INTO purchase_order_items (po_id, item_name, quantity, stock_id) VALUES ('PO-OLD','Item OLD-PO',9,'OLD-PO')`)

	seedItem(t, s, "NEW-PO", 50, 10)
	mustExec(t, s, `INSERT INTO purchase_orders (po_id, date, status, ship_status) VALUES ('PO-NEW','2026-08-08','Approved','Pending')`)
	mustExec(t, s, `INSERT INTO purchase_order_items (po_id, item_name, quantity, stock_id) VALUES ('PO-NEW','Item NEW-PO',9,'NEW-PO')`)

	seedItem(t, s, "OLD-DIRECT", 50, 10)
	mustExec(t, s, `INSERT INTO direct_orders (order_id, date, stock_id, item_name, quantity, status) VALUES ('DO-OLD','2026-08-07','OLD-DIRECT','Item OLD-DIRECT',3,'ACTIVE')`)

	seedItem(t, s, "OLD-RFQ", 50, 10)
	mustExec(t, s, `INSERT INTO rfq_logs (rfq_id, date, raw_rfq_json) VALUES ('RFQ-OLD','2026-08-07','[{"id":"OLD-RFQ","q":4}]')`)

	seedItem(t, s, "RFQ-AFTER-OLD-PO", 50, 10)
	mustExec(t, s, `INSERT INTO purchase_orders (po_id, date, linked_rfq, status, ship_status) VALUES ('PO-RFQ-OLD','2026-08-01','RFQ-RECENT','Approved','Pending')`)
	mustExec(t, s, `INSERT INTO rfq_logs (rfq_id, date, raw_rfq_json) VALUES ('RFQ-RECENT','2026-09-05','[{"id":"RFQ-AFTER-OLD-PO","q":4}]')`)

	incoming := s.incomingPipeline()
	if len(incoming["OLD-PO"]) != 0 || len(incoming["OLD-DIRECT"]) != 0 || len(incoming["OLD-RFQ"]) != 0 {
		t.Fatalf("expired links remained: %#v", incoming)
	}
	if len(incoming["NEW-PO"]) != 1 || incoming["NEW-PO"][0].Qty != 9 {
		t.Fatalf("fresh PO = %#v, want one incoming row", incoming["NEW-PO"])
	}
	if len(incoming["RFQ-AFTER-OLD-PO"]) != 1 {
		t.Fatalf("recent RFQ stayed suppressed by expired PO: %#v", incoming["RFQ-AFTER-OLD-PO"])
	}
}

func TestSupersedeDirectOrders(t *testing.T) {
	s := testDB(t)
	mustExec(t, s, `INSERT INTO direct_orders (order_id, date, stock_id, item_name, quantity, status) VALUES ('DO-S','2026-01-01','H','Item H',3,'ACTIVE')`)
	if err := s.SupersedeDirectOrders("PO-Z", []string{"H"}); err != nil {
		t.Fatal(err)
	}
	var status, byPo string
	s.DB.QueryRow("SELECT status, COALESCE(superseded_by_po,'') FROM direct_orders WHERE order_id='DO-S'").Scan(&status, &byPo)
	if status != "SUPERSEDED" || byPo != "PO-Z" {
		t.Errorf("status/by = %v/%v, want SUPERSEDED/PO-Z", status, byPo)
	}
}

func TestDirectOrdersParsesTimestampDate(t *testing.T) {
	s := testDB(t)
	mustExec(t, s, `INSERT INTO direct_orders (order_id, date, stock_id, item_name, quantity, status) VALUES ('DO-TIME','2026-03-25T10:00:23','TIME','Timestamp item',1,'ACTIVE')`)

	orders := s.DirectOrders()
	if len(orders) != 1 {
		t.Fatalf("orders = %d, want 1", len(orders))
	}
	want := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	if !orders[0].Date.Equal(want) {
		t.Errorf("date = %v, want %v", orders[0].Date, want)
	}
}

func TestDirectOrdersIncludesStatus(t *testing.T) {
	s := testDB(t)
	mustExec(t, s, `INSERT INTO direct_orders (order_id, date, stock_id, item_name, quantity, status) VALUES ('DO-STATUS','2026-09-01','STATUS','Status item',1,'ACTIVE')`)

	orders := s.DirectOrders()
	if len(orders) != 1 || orders[0].Status != "ACTIVE" {
		t.Fatalf("status = %q, want ACTIVE", orders[0].Status)
	}
}

func TestParseCompactItems(t *testing.T) {
	raw := `[{"id":"SKU1","n":"Name One","u":"BOX","q":3},{"id":"SKU2","n":"Name Two","q":1.5}]`
	got := parseCompactItems(raw)
	if len(got) != 2 || got[0].ID != "SKU1" || got[0].Qty != 3 || got[1].ID != "SKU2" || got[1].Qty != 1.5 {
		t.Errorf("parseCompactItems = %+v", got)
	}
}

func TestLastCompleteMonthIdx(t *testing.T) {
	nowFnOrig := nowFn
	defer func() { nowFn = nowFnOrig }()
	nowFn = func() time.Time { return time.Date(2026, 7, 27, 0, 0, 0, 0, time.UTC) }
	if got := lastCompleteMonthIdx(); got != 2026*12+6 {
		t.Errorf("lastCompleteMonthIdx = %d, want %d", got, 2026*12+6)
	}
}
