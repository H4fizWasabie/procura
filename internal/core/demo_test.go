package core

import (
	"testing"
)

func TestSeedDemoIsIdempotent(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if err := SeedDemo(db); err != nil {
		t.Fatal(err)
	}
	if err := SeedDemo(db); err != nil {
		t.Fatal(err)
	}

	var items, suppliers, movements int
	if err := db.QueryRow("SELECT COUNT(*) FROM items").Scan(&items); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM suppliers").Scan(&suppliers); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM stock_movements").Scan(&movements); err != nil {
		t.Fatal(err)
	}
	if items != 8 || suppliers != 3 || movements != 64 {
		t.Fatalf("unexpected demo counts: items=%d suppliers=%d movements=%d", items, suppliers, movements)
	}

	var name string
	if err := db.QueryRow("SELECT item_name FROM items WHERE stock_id = 'DEMO-001'").Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "Nitrile Examination Gloves" {
		t.Fatalf("unexpected demo item %q", name)
	}
}
