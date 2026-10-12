package po

import (
	"testing"

	"procura/internal/core"
)

func TestCreditTerms(t *testing.T) {
	for terms, want := range map[string]bool{
		"30 Days Terms": true, "30 DAYS": true, "30 Day Terms": true, "60 Days": true, "14 Days Terms": true,
		"Pay in Advance": false, "COD": false, "C.O.D. (3% discount)": false, "20% Deposit": false, "PREPAID": false, "": false, "Legacy": false,
		"Pay in Advance; delivery in 30 days": false, "COD within 7 days": false, "50% deposit, balance 30 days": false, "P.I.A. 7 days": false,
	} {
		if CreditTerms(terms) != want {
			t.Errorf("CreditTerms(%q) = %v", terms, !want)
		}
	}
}

func TestNewPOShipStatusFollowsTermsWhenEnabled(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(stock_id,item_name) VALUES('A','Item A');
		INSERT INTO suppliers(supplier_name,payment_terms) VALUES('Credit','30 Days Terms'),('Cash','Pay in Advance'),('Blank','')`); err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}
	ship := func(id string) (v string) {
		db.QueryRow(`SELECT ship_status FROM purchase_orders WHERE po_id=?`, id).Scan(&v)
		return
	}
	newPO := func(supplier, shipStatus string) string {
		id, err := s.Save(PO{Date: "2026-10-12", Supplier: supplier, Department: "Ward", ShipStatus: shipStatus, Items: []Item{{StockID: "A", Name: "Item A", Qty: 1}}})
		if err != nil {
			t.Fatal(err)
		}
		return ship(id)
	}
	if got := newPO("credit", ""); got != "Pending" {
		t.Fatalf("setting off: %q", got)
	}
	if err := s.SetTermsAutoDelivered(true); err != nil || !s.TermsAutoDelivered() {
		t.Fatalf("enable: %v", err)
	}
	for supplier, want := range map[string]string{"credit": "Delivered", "Cash": "Pending", "Blank": "Pending", "Unknown": "Pending"} {
		if got := newPO(supplier, ""); got != want {
			t.Errorf("%s: %q, want %q", supplier, got, want)
		}
	}
	if got := newPO("Credit", "Shipped"); got != "Shipped" {
		t.Errorf("a chosen status must be kept: %q", got)
	}
	id, err := s.CreateAssistant(PO{Date: "2026-10-12", Supplier: "Credit", Department: "Ward", ShipStatus: "Received", Items: []Item{{StockID: "A", Name: "Item A", Qty: 1}}})
	if err != nil || ship(id) != "Delivered" {
		t.Fatalf("assistant draft: err=%v ship=%q", err, ship(id))
	}
	if _, err := db.Exec(`UPDATE purchase_orders SET ship_status='' WHERE po_id=?`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(PO{POID: id, Date: "2026-10-12", Supplier: "Credit", Department: "Ward", Items: []Item{{StockID: "A", Name: "Item A", Qty: 1}}}); err != nil || ship(id) != "Pending" {
		t.Fatalf("editing must not apply the rule: err=%v ship=%q", err, ship(id))
	}
}
