package ximport

import (
	"bytes"
	"testing"

	"github.com/xuri/excelize/v2"
	"procura/internal/core"
)

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
