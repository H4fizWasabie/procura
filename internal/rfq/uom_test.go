package rfq

import (
	"strings"
	"testing"

	"procura/internal/core"
)

func TestPendingUOMBlocksRFQCreation(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(stock_id,item_name,uom_confirmation_pending) VALUES('A','Fixture item',1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := (&Service{DB: db}).Save(RFQ{Supplier: "Supplier", Items: []Item{{StockID: "A", Name: "Fixture item", Qty: 1}}}, "editor@example.test"); err == nil || !strings.Contains(err.Error(), "Fixture item") || !strings.Contains(err.Error(), "Confirm UOM") {
		t.Fatalf("pending RFQ: %v", err)
	}
	var n int
	db.QueryRow("SELECT COUNT(*) FROM rfq_logs").Scan(&n)
	if n != 0 {
		t.Fatalf("blocked RFQ was saved: %d", n)
	}
}
