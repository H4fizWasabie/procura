package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"procura/internal/auth"
	"procura/internal/core"
	"procura/internal/planning"
	"procura/internal/po"
	"procura/internal/rfq"
)

func assistantHTTP(t *testing.T) (*sql.DB, func(string, string, interface{}) *httptest.ResponseRecorder) {
	t.Helper()
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`INSERT INTO items(stock_id,item_name,product_type,product_status,last_updated,uom_confirmation_pending)
		VALUES('A','Fixture item','Base','Available','2026-01-02',1),('B','Fixture type','Supply','Available','2026-01-02',0)`); err != nil {
		t.Fatal(err)
	}
	a := &auth.Service{DB: db}
	pin, err := a.AddUser("assistant@example.test", "Fixture assistant", "ASSISTANT")
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := a.Login("assistant@example.test", pin)
	if err != nil {
		t.Fatal(err)
	}
	handler := newHandler(db, false)
	return db, func(method, path string, body interface{}) *httptest.ResponseRecorder {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(b))
		r.Header.Set("Authorization", "Bearer "+token)
		// Client headers cannot elevate the authenticated role.
		r.Header.Set("X-User-Role", "ADMIN")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
}

func TestAssistantHTTPWriteBoundary(t *testing.T) {
	_, request := assistantHTTP(t)
	for _, route := range []struct{ method, path string }{
		{"POST", "/api/pos/fixture/status"}, {"POST", "/api/pos/fixture/invoice-date"}, {"POST", "/api/pos/unlinked/link"},
		{"DELETE", "/api/rfq/fixture"}, {"POST", "/api/workflow/approve"}, {"POST", "/api/workflow/payment"},
		{"POST", "/api/planning/order"}, {"POST", "/api/planning/order/delivered"},
		{"POST", "/api/movement/rop"}, {"POST", "/api/movement/bulk"},
		{"POST", "/api/uom/mapping"}, {"POST", "/api/tasks"}, {"POST", "/api/scorecard"},
		{"POST", "/api/analytics/freeze"}, {"POST", "/api/import"}, {"POST", "/api/import-stock"},
		{"POST", "/api/suppliers"}, {"DELETE", "/api/suppliers/fixture"},
		{"POST", "/api/users"}, {"PUT", "/api/users"}, {"DELETE", "/api/users"}, {"POST", "/api/users/reset-pin"},
		{"POST", "/api/change-pin"}, {"GET", "/api/users"}, {"GET", "/users"},
	} {
		if w := request(route.method, route.path, map[string]interface{}{}); w.Code != 403 {
			t.Errorf("%s %s=%d %s", route.method, route.path, w.Code, w.Body.String())
		}
	}
	for _, path := range []string{"/api/dashboard", "/api/pos", "/api/rfq", "/api/inventory/basic"} {
		if w := request("GET", path, nil); w.Code != 200 {
			t.Errorf("read %s=%d", path, w.Code)
		}
	}
	if w := request("POST", "/api/reports/item-history", map[string]interface{}{"stockId": "A"}); w.Code != 200 {
		t.Fatalf("read-only report=%d %s", w.Code, w.Body.String())
	}
}

func TestAdminHTTPRejectsUnknownUserRoles(t *testing.T) {
	db, _ := assistantHTTP(t)
	s := &auth.Service{DB: db}
	pin, err := s.AddUser("admin@example.test", "Fixture admin", "ADMIN")
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := s.Login("admin@example.test", pin)
	if err != nil {
		t.Fatal(err)
	}
	handler := newHandler(db, false)
	for _, method := range []string{"POST", "PUT"} {
		r := httptest.NewRequest(method, "/api/users", strings.NewReader(`{"email":"assistant@example.test","name":"Do not change","role":"ROOT"}`))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 400 || !strings.Contains(w.Body.String(), "role must be") {
			t.Fatalf("%s unknown role=%d %s", method, w.Code, w.Body.String())
		}
	}
	var name, role string
	if err := db.QueryRow(`SELECT name,role FROM users WHERE email='assistant@example.test'`).Scan(&name, &role); err != nil {
		t.Fatal(err)
	}
	if name != "Fixture assistant" || role != "ASSISTANT" {
		t.Fatal("unknown role request changed the user")
	}
}

func TestAssistantItemFieldsValidationAndAudit(t *testing.T) {
	db, request := assistantHTTP(t)
	for field, value := range map[string]interface{}{
		"exclude": 1, "item_behaviour": "In-House Use", "purchase_policy": "on_demand", "product_status": "not-available",
		"product_type": "Supply", "rop": 20, "velocity_override": 5, "pack_size": "12",
	} {
		w := request("POST", "/api/inventory/A", map[string]interface{}{field: value, "reason": "Fixture review"})
		if w.Code != 200 {
			t.Fatalf("allowed %s=%d %s", field, w.Code, w.Body.String())
		}
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM item_anchor_audit WHERE stock_id='A' AND field_name=? AND changed_by='assistant@example.test' AND reason='Fixture review'`, field).Scan(&n); err != nil || n != 1 {
			t.Fatalf("%s audit rows=%d err=%v", field, n, err)
		}
	}
	var before int
	if err := db.QueryRow(`SELECT COUNT(*) FROM item_anchor_audit`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for field, value := range map[string]interface{}{
		"cost": 9, "selling_price": 9, "uom": "box", "confirm_uom": true,
		"current_stock": 9, "supplier_name": "Fixture supplier", "category": "Fixture category", "item_name": "Renamed fixture",
		"resync_product_status": true, "resync_product_type": true, "hospital_product_type": "Supply",
		"last_updated": "2026-02-03", "uom_confirmation_pending": 0, "unexpected": true,
	} {
		w := request("POST", "/api/inventory/A", map[string]interface{}{field: value, "exclude": false, "reason": "Fixture denied edit"})
		if w.Code != 403 {
			t.Fatalf("forbidden %s=%d %s", field, w.Code, w.Body.String())
		}
	}
	for _, body := range []map[string]interface{}{
		{"rop": 1}, {"rop": -1, "reason": "Invalid fixture"}, {"product_type": "New assistant type", "reason": "Invalid fixture"},
	} {
		if w := request("POST", "/api/inventory/A", body); w.Code != 400 {
			t.Fatalf("validation=%d %s", w.Code, w.Body.String())
		}
	}
	var after, pending int
	var updated, excluded string
	if err := db.QueryRow(`SELECT COUNT(*) FROM item_anchor_audit`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT last_updated,exclude,uom_confirmation_pending FROM items WHERE stock_id='A'`).Scan(&updated, &excluded, &pending); err != nil {
		t.Fatal(err)
	}
	if before != after || updated != "2026-01-02" || excluded != "1" || pending != 1 {
		t.Fatalf("denied edit mutated item/audit: %d/%d %s %s %d", before, after, updated, excluded, pending)
	}
}

func TestAssistantHTTPCreateOnlyAndNoUnrelatedWrites(t *testing.T) {
	db, request := assistantHTTP(t)
	if _, err := db.Exec(`UPDATE items SET uom_confirmation_pending=0 WHERE stock_id='A';
		INSERT INTO purchase_orders(po_id,supplier,status) VALUES('existing-po','Original','Approved');
		INSERT INTO purchase_order_items(po_id,stock_id) VALUES('existing-po','A');
		INSERT INTO rfq_logs(rfq_id,supplier,raw_rfq_json) VALUES('existing-rfq','Original','[{"id":"A"}]');
		INSERT INTO direct_orders(order_id,stock_id,status) VALUES('fixture-direct','A','ACTIVE')`); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path, key string
		body      interface{}
	}{
		{"/api/pos", "po_id", map[string]interface{}{"po_id": "existing-po", "date": "2026-01-02", "department": "Ward", "supplier": "Fixture supplier", "status": "Paid", "ship_status": "Received", "paid": 100, "invoice_date": "2026-01-01", "items": []po.Item{{StockID: "A", Name: "Fixture item", Qty: 1, SupplierUOM: "box"}}}},
		{"/api/rfq", "rfq_id", map[string]interface{}{"rfq_id": "existing-rfq", "supplier": "Fixture supplier", "status": "Approved", "items": []rfq.Item{{StockID: "A", Name: "Fixture item", Qty: 1}}}},
	} {
		w := request("POST", tc.path, tc.body)
		if w.Code != 200 {
			t.Fatalf("create %s=%d %s", tc.path, w.Code, w.Body.String())
		}
		var response map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		id := response[tc.key].(string)
		if strings.HasPrefix(id, "existing-") {
			t.Fatalf("client ID reused: %s", id)
		}
		if tc.key == "po_id" {
			var status, ship, invoice string
			var paid float64
			if err := db.QueryRow(`SELECT status,ship_status,COALESCE(invoice_date,''),COALESCE(paid,0) FROM purchase_orders WHERE po_id=?`, id).Scan(&status, &ship, &invoice, &paid); err != nil {
				t.Fatal(err)
			}
			if status != "Pending Approval" || ship != "Pending" || invoice != "" || paid != 0 {
				t.Fatalf("unsafe draft status/fields: %s %s %s %v", status, ship, invoice, paid)
			}
		} else {
			var createdBy string
			if err := db.QueryRow(`SELECT created_by FROM rfq_logs WHERE rfq_id=?`, id).Scan(&createdBy); err != nil || createdBy != "assistant@example.test" {
				t.Fatalf("RFQ provenance=%s err=%v", createdBy, err)
			}
		}
	}
	var originalPO, originalRFQ, direct string
	if err := db.QueryRow(`SELECT supplier FROM purchase_orders WHERE po_id='existing-po'`).Scan(&originalPO); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT supplier FROM rfq_logs WHERE rfq_id='existing-rfq'`).Scan(&originalRFQ); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT status FROM direct_orders WHERE order_id='fixture-direct'`).Scan(&direct); err != nil {
		t.Fatal(err)
	}
	if originalPO != "Original" || originalRFQ != "Original" || direct != "ACTIVE" {
		t.Fatal("create overwrote history or direct-order state")
	}
	// Supplied existing IDs cannot exempt assistant creates from the UOM guard.
	if _, err := db.Exec(`UPDATE items SET uom_confirmation_pending=1 WHERE stock_id='A'`); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path string
		body interface{}
	}{
		{"/api/pos", po.PO{POID: "existing-po", Date: "2026-01-02", Department: "Ward", Supplier: "Fixture supplier", Items: []po.Item{{StockID: "A"}}}},
		{"/api/rfq", rfq.RFQ{RFQID: "existing-rfq", Items: []rfq.Item{{StockID: "A"}}}},
	} {
		if w := request("POST", tc.path, tc.body); w.Code != 400 {
			t.Fatalf("UOM guard bypassed: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestAssistantCannotSupplyAvailabilityAcknowledgements(t *testing.T) {
	db, request := assistantHTTP(t)
	if _, err := db.Exec(`UPDATE items SET uom_confirmation_pending=0,product_status='not-available' WHERE stock_id='A'`); err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"po", "rfq"} {
		for _, tc := range []struct {
			key   string
			value interface{}
		}{
			{"acknowledged_stock_ids", []string{"A"}}, {"acknowledged_stock_ids", []string{}},
			{"acknowledged_stock_ids", nil}, {"ACKNOWLEDGED_STOCK_IDS", []string{"A"}}, {"acknowledged_stock_ids", false},
		} {
			body := map[string]interface{}{"date": "2026-01-02", "department": "Ward", "supplier": "Fixture supplier", tc.key: tc.value}
			body["items"] = []map[string]interface{}{{"stock_id": "A", "item_name": "Fixture item", "qty": 1}}
			path := "/api/pos"
			if route == "rfq" {
				path = "/api/rfq"
			}
			if w := request("POST", path, body); w.Code != 403 || !strings.Contains(w.Body.String(), "cannot supply acknowledged_stock_ids") {
				t.Fatalf("%s acknowledgement %s=%v: %d %s", route, tc.key, tc.value, w.Code, w.Body.String())
			}
		}
		// Service callers cannot bypass the HTTP presence check.
		var err error
		if route == "po" {
			_, err = (&po.Service{DB: db}).CreateAssistant(po.PO{AcknowledgedStockIDs: []string{"A"}})
		} else {
			_, err = (&rfq.Service{DB: db}).CreateAssistant(rfq.RFQ{AcknowledgedStockIDs: []string{}}, "assistant@example.test")
		}
		if !errors.Is(err, planning.ErrAssistantAcknowledgement) {
			t.Fatalf("%s service acknowledgement error=%v", route, err)
		}
	}
	var count int
	if err := db.QueryRow(`SELECT (SELECT COUNT(*) FROM purchase_orders)+(SELECT COUNT(*) FROM rfq_logs)+(SELECT COUNT(*) FROM logs WHERE action='AVAILABILITY_OVERRIDE')`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("acknowledgement request wrote records/logs=%d err=%v", count, err)
	}
}

func TestAssistantDraftPurchaseGuards(t *testing.T) {
	db, request := assistantHTTP(t)
	for _, route := range []string{"po", "rfq"} {
		for _, tc := range []struct {
			policy  interface{}
			status  string
			pending int
			want    int
			message string
		}{
			{"routine", "Available", 0, 200, ""}, {"on_demand", "Available", 0, 200, ""},
			{"do_not_reorder", "Available", 0, 400, "change the purchase policy first"}, {nil, "Available", 0, 400, "unclassified"},
			{"routine", "not-available", 0, 400, "human must create"}, {"on_demand", " NOT-AVAILABLE ", 0, 400, "human must create"},
			{"routine", "Unavailable", 0, 400, "human must create"}, {"routine", "unavailable", 0, 400, "human must create"},
			{"routine", "", 0, 200, ""}, {"routine", "Unknown", 0, 200, ""},
			{"routine", "Available", 1, 400, "Confirm UOM"},
		} {
			if _, err := db.Exec(`UPDATE items SET purchase_policy=?,product_status=?,uom_confirmation_pending=?,
				exclude=1,item_behaviour='Service',product_type='Surgical' WHERE stock_id='A'`, tc.policy, tc.status, tc.pending); err != nil {
				t.Fatal(err)
			}
			body := map[string]interface{}{"date": "2026-01-02", "department": "Ward", "supplier": "Fixture supplier",
				"items": []map[string]interface{}{{"stock_id": "A", "item_name": "Fixture item", "qty": 1}}}
			path := "/api/pos"
			if route == "rfq" {
				path = "/api/rfq"
			}
			w := request("POST", path, body)
			if w.Code != tc.want || (tc.message != "" && !strings.Contains(w.Body.String(), tc.message)) {
				t.Fatalf("%s policy=%v status=%q pending=%d: %d %s", route, tc.policy, tc.status, tc.pending, w.Code, w.Body.String())
			}
		}
	}
}

func assistantCreate(db *sql.DB, route string, suppliedID string) (string, error) {
	if route == "po" {
		return (&po.Service{DB: db}).CreateAssistant(po.PO{POID: suppliedID, Status: "Approved", Date: "2026-01-02", Department: "Ward", Supplier: "Fixture supplier", Items: []po.Item{{Name: "Fixture item", Qty: 1}}})
	}
	return (&rfq.Service{DB: db}).CreateAssistant(rfq.RFQ{RFQID: suppliedID, Supplier: "Fixture supplier", Items: []rfq.Item{{Name: "Fixture item", Qty: 1}}}, "assistant@example.test")
}

func TestConcurrentAssistantCreatesAcrossDBConnections(t *testing.T) {
	for _, route := range []string{"po", "rfq"} {
		t.Run(route, func(t *testing.T) {
			dir := t.TempDir()
			first, err := core.Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer first.Close()
			second, err := core.Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer second.Close()
			table, column, prefix := "purchase_orders", "po_id", "PO - "+time.Now().Format("012006")+" - "
			if route == "rfq" {
				table, column, prefix = "rfq_logs", "rfq_id", "RFQ-"+time.Now().Format("012006")+"-"
			}
			seed := prefix + "099"
			if _, err := first.Exec("INSERT INTO "+table+"("+column+",supplier) VALUES(?,'Original')", seed); err != nil {
				t.Fatal(err)
			}
			const n = 12
			results := make(chan string, n)
			failures := make(chan error, n)
			start := make(chan struct{})
			var wg sync.WaitGroup
			for i := 0; i < n; i++ {
				wg.Add(1)
				go func(db *sql.DB) {
					defer wg.Done()
					<-start
					id, err := assistantCreate(db, route, seed)
					if err != nil {
						failures <- err
					} else {
						results <- id
					}
				}([]*sql.DB{first, second}[i%2])
			}
			close(start)
			wg.Wait()
			close(results)
			close(failures)
			for err := range failures {
				t.Error(err)
			}
			seen := map[string]bool{}
			for id := range results {
				if seen[id] || id == seed {
					t.Errorf("duplicate/client ID: %s", id)
				}
				seen[id] = true
			}
			var count int
			var supplier string
			if err := first.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if err := first.QueryRow("SELECT supplier FROM "+table+" WHERE "+column+"=?", seed).Scan(&supplier); err != nil {
				t.Fatal(err)
			}
			if len(seen) != n || count != n+1 || supplier != "Original" {
				t.Fatalf("ids=%d rows=%d original=%s", len(seen), count, supplier)
			}
		})
	}
}

func TestAssistantCreateRollback(t *testing.T) {
	for _, route := range []string{"po", "rfq"} {
		t.Run(route, func(t *testing.T) {
			db, err := core.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			table, triggerTable := "purchase_orders", "purchase_order_items"
			if route == "rfq" {
				table, triggerTable = "rfq_logs", "rfq_logs"
			}
			if _, err := db.Exec(fmt.Sprintf(`CREATE TRIGGER fixture_failure BEFORE INSERT ON %s BEGIN SELECT RAISE(ABORT,'fixture failure'); END`, triggerTable)); err != nil {
				t.Fatal(err)
			}
			if _, err := assistantCreate(db, route, "malicious-id"); err == nil {
				t.Fatal("failed create succeeded")
			}
			var count int
			if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
				t.Fatalf("partial create rows=%d err=%v", count, err)
			}
			if _, err := db.Exec(`DROP TRIGGER fixture_failure`); err != nil {
				t.Fatal(err)
			}
			if _, err := assistantCreate(db, route, "malicious-id"); err != nil {
				t.Fatal(err)
			}
		})
	}
}
