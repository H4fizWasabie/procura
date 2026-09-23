package core

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// TestRebuildDirectOrdersPK simulates an existing database created before
// issue #37, where direct_orders.order_id was the single-column PRIMARY KEY,
// and verifies Open() rebuilds it without losing data and without blocking
// multi-item direct orders afterward.
func TestRebuildDirectOrdersPK(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "procura.sqlite")

	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`CREATE TABLE direct_orders (
		order_id TEXT PRIMARY KEY,
		date TEXT,
		stock_id TEXT,
		item_name TEXT,
		supplier TEXT,
		quantity REAL,
		ordered_by TEXT,
		notes TEXT,
		status TEXT
	)`); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`INSERT INTO direct_orders (order_id, date, stock_id, item_name, quantity, status) VALUES ('DO-OLD','2026-01-01','A','Item A',1,'ACTIVE')`); err != nil {
		t.Fatal(err)
	}
	legacy.Close()

	db, err := Open(dir)
	if err != nil {
		t.Fatalf("Open after legacy schema: %v", err)
	}
	defer db.Close()

	var name string
	if err := db.QueryRow("SELECT item_name FROM direct_orders WHERE order_id='DO-OLD'").Scan(&name); err != nil {
		t.Fatalf("legacy row lost: %v", err)
	}
	if name != "Item A" {
		t.Errorf("item_name = %q, want Item A", name)
	}

	if _, err := db.Exec(`INSERT INTO direct_orders (order_id, date, stock_id, item_name, quantity, status) VALUES ('DO-NEW','2026-01-02','B','Item B',2,'ACTIVE')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO direct_orders (order_id, date, stock_id, item_name, quantity, status) VALUES ('DO-NEW','2026-01-02','C','Item C',3,'ACTIVE')`); err != nil {
		t.Fatalf("second row for same order_id should now be allowed: %v", err)
	}
}
