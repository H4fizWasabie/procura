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

func TestPendingUOMBlocksOnlyNewItemsOnRFQResave(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(stock_id,item_name) VALUES('A','Existing item'),('B','Added item')`); err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}
	r := RFQ{Supplier: "Fixture supplier", Items: []Item{{StockID: "A", Name: "Existing item", Qty: 1}}}
	r.RFQID, err = s.Save(r, "editor@example.test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE items SET uom_confirmation_pending=1`); err != nil {
		t.Fatal(err)
	}
	r.Items[0].Qty = 2
	if _, err := s.Save(r, "editor@example.test"); err != nil {
		t.Fatalf("existing pending item edit: %v", err)
	}
	r.Supplier = "Changed supplier"
	r.Items = append(r.Items, Item{StockID: "B", Name: "Added item", Qty: 3})
	if _, err := s.Save(r, "editor@example.test"); err == nil || !strings.Contains(err.Error(), "Added item") || !strings.Contains(err.Error(), "Confirm UOM") {
		t.Fatalf("adding pending item: %v", err)
	}
	got, err := s.GetByID(r.RFQID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Supplier != "Fixture supplier" || len(got.Items) != 1 || got.Items[0].Qty != 2 {
		t.Fatalf("rejected save changed RFQ: %+v", got)
	}
	if _, err := db.Exec(`UPDATE items SET uom_confirmation_pending=0 WHERE stock_id='B'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(r, "editor@example.test"); err != nil {
		t.Fatalf("adding confirmed item: %v", err)
	}
}
