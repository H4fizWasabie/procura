package planning

import (
	"testing"

	"procura/internal/core"
)

func TestPendingUOMStillRecordsDirectOrder(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(stock_id,item_name,uom_confirmation_pending) VALUES('A','Fixture item',1)`); err != nil {
		t.Fatal(err)
	}
	id, err := (&Service{DB: db}).MarkOrdered([]OrderItem{{StockID: "A", Name: "Fixture item", Qty: 1}}, "Supplier", "already placed", "editor@example.test")
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM direct_orders WHERE order_id=? AND stock_id='A'", id).Scan(&n); err != nil || n != 1 {
		t.Fatalf("direct order rows=%d err=%v", n, err)
	}
	if name, err := core.PendingUOM(db, "A"); err != nil || name != "Fixture item" {
		t.Fatalf("warning lookup=%q err=%v", name, err)
	}
}
