package planning

import (
	"database/sql"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// MOV_CONFIG constants (GAS)
const (
	supplierLeadDays  = 14
	paymentDelayDays  = 30
	safetyBufferDays  = 14
	turnoverFastThres = 12.0 // times per year
	turnoverSlowThres = 4.0
	capFastMonths     = 4.0
	capMediumMonths   = 3.0
	capSlowMonths     = 2.0
	ropMonths         = 2.0 // ROP = 2 months of velocity
	safetyStockMonths = 1.0
	rfdLookbackDays   = 7
)

type Item struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Category     string  `json:"category"`
	ProductType  string  `json:"productType"`
	Supplier     string  `json:"supplier"`
	UOM          string  `json:"uom"`
	Current      float64 `json:"current"`
	ROP          float64 `json:"rop"`
	Cost         float64 `json:"cost"`
	Suggested    float64 `json:"suggested"`
	Health       float64 `json:"health"`
	Status       string  `json:"status"` // CRITICAL or REORDER
	SafetyQty    float64 `json:"safetyStockQty"`
	VelocityClass string `json:"velocityClass"`
	CapMonths    float64 `json:"capMonths"`
	TurnoverRate float64 `json:"turnoverRate"`
}

type DirectOrder struct {
	OrderID   string    `json:"orderId"`
	Date      time.Time `json:"date"`
	OrderedBy string    `json:"orderedBy"`
	Notes     string    `json:"notes"`
	Items     []OrderItem `json:"items"`
}

type OrderItem struct {
	StockID  string  `json:"stockId"`
	Name     string  `json:"name"`
	Supplier string  `json:"supplier"`
	Qty      float64 `json:"qty"`
}

type Service struct {
	DB *sql.DB
}

// Plan returns items needing reorder, with tiered suggestions.
func (s *Service) Plan() []Item {
	pipeline := s.pipelineStockIDs()
	turnover := s.turnoverRates()

	rows, err := s.DB.Query(`
		SELECT stock_id, item_name, category, product_type, supplier_name, uom,
		       current_stock, rop, cost, exclude, item_behaviour, product_status,
		       velocity_override
		FROM items
	`)
	if err != nil {
		return []Item{}
	}
	defer rows.Close()

	var items []Item
	for rows.Next() {
		var id, name, cat, ptype, supplier, uom, excl, beh, status sql.NullString
		var velOv sql.NullString
		var current, rop, cost sql.NullFloat64
		rows.Scan(&id, &name, &cat, &ptype, &supplier, &uom,
			&current, &rop, &cost, &excl, &beh, &status, &velOv)

		if !id.Valid || !name.Valid {
			continue
		}

		// Pipeline check: skip items already being procured
		if pipeline[id.String] {
			continue
		}

		// Exclude filter
		if strings.ToUpper(strings.TrimSpace(excl.String)) == "TRUE" ||
			strings.ToUpper(strings.TrimSpace(excl.String)) == "YES" ||
			strings.ToUpper(strings.TrimSpace(excl.String)) == "EXCLUDE" ||
			strings.TrimSpace(excl.String) == "1" {
			continue
		}

		// Behaviour filter
		behStr := strings.ToLower(strings.TrimSpace(beh.String))
		if behStr == "asset" || behStr == "service" || behStr == "exclude" {
			continue
		}
		if behStr != "" && behStr != "standard / pack" && behStr != "in-house use" {
			continue
		}

		// Status filter
		if strings.ToLower(strings.TrimSpace(status.String)) == "unavailable" {
			continue
		}

		// Skip surgical
		ptStr := strings.ToLower(strings.TrimSpace(ptype.String))
		catStr := strings.ToLower(strings.TrimSpace(cat.String))
		if strings.Contains(ptStr, "surgical") || strings.Contains(catStr, "surgical") {
			continue
		}

		curr := orZero(current)
		dbROP := orZero(rop)
		c := orZero(cost)
		vel := 0.0
		if v, err := parseFloat(velOv.String); err == nil {
			vel = v
		}

		effectiveROP := dbROP
		if vel > 0 {
			effectiveROP = vel
		}
		if effectiveROP <= 0 || curr >= effectiveROP {
			continue
		}

		health := (curr / effectiveROP) * 100

		// Turnover rate from movement data
		tr := turnover[strings.ToUpper(id.String)]
		vClass := velocityClass(tr)
		capMonths := capMonthsFor(vClass)

		// Estimate velocity from ROP
		estVelocity := 0.0
		if ropMonths > 0 {
			estVelocity = dbROP / ropMonths
		}

		maxStockQty := math.Ceil(estVelocity * capMonths)
		if vel > 0 {
			maxStockQty = vel
		}

		safetyQty := math.Ceil(estVelocity * safetyStockMonths)
		if vel > 0 {
			safetyQty = vel
		}

		statusLabel := "REORDER"
		suggested := 0.0
		if curr <= safetyQty {
			statusLabel = "CRITICAL"
			suggested = max(0, maxStockQty-curr)
		}

		items = append(items, Item{
			ID: id.String, Name: name.String, Category: cat.String,
			ProductType: ptStr, Supplier: supplier.String, UOM: uom.String,
			Current: curr, ROP: effectiveROP, Cost: c,
			Suggested: suggested, Health: math.Round(health*10) / 10,
			Status: statusLabel, SafetyQty: safetyQty,
			VelocityClass: vClass, CapMonths: capMonths, TurnoverRate: tr,
		})
	}

	sort.Slice(items, func(i, j int) bool { return items[i].Health < items[j].Health })
	return items
}

// MarkOrdered creates a direct order record (bypasses RFQ).
func (s *Service) MarkOrdered(items []OrderItem, notes, orderedBy string) (string, error) {
	now := time.Now()
	orderID := s.nextDirectOrderID()

	for _, item := range items {
		_, err := s.DB.Exec(`
			INSERT INTO direct_orders (order_id, date, stock_id, item_name, supplier, quantity, ordered_by, notes, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
		`, orderID, now.Format("2006-01-02"), item.StockID, item.Name, item.Supplier, item.Qty, orderedBy, notes)
		if err != nil {
			return "", err
		}
	}
	return orderID, nil
}

// CancelOrder marks a direct order as CANCELLED.
func (s *Service) CancelOrder(orderID string) (int, error) {
	res, err := s.DB.Exec(
		"UPDATE direct_orders SET status = 'CANCELLED' WHERE order_id = ? AND status = 'ACTIVE'",
		orderID,
	)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// DirectOrders returns active orders from last 7 days.
func (s *Service) DirectOrders() []DirectOrder {
	cutoff := time.Now().AddDate(0, 0, -rfdLookbackDays).Format("2006-01-02")
	rows, _ := s.DB.Query(`
		SELECT order_id, date, stock_id, item_name, supplier, quantity, ordered_by, notes
		FROM direct_orders
		WHERE status = 'ACTIVE' AND date >= ?
		ORDER BY date DESC, order_id
	`, cutoff)
	if rows == nil {
		return nil
	}
	defer rows.Close()

	orders := map[string]*DirectOrder{}
	var orderKeys []string
	for rows.Next() {
		var oid, dateStr, sid, name, supplier, by, notes string
		var qty float64
		rows.Scan(&oid, &dateStr, &sid, &name, &supplier, &qty, &by, &notes)

		if _, ok := orders[oid]; !ok {
			d, _ := time.Parse("2006-01-02", dateStr[:10])
			orders[oid] = &DirectOrder{OrderID: oid, Date: d, OrderedBy: by, Notes: notes}
			orderKeys = append(orderKeys, oid)
		}
		orders[oid].Items = append(orders[oid].Items, OrderItem{StockID: sid, Name: name, Supplier: supplier, Qty: qty})
	}

	var out []DirectOrder
	for _, k := range orderKeys {
		out = append(out, *orders[k])
	}
	return out
}

// pipelineStockIDs returns stock_ids currently in procurement (open POs, recent RFQs, recent direct orders).
func (s *Service) pipelineStockIDs() map[string]bool {
	p := map[string]bool{}

	// Direct orders (last 7 days, active)
	cutoff := time.Now().AddDate(0, 0, -rfdLookbackDays).Format("2006-01-02")
	rows, _ := s.DB.Query("SELECT stock_id FROM direct_orders WHERE status = 'ACTIVE' AND date >= ?", cutoff)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var sid string
			rows.Scan(&sid)
			if sid != "" {
				p[strings.TrimSpace(sid)] = true
			}
		}
	}

	// RFQs (last 7 days)
	rows, _ = s.DB.Query("SELECT raw_rfq_json FROM rfq_logs WHERE date >= ?", cutoff)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var raw string
			rows.Scan(&raw)
			// Parse compact JSON: [{"id":"SKU123",...}]
			for _, sid := range parseCompactIDs(raw) {
				p[sid] = true
			}
		}
	}

	// Open POs (not received/voided)
	rows, _ = s.DB.Query(`
		SELECT raw_po_json FROM purchase_orders
		WHERE COALESCE(ship_status,'') != 'Received'
		  AND COALESCE(status,'') != 'VOID'
		  AND raw_po_json IS NOT NULL AND raw_po_json != ''
	`)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var raw string
			rows.Scan(&raw)
			for _, sid := range parseCompactIDs(raw) {
				p[sid] = true
			}
		}
	}

	return p
}

// turnoverRates computes turnover rate (annual consumption / ROP) from movement data.
func (s *Service) turnoverRates() map[string]float64 {
	rows, _ := s.DB.Query(`
		SELECT stock_id, SUM(out_qty + adj_out) as total_out
		FROM stock_movements
		GROUP BY stock_id
	`)
	if rows == nil {
		return map[string]float64{}
	}
	defer rows.Close()

	m := map[string]float64{}
	for rows.Next() {
		var sid string
		var total float64
		rows.Scan(&sid, &total)
		if sid != "" && total > 0 {
			m[strings.ToUpper(strings.TrimSpace(sid))] = total
		}
	}
	return m
}

func (s *Service) nextDirectOrderID() string {
	year := time.Now().Year()
	prefix := "DO-" + itoa(year) + "-"
	var maxSeq int
	rows, _ := s.DB.Query("SELECT order_id FROM direct_orders WHERE order_id LIKE ?", prefix+"%")
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var oid string
			rows.Scan(&oid)
			oid = strings.TrimPrefix(oid, prefix)
			if seq, err := parseInt(oid); err == nil && seq > maxSeq {
				maxSeq = seq
			}
		}
	}
	return prefix + padInt(maxSeq+1, 3)
}

func velocityClass(tr float64) string {
	if tr >= turnoverFastThres {
		return "FAST"
	}
	if tr < turnoverSlowThres {
		return "SLOW"
	}
	return "MEDIUM"
}

func capMonthsFor(vc string) float64 {
	switch vc {
	case "FAST": return capFastMonths
	case "SLOW": return capSlowMonths
	default: return capMediumMonths
	}
}

// helpers
func orZero(f sql.NullFloat64) float64 { if f.Valid { return f.Float64 }; return 0 }
func parseFloat(s string) (float64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}
	return strconv.ParseFloat(s, 64)
}

func itoa(n int) string    { return strconv.Itoa(n) }
func padInt(n, width int) string {
	s := itoa(n)
	for len(s) < width {
		s = "0" + s
	}
	return s
}
func parseInt(s string) (int, error) { return strconv.Atoi(s) }

// parseCompactIDs extracts stock_ids from GAS compact JSON: [{"id":"SKU123","n":"name",...}]
func parseCompactIDs(raw string) []string {
	// ponytail: simple string scan for "id":"..."
	var ids []string
	for i := 0; i < len(raw); {
		// find "id":
		idx := strings.Index(raw[i:], `"id"`)
		if idx < 0 { break }
		i += idx + 4
		// find opening quote after colon
		colon := strings.Index(raw[i:], ":")
		if colon < 0 { break }
		i += colon + 1
		// skip whitespace/quote
		for i < len(raw) && (raw[i] == ' ' || raw[i] == '"') { i++ }
		// read until closing quote
		start := i
		for i < len(raw) && raw[i] != '"' { i++ }
		if start < i {
			ids = append(ids, raw[start:i])
		}
		i++
	}
	return ids
}
