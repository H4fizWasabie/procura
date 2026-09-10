package rfq

import (
	"testing"

	"procura/internal/core"
)

func TestSavePreservesDateAndItemsWhenEditing(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}

	id, err := s.Save(RFQ{RFQID: "RFQ-082026-01", Date: "2026-08-20", Supplier: "Acme", Items: []Item{{Name: "Widget", Qty: 3, UOM: "BOX"}}}, "buyer@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if id != "RFQ-082026-01" {
		t.Fatalf("id = %q", id)
	}

	if _, err := s.Save(RFQ{RFQID: id, Date: "2026-08-20", Supplier: "New supplier", Items: []Item{{Name: "Updated widget", Qty: 5, UOM: "UNIT"}}}, "buyer@example.com"); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetByID(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Date != "2026-08-20" || got.Supplier != "New supplier" || len(got.Items) != 1 || got.Items[0].Name != "Updated widget" || got.Items[0].Qty != 5 {
		t.Fatalf("edited RFQ = %+v", got)
	}
}

func TestHistorySortsSameDayByRFQSequenceDescending(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}
	for _, id := range []string{"RFQ-092026-01", "RFQ-092026-02", "RFQ-092026-10"} {
		if _, err := s.Save(RFQ{RFQID: id, Date: "2026-09-10"}, "buyer@example.com"); err != nil {
			t.Fatal(err)
		}
	}
	history := s.History()
	if len(history) != 3 || history[0].RFQID != "RFQ-092026-10" || history[1].RFQID != "RFQ-092026-02" || history[2].RFQID != "RFQ-092026-01" {
		t.Fatalf("same-day RFQs = %+v", history)
	}
}
