package core

import (
	"database/sql"
	"log"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	dmyDate = regexp.MustCompile(`^(\d{1,2})/(\d{1,2})/(\d{4})$`)
	ymdDate = regexp.MustCompile(`^(\d{2,4})-(\d{1,2})-(\d{1,2})$`)
)

// ParseLooseDate reads the invoice dates people type: 2026-09-08, 2026-9-8,
// 26-9-8 and 8/9/2026 (day first). Impossible dates such as 129/06/2026 fail.
func ParseLooseDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	var y, m, d int
	if p := dmyDate.FindStringSubmatch(s); p != nil {
		d, _ = strconv.Atoi(p[1])
		m, _ = strconv.Atoi(p[2])
		y, _ = strconv.Atoi(p[3])
	} else if p := ymdDate.FindStringSubmatch(s); p != nil {
		y, _ = strconv.Atoi(p[1])
		m, _ = strconv.Atoi(p[2])
		d, _ = strconv.Atoi(p[3])
		if y < 100 {
			y += 2000
		}
	} else {
		return time.Time{}, false
	}
	t := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
	if t.Year() != y || int(t.Month()) != m || t.Day() != d {
		return time.Time{}, false
	}
	return t, true
}

// MaxInvoiceGap is how far an invoice date may be from its PO date; beyond it
// the date is treated as a typo (e.g. a wrong year).
const MaxInvoiceGap = 120 * 24 * time.Hour

// InvoiceSpendFrom is the first month whose spend follows invoice dates.
// Earlier months are frozen baselines, so an invoice dated before it counts here.
var InvoiceSpendFrom = time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)

// SpendDate is the date a PO counts as spend: its invoice date for POs created
// from August 2026 (moved up to August 2026 if earlier), otherwise its PO date.
// A missing or implausible invoice date falls back to the PO date.
func SpendDate(poDate time.Time, invoiceDate string) time.Time {
	inv, ok := ParseLooseDate(invoiceDate)
	if poDate.Before(InvoiceSpendFrom) || !ok || inv.Sub(poDate) > MaxInvoiceGap || poDate.Sub(inv) > MaxInvoiceGap {
		return poDate
	}
	if inv.Before(InvoiceSpendFrom) {
		return InvoiceSpendFrom
	}
	return inv
}

// normalizeInvoiceDates rewrites readable invoice dates as YYYY-MM-DD; others are left as typed.
func normalizeInvoiceDates(db *sql.DB) error {
	rows, err := db.Query(`SELECT po_id, invoice_date FROM purchase_orders
		WHERE COALESCE(invoice_date,'') != '' AND invoice_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`)
	if err != nil {
		return err
	}
	fixed := map[string]string{}
	for rows.Next() {
		var id, raw string
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return err
		}
		if t, ok := ParseLooseDate(raw); ok {
			fixed[id] = t.Format("2006-01-02")
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for id, d := range fixed {
		if _, err := tx.Exec(`UPDATE purchase_orders SET invoice_date=? WHERE po_id=?`, d, id); err != nil {
			return err
		}
	}
	if len(fixed) > 0 {
		log.Printf("core: normalized %d invoice dates to YYYY-MM-DD", len(fixed))
	}
	return tx.Commit()
}
