package ximport

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

type Result struct {
	RunID     int            `json:"run_id"`
	Source    string         `json:"source"`
	TableRows map[string]int `json:"tables"`
	Rows      int            `json:"rows"`
}

type Service struct {
	DB         *sql.DB
	ImportsDir string
}

func (s *Service) Import(r io.Reader, filename string) (*Result, error) {
	os.MkdirAll(s.ImportsDir, 0755)

	f, err := excelize.OpenReader(r)
	if err != nil {
		return nil, fmt.Errorf("open xlsx: %w", err)
	}
	defer f.Close()

	now := time.Now()
	stamp := now.Format("20060102_150405")
	copiedName := strings.TrimSuffix(filename, filepath.Ext(filename)) + "_" + stamp + filepath.Ext(filename)
	copiedPath := filepath.Join(s.ImportsDir, copiedName)

	// Copy to imports dir
	src, _ := os.Create(copiedPath)
	// ponytail: skip file copy for now, just record
	src.Close()

	tableRows := map[string]int{}

	// DB_Items
	if idx, _ := f.GetSheetIndex("DB_Items"); idx != -1 {
		rows, _ := f.GetRows("DB_Items")
		if len(rows) > 1 {
			headers := normHeaders(rows[0])
			inserted := 0
			for _, row := range rows[1:] {
				r := mapRow(headers, row)
				sid := strVal(r["stock_id"])
				if sid == "" { continue }
				itemName := strVal(r["item_name"])
				currentStock := floatVal(r["current"])
				ts := now.Format("2006-01-02T15:04:05")

				var exists int
				s.DB.QueryRow("SELECT COUNT(*) FROM items WHERE stock_id = ?", sid).Scan(&exists)
				if exists > 0 {
					s.DB.Exec("UPDATE items SET item_name = CASE WHEN COALESCE(item_name,'') = '' THEN ? ELSE item_name END, current_stock = ?, last_updated = ? WHERE stock_id = ?",
						itemName, currentStock, ts, sid)
				} else {
					s.DB.Exec(`INSERT INTO items (stock_id, item_name, cost, uom, product_type, category, current_stock, last_updated, pack_size, exclude, product_status, velocity_override, supplier_name, item_behaviour) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
						sid, itemName, floatVal(r["cost"]), strVal(r["uom"]), strVal(r["product_type"]), strVal(r["category"]),
						currentStock, ts, strVal(r["pack_size"]), intVal(r["exclude"]), strVal(r["product_status"]),
						strVal(r["velocity_override"]), strVal(r["supplier"]), strVal(r["item_behaviour"]))
				}
				inserted++
			}
			tableRows["items"] = inserted
		}
	}

	// DB_Suppliers
	if idx, _ := f.GetSheetIndex("DB_Suppliers"); idx != -1 {
		rows, _ := f.GetRows("DB_Suppliers")
		if len(rows) > 1 {
			headers := normHeaders(rows[0])
			inserted := 0
			for _, row := range rows[1:] {
				r := mapRow(headers, row)
				sn := strVal(r["supplier_name"])
				if sn == "" { continue }
				s.DB.Exec(`INSERT OR REPLACE INTO suppliers (supplier_name, contact_person, phone, email, address, payment_terms, brn, account_no, bank_name) VALUES (?,?,?,?,?,?,?,?,?)`,
					sn, strVal(r["contact_person"]), strVal(r["phone"]), strVal(r["email"]), strVal(r["address"]),
					strVal(r["payment_terms"]), strVal(r["brn"]), strVal(r["account_no"]), strVal(r["bank_name"]))
				inserted++
			}
			tableRows["suppliers"] = inserted
		}
	}

	// PurchaseOrder
	if idx, _ := f.GetSheetIndex("PurchaseOrder"); idx != -1 {
		rows, _ := f.GetRows("PurchaseOrder")
		if len(rows) > 1 {
			headers := normHeaders(rows[0])
			inserted, itemRows := 0, 0
			for _, row := range rows[1:] {
				r := mapRow(headers, row)
				poID := strVal(r["po_id"])
				if poID == "" { continue }
				rawJSON := strVal(r["po_data_json"])
				s.DB.Exec(`INSERT OR REPLACE INTO purchase_orders (po_id, date, supplier, bill_no, total, paid, balance, status, ship_status, department, terms, raw_po_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
					poID, strVal(r["date"]), strVal(r["supplier"]), strVal(r["bill"]), floatVal(r["total"]), floatVal(r["paid"]),
					floatVal(r["balance"]), strVal(r["status"]), strVal(r["ship_status"]), strVal(r["dept"]), strVal(r["terms"]), rawJSON)
				inserted++
				// Parse items from JSON
				var items []map[string]interface{}
				if json.Unmarshal([]byte(rawJSON), &items) == nil {
					s.DB.Exec("DELETE FROM purchase_order_items WHERE po_id = ?", poID)
					for _, it := range items {
						s.DB.Exec("INSERT INTO purchase_order_items (po_id, item_name, quantity, cost, total, uom, stock_id) VALUES (?,?,?,?,?,?,?)",
							poID, strVal2(it["n"]), floatVal2(it["q"]), floatVal2(it["c"]), floatVal2(it["t"]), strVal2(it["u"]), strVal2(it["id"]))
						itemRows++
					}
				}
			}
			tableRows["purchase_orders"] = inserted
			tableRows["purchase_order_items"] = itemRows
		}
	}

	// Stock movements
	for _, yr := range []string{"2024","2025","2026"} {
		sheetName := "Movement " + yr
		if idx, _ := f.GetSheetIndex(sheetName); idx != -1 {
			rows, _ := f.GetRows(sheetName)
			if len(rows) > 1 {
				movCount := 0
				for _, row := range rows[1:] {
					if len(row) < 7 { continue }
					yrInt := intVal(yr)
					moInt := intVal(row[1])
					if moInt < 1 || moInt > 12 { continue }
					sid := strVal(row[0])
					s.DB.Exec("DELETE FROM stock_movements WHERE COALESCE(stock_id,'') = ? AND year = ? AND month = ?", sid, yrInt, moInt)
					s.DB.Exec("INSERT INTO stock_movements (stock_id, item_name, year, month, in_qty, out_qty, adj_in, adj_out, report_closing) VALUES (?,?,?,?,?,?,?,?,?)",
						sid, strVal(row[2]), yrInt, moInt, floatVal(row[3]), floatVal(row[4]), floatVal(row[5]), floatVal(row[6]), floatVal(row[7]))
					movCount++
				}
				tableRows["stock_movements"] = movCount
			}
		}
	}

	// Record import run
	total := 0
	for _, v := range tableRows { total += v }
	js, _ := json.Marshal(tableRows)
	res, _ := s.DB.Exec("INSERT INTO import_runs (source_file, copied_file, imported_at, row_counts_json) VALUES (?,?,?,?)",
		filename, copiedPath, now.Format("2006-01-02T15:04:05"), string(js))
	runID, _ := res.LastInsertId()
	for table, n := range tableRows {
		s.DB.Exec("INSERT INTO import_run_tables (run_id, table_name, rows_imported) VALUES (?,?,?)", runID, table, n)
	}

	return &Result{RunID: int(runID), Source: filename, TableRows: tableRows, Rows: total}, nil
}

func normHeaders(headers []string) []string {
	out := make([]string, len(headers))
	seen := map[string]int{}
	for i, h := range headers {
		h = strings.TrimSpace(h)
		key := strings.ToLower(strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') { return r }
			return '_'
		}, h))
		key = strings.Trim(key, "_")
		if key == "" { key = fmt.Sprintf("column_%d", i+1) }
		c := seen[key]; seen[key] = c+1
		if c > 0 { key = fmt.Sprintf("%s_%d", key, c+1) }
		out[i] = key
	}
	return out
}

func mapRow(headers, row []string) map[string]string {
	m := map[string]string{}
	for i, h := range headers {
		if i < len(row) { m[h] = row[i] } else { m[h] = "" }
	}
	return m
}

func strVal(s string) string { return strings.TrimSpace(s) }
func intVal(s string) int { s = strings.TrimSpace(s); n:=0; fmt.Sscanf(s, "%d", &n); return n }
func floatVal(s string) float64 { s = strings.TrimSpace(s); var f float64; fmt.Sscanf(s, "%f", &f); return f }
func strVal2(v interface{}) string { if v==nil { return "" }; if s,ok:=v.(string); ok { return s }; return "" }
func floatVal2(v interface{}) float64 {
	if v==nil { return 0 }
	switch n:=v.(type) {
	case float64: return n
	case json.Number: f,_:=n.Float64(); return f
	}
	return 0
}
