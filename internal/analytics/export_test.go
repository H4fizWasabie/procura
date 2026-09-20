package analytics

import (
	"bytes"
	"testing"

	"procura/internal/core"
)

func TestFreezeExport(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil { t.Fatal(err) }
	defer db.Close()
	s := &Service{DB: db}
	if _, err := db.Exec(`INSERT INTO items (stock_id, item_name, cost, selling_price, item_behaviour, current_stock) VALUES ('JULY','July item',10,20,'In-House Use',3)`); err != nil { t.Fatal(err) }
	if _, err := db.Exec(`INSERT INTO stock_movements (stock_id, item_name, year, month, out_qty, report_closing) VALUES ('JULY','July item',2026,7,2,3)`); err != nil { t.Fatal(err) }
	if _, err := db.Exec(`INSERT INTO purchase_orders (po_id, date, total, status) VALUES ('PO-JULY','2026-07-10',50,'Paid')`); err != nil { t.Fatal(err) }

	vals, err := s.Freeze(2026, 6)
	if err != nil { t.Fatal(err) }
	if vals["ih"] != 20 || vals["val"] != 30 || vals["cons"] != 20 || vals["rev"] != 40 || vals["spend"] != 50 {
		t.Fatalf("raw freeze = %#v, want ih=20 val=30 cons=20 rev=40 spend=50", vals)
	}

	if _, err := db.Exec(`UPDATE items SET cost=99, selling_price=199 WHERE stock_id='JULY'`); err != nil { t.Fatal(err) }
	m := s.Compute(2026, 6, 2026, 6)
	if m.Operation.InHouseConsumption[0] != 20 || m.Inventory.ValuationTrend[0] != 30 || m.Inventory.ConsumptionTrend[0] != 20 || m.Business.GrossRevenueTrend[0] != 40 || m.Finance.MonthlySpend[0] != 50 || m.Finance.TotalSpend != 50 {
		t.Fatalf("frozen recompute changed = %+v", m)
	}
	if _, err := db.Exec(`INSERT INTO stock_movements (stock_id, item_name, year, month, out_qty, report_closing) VALUES ('JULY','July item',2026,9,1,4)`); err != nil { t.Fatal(err) }
	if _, err := db.Exec(`INSERT INTO purchase_orders (po_id, date, total, status) VALUES ('PO-SEPT','2026-09-10',60,'Paid')`); err != nil { t.Fatal(err) }
	live := s.Compute(2026, 6, 2026, 8)
	if live.Operation.InHouseConsumption[2] != 99 || live.Inventory.ValuationTrend[2] != 396 || live.Inventory.ConsumptionTrend[2] != 99 || live.Business.GrossRevenueTrend[2] != 199 || live.Finance.MonthlySpend[2] != 60 {
		t.Fatalf("September did not remain live = %+v", live)
	}

	b, err := s.Export(2026, 6, 2026, 6)
	if err != nil { t.Fatal(err) }
	if !bytes.HasPrefix(b, []byte("PK\x03\x04")) { t.Fatal("not a valid xlsx") }
	if len(b) < 10000 { t.Fatalf("xlsx too small: %d bytes", len(b)) }
}

func TestTotalSpendMatchesBaselineMonthlySeries(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil { t.Fatal(err) }
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO purchase_orders (po_id, date, total, status) VALUES ('PO-JAN','2026-01-10',10,'Paid')`); err != nil { t.Fatal(err) }

	m := (&Service{DB: db}).Compute(2026, 0, 2026, 0)
	if m.Finance.MonthlySpend[0] != 198000 || m.Finance.TotalSpend != 198000 {
		t.Fatalf("spend = total %v monthly %v, want both 198000", m.Finance.TotalSpend, m.Finance.MonthlySpend[0])
	}
}
