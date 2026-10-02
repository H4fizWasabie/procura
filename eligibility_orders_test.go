package main

import (
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"procura/internal/core"
	"procura/internal/planning"
	"procura/internal/po"
	"procura/internal/rfq"
)

// The same fixtures exercise both real save routes; no mock bypasses the guards.
func fixtureOrderSave(db *sql.DB, route string) func(string, []string, []string) (string, error) {
	return func(id string, stockIDs, acknowledged []string) (string, error) {
		if route == "po" {
			p := po.PO{POID: id, Date: "2026-01-02", Department: "Ward", Supplier: "Fixture supplier", AcknowledgedStockIDs: acknowledged}
			for _, sid := range stockIDs {
				p.Items = append(p.Items, po.Item{StockID: sid, Name: sid, Qty: 1})
			}
			return (&po.Service{DB: db}).SaveAs(p, "editor@example.test")
		}
		r := rfq.RFQ{RFQID: id, Supplier: "Fixture supplier", AcknowledgedStockIDs: acknowledged}
		for _, sid := range stockIDs {
			r.Items = append(r.Items, rfq.Item{StockID: sid, Name: sid, Qty: 1})
		}
		return (&rfq.Service{DB: db}).Save(r, "editor@example.test")
	}
}

func TestPurchaseGuardsAndLoggedOverrides(t *testing.T) {
	for _, route := range []string{"po", "rfq"} {
		t.Run(route, func(t *testing.T) {
			db, err := core.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			save := fixtureOrderSave(db, route)
			for _, tc := range []struct {
				id                        string
				policy                    interface{}
				status                    string
				ack                       []string
				blocked, overrideRequired bool
				logs                      int
			}{
				{"ROUTINE", "routine", "Available", nil, false, false, 0},
				{"ON_DEMAND", "on_demand", "Available", nil, false, false, 0},
				{"DO_NOT", "do_not_reorder", "Available", nil, true, false, 0},
				{"UNCLASSIFIED", nil, "Available", nil, true, false, 0},
				{"UNAVAILABLE", "routine", "not-available", nil, true, true, 0},
				{"WRONG_ACK", "routine", "not-available", []string{"OTHER"}, true, true, 0},
				{"OVERRIDE", "on_demand", "not-available", []string{"OVERRIDE"}, false, false, 1},
				{"LEGACY", "routine", "Unavailable", []string{"LEGACY"}, false, false, 1},
				{"BLANK", "routine", "", nil, false, false, 0},
				{"UNKNOWN", "routine", "unknown", nil, false, false, 0},
				{"HARD_BLOCK", "do_not_reorder", "not-available", []string{"HARD_BLOCK"}, true, false, 0},
			} {
				if _, err := db.Exec(`INSERT INTO items(stock_id,item_name,purchase_policy,product_status,item_behaviour,product_type,exclude)
					VALUES(?,?,?,?, 'Service','Surgical',1)`, tc.id, "Fixture "+tc.id, tc.policy, tc.status); err != nil {
					t.Fatal(err)
				}
				id, err := save("", []string{tc.id}, tc.ack)
				if tc.blocked {
					var failure *planning.PurchaseError
					if !errors.As(err, &failure) || failure.StockID != tc.id || failure.AvailabilityOverride != tc.overrideRequired {
						t.Fatalf("%s: %v", tc.id, err)
					}
					w := httptest.NewRecorder()
					writeOrderSaveError(w, err)
					if w.Code != http.StatusBadRequest {
						t.Fatalf("%s HTTP=%d", tc.id, w.Code)
					}
					if tc.overrideRequired && !strings.Contains(w.Body.String(), "unavailable_stock_ids") {
						t.Fatal("missing acknowledgement IDs")
					}
					if !tc.overrideRequired && !strings.Contains(err.Error(), "change the purchase policy first") {
						t.Fatalf("policy error: %v", err)
					}
				} else if err != nil {
					t.Fatalf("%s save: %v", tc.id, err)
				}
				var logs int
				if err := db.QueryRow(`SELECT COUNT(*) FROM logs WHERE action='AVAILABILITY_OVERRIDE' AND module=? AND context=? AND user_email='editor@example.test'`, route, id).Scan(&logs); err != nil {
					t.Fatal(err)
				}
				if logs != tc.logs {
					t.Fatalf("%s logs=%d want %d", tc.id, logs, tc.logs)
				}
				if tc.logs > 0 {
					var details string
					if err := db.QueryRow(`SELECT details FROM logs WHERE context=?`, id).Scan(&details); err != nil || !strings.Contains(details, tc.id) {
						t.Fatalf("override details=%q err=%v", details, err)
					}
				}
			}
		})
	}
}

func TestHistoricalLinesAreNotRecheckedButAddedLinesAre(t *testing.T) {
	for _, route := range []string{"po", "rfq"} {
		t.Run(route, func(t *testing.T) {
			db, err := core.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err := db.Exec(`INSERT INTO items(stock_id,item_name,purchase_policy,product_status)
				VALUES('A','Existing item','routine','Available'),('B','Added item','on_demand','not-available'),('C','Blocked item',NULL,'Available')`); err != nil {
				t.Fatal(err)
			}
			save := fixtureOrderSave(db, route)
			id, err := save("", []string{"A"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`UPDATE items SET purchase_policy='do_not_reorder',product_status='not-available',uom_confirmation_pending=1 WHERE stock_id='A'`); err != nil {
				t.Fatal(err)
			}
			if _, err := save(id, []string{"A"}, nil); err != nil {
				t.Fatalf("historical line rechecked: %v", err)
			}
			if _, err := save(id, []string{"A", "B"}, nil); err == nil {
				t.Fatal("new unavailable line bypassed acknowledgement")
			}
			if _, err := save(id, []string{"A", "B"}, []string{"B"}); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`UPDATE items SET purchase_policy='do_not_reorder',uom_confirmation_pending=1 WHERE stock_id='B'`); err != nil {
				t.Fatal(err)
			}
			if _, err := save(id, []string{"A", "B"}, nil); err != nil {
				t.Fatalf("saved override was rechecked: %v", err)
			}
			if _, err := save(id, []string{"A", "B", "C"}, []string{"C"}); err == nil {
				t.Fatal("new unclassified line allowed")
			}
			var raw string
			query := `SELECT raw_po_json FROM purchase_orders WHERE po_id=?`
			if route == "rfq" {
				query = `SELECT raw_rfq_json FROM rfq_logs WHERE rfq_id=?`
			}
			if err := db.QueryRow(query, id).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(raw, `"C"`) {
				t.Fatalf("rejected line saved: %s", raw)
			}
			var logs int
			if err := db.QueryRow(`SELECT COUNT(*) FROM logs WHERE context=? AND action='AVAILABILITY_OVERRIDE'`, id).Scan(&logs); err != nil || logs != 1 {
				t.Fatalf("historical override logs=%d err=%v", logs, err)
			}
		})
	}
}

func TestAvailabilityOverrideLogFailureRollsBackOrder(t *testing.T) {
	for _, route := range []string{"po", "rfq"} {
		t.Run(route, func(t *testing.T) {
			db, err := core.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err := db.Exec(`INSERT INTO items(stock_id,item_name,product_status) VALUES('A','Fixture item','not-available');
				CREATE TRIGGER reject_override BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT,'fixture log failure'); END`); err != nil {
				t.Fatal(err)
			}
			_, err = fixtureOrderSave(db, route)("", []string{"A"}, []string{"A"})
			if err == nil {
				t.Fatal("expected log failure")
			}
			w := httptest.NewRecorder()
			writeOrderSaveError(w, err)
			if w.Code != http.StatusInternalServerError {
				t.Fatalf("log failure HTTP=%d", w.Code)
			}
			var n int
			query := `SELECT COUNT(*) FROM purchase_orders`
			if route == "rfq" {
				query = `SELECT COUNT(*) FROM rfq_logs`
			}
			if err := db.QueryRow(query).Scan(&n); err != nil || n != 0 {
				t.Fatalf("failed audit saved %d documents: %v", n, err)
			}
		})
	}
}

func TestDirectOrdersRecordNormallyWithWarnings(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(stock_id,item_name,purchase_policy,product_status,uom_confirmation_pending)
		VALUES('A','Historical item',NULL,'Unavailable',1)`); err != nil {
		t.Fatal(err)
	}
	warnings, err := planning.DirectOrderWarnings(db, "A")
	if err != nil || len(warnings) != 2 {
		t.Fatalf("direct warnings=%v err=%v", warnings, err)
	}
	if _, err := (&planning.Service{DB: db}).MarkOrdered([]planning.OrderItem{{StockID: "A", Name: "Historical item", Qty: 2}}, "Fixture supplier", "", "editor@example.test"); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := db.QueryRow(`SELECT COUNT(*) FROM direct_orders WHERE stock_id='A'`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("historical order rows=%d err=%v", rows, err)
	}
}
