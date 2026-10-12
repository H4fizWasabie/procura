package core

import (
	"testing"
	"time"
)

func TestParseLooseDate(t *testing.T) {
	for in, want := range map[string]string{
		"2026-09-08": "2026-09-08", "2026-9-8": "2026-09-08", "26-9-8": "2026-09-08", "026-08-03": "2026-08-03",
		"8/9/2026": "2026-09-08", "01/07/2026": "2026-07-01", " 2026-10-5 ": "2026-10-05",
		"129/06/2026": "", "31/02/2026": "", "2026/09/08": "", "": "", "Sept 8": "",
	} {
		got, ok := ParseLooseDate(in)
		if (want == "") == ok || ok && got.Format("2006-01-02") != want {
			t.Errorf("ParseLooseDate(%q) = %v %v, want %q", in, got.Format("2006-01-02"), ok, want)
		}
	}
}

func TestSpendDate(t *testing.T) {
	day := func(s string) time.Time { d, _ := time.Parse("2006-01-02", s); return d }
	for _, c := range [][3]string{
		{"2026-07-22", "2026-08-01", "2026-07-22"}, // POs before August keep their PO date
		{"2026-09-14", "2026-08-28", "2026-08-28"}, // invoice month
		{"2026-08-10", "2026-07-20", "2026-08-01"}, // invoice in a frozen month counts in August
		{"2026-09-08", "26-9-8", "2026-09-08"},
		{"2026-09-21", "2025-09-11", "2026-09-21"}, // wrong year: PO date
		{"2026-08-03", "2027-08-03", "2026-08-03"},
		{"2026-10-01", "", "2026-10-01"},
		{"2026-10-01", "129/06/2026", "2026-10-01"},
	} {
		if got := SpendDate(day(c[0]), c[1]).Format("2006-01-02"); got != c[2] {
			t.Errorf("SpendDate(%s, %q) = %s, want %s", c[0], c[1], got, c[2])
		}
	}
}

func TestNormalizeInvoiceDatesOnOpen(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO purchase_orders(po_id,date,invoice_date) VALUES('A','2026-09-08','26-9-8'),('B','2026-07-02','01/07/2026'),('C','2026-07-13','129/06/2026'),('D','2026-10-01','2026-09-30'),('E','2026-10-01',NULL)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if db, err = Open(dir); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	want := map[string]string{"A": "2026-09-08", "B": "2026-07-01", "C": "129/06/2026", "D": "2026-09-30", "E": ""}
	for id, w := range want {
		var got string
		db.QueryRow(`SELECT COALESCE(invoice_date,'') FROM purchase_orders WHERE po_id=?`, id).Scan(&got)
		if got != w {
			t.Errorf("%s: %q, want %q", id, got, w)
		}
	}
}
