package ximport

import (
	"bytes"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
	"procura/internal/core"
)

func poSheetFile(t *testing.T, dataRows [][]interface{}) *bytes.Buffer {
	t.Helper()
	f := excelize.NewFile()
	header := []interface{}{"po_id", "date", "supplier", "bill", "total", "paid", "balance", "status", "ship_status", "dept", "terms", "po_data_json"}
	if err := f.SetSheetName("Sheet1", "PurchaseOrder"); err != nil {
		t.Fatal(err)
	}
	if err := f.SetSheetRow("PurchaseOrder", "A1", &header); err != nil {
		t.Fatal(err)
	}
	for i, row := range dataRows {
		cell, _ := excelize.CoordinatesToCellName(1, i+2)
		if err := f.SetSheetRow("PurchaseOrder", cell, &row); err != nil {
			t.Fatal(err)
		}
	}
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatal(err)
	}
	f.Close()
	return &buf
}

func TestImportPOMalformedJSONReportedNotEmpty(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	buf := poSheetFile(t, [][]interface{}{
		{"PO-BAD", "2026-01-01", "Sup", "B-1", "10", "0", "10", "OPEN", "PENDING", "Ward", "", "{not valid json"},
	})

	res, err := (&Service{DB: db, ImportsDir: t.TempDir()}).Import(buf, "wb.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	if res.TableRows["purchase_orders"] != 0 {
		t.Fatalf("purchase_orders imported = %d, want 0 for malformed json", res.TableRows["purchase_orders"])
	}
	if len(res.Errors) == 0 || !strings.Contains(res.Errors[0], "PO-BAD") {
		t.Fatalf("errors = %v, want a PO-BAD malformed json error", res.Errors)
	}
	var count int
	db.QueryRow("SELECT COUNT(*) FROM purchase_orders WHERE po_id='PO-BAD'").Scan(&count)
	if count != 0 {
		t.Fatalf("purchase_orders row count = %d, want 0 (should not save header for malformed json)", count)
	}
}

func TestImportPOFailedLineLeavesPreviousIntact(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// First import: a good PO with one line.
	buf1 := poSheetFile(t, [][]interface{}{
		{"PO-1", "2026-01-01", "Sup", "B-1", "10", "0", "10", "OPEN", "PENDING", "Ward", "", `[{"id":"A","n":"Item A","q":1,"c":5,"t":5,"u":"UNIT"}]`},
	})
	if _, err := (&Service{DB: db, ImportsDir: t.TempDir()}).Import(buf1, "wb1.xlsx"); err != nil {
		t.Fatal(err)
	}

	// Force a failure on the re-import's line insert via a trigger, then
	// re-import the same PO with a different header (date changed) and items.
	if _, err := db.Exec(`CREATE TRIGGER fail_po_item BEFORE INSERT ON purchase_order_items
		WHEN NEW.item_name = 'FAIL' BEGIN SELECT RAISE(ABORT, 'forced failure'); END`); err != nil {
		t.Fatal(err)
	}
	buf2 := poSheetFile(t, [][]interface{}{
		{"PO-1", "2026-02-02", "Sup", "B-1", "10", "0", "10", "OPEN", "PENDING", "Ward", "", `[{"id":"A","n":"FAIL","q":1,"c":5,"t":5,"u":"UNIT"}]`},
	})
	res, err := (&Service{DB: db, ImportsDir: t.TempDir()}).Import(buf2, "wb2.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	if res.TableRows["purchase_orders"] != 0 {
		t.Fatalf("purchase_orders imported = %d, want 0 (the only PO row failed)", res.TableRows["purchase_orders"])
	}
	if len(res.Errors) == 0 {
		t.Fatal("expected an error for the failed line insert")
	}

	var date string
	if err := db.QueryRow("SELECT date FROM purchase_orders WHERE po_id='PO-1'").Scan(&date); err != nil {
		t.Fatal(err)
	}
	if date != "2026-01-01" {
		t.Fatalf("date = %q, want unchanged 2026-01-01 (failed re-import should not overwrite header)", date)
	}
	var itemName string
	if err := db.QueryRow("SELECT item_name FROM purchase_order_items WHERE po_id='PO-1'").Scan(&itemName); err != nil {
		t.Fatal(err)
	}
	if itemName != "Item A" {
		t.Fatalf("item_name = %q, want unchanged Item A (failed re-import should not delete previous lines)", itemName)
	}
}

func TestImportStockUpsertsCatalogueAndStock(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items (stock_id, item_name, rop, velocity) VALUES ('OLD', 'Old name', 9, 3)`); err != nil {
		t.Fatal(err)
	}

	f := excelize.NewFile()
	rows := [][]interface{}{
		{"Product Name", "Product Type", "Product Status", "SKU Code", "Brand", "Category", "Supplier", "UOM", "Cost Price", "Selling Price", "Actual Stock"},
		{"RENADYL", "Medication", "Available", "M26079R", "RENADYL", "Supplements", "GLADRON CHEMICALS SDN BHD", "Capsule", "5.60", "8.00", "325"},
		{"Updated old", "Medication", "Available", "OLD", "Brand", "Other", "Supplier", "Box", "2.50", "4.00", "7"},
	}
	if err := f.SetSheetRow("Sheet1", "A1", &rows[0]); err != nil {
		t.Fatal(err)
	}
	if err := f.SetSheetRow("Sheet1", "A2", &rows[1]); err != nil {
		t.Fatal(err)
	}
	if err := f.SetSheetRow("Sheet1", "A3", &rows[2]); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatal(err)
	}
	f.Close()

	counts, err := (&Service{DB: db}).ImportStock(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if counts["added"] != 1 || counts["updated"] != 1 || counts["errors"] != 0 {
		t.Fatalf("counts = %#v", counts)
	}

	var name, supplier string
	var stock, cost, price, rop, velocity float64
	if err := db.QueryRow(`SELECT item_name,supplier_name,current_stock,cost,selling_price,COALESCE(rop,0),COALESCE(velocity,0) FROM items WHERE stock_id='M26079R'`).Scan(&name, &supplier, &stock, &cost, &price, &rop, &velocity); err != nil {
		t.Fatal(err)
	}
	if name != "RENADYL" || supplier != "GLADRON CHEMICALS SDN BHD" || stock != 325 || cost != 5.6 || price != 8 {
		t.Fatalf("new item = %q %q %.0f %.2f %.2f", name, supplier, stock, cost, price)
	}
	if rop != 0 || velocity != 0 {
		t.Fatalf("new planning fields changed: rop=%v velocity=%v", rop, velocity)
	}
	if err := db.QueryRow(`SELECT item_name,current_stock,cost,selling_price,COALESCE(rop,0),COALESCE(velocity,0) FROM items WHERE stock_id='OLD'`).Scan(&name, &stock, &cost, &price, &rop, &velocity); err != nil {
		t.Fatal(err)
	}
	if name != "Updated old" || stock != 7 || cost != 2.5 || price != 4 || rop != 9 || velocity != 3 {
		t.Fatalf("updated item = %q %.0f %.2f %.2f rop=%v velocity=%v", name, stock, cost, price, rop, velocity)
	}
}
