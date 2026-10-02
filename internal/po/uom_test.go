package po

import (
	"strings"
	"testing"

	"procura/internal/core"
)

func TestPendingUOMBlocksPOCreation(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(stock_id,item_name,uom_confirmation_pending) VALUES('A','Fixture item',1)`); err != nil {
		t.Fatal(err)
	}
	p := PO{Date: "2026-01-02", Supplier: "Supplier", Department: "Ward", Items: []Item{{StockID: "A", Name: "Fixture item", Qty: 1}}}
	if _, err := (&Service{DB: db}).Save(p); err == nil || !strings.Contains(err.Error(), "Fixture item") || !strings.Contains(err.Error(), "Confirm UOM") {
		t.Fatalf("pending PO: %v", err)
	}
	var n int
	db.QueryRow("SELECT COUNT(*) FROM purchase_orders").Scan(&n)
	if n != 0 {
		t.Fatalf("blocked PO was saved: %d", n)
	}
}
