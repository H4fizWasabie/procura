package movement

import (
	"database/sql"
	"fmt"
	"math"
	"sort"
	"time"
)

type Row struct {
	StockID      string  `json:"stock_id"`
	ItemName     string  `json:"item_name"`
	Year         int     `json:"year"`
	Month        int     `json:"month"`
	InQty        float64 `json:"in_qty"`
	OutQty       float64 `json:"out_qty"`
	AdjIn        float64 `json:"adj_in"`
	AdjOut       float64 `json:"adj_out"`
	ReportClosing float64 `json:"report_closing"`
}

type Service struct {
	DB *sql.DB
}

// List returns movement data filtered by year/month/search.
func (s *Service) List(year, month int, search string, limit int) []Row {
	where := []string{"1=1"}
	args := []interface{}{}
	if year > 0 {
		where = append(where, "year = ?")
		args = append(args, year)
	}
	if month > 0 {
		where = append(where, "month = ?")
		args = append(args, month)
	}
	if search != "" {
		where = append(where, "(stock_id LIKE ? OR item_name LIKE ?)")
		term := "%" + search + "%"
		args = append(args, term, term)
	}
	if limit <= 0 { limit = 500 }
	args = append(args, limit)

	query := `
		SELECT stock_id, item_name, year, month, in_qty, out_qty, adj_in, adj_out, report_closing
		FROM stock_movements
		WHERE ` + join(where, " AND ") + `
		ORDER BY year DESC, month DESC, stock_id LIMIT ?
	`
	rows, err := s.DB.Query(query, args...)
	if err != nil { return []Row{} }
	defer rows.Close()

	var out []Row
	for rows.Next() {
		var r Row
		var sid, name sql.NullString
		var in, outQ, ai, ao, rc sql.NullFloat64
		rows.Scan(&sid, &name, &r.Year, &r.Month, &in, &outQ, &ai, &ao, &rc)
		r.StockID = strv(sid)
		r.ItemName = strv(name)
		r.InQty = f64v(in)
		r.OutQty = f64v(outQ)
		r.AdjIn = f64v(ai)
		r.AdjOut = f64v(ao)
		r.ReportClosing = f64v(rc)
		out = append(out, r)
	}
	return out
}

// Years returns distinct years in movement data.
func (s *Service) Years() []int {
	rows, _ := s.DB.Query("SELECT DISTINCT year FROM stock_movements ORDER BY year DESC")
	if rows == nil { return []int{} }
	defer rows.Close()
	out := []int{}
	for rows.Next() {
		var y int; rows.Scan(&y); out = append(out, y)
	}
	return out
}

// RecalcROP mirrors GAS autoCalculateROP v3:
//   - Weighted velocity from monthly usage (out_qty + adj_out)
//   - Recency buckets: 0-2mo 50%, 3-5mo 30%, 6+mo 20%
//   - ROP = CEIL(weighted_velocity * 2)
//   - Respects velocity_override and excludes Service/Excluded items.
func (s *Service) RecalcROP() int {
	// 1. Fetch movement data: stock_id, year, month, usage (out + adj_out)
	cutoff := time.Now().AddDate(0, -36, 0) // 36-month lookback
	rows, err := s.DB.Query(`
		SELECT COALESCE(stock_id,''), year, month,
		       COALESCE(out_qty,0) + COALESCE(adj_out,0) AS usage
		FROM stock_movements
		WHERE (year > ? OR (year = ? AND month >= ?))
		ORDER BY stock_id, year, month
	`, cutoff.Year(), cutoff.Year(), int(cutoff.Month()))
	if err != nil {
		return 0
	}
	defer rows.Close()

	type monthlyUsage struct {
		year, month int
		usage       float64
	}
	usageMap := map[string][]monthlyUsage{}
	for rows.Next() {
		var sid string
		var mu monthlyUsage
		rows.Scan(&sid, &mu.year, &mu.month, &mu.usage)
		usageMap[sid] = append(usageMap[sid], mu)
	}

	// 2. Fetch all items (stock_id, rop, exclude, item_behaviour, velocity_override)
	itemRows, err := s.DB.Query(`
		SELECT stock_id, COALESCE(rop,0), COALESCE(exclude,''),
		       COALESCE(item_behaviour,''), COALESCE(velocity_override,0)
		FROM items
	`)
	if err != nil {
		return 0
	}
	defer itemRows.Close()

	type itemRec struct {
		id       string
		currROP  float64
		exclude  string
		beh      string
		velOv    float64
	}
	var items []itemRec
	for itemRows.Next() {
		var it itemRec
		itemRows.Scan(&it.id, &it.currROP, &it.exclude, &it.beh, &it.velOv)
		items = append(items, it)
	}

	// 3. Compute ROP per item
	now := time.Now()
	currentYearMonth := now.Year()*12 + int(now.Month()) - 1

	buckets := []struct {
		from, to, weight float64
	}{
		{0, 2, 0.50},
		{3, 5, 0.30},
		{6, 35, 0.20},
	}

	updated := 0
	for _, it := range items {
		newROP := 0.0

		// Skip: service / exclude
		beh := it.beh
		excl := it.exclude
		if beh == "Service" || excl == "TRUE" || excl == "YES" || excl == "EXCLUDE" || excl == "1" {
			newROP = 0
		} else if it.velOv > 0 {
			// Velocity override
			newROP = math.Ceil(it.velOv * 2)
		} else {
			// Weighted velocity from movement history
			usages := usageMap[it.id]
			if len(usages) > 0 {
				// Compute monthsAgo for each data point
				type point struct {
					monthsAgo int
					usage     float64
				}
				var points []point
				lifecycleStart := -1
				for _, mu := range usages {
					ym := mu.year*12 + mu.month - 1
					monthsAgo := currentYearMonth - ym
					if monthsAgo < 0 {
						continue // future data, skip
					}
					isActive := mu.usage > 0
					points = append(points, point{monthsAgo, mu.usage})
					if isActive && monthsAgo > lifecycleStart {
						lifecycleStart = monthsAgo
					}
				}

				if lifecycleStart >= 0 && len(points) > 0 {
					// Only include months within lifecycle
					var activePoints []point
					for _, p := range points {
						if p.monthsAgo <= lifecycleStart {
							activePoints = append(activePoints, p)
						}
					}

					// Sort by monthsAgo for weighted calculation
					sort.Slice(activePoints, func(i, j int) bool {
						return activePoints[i].monthsAgo < activePoints[j].monthsAgo
					})

					totalWV, totalW := 0.0, 0.0
					for _, b := range buckets {
						sum, count := 0.0, 0
						for _, p := range activePoints {
							if float64(p.monthsAgo) >= b.from && float64(p.monthsAgo) <= b.to {
								sum += p.usage
								count++
							}
						}
						if count > 0 {
							avg := sum / float64(count)
							totalWV += avg * b.weight
							totalW += b.weight
						}
					}
					if totalW > 0 {
						velocity := totalWV / totalW
						newROP = math.Ceil(velocity * 2)
					}
				}
			}
		}

		// Only update if ROP changed
		if newROP != it.currROP {
			s.DB.Exec("UPDATE items SET rop = ? WHERE stock_id = ?", newROP, it.id)
			updated++
		}
	}

	return updated
}

func strv(s sql.NullString) string { if s.Valid { return s.String }; return "" }
func f64v(f sql.NullFloat64) float64 { if f.Valid { return f.Float64 }; return 0 }
func itoa(n int) string { return fmt.Sprintf("%d", n) }
// TimelineItem is one data point for a single stock item's monthly history.
type TimelineItem struct {
	Year    int     `json:"year"`
	Month   int     `json:"month"`
	Label   string  `json:"label"`
	In      float64 `json:"in"`
	Out     float64 `json:"out"`
	AdjIn   float64 `json:"adjIn"`
	AdjOut  float64 `json:"adjOut"`
	Closing float64 `json:"closing"`
}

// ItemDetail holds cost/selling price for profit calculation.
type ItemDetail struct {
	StockID      string  `json:"stock_id"`
	ItemName     string  `json:"item_name"`
	Category     string  `json:"category"`
	Cost         float64 `json:"cost"`
	SellingPrice float64 `json:"selling_price"`
}

// BulkRow is a single movement row for bulk upload.
type BulkRow struct {
	StockID  string  `json:"stock_id"`
	ItemName string  `json:"item_name"`
	In       float64 `json:"in"`
	Out      float64 `json:"out"`
	AdjIn    float64 `json:"adj_in"`
	AdjOut   float64 `json:"adj_out"`
	Closing  float64 `json:"closing"`
}

// Timeline returns monthly movement history for a stock item.
func (s *Service) Timeline(stockID string) []TimelineItem {
	rows, err := s.DB.Query(`
		SELECT year, month, in_qty, out_qty, adj_in, adj_out, report_closing
		FROM stock_movements
		WHERE stock_id = ?
		ORDER BY year, month
	`, stockID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	months := []string{"Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"}
	var out []TimelineItem
	for rows.Next() {
		var y, m int
		var in, outQ, ai, ao, rc sql.NullFloat64
		rows.Scan(&y, &m, &in, &outQ, &ai, &ao, &rc)
		out = append(out, TimelineItem{
			Year: y, Month: m,
			Label:   months[m-1] + " " + itoa(y),
			In:      f64v(in),
			Out:     f64v(outQ),
			AdjIn:   f64v(ai),
			AdjOut:  f64v(ao),
			Closing: f64v(rc),
		})
	}
	return out
}

// ItemDetail returns cost/selling info for one item.
func (s *Service) ItemDetail(stockID string) (ItemDetail, bool) {
	var d ItemDetail
	var cost, sp sql.NullFloat64
	var name, cat sql.NullString
	err := s.DB.QueryRow(`
		SELECT stock_id, item_name, category, cost, selling_price
		FROM items WHERE stock_id = ?
	`, stockID).Scan(&d.StockID, &name, &cat, &cost, &sp)
	if err != nil {
		return d, false
	}
	d.ItemName = strv(name)
	d.Category = strv(cat)
	d.Cost = f64v(cost)
	d.SellingPrice = f64v(sp)
	return d, true
}

// BulkSave inserts or replaces movement rows for a given year/month.
func (s *Service) BulkSave(year, month int, rows []BulkRow) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	tx.Exec("DELETE FROM stock_movements WHERE year = ? AND month = ?", year, month)

	stmt, err := tx.Prepare(`
		INSERT INTO stock_movements (stock_id, item_name, year, month, in_qty, out_qty, adj_in, adj_out, report_closing)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, r := range rows {
		_, err := stmt.Exec(r.StockID, r.ItemName, year, month, r.In, r.Out, r.AdjIn, r.AdjOut, r.Closing)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func join(ss []string, sep string) string {
	r := ""
	for i, s := range ss {
		if i > 0 { r += sep }
		r += s
	}
	return r
}
