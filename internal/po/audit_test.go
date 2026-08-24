package po

import (
	"encoding/json"
	"strings"
	"testing"

	"procura/internal/core"
)

func TestLinkLineUpdatesRowAndRawJSON(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}
	_, err = db.Exec(`INSERT INTO purchase_orders (po_id, ship_status, status, raw_po_json)
		VALUES ('PO-1', 'Pending', 'Approved', '[{"id":"","n":"SUPPLIER WIDGET 100","q":2,"stock_id":""}]')`)
	if err != nil {
		t.Fatal(err)
	}
	res, _ := db.Exec(`INSERT INTO purchase_order_items (po_id, item_name, quantity, stock_id) VALUES ('PO-1','SUPPLIER WIDGET 100',2,'')`)
	lineID, _ := res.LastInsertId()

	if err := s.LinkLine(lineID, "M123"); err != nil {
		t.Fatal(err)
	}

	var sid string
	db.QueryRow("SELECT stock_id FROM purchase_order_items WHERE id=?", lineID).Scan(&sid)
	if sid != "M123" {
		t.Errorf("row stock_id = %q", sid)
	}
	var raw string
	db.QueryRow("SELECT raw_po_json FROM purchase_orders WHERE po_id='PO-1'").Scan(&raw)
	if !strings.Contains(raw, `"id":"M123"`) || !strings.Contains(raw, `"stock_id":"M123"`) {
		t.Errorf("raw json not updated: %s", raw)
	}

	// Round-trip through Item.UnmarshalJSON must still see the link.
	var items []Item
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].StockID != "M123" {
		t.Errorf("unmarshal round-trip = %+v", items)
	}
}

// Regression: MarshalJSON emits both "id" and long keys; UnmarshalJSON must
// read long-format entries correctly instead of misreading them as GAS
// compact format (empty names, zero quantities — the KM VET PO bug).
func TestItemJSONRoundTrip(t *testing.T) {
	in := Item{StockID: "M24089KD", Name: "KALZYME Dental Spray", Qty: 22, Cost: 69.9, Total: 1537.8, UOM: "Bottle", SupplierUOM: "Bottle"}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out Item
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out != in {
		t.Errorf("round-trip mismatch:\n in:  %+v\n out: %+v", in, out)
	}

	// GAS legacy entries still parse.
	legacy := []byte(`{"id":"M123","n":"Legacy Name","q":5,"c":2,"t":10,"u":"BOX"}`)
	var gas Item
	if err := json.Unmarshal(legacy, &gas); err != nil {
		t.Fatal(err)
	}
	if gas.StockID != "M123" || gas.Name != "Legacy Name" || gas.Qty != 5 {
		t.Errorf("gas parse = %+v", gas)
	}
}
