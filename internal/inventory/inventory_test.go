package inventory

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"procura/internal/core"
)

func inventoryDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO items
		(stock_id,item_name,cost,uom,rop,selling_price,last_updated,pack_size,exclude,velocity_override,item_behaviour)
		VALUES ('A','Item A',1,'ea',5,2,'2026-01-02T03:04:05','2',0,'1','Standard / Pack')`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestUpdateAnchorsValidationAndSingleFieldAudit(t *testing.T) {
	tests := []struct {
		field string
		value interface{}
		bad   interface{}
		text  string
	}{
		{"item_behaviour", "In-House Use", "In House Use", "Standard / Pack, In-House Use, Service, Unavailable, Asset"},
		{"exclude", "1", "TRUE", "0 or 1"},
		{"rop", 0.0, -1.0, "greater than or equal to 0"},
		{"velocity_override", "0", "fast", "greater than or equal to 0"},
		{"cost", 0.0, -0.01, "greater than or equal to 0"},
		{"selling_price", 0.0, -2.0, "greater than or equal to 0"},
		{"uom", " box ", "  ", "non-empty text"},
		{"pack_size", "", 3.0, "empty is allowed"},
	}
	for _, tt := range tests {
		t.Run(tt.field, func(t *testing.T) {
			db := inventoryDB(t)
			service := &Service{DB: db}
			if err := service.UpdateAnchors("A", "editor@example.test", "correction", map[string]interface{}{tt.field: tt.bad}); !errors.Is(err, ErrInvalidUpdate) || !strings.Contains(err.Error(), tt.text) {
				t.Fatalf("invalid value error = %v, want ErrInvalidUpdate", err)
			}
			if err := service.UpdateAnchors("A", "editor@example.test", "correction", map[string]interface{}{tt.field: tt.value}); err != nil {
				t.Fatalf("valid update: %v", err)
			}
			var count int
			if err := db.QueryRow("SELECT COUNT(*) FROM item_anchor_audit").Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 1 {
				t.Fatalf("audit rows = %d, want exactly one", count)
			}
			var field, reason, changedBy, lastUpdated string
			if err := db.QueryRow("SELECT field_name,reason,changed_by FROM item_anchor_audit").Scan(&field, &reason, &changedBy); err != nil {
				t.Fatal(err)
			}
			if field != tt.field || reason != "correction" || changedBy != "editor@example.test" {
				t.Fatalf("audit = %q %q %q", field, reason, changedBy)
			}
			if err := db.QueryRow("SELECT last_updated FROM items WHERE stock_id='A'").Scan(&lastUpdated); err != nil {
				t.Fatal(err)
			}
			if lastUpdated != "2026-01-02T03:04:05" {
				t.Fatalf("last_updated = %q, was changed by item edit", lastUpdated)
			}
		})
	}
}

func TestAllItemBehavioursAreAccepted(t *testing.T) {
	for _, value := range []string{"Standard / Pack", "In-House Use", "Service", "Unavailable", "Asset"} {
		if _, err := anchorValidation["item_behaviour"](value); err != nil {
			t.Errorf("item_behaviour %q: %v", value, err)
		}
	}
}

func TestUpdateAnchorsNoopDoesNotAudit(t *testing.T) {
	db := inventoryDB(t)
	if err := (&Service{DB: db}).UpdateAnchors("A", "editor@example.test", "checked", map[string]interface{}{"cost": 1.0}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM item_anchor_audit").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("audit rows = %d, want 0 for no-op", count)
	}
}

func TestUpdateAnchorsForcedROPIsAudited(t *testing.T) {
	db := inventoryDB(t)
	service := &Service{DB: db}
	if err := service.UpdateAnchors("A", "editor@example.test", "not a reorder item", map[string]interface{}{"item_behaviour": "Service"}); err != nil {
		t.Fatal(err)
	}
	rows, err := db.Query("SELECT field_name,old_value,new_value FROM item_anchor_audit ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	want := map[string][2]string{"item_behaviour": {"Standard / Pack", "Service"}, "rop": {"5", "0"}}
	for rows.Next() {
		var field, oldValue, newValue string
		if err := rows.Scan(&field, &oldValue, &newValue); err != nil {
			t.Fatal(err)
		}
		if values, ok := want[field]; !ok || values != [2]string{oldValue, newValue} {
			t.Fatalf("unexpected audit row %s: %q -> %q", field, oldValue, newValue)
		}
		delete(want, field)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(want) != 0 {
		t.Fatalf("missing audit rows: %v", want)
	}
	var rop float64
	if err := db.QueryRow("SELECT rop FROM items WHERE stock_id='A'").Scan(&rop); err != nil {
		t.Fatal(err)
	}
	if rop != 0 {
		t.Fatalf("ROP = %v, want 0", rop)
	}
}

func TestUpdateAnchorsStoredNonStockBehaviourForcesROPZero(t *testing.T) {
	for _, behaviour := range []string{"Service", "Asset"} {
		t.Run(behaviour, func(t *testing.T) {
			db := inventoryDB(t)
			if _, err := db.Exec("UPDATE items SET item_behaviour=? WHERE stock_id='A'", behaviour); err != nil {
				t.Fatal(err)
			}
			if err := (&Service{DB: db}).UpdateAnchors("A", "editor@example.test", "non-stock item", map[string]interface{}{"cost": 2.0}); err != nil {
				t.Fatal(err)
			}
			var rop float64
			if err := db.QueryRow("SELECT rop FROM items WHERE stock_id='A'").Scan(&rop); err != nil {
				t.Fatal(err)
			}
			if rop != 0 {
				t.Fatalf("ROP = %v, want 0 for stored %s behaviour", rop, behaviour)
			}
		})
	}
}

func TestUpdateAnchorsRejectsUnknownFieldsWithEditableList(t *testing.T) {
	db := inventoryDB(t)
	err := (&Service{DB: db}).UpdateAnchors("A", "editor@example.test", "correction", map[string]interface{}{
		"product_status": "Unavailable",
	})
	if !errors.Is(err, ErrInvalidUpdate) {
		t.Fatalf("unknown field error = %v, want ErrInvalidUpdate", err)
	}
	for _, field := range anchorFields {
		if !strings.Contains(err.Error(), field) {
			t.Errorf("unknown field error %q does not list editable field %q", err, field)
		}
	}
}

func TestAuditValueFormatsLargeFloatsWithoutExponent(t *testing.T) {
	if got := auditValue(float64(1_000_000)); got != "1000000" {
		t.Fatalf("auditValue(1e6) = %q, want 1000000", got)
	}
}

func TestUpdateAnchorsAuditFailureRollsBack(t *testing.T) {
	db := inventoryDB(t)
	if _, err := db.Exec(`CREATE TRIGGER reject_item_audit BEFORE INSERT ON item_anchor_audit
		BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`); err != nil {
		t.Fatal(err)
	}
	err := (&Service{DB: db}).UpdateAnchors("A", "editor@example.test", "correction", map[string]interface{}{"cost": 9.0})
	if err == nil {
		t.Fatal("expected audit insert failure")
	}
	var cost float64
	var count int
	if err := db.QueryRow("SELECT cost FROM items WHERE stock_id='A'").Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM item_anchor_audit").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if cost != 1 || count != 0 {
		t.Fatalf("after audit failure cost=%v audit rows=%d, want 1 and 0", cost, count)
	}
}

func TestUpdateAnchorsRequiresActorAndReason(t *testing.T) {
	db := inventoryDB(t)
	service := &Service{DB: db}
	for _, input := range [][2]string{{"", "reason"}, {"editor@example.test", " "}} {
		if err := service.UpdateAnchors("A", input[0], input[1], map[string]interface{}{"cost": 3.0}); !errors.Is(err, ErrInvalidUpdate) {
			t.Fatalf("UpdateAnchors(%q,%q) error = %v, want ErrInvalidUpdate", input[0], input[1], err)
		}
	}
}
