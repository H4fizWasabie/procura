package report

import (
	"database/sql"
	"math"
	"sort"
)

type MetricRow struct {
	SKU       string  `json:"sku"`
	Name      string  `json:"name"`
	Type      string  `json:"type"`
	Category  string  `json:"category"`
	Qty       float64 `json:"qty"`
	Cost      float64 `json:"cost"`
	TotalValue float64 `json:"totalValue"`
}

type Paginated struct {
	Data       []MetricRow `json:"data"`
	Page       int         `json:"page"`
	PageSize   int         `json:"pageSize"`
	TotalItems int         `json:"totalItems"`
	TotalPages int         `json:"totalPages"`
	TotalQty   float64     `json:"totalQty"`
	TotalValue float64     `json:"totalValue"`
}

type Service struct {
	DB *sql.DB
}

// RestockReport returns items below ROP, sorted by cost impact.
func (s *Service) RestockReport(page, pageSize int) Paginated {
	rows, _ := s.DB.Query(`
		SELECT stock_id, item_name, product_type, category, current_stock, rop, cost
		FROM items WHERE rop > 0 AND current_stock < rop AND (exclude IS NULL OR exclude = 0)
	`)
	if rows == nil { return emptyPage(page, pageSize) }
	defer rows.Close()

	var data []MetricRow
	for rows.Next() {
		var id, name, ptype, cat sql.NullString
		var cur, rop, cost sql.NullFloat64
		rows.Scan(&id, &name, &ptype, &cat, &cur, &rop, &cost)
		gap := f64v(rop) - f64v(cur)
		if gap <= 0 { continue }
		c := f64v(cost)
		data = append(data, MetricRow{
			SKU: strv(id), Name: strv(name), Type: strv(ptype), Category: strv(cat),
			Qty: math.Round(gap*100) / 100, Cost: math.Round(c*100) / 100,
			TotalValue: math.Round(gap*c*100) / 100,
		})
	}
	sort.Slice(data, func(i, j int) bool { return data[i].TotalValue > data[j].TotalValue })
	return paginate(data, page, pageSize)
}

// HistoricalReport returns closing stock or consumption for a given year/month.
func (s *Service) HistoricalReport(metricType string, year, month, page, pageSize int) Paginated {
	rows, _ := s.DB.Query(`
		SELECT sm.stock_id, sm.item_name, sm.out_qty, sm.adj_out, sm.report_closing,
		       COALESCE(i.product_type,''), COALESCE(i.category,''), COALESCE(i.cost,0)
		FROM stock_movements sm
		LEFT JOIN items i ON i.stock_id = sm.stock_id
		WHERE sm.year = ? AND sm.month = ?
	`, year, month)
	if rows == nil { return emptyPage(page, pageSize) }
	defer rows.Close()

	var data []MetricRow
	for rows.Next() {
		var id, name, ptype, cat sql.NullString
		var outQ, adjO, closing, cost sql.NullFloat64
		rows.Scan(&id, &name, &outQ, &adjO, &closing, &ptype, &cat, &cost)

		qty := f64v(closing)
		if metricType != "closing_stock" {
			qty = f64v(outQ) + f64v(adjO)
		}
		if qty <= 0 { continue }
		c := f64v(cost)
		data = append(data, MetricRow{
			SKU: strv(id), Name: strv(name), Type: strv(ptype), Category: strv(cat),
			Qty: math.Round(qty*100) / 100, Cost: math.Round(c*100) / 100,
			TotalValue: math.Round(qty*c*100) / 100,
		})
	}
	sort.Slice(data, func(i, j int) bool { return data[i].TotalValue > data[j].TotalValue })
	return paginate(data, page, pageSize)
}

// ItemHistory finds last purchase for each item from PO history.
func (s *Service) ItemHistory(items []struct{ ID, Name string }) []map[string]interface{} {
	if len(items) == 0 { return nil }
	var out []map[string]interface{}
	for _, req := range items {
		// Find most recent PO item
		row := s.DB.QueryRow(`
			SELECT po.po_id, po.date, poi.quantity, poi.cost, poi.total, poi.uom
			FROM purchase_order_items poi
			JOIN purchase_orders po ON po.po_id = poi.po_id
			WHERE LOWER(poi.item_name) = LOWER(?)
			   OR (poi.stock_id != '' AND poi.stock_id = ?)
			ORDER BY po.date DESC LIMIT 1
		`, req.Name, req.ID)

		var poID, dateStr, uom sql.NullString
		var qty, cost, total sql.NullFloat64
		err := row.Scan(&poID, &dateStr, &qty, &cost, &total, &uom)
		if err != nil {
			out = append(out, map[string]interface{}{
				"stockId": req.ID, "itemName": req.Name,
				"lastPoId": "N/A", "lastBuyDate": "Never",
			})
			continue
		}
		out = append(out, map[string]interface{}{
			"stockId": req.ID, "itemName": req.Name,
			"lastPoId": strv(poID), "lastBuyDate": strv(dateStr),
			"lastBuyQty": f64v(qty), "matchedName": req.Name,
		})
	}
	return out
}

func emptyPage(page, pageSize int) Paginated {
	return Paginated{Data: []MetricRow{}, Page: page, PageSize: pageSize}
}

func paginate(data []MetricRow, page, pageSize int) Paginated {
	if page < 1 { page = 1 }
	if pageSize < 1 { pageSize = 50 }
	total := len(data)
	totalPages := (total + pageSize - 1) / pageSize
	if totalPages < 1 { totalPages = 1 }
	start := (page - 1) * pageSize
	end := start + pageSize
	if end > total { end = total }
	if start >= total { start = 0; end = 0 }

	var totalQty, totalValue float64
	for _, d := range data {
		totalQty += d.Qty
		totalValue += d.TotalValue
	}

	return Paginated{
		Data: data[start:end], Page: page, PageSize: pageSize,
		TotalItems: total, TotalPages: totalPages,
		TotalQty: math.Round(totalQty*100) / 100,
		TotalValue: math.Round(totalValue*100) / 100,
	}
}

func strv(s sql.NullString) string { if s.Valid { return s.String }; return "" }
func f64v(f sql.NullFloat64) float64 { if f.Valid { return f.Float64 }; return 0 }
