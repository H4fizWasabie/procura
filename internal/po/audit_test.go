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
