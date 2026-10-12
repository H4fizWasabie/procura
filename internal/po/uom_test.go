package po

import (
	"errors"
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

func TestPendingUOMBlocksOnlyNewItemsOnPOResave(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(stock_id,item_name) VALUES('A','Existing item'),('B','Added item')`); err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}
	p := PO{Date: "2026-01-02", Supplier: "Fixture supplier", Department: "Ward", Items: []Item{{StockID: "A", Name: "Existing item", Qty: 1}}}
	p.POID, err = s.Save(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE items SET uom_confirmation_pending=1`); err != nil {
		t.Fatal(err)
	}
	p.Items[0].Qty = 2
	if _, err := s.Save(p); err != nil {
		t.Fatalf("existing pending item edit: %v", err)
	}
	p.Supplier = "Changed supplier"
	p.Items = append(p.Items, Item{StockID: "B", Name: "Added item", Qty: 3})
	if _, err := s.Save(p); err == nil || !strings.Contains(err.Error(), "Added item") || !strings.Contains(err.Error(), "Confirm UOM") {
		t.Fatalf("adding pending item: %v", err)
	}
	got, err := s.GetByID(p.POID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Supplier != "Fixture supplier" || len(got.Items) != 1 || got.Items[0].Qty != 2 {
		t.Fatalf("rejected save changed PO: %+v", got)
	}
	var lines int
	if err := db.QueryRow(`SELECT COUNT(*) FROM purchase_order_items WHERE po_id=?`, p.POID).Scan(&lines); err != nil || lines != 1 {
		t.Fatalf("saved lines=%d err=%v", lines, err)
	}
	if _, err := db.Exec(`UPDATE items SET uom_confirmation_pending=0 WHERE stock_id='B'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(p); err != nil {
		t.Fatalf("adding confirmed item: %v", err)
	}
}

func TestSupplierUOMMustBeListedUnlessUnchangedLegacy(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(stock_id,item_name) VALUES('A','Item A'),('B','Item B');
		INSERT INTO purchase_orders(po_id,date,supplier) VALUES('PO-OLD','2026-01-02','Supplier');
		INSERT INTO purchase_order_items(po_id,item_name,quantity,stock_id,supplier_uom) VALUES('PO-OLD','Item A',1,'A','PACLK')`); err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}
	p := PO{Date: "2026-01-02", Supplier: "Supplier", Department: "Ward", Items: []Item{{StockID: "A", Name: "Item A", Qty: 1, SupplierUOM: " BOX "}}}
	id, err := s.Save(p)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetByID(id); got.Items[0].SupplierUOM != "box" || p.Items[0].SupplierUOM != "box" {
		t.Fatalf("saved %q, caller sees %q, want box", got.Items[0].SupplierUOM, p.Items[0].SupplierUOM)
	}
	p.Items[0].SupplierUOM = "PACLK"
	if _, err := s.Save(p); !errors.Is(err, core.ErrInvalidPackUOM) {
		t.Fatalf("unlisted unit: %v", err)
	}
	old := PO{POID: "PO-OLD", Date: "2026-01-02", Supplier: "Supplier", Department: "Ward", Items: []Item{{StockID: "A", Name: "Item A", Qty: 2, SupplierUOM: "PACLK"}}}
	if _, err := s.Save(old); err != nil {
		t.Fatalf("unchanged legacy unit: %v", err)
	}
	old.Items = append(old.Items, Item{StockID: "B", Name: "Item B", Qty: 1, SupplierUOM: "PACLK"})
	if _, err := s.Save(old); !errors.Is(err, core.ErrInvalidPackUOM) {
		t.Fatalf("legacy unit on new line: %v", err)
	}
}
