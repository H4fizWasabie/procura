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

func TestHistoryListsNonVoidLinkedPOs(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO rfq_logs(rfq_id,date,supplier,items_count,raw_rfq_json) VALUES('RFQ-102026-18','2026-10-07','YSP',1,'[{"id":"A","n":"Item A","q":"80","u":"box"}]'),('RFQ-102026-19','2026-10-08','YSP',1,'[]');
		INSERT INTO purchase_orders(po_id,date,linked_rfq,status) VALUES('PO-1','2026-10-09','RFQ-102026-18','Pending'),('PO-2','2026-10-10','RFQ-102026-18','VOID')`); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, r := range (&Service{DB: db}).History() {
		got[r.RFQID] = r.POIDs
		if r.RFQID == "RFQ-102026-18" && (len(r.Items) != 1 || r.Items[0].Qty != 80) {
			t.Fatalf("text quantity not parsed: %+v", r.Items)
		}
	}
	if got["RFQ-102026-18"] != "PO-1" || got["RFQ-102026-19"] != "" {
		t.Fatalf("po_ids = %v", got)
	}
}
