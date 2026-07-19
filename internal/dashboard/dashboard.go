package dashboard

import (
	"database/sql"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// MOV_CONFIG constants (GAS: GS_Dashboard.js uses these)
const (
	supplierLeadDays  = 14
	paymentDelayDays  = 30
	safetyBufferDays  = 14
)

type Stats struct {
	Financials struct {
		YTDSpend float64 `json:"ytdSpend"`
	} `json:"financials"`
	Operations struct {
		PendingApprovals int `json:"pendingApprovals"`
		PendingPayment   int `json:"pendingPayment"`
	} `json:"operations"`
	Inventory struct {
		CriticalStock int `json:"criticalStock"`
		TotalItems    int `json:"totalItems"`
	} `json:"inventory"`
	ROPAlerts []ROPAlert `json:"ropAlerts"`
}

type ROPAlert struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Current  float64 `json:"current"`
	ROP      float64 `json:"rop"`
	SafetyQty float64 `json:"safetyStockQty"`
	Gap      float64 `json:"gap"`
	Cost     float64 `json:"cost"`
	Health   float64 `json:"health"`
}

type Service struct {
	DB *sql.DB
}

func (s *Service) Compute() Stats {
	var st Stats
	now := time.Now()
	currentYear := now.Year()

	// ── A. PO SCAN ──
	rows, err := s.DB.Query(`
		SELECT po_id, date, total, status
		FROM purchase_orders
		ORDER BY date DESC, po_id DESC
		LIMIT 1000
	`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var poID, dateStr, status string
			var total sql.NullFloat64
			rows.Scan(&poID, &dateStr, &total, &status)
			status = strings.ToUpper(strings.TrimSpace(status))
			if status == "VOID" || status == "CANCELLED" || poID == "" {
				continue
			}
			switch status {
			case "PENDING APPROVAL":
				st.Operations.PendingApprovals++
			case "PENDING PAYMENT":
				st.Operations.PendingPayment++
			}
			// GAS: YTD sum for APPROVED/PAID/PARTIAL
			// SQLite maps: Paid=PAID, Pending Payment≈APPROVED, Pending Approval≈PARTIAL
			if status == "PAID" || status == "PENDING PAYMENT" || status == "PENDING APPROVAL" {
				if d := parseDate(dateStr, poID); d != nil && d.Year() == currentYear {
					st.Financials.YTDSpend += orZero(total)
				}
			}
		}
	}

	// ── B. INVENTORY SCAN ──
	rows, err = s.DB.Query(`
		SELECT stock_id, item_name, current_stock, rop, cost, exclude,
		       velocity_override, item_behaviour
		FROM items
	`)
	if err != nil {
		return st
	}
	defer rows.Close()

	var alerts []ROPAlert
	for rows.Next() {
		var id, name, excludeStr, velOvStr, behaviour sql.NullString
		var current, rop, cost sql.NullFloat64
		rows.Scan(&id, &name, &current, &rop, &cost, &excludeStr, &velOvStr, &behaviour)

		if !id.Valid || !name.Valid {
			continue
		}
		st.Inventory.TotalItems++

		// Exclude filter
		excl := strings.ToUpper(strings.TrimSpace(excludeStr.String))
		if excl == "TRUE" || excl == "YES" || excl == "EXCLUDE" || excl == "1" {
			continue
		}

		// Behaviour filter: only Standard/Pack, In-House Use, or empty
		beh := strings.TrimSpace(behaviour.String)
		if beh != "" && beh != "Standard / Pack" && beh != "In-House Use" {
			continue
		}

		curr := orZeroF(current)
		dbROP := orZeroF(rop)
		velOv := orZeroF(velOvStr)

		effectiveROP := dbROP
		if velOv > 0 {
			effectiveROP = velOv
		}
		if effectiveROP <= 0 {
			continue
		}

		// Safety stock calculation (GAS logic)
		effectiveLeadMonths := (supplierLeadDays + paymentDelayDays + safetyBufferDays) / 30.0
		estVelocity := 0.0
		if effectiveLeadMonths > 0 {
			estVelocity = dbROP / effectiveLeadMonths
		}
		safetyMonths := (paymentDelayDays + safetyBufferDays) / 30.0
		safetyQty := math.Ceil(estVelocity * safetyMonths)
		if velOv > 0 {
			safetyQty = velOv
		}

		if curr > safetyQty {
			continue
		}

		gap := effectiveROP - curr
		c := orZeroF(cost)
		health := 0.0
		if effectiveROP > 0 {
			health = (curr / effectiveROP) * 100
		}

		st.Inventory.CriticalStock++
		alerts = append(alerts, ROPAlert{
			ID: id.String, Name: name.String,
			Current: curr, ROP: effectiveROP, SafetyQty: safetyQty,
			Gap: gap, Cost: gap * c, Health: health,
		})
	}

	sort.Slice(alerts, func(i, j int) bool { return alerts[i].Health < alerts[j].Health })
	if len(alerts) > 10 {
		alerts = alerts[:10]
	}
	st.ROPAlerts = alerts
	return st
}

func parseDate(dateStr string, poID string) *time.Time {
	// Try date column first
	s := strings.TrimSpace(dateStr)
	for _, fmt := range []string{"2006-01-02", "2006-01-02T15:04:05", "02/01/2006"} {
		if t, err := time.Parse(fmt, s); err == nil {
			return &t
		}
	}
	// If date column is empty or unparseable, try PO ID date parsing (GAS fallback)
	if s == "" {
		if t := parsePOIDDate(poID); t != nil {
			return t
		}
	}
	return nil
}

// parsePOIDDate extracts date from PO ID format (GAS parsePoDateFromId).
// Supports: PO - DDMMYYYY - NNN, PO - MMYYYY - NNN, PO.NNN(MM/YYYY), special cases.
func parsePOIDDate(poID string) *time.Time {
	if poID == "" {
		return nil
	}
	s := strings.ToUpper(strings.TrimSpace(poID))
	if strings.Contains(s, "STARLIGHT") {
		t := time.Date(2025, 12, 1, 0, 0, 0, 0, time.UTC)
		return &t
	}
	if strings.ReplaceAll(s, " ", "") == "PO.06031025" {
		t := time.Date(2025, 10, 1, 0, 0, 0, 0, time.UTC)
		return &t
	}
	// Dot-paren: PO.NNN(MM/YYYY)
	if idx := strings.Index(s, "("); idx > 0 {
		rest := s[idx+1:]
		if end := strings.Index(rest, "/"); end > 0 {
			mm, _ := strconv.Atoi(rest[:end])
			yyyy, _ := strconv.Atoi(rest[end+1 : end+5])
			if mm >= 1 && mm <= 12 && yyyy >= 2020 && yyyy <= 2030 {
				t := time.Date(yyyy, time.Month(mm), 1, 0, 0, 0, 0, time.UTC)
				return &t
			}
		}
	}
	// 8 digits after dash: DDMMYYYY → month at pos 2-4, year at 4-8
	if len(s) >= 10 {
		digits := ""
		for _, c := range s {
			if c >= '0' && c <= '9' {
				digits += string(c)
			}
		}
		if len(digits) == 8 {
			mm, _ := strconv.Atoi(digits[2:4])
			yyyy, _ := strconv.Atoi(digits[4:8])
			if mm >= 1 && mm <= 12 && yyyy >= 2020 && yyyy <= 2030 {
				t := time.Date(yyyy, time.Month(mm), 1, 0, 0, 0, 0, time.UTC)
				return &t
			}
		}
		// 6 digits: MMYYYY
		if len(digits) == 6 {
			mm, _ := strconv.Atoi(digits[:2])
			yyyy, _ := strconv.Atoi(digits[2:6])
			if mm >= 1 && mm <= 12 && yyyy >= 2020 && yyyy <= 2030 {
				t := time.Date(yyyy, time.Month(mm), 1, 0, 0, 0, 0, time.UTC)
				return &t
			}
		}
	}
	return nil
}

func orZero(f sql.NullFloat64) float64 {
	if f.Valid {
		return f.Float64
	}
	return 0
}

func orZeroF(f interface{}) float64 {
	switch v := f.(type) {
	case sql.NullFloat64:
		if v.Valid {
			return v.Float64
		}
	case sql.NullString:
		if v.Valid {
			s := strings.Map(func(r rune) rune {
				if (r >= '0' && r <= '9') || r == '.' || r == '-' {
					return r
				}
				return -1
			}, v.String)
			x, _ := strconv.ParseFloat(s, 64)
			return x
		}
	}
	return 0
}
