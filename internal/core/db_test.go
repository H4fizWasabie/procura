package core

import (
	"bytes"
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
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

func TestPurchasePolicyMigrationBackfillsOnce(t *testing.T) {
	fixturePath := filepath.Join(t.TempDir(), "fixture.sqlite")
	fixture, err := sql.Open("sqlite", fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.Exec("CREATE TABLE items (stock_id TEXT PRIMARY KEY, exclude)"); err != nil {
		t.Fatal(err)
	}
	for i, value := range []interface{}{1, "1", "TRUE", " YES ", "EXCLUDE", 0, "FALSE", nil, 2} {
		if _, err := fixture.Exec("INSERT INTO items(stock_id,exclude) VALUES(?,?)", fmt.Sprintf("I%d", i), value); err != nil {
			t.Fatal(err)
		}
	}
	if err := fixture.Close(); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	fixtureBytes, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "procura.sqlite"), fixtureBytes, 0600); err != nil {
		t.Fatal(err)
	}

	db, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"", "", "", "", "", "routine", "routine", "routine", "routine"}
	for i, expected := range want {
		var policy sql.NullString
		if err := db.QueryRow("SELECT purchase_policy FROM items WHERE stock_id=?", fmt.Sprintf("I%d", i)).Scan(&policy); err != nil {
			t.Fatal(err)
		}
		if expected == "" && policy.Valid || expected != "" && (!policy.Valid || policy.String != expected) {
			t.Errorf("I%d policy = %#v, want %q", i, policy, expected)
		}
	}
	if _, err := db.Exec("INSERT INTO items(stock_id,purchase_policy) VALUES('INVALID','other')"); err == nil {
		t.Fatal("purchase_policy CHECK accepted invalid value")
	}
	if _, err := db.Exec("INSERT INTO items(stock_id) VALUES('NEW')"); err != nil {
		t.Fatal(err)
	}
	var policy string
	if err := db.QueryRow("SELECT purchase_policy FROM items WHERE stock_id='NEW'").Scan(&policy); err != nil || policy != "routine" {
		t.Fatalf("new item purchase_policy = %q, %v; want routine", policy, err)
	}
	if _, err := db.Exec("UPDATE items SET purchase_policy='do_not_reorder' WHERE stock_id='I0'"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.QueryRow("SELECT purchase_policy FROM items WHERE stock_id='I0'").Scan(&policy); err != nil || policy != "do_not_reorder" {
		t.Fatalf("restart changed policy to %q, %v", policy, err)
	}
	var marker string
	if err := db.QueryRow("SELECT value FROM settings WHERE key='migration.purchase_policy.v1'").Scan(&marker); err != nil || marker != "5" {
		t.Fatalf("migration marker = %q, %v; want count 5", marker, err)
	}
}

func TestOpenFailsWhenPurchasePolicyMigrationCannotAddColumn(t *testing.T) {
	dir := t.TempDir()
	fixturePath := filepath.Join(t.TempDir(), "fixture.sqlite")
	fixture, err := sql.Open("sqlite", fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.Exec("CREATE VIEW items AS SELECT NULL AS stock_id, NULL AS exclude"); err != nil {
		t.Fatal(err)
	}
	if err := fixture.Close(); err != nil {
		t.Fatal(err)
	}
	fixtureBytes, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "procura.sqlite"), fixtureBytes, 0600); err != nil {
		t.Fatal(err)
	}

	var logs bytes.Buffer
	oldOutput := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(oldOutput)
	if db, err := Open(dir); err == nil {
		db.Close()
		t.Fatal("Open succeeded without items.purchase_policy")
	} else if !strings.Contains(err.Error(), "items.purchase_policy is missing") {
		t.Fatalf("Open error = %v, want missing purchase_policy", err)
	}
	if !strings.Contains(logs.String(), "migration 6 failed:") {
		t.Fatalf("migration failure was not logged: %s", logs.String())
	}
}
