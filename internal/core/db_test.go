package core

import (
	"database/sql"
	"os"
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

func TestOpenSQLitePragmas(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var busyTimeout int
	if err := db.QueryRow("PRAGMA busy_timeout").Scan(&busyTimeout); err != nil {
		t.Fatal(err)
	}
	if busyTimeout != 5000 {
		t.Errorf("busy_timeout = %d, want 5000", busyTimeout)
	}

	var journalMode string
	if err := db.QueryRow("PRAGMA journal_mode").Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if journalMode != "delete" {
		t.Errorf("journal_mode = %q, want delete", journalMode)
	}

	var foreignKeys int
	if err := db.QueryRow("PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if foreignKeys != 0 {
		t.Errorf("foreign_keys = %d, want 0", foreignKeys)
	}
}

func TestOpenAddsChangedByToLegacyItemAnchorAudit(t *testing.T) {
	fixturePath := filepath.Join(t.TempDir(), "legacy-fixture.sqlite")
	legacy, err := sql.Open("sqlite", fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`CREATE TABLE item_anchor_audit (
		id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, stock_id TEXT,
		item_name TEXT, field_name TEXT, old_value TEXT, new_value TEXT, reason TEXT
	)`); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`INSERT INTO item_anchor_audit (timestamp,stock_id,field_name,reason)
		VALUES ('2026-01-02T03:04:05','A','cost','fixture')`); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	fixture, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "procura.sqlite"), fixture, 0600); err != nil {
		t.Fatal(err)
	}
	db, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var reason string
	var changedBy sql.NullString
	if err := db.QueryRow("SELECT reason,changed_by FROM item_anchor_audit WHERE stock_id='A'").Scan(&reason, &changedBy); err != nil {
		t.Fatal(err)
	}
	if reason != "fixture" || changedBy.Valid {
		t.Fatalf("migrated audit row = reason %q, changed_by %#v", reason, changedBy)
	}
}
