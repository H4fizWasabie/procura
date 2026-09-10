// Package planning implements the "what to buy" recommendation engine.
//
// Principle (map #1): the plan proposes, humans close the loop. Every
// suggestion carries a confidence tier; thin data yields coarser treatment,
// never fake numbers.
//
// Data ownership: current_stock belongs to the morning import, rop to the
// movement module. Planning only reads; it writes direct-order rows and
// alias memories, nothing else.
package planning

import (
	"database/sql"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	coverMonths    = 2.0 // single global cover period (ticket #3)
	safetyMonths   = 1.0 // safety stock lives in the trigger only
	incomingExpiry = 30  // unresolved incoming links expire after 30 calendar days
	recentWindow   = 3   // trailing complete months for velocity
	widenedWindow  = 6   // widened window when recent window is sparse
	minActiveForHi = 3   // active months in recent window required for HIGH confidence
)

// Confidence tiers for suggested quantities (ticket #2).
const (
	ConfHigh   = "HIGH"
	ConfLow    = "LOW"
	ConfManual = "MANUAL"
)

// Status tiers (ticket #4). REVIEW is for MANUAL-tier items.
const (
	StatusCritical = "CRITICAL"
	StatusReorder  = "REORDER"
	StatusReview   = "REVIEW"
)

type Incoming struct {
	Stage string  `json:"stage"` // PO | DIRECT | RFQ
	Ref   string  `json:"ref"`   // PO-nnn / DO-2026-001 / RFQ-nnn
	Qty   float64 `json:"qty"`
}

type Item struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Category      string     `json:"category"`
	ProductType   string     `json:"productType"`
	Supplier      string     `json:"supplier"`
	UOM           string     `json:"uom"`
	Current       float64    `json:"current"`
	ROP           float64    `json:"rop"`
	Cost          float64    `json:"cost"`
	Velocity      float64    `json:"velocity"`
	SafetyQty     float64    `json:"safetyQty"`
	InitialTarget float64    `json:"initialTarget"`
	Status        string     `json:"status"`
	Confidence    string     `json:"confidence"`
	Suggested     float64    `json:"suggested"` // 0 = no auto suggestion (flagged for review)
	OnOrder       bool       `json:"onOrder"`
	Incoming      []Incoming `json:"incoming,omitempty"`
	IncomingQty   float64    `json:"incomingQty"`
	Health        float64    `json:"health"`
}

type OrderItem struct {
	StockID  string  `json:"stockId"`
	Name     string  `json:"name"`
	UOM      string  `json:"uom"`
	Supplier string  `json:"supplier"`
	Qty      float64 `json:"qty"`
}

type DirectOrder struct {
	OrderID        string      `json:"orderId"`
	Date           time.Time   `json:"date"`
	OrderedBy      string      `json:"orderedBy"`
	Notes          string      `json:"notes"`
	DaysOpen       int         `json:"daysOpen"`
	SupersededByPO string      `json:"supersededByPo,omitempty"`
	Items          []OrderItem `json:"items"`
}

type Service struct {
	DB *sql.DB
}

// Plan returns actionable plannable items below their ROP. Incoming pipeline
// stays visible only while the item is below 100% health.
func (s *Service) Plan() []Item {
	incoming := s.incomingPipeline()
	coverage := s.historyCoverage()

	rows, err := s.DB.Query(`
		SELECT stock_id, item_name, category, product_type, supplier_name, uom,
		       current_stock, rop, cost, exclude, item_behaviour, product_status,
		       velocity_override, initial_stock_target, COALESCE(velocity,0)
		FROM items
	`)
	if err != nil {
		return []Item{}
	}
	defer rows.Close()

	var items []Item
	for rows.Next() {
		var id, name, cat, ptype, supplier, uom, excl, beh, status, velOv sql.NullString
		var current, rop, cost, initTarget, velCol sql.NullFloat64
		rows.Scan(&id, &name, &cat, &ptype, &supplier, &uom,
			&current, &rop, &cost, &excl, &beh, &status, &velOv, &initTarget, &velCol)

		if !id.Valid || !name.Valid {
			continue
		}
		sid := id.String

		if excluded(excl.String, beh.String, status.String, ptype.String, cat.String) {
			continue
		}

		curr := orZero(current)
		dbROP := orZero(rop)
		inc := incoming[sid]
		onOrder := len(inc) > 0
		health := 100.0
		if dbROP > 0 {
			health = math.Round(curr/dbROP*1000) / 10
		}
		if health >= 100 {
			continue
		}

		it := Item{
			ID: sid, Name: name.String, Category: cat.String,
			ProductType: strings.ToLower(strings.TrimSpace(ptype.String)),
			Supplier:    supplier.String, UOM: uom.String,
			Current: curr, ROP: dbROP, Cost: orZero(cost),
			InitialTarget: orZero(initTarget),
			Incoming:      inc, OnOrder: onOrder,
		}
		for _, in := range inc {
			it.IncomingQty += in.Qty
		}

		// Velocity resolution (ticket #9): read the persisted weighted
		// velocity owned by movement.RecalcROP; planning never recomputes
		// from windows. Confidence reflects data coverage only.
		cov := coverage[sid]
		if v := parseFloatOr(velOv.String, 0); v > 0 {
			it.Velocity = v
			it.Confidence = ConfHigh
			it.SafetyQty = math.Ceil(v * safetyMonths)
		} else if cov.totalMonths <= 1 || it.InitialTarget > 0 {
			it.Confidence = ConfManual
			it.Status = StatusReview
		} else if velCol.Float64 > 0 {
			it.Velocity = velCol.Float64
			if cov.recentActive >= minActiveForHi {
				it.Confidence = ConfHigh
			} else {
				it.Confidence = ConfLow
			}
			it.SafetyQty = math.Ceil(it.Velocity * safetyMonths)
		} else if dbROP > 0 {
			// Zero-velocity below ROP: conservative proxy, never hidden.
			it.Velocity = dbROP / 2
			it.Confidence = ConfLow
			it.SafetyQty = math.Ceil(it.Velocity * safetyMonths)
		} else {
			it.Confidence = ConfManual
			it.Status = StatusReview
		}

		if it.Status == "" {
			if it.SafetyQty > 0 && curr <= it.SafetyQty {
				it.Status = StatusCritical
			} else {
				it.Status = StatusReorder
			}
		}

		// Suggested qty (ticket #3): target − on_hand − incoming, ceil.
		// MANUAL items get no estimate-based number; an active initial_stock_target
		// is a human number, so deriving from it is honest (#2).
		if it.Confidence == ConfManual {
			if it.InitialTarget > 0 {
				if gap := it.InitialTarget - curr - it.IncomingQty; gap > 0 {
					it.Suggested = math.Ceil(gap)
				}
			}
		} else if gap := it.Velocity*coverMonths - curr - it.IncomingQty; gap > 0 {
			it.Suggested = math.Ceil(gap)
		}

		it.Health = health

		items = append(items, it)
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].Health != items[j].Health {
			return items[i].Health < items[j].Health
		}
		return items[i].Name < items[j].Name
	})
	return items
}

// Plannable reports whether an item participates in reorder planning.
// Shared by planning and movement.RecalcROP so both modules agree on what
// is plannable (#14).
func Plannable(excl, beh, status, ptype, category string) bool {
	return !excluded(excl, beh, status, ptype, category)
}

// excluded applies the static filters: manual exclude flag, non-plannable
// behaviours, unavailable status, surgical items.
func excluded(excl, beh, status, ptype, category string) bool {
	e := strings.ToUpper(strings.TrimSpace(excl))
	if e == "TRUE" || e == "YES" || e == "EXCLUDE" || e == "1" {
		return true
	}
	b := strings.ToLower(strings.TrimSpace(beh))
	if b == "asset" || b == "service" || b == "exclude" {
		return true
	}
	if b != "" && b != "standard / pack" && b != "in-house use" {
		return true
	}
	if strings.ToLower(strings.TrimSpace(status)) == "unavailable" {
		return true
	}
	pt := strings.ToLower(ptype)
	ct := strings.ToLower(category)
	return strings.Contains(pt, "surgical") || strings.Contains(ct, "surgical")
}

// incomingPipeline returns per-stock-id recent, unresolved incoming links:
// open PO lines (not Received/VOID), ACTIVE direct orders, and RFQs not yet
// superseded by a recent linked PO. Older links remain in history but no
// longer suppress a fresh recommendation.
func (s *Service) incomingPipeline() map[string][]Incoming {
	out := map[string][]Incoming{}
	cutoff := nowFn().AddDate(0, 0, -incomingExpiry)
	cutoffDate := cutoff.Format("2006-01-02")

	rows, err := s.DB.Query(`
		SELECT poi.po_id, poi.stock_id, poi.quantity
		FROM purchase_order_items poi
		JOIN purchase_orders po ON po.po_id = poi.po_id
		WHERE COALESCE(poi.stock_id,'') != ''
		  AND COALESCE(po.ship_status,'') != 'Received'
		  AND COALESCE(po.status,'') != 'VOID'
		  AND substr(COALESCE(po.date,''),1,10) > ?
	`, cutoffDate)
	if err == nil {
		for rows.Next() {
			var ref, sid string
			var qty float64
			rows.Scan(&ref, &sid, &qty)
			if sid = strings.TrimSpace(sid); sid != "" {
				out[sid] = append(out[sid], Incoming{Stage: "PO", Ref: ref, Qty: qty})
			}
		}
		rows.Close()
	}

	rows, err = s.DB.Query(`
		SELECT order_id, stock_id, quantity
		FROM direct_orders
		WHERE status = 'ACTIVE' AND substr(COALESCE(date,''),1,10) > ?
	`, cutoffDate)
	if err == nil {
		for rows.Next() {
			var ref, sid string
			var qty float64
			rows.Scan(&ref, &sid, &qty)
			if sid = strings.TrimSpace(sid); sid != "" {
				out[sid] = append(out[sid], Incoming{Stage: "DIRECT", Ref: ref, Qty: qty})
			}
		}
		rows.Close()
	}

	// RFQs suppress until a recent PO links them. A stale PO must not keep its
	// RFQ suppressed forever.
	rows, err = s.DB.Query(`
		SELECT rfq_id, raw_rfq_json FROM rfq_logs r
		WHERE substr(COALESCE(r.date,''),1,10) > ?
		  AND NOT EXISTS (
			SELECT 1 FROM purchase_orders po
			WHERE po.linked_rfq = r.rfq_id
			  AND COALESCE(po.ship_status,'') != 'Received'
			  AND COALESCE(po.status,'') != 'VOID'
			  AND substr(COALESCE(po.date,''),1,10) > ?
		  )
	`, cutoffDate, cutoffDate)
	if err == nil {
		for rows.Next() {
			var ref, raw string
			rows.Scan(&ref, &raw)
			for _, it := range parseCompactItems(raw) {
				if it.ID != "" {
					out[it.ID] = append(out[it.ID], Incoming{Stage: "RFQ", Ref: ref, Qty: it.Qty})
				}
			}
		}
		rows.Close()
	}

	return out
}

// historyCoverage returns per stock_id: total months with any movement row,
// and active (out>0) months in the recent window. Used only for confidence
// tiers — velocity itself comes from items.velocity (#9).
func (s *Service) historyCoverage() map[string]historyMonths {
	m := map[string]historyMonths{}
	lc := lastCompleteMonthIdx()
	rows, err := s.DB.Query(`
		SELECT COALESCE(stock_id,''),
		       COUNT(DISTINCT year*12+month),
		       SUM(CASE WHEN year*12+month > ? AND year*12+month <= ?
		                AND COALESCE(out_qty,0)+COALESCE(adj_out,0) > 0
		            THEN 1 ELSE 0 END)
		FROM stock_movements GROUP BY stock_id
	`, lc-widenedWindow, lc)
	if err != nil {
		return m
	}
	defer rows.Close()
	for rows.Next() {
		var sid string
		var total, recent int
		rows.Scan(&sid, &total, &recent)
		if sid != "" {
			m[sid] = historyMonths{totalMonths: total, recentActive: recent}
		}
	}
	return m
}

type historyMonths struct {
	totalMonths  int
	recentActive int
}

// DataThrough describes how fresh the movement data behind velocity is,
// e.g. "Jul 2026" (Q3: staleness made visible).
func (s *Service) DataThrough() string {
	var idx sql.NullInt64
	s.DB.QueryRow("SELECT MAX(year*12+month) FROM stock_movements").Scan(&idx)
	if !idx.Valid {
		return "no movement data"
	}
	y := int(idx.Int64) / 12
	mo := int(idx.Int64) % 12
	if mo == 0 { // December wraps to idx%12 == 0
		y--
		mo = 12
	}
	return time.Month(mo).String()[:3] + fmt.Sprintf(" %d", y)
}

var nowFn = time.Now // overridable in tests

// lastCompleteMonthIdx returns year*12+month of the most recent complete
// month (the one before the current, partial month).
func lastCompleteMonthIdx() int {
	t := nowFn().AddDate(0, -1, 0)
	return t.Year()*12 + int(t.Month())
}

// MarkOrdered records an explicit direct order — the in-flight marker for
// verbal/term-supplier orders (tickets #6, #7). Quantities come from the
// caller, never re-derived from Plan().
func (s *Service) MarkOrdered(items []OrderItem, supplier, notes, orderedBy string) (string, error) {
	now := time.Now()
	orderID := s.nextDirectOrderID()
	for _, item := range items {
		_, err := s.DB.Exec(`
			INSERT INTO direct_orders (order_id, date, stock_id, item_name, quantity, ordered_by, notes, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
		`, orderID, now.Format("2006-01-02"), item.StockID, item.Name, item.Qty, orderedBy, notes)
		if err != nil {
			return "", err
		}
	}
	return orderID, nil
}

// SupersedeDirectOrders resolves ACTIVE direct orders covered by a saved PO
// (ticket #6: the eventual PO closes the loop automatically).
func (s *Service) SupersedeDirectOrders(poID string, stockIDs []string) error {
	for _, sid := range stockIDs {
		if strings.TrimSpace(sid) == "" {
			continue
		}
		if _, err := s.DB.Exec(`
			UPDATE direct_orders SET status='SUPERSEDED', superseded_by_po=?
			WHERE status='ACTIVE' AND TRIM(stock_id)=?
		`, poID, strings.TrimSpace(sid)); err != nil {
			return err
		}
	}
	return nil
}

// MarkDelivered marks a direct order as arrived (one click when goods land).
func (s *Service) MarkDelivered(orderID string) error {
	_, err := s.DB.Exec(
		"UPDATE direct_orders SET status='DELIVERED' WHERE order_id=? AND status='ACTIVE'", orderID)
	return err
}

// CancelOrder marks a direct order as CANCELLED.
func (s *Service) CancelOrder(orderID string) error {
	_, err := s.DB.Exec(
		"UPDATE direct_orders SET status='CANCELLED' WHERE order_id=? AND status='ACTIVE'", orderID)
	return err
}

// DirectOrders returns in-flight (and recently resolved) direct orders with
// age badges data (ticket #6).
func (s *Service) DirectOrders() []DirectOrder {
	rows, _ := s.DB.Query(`
		SELECT order_id, date, ordered_by, notes, status, COALESCE(superseded_by_po,''), stock_id, item_name, quantity
		FROM direct_orders
		WHERE status IN ('ACTIVE','DELIVERED','SUPERSEDED')
		ORDER BY date DESC, order_id
	`)
	if rows == nil {
		return nil
	}
	defer rows.Close()

	type row struct {
		o    *DirectOrder
		item OrderItem
	}
	var rws []row
	orders := map[string]*DirectOrder{}
	var keys []string
	for rows.Next() {
		var oid, dateStr, status, supPo, sid, name string
		var by, notes sql.NullString
		var qty float64
		rows.Scan(&oid, &dateStr, &by, &notes, &status, &supPo, &sid, &name, &qty)

		o, ok := orders[oid]
		if !ok {
			d := parseDirectOrderDate(dateStr)
			o = &DirectOrder{OrderID: oid, Date: d, OrderedBy: strv(by), Notes: strv(notes),
				SupersededByPO: supPo, DaysOpen: int(time.Since(d).Hours() / 24)}
			orders[oid] = o
			keys = append(keys, oid)
		}
		_ = status // status is uniform per order_id in practice
		rws = append(rws, row{o, OrderItem{StockID: sid, Name: name, Qty: qty}})
	}

	out := make([]DirectOrder, 0, len(keys))
	for _, k := range keys {
		o := orders[k]
		for _, rw := range rws {
			if rw.o.OrderID == k {
				o.Items = append(o.Items, rw.item)
			}
		}
		out = append(out, *o)
	}
	return out
}

func parseDirectOrderDate(value string) time.Time {
	value = strings.TrimSpace(value)
	if len(value) > len("2006-01-02") {
		value = value[:len("2006-01-02")]
	}
	d, _ := time.Parse("2006-01-02", value)
	return d
}

func (s *Service) nextDirectOrderID() string {
	prefix := "DO-" + strconv.Itoa(time.Now().Year()) + "-"
	var maxSeq int
	rows, _ := s.DB.Query("SELECT order_id FROM direct_orders WHERE order_id LIKE ?", prefix+"%")
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var oid string
			rows.Scan(&oid)
			if seq, err := strconv.Atoi(strings.TrimPrefix(oid, prefix)); err == nil && seq > maxSeq {
				maxSeq = seq
			}
		}
	}
	return prefix + fmtPad(maxSeq+1, 3)
}

// compactItem is one entry of GAS compact JSON: {"id":"SKU","n":"name","u":"uom","q":2}
type compactItem struct {
	ID  string
	Qty float64
}

// parseCompactItems extracts id (+qty when present) entries from the GAS
// compact JSON used in rfq_logs.raw_rfq_json.
func parseCompactItems(raw string) []compactItem {
	var out []compactItem
	for _, seg := range splitObjects(raw) {
		id := jsonStringValue(seg, "id")
		if id == "" {
			continue
		}
		qty := 0.0
		if qs := jsonStringValue(seg, "q"); qs != "" {
			qty = parseFloatOr(qs, 0)
		}
		out = append(out, compactItem{ID: id, Qty: qty})
	}
	return out
}

// splitObjects splits a JSON array string into its {...} object substrings
// without full parsing. ponytail: inputs are machine-written compact JSON;
// hand-edited JSON goes through encoding/json paths instead.
func splitObjects(raw string) []string {
	var objs []string
	depth := 0
	start := -1
	for i := 0; i < len(raw); i++ {
		switch raw[i] {
		case '{':
			if depth == 0 {
				start = i
			}
			depth++
		case '}':
			depth--
			if depth == 0 && start >= 0 {
				objs = append(objs, raw[start:i+1])
				start = -1
			}
		}
	}
	return objs
}

// jsonStringValue scans one flat JSON object substring for "key":"value".
func jsonStringValue(obj, key string) string {
	pat := `"` + key + `":`
	i := strings.Index(obj, pat)
	if i < 0 {
		return ""
	}
	i += len(pat)
	for i < len(obj) && (obj[i] == ' ' || obj[i] == '"') {
		i++
	}
	start := i
	for i < len(obj) && obj[i] != '"' && obj[i] != ',' && obj[i] != '}' {
		i++
	}
	return strings.TrimRight(obj[start:i], `"`)
}

// helpers
func orZero(f sql.NullFloat64) float64 {
	if f.Valid {
		return f.Float64
	}
	return 0
}

func strv(s sql.NullString) string {
	if s.Valid {
		return s.String
	}
	return ""
}

func parseFloatOr(s string, def float64) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return def
	}
	return v
}

func fmtPad(n, width int) string {
	s := strconv.Itoa(n)
	for len(s) < width {
		s = "0" + s
	}
	return s
}
