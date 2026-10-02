package main

import (
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	"procura/internal/analytics"
	"procura/internal/core"
	"procura/internal/dashboard"
	"procura/internal/inventory"
	"procura/internal/movement"
	"procura/internal/planning"
	"procura/internal/report"
	"procura/internal/validation"
)

func eligibilityFixture(t *testing.T) *sql.DB {
	t.Helper()
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`CREATE TABLE supplier_item_mappings(id INTEGER, stock_id TEXT, supplier_name TEXT, supplier_uom TEXT)`); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		id                               string
		policy                           interface{}
		exclude                          interface{}
		behaviour, status, typ, category string
		stock, velocity                  float64
	}{
		{"ROUTINE", "routine", 0, "Standard / Pack", "Available", "Supply", "Fixture", 2, 0},
		{"AT_ROP", "routine", 0, "Standard / Pack", "Available", "Supply", "Fixture", 10, 10},
		{"ON_DEMAND", "on_demand", 0, "Standard / Pack", "Available", "Supply", "Fixture", 0, 0},
		{"DO_NOT_REORDER", "do_not_reorder", 0, "Standard / Pack", "Available", "Supply", "Fixture", 2, 0},
		{"UNCLASSIFIED", nil, 0, "Standard / Pack", "Available", "Supply", "Fixture", 2, 0},
		{"EXCLUDED", "routine", "YES", "Standard / Pack", "Available", "Supply", "Fixture", 2, 0},
		{"NOT_AVAILABLE", "routine", 0, "Standard / Pack", "not-available", "Supply", "Fixture", 2, 0},
		{"SURGICAL_TYPE", "routine", 0, "Standard / Pack", "Available", "Surgical supply", "Fixture", 2, 0},
		{"SURGICAL_CATEGORY", "routine", 0, "Standard / Pack", "Available", "Supply", "Surgical", 2, 0},
		{"SERVICE", "routine", 0, "Service", "Available", "Supply", "Fixture", 2, 0},
		{"ASSET", "routine", 0, "Asset", "Available", "Supply", "Fixture", 2, 0},
		{"EMPTY_BEHAVIOUR", "routine", 0, "", "Available", "Supply", "Fixture", 2, 0},
		{"UNKNOWN_BEHAVIOUR", "routine", 0, "Unknown", "Available", "Supply", "Fixture", 2, 0},
		{"LEGACY_EXCLUDE_BEHAVIOUR", "routine", 0, "Exclude", "Available", "Supply", "Fixture", 2, 0},
		{"ZERO_EXCLUDED", "routine", 1, "Standard / Pack", "Available", "Supply", "Fixture", 0, 0},
	} {
		if _, err := db.Exec(`INSERT INTO items(stock_id,item_name,purchase_policy,exclude,item_behaviour,product_status,
			product_type,category,current_stock,rop,cost,uom,velocity_override,last_updated)
			VALUES(?,?,?,?,?,?,?,?,?,10,1,'ea',?,'2026-01-02T03:04:05')`,
			item.id, item.id, item.policy, item.exclude, item.behaviour, item.status, item.typ, item.category, item.stock, item.velocity); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func captureEligibilityViews(t *testing.T, db *sql.DB) map[string][]string {
	t.Helper()
	views := map[string][]string{"Validation ZERO_STOCK_WITH_ROP": {}}
	plan, err := (&planning.Service{DB: db}).Plan()
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range plan {
		views["Planning"] = append(views["Planning"], item.ID+":"+item.Status)
	}
	dash := (&dashboard.Service{DB: db}).Compute()
	for _, item := range dash.ROPAlerts {
		views["Dashboard alerts"] = append(views["Dashboard alerts"], item.ID)
	}
	for _, item := range (&report.Service{DB: db}).RestockReport(1, 100).Data {
		views["Restock report"] = append(views["Restock report"], item.SKU)
	}
	for name, filter := range map[string]inventory.Filters{"Inventory low stock": {LowStock: true}, "Inventory Active": {Active: true}, "All inventory": {}} {
		items, err := (&inventory.Service{DB: db}).ListFiltered(filter, 1, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range items {
			views[name] = append(views[name], item.StockID)
		}
	}
	metrics := (&analytics.Service{DB: db}).Compute(2026, 0, 2026, 0)
	for _, item := range metrics.Operation.CriticalItems {
		views["Analytics critical"] = append(views["Analytics critical"], item.Name)
	}
	for _, item := range (&validation.Service{DB: db}).Run(false) {
		if item.Type == "MISSING_MOVEMENT" || item.Type == "ZERO_STOCK_WITH_ROP" {
			views["Validation "+item.Type] = append(views["Validation "+item.Type], item.StockID)
		}
	}
	for _, item := range (&inventory.Service{DB: db}).BasicList() {
		views["Order dropdown"] = append(views["Order dropdown"], item["Stock ID"].(string))
	}
	for _, ids := range views {
		sort.Strings(ids)
	}
	t.Logf("Dashboard critical count=%d; restock cost=%v; inventory asset=%v", dash.Inventory.CriticalStock, metrics.Operation.RestockCost, metrics.Finance.InventoryAsset)
	return views
}

func TestEligibilityViewComparison(t *testing.T) {
	db := eligibilityFixture(t)
	views := captureEligibilityViews(t, db)
	routine := []string{"EMPTY_BEHAVIOUR", "ROUTINE"}
	all := []string{"ASSET", "AT_ROP", "DO_NOT_REORDER", "EMPTY_BEHAVIOUR", "EXCLUDED", "LEGACY_EXCLUDE_BEHAVIOUR", "NOT_AVAILABLE", "ON_DEMAND", "ROUTINE", "SERVICE", "SURGICAL_CATEGORY", "SURGICAL_TYPE", "UNCLASSIFIED", "UNKNOWN_BEHAVIOUR", "ZERO_EXCLUDED"}
	active := []string{"ASSET", "AT_ROP", "DO_NOT_REORDER", "EMPTY_BEHAVIOUR", "LEGACY_EXCLUDE_BEHAVIOUR", "NOT_AVAILABLE", "ON_DEMAND", "ROUTINE", "SERVICE", "SURGICAL_CATEGORY", "SURGICAL_TYPE", "UNCLASSIFIED", "UNKNOWN_BEHAVIOUR"}
	for view, want := range map[string][]string{
		"Planning":         {"EMPTY_BEHAVIOUR:REVIEW", "ROUTINE:REVIEW"},
		"Dashboard alerts": routine, "Restock report": routine, "Inventory low stock": routine, "Analytics critical": routine,
		"Inventory Active": active, "All inventory": all, "Order dropdown": all,
		"Validation MISSING_MOVEMENT": all, "Validation ZERO_STOCK_WITH_ROP": {},
	} {
		if !reflect.DeepEqual(views[view], want) {
			t.Errorf("%s=%v want %v", view, views[view], want)
		}
	}
	dash := (&dashboard.Service{DB: db}).Compute()
	metrics := (&analytics.Service{DB: db}).Compute(2026, 0, 2026, 0)
	if dash.Inventory.CriticalStock != 2 || dash.Inventory.TotalItems != 15 || metrics.Operation.RestockCost != 16 || metrics.Finance.InventoryAsset != 34 {
		t.Fatalf("unexpected totals: dashboard=%+v restock=%v asset=%v", dash.Inventory, metrics.Operation.RestockCost, metrics.Finance.InventoryAsset)
	}
	b, err := json.Marshal(views)
	if err != nil {
		t.Fatal(err)
	}
	t.Log(string(b))
}

func TestValidationZeroStockUsesRoutineEligibilityBeforeAndAfterRecalc(t *testing.T) {
	db := eligibilityFixture(t)
	if _, err := db.Exec(`UPDATE items SET current_stock=0,velocity_override=5`); err != nil {
		t.Fatal(err)
	}
	for _, recalc := range []bool{false, true} {
		if recalc {
			(&movement.Service{DB: db}).RecalcROP()
		}
		views := captureEligibilityViews(t, db)
		if !reflect.DeepEqual(views["Validation ZERO_STOCK_WITH_ROP"], []string{"AT_ROP", "EMPTY_BEHAVIOUR", "ROUTINE"}) {
			t.Errorf("recalc=%t zero-stock signal=%v", recalc, views["Validation ZERO_STOCK_WITH_ROP"])
		}
		if len(views["Validation MISSING_MOVEMENT"]) != 15 {
			t.Error("data-quality check lost excluded or unavailable items")
		}
	}
}

func TestDashboardTopTenBreaksHealthTiesByStockID(t *testing.T) {
	db := eligibilityFixture(t)
	if _, err := db.Exec(`UPDATE items SET current_stock=0,exclude=0,purchase_policy='routine',item_behaviour='',
		product_status='Available',product_type='',category=''`); err != nil {
		t.Fatal(err)
	}
	alerts := (&dashboard.Service{DB: db}).Compute().ROPAlerts
	want := []string{"ASSET", "AT_ROP", "DO_NOT_REORDER", "EMPTY_BEHAVIOUR", "EXCLUDED", "LEGACY_EXCLUDE_BEHAVIOUR", "NOT_AVAILABLE", "ON_DEMAND", "ROUTINE", "SERVICE"}
	ids := []string{}
	for _, alert := range alerts {
		ids = append(ids, alert.ID)
	}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("top ten=%v want %v", ids, want)
	}
}

func TestLowStockThresholdBeforeRoundingAndPagination(t *testing.T) {
	db := eligibilityFixture(t)
	if _, err := db.Exec(`UPDATE items SET current_stock=9.999 WHERE stock_id='AT_ROP'`); err != nil {
		t.Fatal(err)
	}
	views := captureEligibilityViews(t, db)
	for _, view := range []string{"Dashboard alerts", "Restock report", "Inventory low stock", "Analytics critical"} {
		if !reflect.DeepEqual(views[view], []string{"AT_ROP", "EMPTY_BEHAVIOUR", "ROUTINE"}) {
			t.Errorf("%s rounded away near-ROP item: %v", view, views[view])
		}
	}
	if len(views["Planning"]) != 3 || !strings.HasPrefix(views["Planning"][0], "AT_ROP:") {
		t.Errorf("planning rounded away near-ROP item: %v", views["Planning"])
	}
	svc := &inventory.Service{DB: db}
	for page, want := range map[int][]string{0: {"ROUTINE", "EMPTY_BEHAVIOUR"}, 2: {"EMPTY_BEHAVIOUR", "AT_ROP"}, 3: {"AT_ROP"}, 4: {}} {
		items, err := svc.ListFiltered(inventory.Filters{LowStock: true}, page, 1)
		if err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, item := range items {
			ids = append(ids, item.StockID)
		}
		if !reflect.DeepEqual(ids, want) {
			t.Errorf("page %d=%v want %v", page, ids, want)
		}
	}
	data, err := svc.Export(inventory.Filters{LowStock: true}, "csv")
	if err != nil {
		t.Fatal(err)
	}
	rows, err := csv.NewReader(strings.NewReader(string(data))).ReadAll()
	if err != nil || len(rows) != 4 || rows[3][0] != "AT_ROP" || rows[3][9] != "9.999" {
		t.Fatalf("filtered export: %v err=%v", rows, err)
	}
}

func TestLooseExclusionAcrossViewsAndUnfilteredDropdown(t *testing.T) {
	db := eligibilityFixture(t)
	svc := &inventory.Service{DB: db}
	for _, exclude := range []interface{}{1, "1", "TRUE", "YES", "EXCLUDE"} {
		if _, err := db.Exec(`UPDATE items SET exclude=? WHERE stock_id='ROUTINE'`, exclude); err != nil {
			t.Fatal(err)
		}
		views := captureEligibilityViews(t, db)
		for _, view := range []string{"Planning", "Dashboard alerts", "Restock report", "Inventory low stock", "Inventory Active", "Analytics critical"} {
			for _, id := range views[view] {
				if id == "ROUTINE" || strings.HasPrefix(id, "ROUTINE:") {
					t.Errorf("%s includes exclude=%v", view, exclude)
				}
			}
		}
		if len(views["Order dropdown"]) != 15 || len(views["Validation MISSING_MOVEMENT"]) != 15 {
			t.Fatal("excluded item lost from dropdown/validation")
		}
	}
	// Assert the JSON contract consumed by RFQ and historical PO linking.
	b, err := json.Marshal(svc.BasicList())
	if err != nil {
		t.Fatal(err)
	}
	var items []map[string]interface{}
	if err := json.Unmarshal(b, &items); err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		id := item["Stock ID"].(string)
		if item["purchasable"] != (id != "DO_NOT_REORDER" && id != "UNCLASSIFIED") || item["not_available"] != (id == "NOT_AVAILABLE") {
			t.Errorf("dropdown flags: %v", item)
		}
		if id == "UNCLASSIFIED" && item["purchase_policy"] != nil {
			t.Error("unclassified policy must remain null")
		}
	}
}
