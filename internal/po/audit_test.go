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

func TestUnlinkedLinesExcludeReceivedAndDelivered(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}
	for _, status := range []string{"Received", "Delivered", "Pending"} {
		poID := "PO-" + status
		if _, err := db.Exec("INSERT INTO purchase_orders (po_id, date, ship_status, status) VALUES (?, '2026-09-01', ?, 'Approved')", poID, status); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO purchase_order_items (po_id, item_name, quantity, stock_id) VALUES (?, 'Unlinked', 1, '')", poID); err != nil {
			t.Fatal(err)
		}
	}

	lines := s.UnlinkedLines(false)
	if len(lines) != 1 || lines[0].POID != "PO-Pending" {
		t.Fatalf("unlinked lines = %+v, want only pending PO", lines)
	}
}

// Regression: MarshalJSON emits both "id" and long keys; UnmarshalJSON must
// read long-format entries correctly instead of misreading them as GAS
// compact format (empty names, zero quantities — the KM VET PO bug).
func TestItemJSONRoundTrip(t *testing.T) {
	in := Item{StockID: "M24089KD", Name: "KALZYME Dental Spray", Qty: 22, Cost: 69.9, Total: 1537.8, UOM: "Bottle", SupplierUOM: "Bottle"}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out Item
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out != in {
		t.Errorf("round-trip mismatch:\n in:  %+v\n out: %+v", in, out)
	}

	// GAS legacy entries still parse.
	legacy := []byte(`{"id":"M123","n":"Legacy Name","q":5,"c":2,"t":10,"u":"BOX"}`)
	var gas Item
	if err := json.Unmarshal(legacy, &gas); err != nil {
		t.Fatal(err)
	}
	if gas.StockID != "M123" || gas.Name != "Legacy Name" || gas.Qty != 5 {
		t.Errorf("gas parse = %+v", gas)
	}
}

func TestSavePreservesPaymentAndWorkflowState(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`INSERT INTO purchase_orders (po_id,status,paid,balance,linked_rfq)
		VALUES ('PO-EDIT','Partial',10,27,'RFQ-KEEP')`)
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}
	p := PO{POID: "PO-EDIT", Date: "2026-09-27", Department: "Pharmacy", Supplier: "Supplier", BillNo: "EDITED", ShipStatus: "Received",
		Items: []Item{{StockID: "I001", Name: "Item", Qty: 2, Cost: 18.5}}}
	if _, err := s.Save(p); err != nil {
		t.Fatal(err)
	}
	var status, linked, bill string
	var paid, balance, total float64
	if err := db.QueryRow(`SELECT status,paid,balance,linked_rfq,bill_no,total FROM purchase_orders WHERE po_id='PO-EDIT'`).Scan(&status, &paid, &balance, &linked, &bill, &total); err != nil {
		t.Fatal(err)
	}
	if status != "Partial" || paid != 10 || balance != 27 || linked != "RFQ-KEEP" || bill != "EDITED" || total != 37 {
		t.Fatalf("edit lost state: status=%s paid=%v balance=%v linked=%s bill=%s total=%v", status, paid, balance, linked, bill, total)
	}
	p.Status = "Paid"
	if _, err := s.Save(p); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT status FROM purchase_orders WHERE po_id='PO-EDIT'`).Scan(&status); err != nil || status != "Paid" {
		t.Fatalf("explicit status change: %q, %v", status, err)
	}
	p.POID, p.BillNo, p.Status = "PO-NEW", "", ""
	if _, err := s.Save(p); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT status FROM purchase_orders WHERE po_id='PO-NEW'`).Scan(&status); err != nil || status != "Pending Approval" {
		t.Fatalf("new order status: %q, %v", status, err)
	}
}

func TestSaveRequiresHeaderWithoutWritingAndAllowsOptionalBlanks(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := &Service{DB: db}

	if _, err := s.Save(PO{Supplier: "Supplier"}); err == nil {
		t.Fatal("Save() accepted a PO missing required header fields")
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM purchase_orders").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rejected save wrote %d purchase orders", count)
	}
	if _, err := s.Save(PO{Date: "2026-99-99", Department: "Pharmacy", Supplier: "Supplier"}); err == nil {
		t.Fatal("Save() accepted an invalid date")
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM purchase_orders").Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid date save wrote a purchase order: count=%d err=%v", count, err)
	}

	if _, err := s.Save(PO{Date: "2026-09-27", Department: "Pharmacy", Supplier: "Supplier"}); err != nil {
		t.Fatalf("Save() rejected blank optional fields: %v", err)
	}
	var bill, invoiceDate, terms string
	if err := db.QueryRow("SELECT bill_no, invoice_date, terms FROM purchase_orders").Scan(&bill, &invoiceDate, &terms); err != nil {
		t.Fatal(err)
	}
	if bill != "" || invoiceDate != "" || terms != "" {
		t.Fatalf("optional fields changed: bill=%q invoice_date=%q terms=%q", bill, invoiceDate, terms)
	}
}
