package analytics

import (
	"testing"

	"procura/internal/core"
)

func TestRefreezeInvoiceSpendOnce(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO settings(key,value) VALUES('analytics_frozen','{"2026":{"6":{"spend":1,"val":5},"7":{"spend":2,"val":6},"8":{"spend":3,"val":7}}}');
		INSERT INTO purchase_orders(po_id,date,invoice_date,total,status) VALUES
		('JUL','2026-07-20','2026-08-01',1000,'Paid'),
		('AUG-JULINV','2026-08-10','2026-07-20',100,'Paid'),
		('AUG','2026-08-12','2026-08-11',10,'Paid'),
		('SEP-AUGINV','2026-09-14','2026-08-28',20,'Paid'),
		('SEP','2026-09-20','2026-09-18',40,'Paid'),
		('SEP-TYPO','2026-09-21','2025-09-11',80,'Paid'),
		('SEP-VOID','2026-09-22','2026-09-22',999,'VOID')`); err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}
	if err := s.RefreezeInvoiceSpend(); err != nil {
		t.Fatal(err)
	}
	f := s.settingsFrozen()["2026"]
	if f["6"]["spend"] != 1 || f["7"]["spend"] != 130 || f["8"]["spend"] != 120 || f["7"]["val"] != 6 || f["8"]["val"] != 7 {
		t.Fatalf("frozen = %v", f)
	}
	if m := s.Compute(2026, 7, 2026, 8); m.Finance.MonthlySpend[0] != 130 || m.Finance.MonthlySpend[1] != 120 {
		t.Fatalf("chart = %v", m.Finance.MonthlySpend)
	}
	db.Exec(`UPDATE purchase_orders SET total=5000 WHERE po_id='AUG'`)
	if err := s.RefreezeInvoiceSpend(); err != nil || s.settingsFrozen()["2026"]["7"]["spend"] != 130 {
		t.Fatalf("must run once: err=%v frozen=%v", err, s.settingsFrozen()["2026"])
	}
}

func TestRefreezeInvoiceSpendMarksDoneWithoutFrozenMonths(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := &Service{DB: db}
	if err := s.RefreezeInvoiceSpend(); err != nil || s.getSetting("migration.invoice_spend.v1") == "" {
		t.Fatalf("marker not written: err=%v", err)
	}
}

func TestLateInvoiceAfterFreezeCountsInPOMonth(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := &Service{DB: db}
	spend := func() []float64 { return s.Compute(2026, 8, 2026, 9).Finance.MonthlySpend } // Sep, Oct
	if _, err := db.Exec(`INSERT INTO purchase_orders(po_id,date,invoice_date,total,status) VALUES
		('SEP','2026-09-20','2026-09-18',100,'Paid'),
		('OCT-EARLY','2026-10-02','2026-09-29',10,'Paid')`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Freeze(2026, 8); err != nil {
		t.Fatal(err)
	}
	if got := spend(); got[0] != 110 || got[1] != 0 {
		t.Fatalf("after freezing Sep: %v", got)
	}
	// Entered after September was frozen, with a September invoice: counts in October, not lost.
	db.Exec(`INSERT INTO purchase_orders(po_id,date,invoice_date,total,status) VALUES('OCT-LATE','2026-10-05','2026-09-30',1000,'Paid')`)
	if got := spend(); got[0] != 110 || got[1] != 1000 {
		t.Fatalf("late invoice: %v", got)
	}
	if _, err := s.Freeze(2026, 9); err != nil {
		t.Fatal(err)
	}
	if got := spend(); got[0] != 110 || got[1] != 1000 {
		t.Fatalf("after freezing Oct: %v", got)
	}
	// Re-freezing September takes the late PO in again, and it is not counted twice.
	if _, err := s.Freeze(2026, 8); err != nil {
		t.Fatal(err)
	}
	if got := spend(); got[0] != 1110 || got[1] != 1000 {
		t.Fatalf("re-frozen Sep: %v (Oct stays as frozen)", got)
	}
}

func TestMarkFreezeWatermarksOnce(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.Exec(`INSERT INTO purchase_orders(po_id,date,total,status) VALUES('A','2026-09-01',1,'Paid'),('B','2026-09-02',1,'Paid');
		INSERT INTO settings(key,value) VALUES('analytics_frozen','{"2026":{"7":{"spend":5},"8":{"spend":6,"po_rowid":1}}}')`)
	s := &Service{DB: db}
	if err := s.MarkFreezeWatermarks(); err != nil {
		t.Fatal(err)
	}
	f := s.settingsFrozen()["2026"]
	if f["7"]["po_rowid"] != 2 || f["8"]["po_rowid"] != 1 || f["7"]["spend"] != 5 {
		t.Fatalf("watermarks = %v", f)
	}
	db.Exec(`INSERT INTO purchase_orders(po_id,date,total,status) VALUES('C','2026-09-03',1,'Paid')`)
	db.Exec(`UPDATE settings SET value='{"2026":{"9":{"spend":1}}}' WHERE key='analytics_frozen'`)
	if err := s.MarkFreezeWatermarks(); err != nil || s.settingsFrozen()["2026"]["9"]["po_rowid"] != 0 {
		t.Fatalf("must run once: %v %v", err, s.settingsFrozen())
	}
}
