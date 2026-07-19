package movement

import (
	"database/sql"
	"fmt"
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

// RecalcROP updates items.rop = avg monthly consumption * 2 from movement data.
func (s *Service) RecalcROP() int {
	res, err := s.DB.Exec(`
		UPDATE items SET rop = (
			SELECT COALESCE(AVG(out_qty + adj_out), 0) * 2
			FROM stock_movements
			WHERE stock_movements.stock_id = items.stock_id
		) WHERE rop > 0 OR rop IS NULL
	`)
	if err != nil { return 0 }
	n, _ := res.RowsAffected()
	return int(n)
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
