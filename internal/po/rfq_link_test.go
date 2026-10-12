package po

import (
	"errors"
	"testing"

	"procura/internal/core"
)

func TestLinkedRFQIsValidatedKeptAndCleared(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(stock_id,item_name) VALUES('A','Item A');
		INSERT INTO rfq_logs(rfq_id,date,supplier) VALUES('RFQ-102026-18','2026-10-07','YSP');
		INSERT INTO purchase_orders(po_id,date,supplier,linked_rfq) VALUES('PO-LEGACY','2025-10-03','Old','PO.06031025')`); err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}
	str := func(v string) *string { return &v }
	linked := func(id string) string {
		var v *string
		db.QueryRow(`SELECT linked_rfq FROM purchase_orders WHERE po_id=?`, id).Scan(&v)
		if v == nil {
			return "<null>"
		}
		return *v
	}
	p := PO{Date: "2026-10-12", Supplier: "YSP", Department: "Ward", Items: []Item{{StockID: "A", Name: "Item A", Qty: 1}}}
	p.LinkedRFQ = str("RFQ-MISSING")
	if _, err := s.Save(p); !errors.Is(err, ErrUnknownRFQ) {
		t.Fatalf("unknown RFQ: %v", err)
	}
	p.LinkedRFQ = str(" RFQ-102026-18 ")
	if p.POID, err = s.Save(p); err != nil || linked(p.POID) != "RFQ-102026-18" {
		t.Fatalf("link: err=%v linked=%q", err, linked(p.POID))
	}
	p.LinkedRFQ = nil
	if _, err := s.Save(p); err != nil || linked(p.POID) != "RFQ-102026-18" {
		t.Fatalf("absent field must keep link: err=%v linked=%q", err, linked(p.POID))
	}
	second := PO{Date: "2026-10-13", Supplier: "YSP", Department: "Ward", Items: p.Items, LinkedRFQ: str("RFQ-102026-18")}
	if _, err := s.Save(second); err != nil {
		t.Fatalf("second PO from the same RFQ: %v", err)
	}
	var n int
	if db.QueryRow(`SELECT COUNT(*) FROM purchase_orders WHERE linked_rfq='RFQ-102026-18'`).Scan(&n); n != 2 {
		t.Fatalf("POs linked to the RFQ = %d, want 2", n)
	}
	p.LinkedRFQ = str("")
	if _, err := s.Save(p); err != nil || linked(p.POID) != "<null>" {
		t.Fatalf("blank must clear link: err=%v linked=%q", err, linked(p.POID))
	}
	legacy := PO{POID: "PO-LEGACY", Date: "2025-10-03", Supplier: "Old", Department: "Ward", Items: p.Items, LinkedRFQ: str("PO.06031025")}
	if _, err := s.Save(legacy); err != nil || linked("PO-LEGACY") != "PO.06031025" {
		t.Fatalf("unchanged legacy link: err=%v linked=%q", err, linked("PO-LEGACY"))
	}
}
