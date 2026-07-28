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
	RunID        int            `json:"run_id"`
	Source       string         `json:"source"`
	TableRows    map[string]int `json:"tables"`
	Rows         int            `json:"rows"`
	SheetsFound  []string       `json:"sheets_found"`
	HeadersFound []string       `json:"headers_found,omitempty"`
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
	var headersFound []string

	// DB_Items — try exact match first, then fall back to first sheet

	// DB_Items — try exact match first, then fall back to first sheet
	itemsSheetName, itemsSheetIdx := s.findInventorySheet(f)
	if itemsSheetIdx != -1 {
		rows, _ := f.GetRows(itemsSheetName)
		if len(rows) > 1 {
			rawHeaders := normHeaders(rows[0])
			headers := applyInventoryAliases(rawHeaders)
			headersFound = rawHeaders
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

	// Stock movements — flexible sheet matching
	movCount := s.parseMovementSheets(f, tableRows)
	if movCount > 0 {
		tableRows["stock_movements"] = movCount
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

	return &Result{RunID: int(runID), Source: filename, TableRows: tableRows, Rows: total, SheetsFound: f.GetSheetList(), HeadersFound: headersFound}, nil
}

// inventoryFieldPatterns defines target schema columns and their aliases.
// Matching uses substring containment (like GAS PARSER_CONFIG.INVENTORY_MAP).
// Order matters: first match wins. Put more specific patterns before generic ones.
var inventoryFieldPatterns = []struct {
	target   string
	patterns []string
}{
	{"stock_id", []string{"sku_code", "sku", "stock_id", "stock id", "item_code", "item code", "part_no", "part no", "part_number", "part number", "material", "item_no", "item no", "product_code", "product code"}},
	{"item_name", []string{"product_name", "product name", "item_name", "item name", "description", "desc", "product"}},
	{"product_type", []string{"product_type", "product type", "p_type", "p.type", "type"}},
	{"product_status", []string{"product_status", "product status", "status", "state", "availability"}},
	{"category", []string{"category", "cat", "group", "family"}},
	{"cost", []string{"cost_price", "cost price", "unit_cost", "unit cost", "buying_price", "buying price", "cost", "rate", "price"}},
	{"supplier", []string{"supplier_name", "supplier name", "supplier", "vendor", "mfr", "manufacturer"}},
	{"uom", []string{"uom", "unit", "measure", "pkg", "packing"}},
	{"current", []string{"actual_stock", "actual stock", "current_stock", "current stock", "current", "qty_on_hand", "qty on hand", "quantity", "qty", "balance", "on_hand", "on hand", "stock", "closing_balance", "closing balance", "closing"}},
	{"pack_size", []string{"pack_size", "pack size"}},
	{"exclude", []string{"exclude"}},
	{"velocity_override", []string{"velocity_override", "velocity override"}},
	{"item_behaviour", []string{"item_behaviour", "item behaviour"}},
}

func applyInventoryAliases(headers []string) []string {
	out := make([]string, len(headers))
	for i, h := range headers {
		// Try to match against patterns (substring match like GAS parser)
		for _, fp := range inventoryFieldPatterns {
			for _, pat := range fp.patterns {
				if strings.Contains(h, pat) {
					out[i] = fp.target
					goto next
				}
			}
		}
		// No match found, keep original header
		out[i] = h
	next:
	}
	return out
}

// findInventorySheet returns the best sheet for inventory import.
// Tries DB_Items first, then any sheet with inventory-like name, then first sheet.
func (s *Service) findInventorySheet(f *excelize.File) (string, int) {
	// Exact match
	if idx, _ := f.GetSheetIndex("DB_Items"); idx != -1 {
		return "DB_Items", idx
	}
	// Try sheets with inventory-related names
	invPatterns := []string{"item", "inventory", "stock", "balance", "product"}
	for _, sheetName := range f.GetSheetList() {
		lower := strings.ToLower(sheetName)
		for _, p := range invPatterns {
			if strings.Contains(lower, p) {
				if idx, _ := f.GetSheetIndex(sheetName); idx != -1 {
					return sheetName, idx
				}
			}
		}
	}
	// Fallback: first sheet
	if f.SheetCount > 0 {
		name := f.GetSheetName(0)
		if idx, _ := f.GetSheetIndex(name); idx != -1 {
			return name, idx
		}
	}
	return "", -1
}

// parseMovementSheets finds movement sheets and parses them in either long or wide format.
func (s *Service) parseMovementSheets(f *excelize.File, tableRows map[string]int) int {
	total := 0
	for _, sheetName := range f.GetSheetList() {
		lower := strings.ToLower(sheetName)
		if !strings.Contains(lower, "movement") {
			continue
		}
		// Extract year from sheet name (first 4-digit number)
		yr := extractYear(sheetName)
		if yr == 0 {
			continue
		}
		rows, _ := f.GetRows(sheetName)
		if len(rows) < 2 {
			continue
		}
		// Detect format: wide format has 20+ columns (2 + 12*5), long format has ~8
		if len(rows[0]) >= 20 {
			total += s.parseWideMovement(rows, yr)
		} else {
			total += s.parseLongMovement(rows, yr)
		}
	}
	return total
}

// parseWideMovement handles GAS-style wide format: one row per item, months as column blocks.
// Header row 0: Stock ID, Item Name, JANUARY(merged), FEBRUARY(merged), ...
// Header row 1: empty, empty, IN, OUT, ADJ IN, ADJ OUT, REPORT CLOSING, ...
// Data rows 2+: Stock ID, Item Name, val, val, val, val, val, ...
func (s *Service) parseWideMovement(rows [][]string, year int) int {
	if len(rows) < 3 {
		return 0
	}
	// Determine number of month blocks from header
	numMonths := (len(rows[0]) - 2) / 5
	if numMonths > 12 {
		numMonths = 12
	}
	if numMonths < 1 {
		return 0
	}
	count := 0
	for _, row := range rows[2:] {
		sid := strVal(row[0])
		if sid == "" {
			continue
		}
		itemName := ""
		if len(row) > 1 {
			itemName = strVal(row[1])
		}
		for m := 0; m < numMonths; m++ {
			base := 2 + (m * 5)
			if base+4 >= len(row) {
				break
			}
			mo := m + 1
			inQty := floatVal(row[base])
			outQty := floatVal(row[base+1])
			adjIn := floatVal(row[base+2])
			adjOut := floatVal(row[base+3])
			closing := floatVal(row[base+4])
			// Skip empty rows
			if inQty == 0 && outQty == 0 && adjIn == 0 && adjOut == 0 && closing == 0 {
				continue
			}
			s.DB.Exec("DELETE FROM stock_movements WHERE COALESCE(stock_id,'') = ? AND year = ? AND month = ?", sid, year, mo)
			s.DB.Exec("INSERT INTO stock_movements (stock_id, item_name, year, month, in_qty, out_qty, adj_in, adj_out, report_closing) VALUES (?,?,?,?,?,?,?,?,?)",
				sid, itemName, year, mo, inQty, outQty, adjIn, adjOut, closing)
			count++
		}
	}
	return count
}

// parseLongMovement handles transposed format: one row per stock_id+month, 8+ columns.
func (s *Service) parseLongMovement(rows [][]string, year int) int {
	count := 0
	for _, row := range rows[1:] {
		if len(row) < 8 {
			continue
		}
		mo := intVal(row[1])
		if mo < 1 || mo > 12 {
			continue
		}
		sid := strVal(row[0])
		if sid == "" {
			continue
		}
		s.DB.Exec("DELETE FROM stock_movements WHERE COALESCE(stock_id,'') = ? AND year = ? AND month = ?", sid, year, mo)
		s.DB.Exec("INSERT INTO stock_movements (stock_id, item_name, year, month, in_qty, out_qty, adj_in, adj_out, report_closing) VALUES (?,?,?,?,?,?,?,?,?)",
			sid, strVal(row[2]), year, mo, floatVal(row[3]), floatVal(row[4]), floatVal(row[5]), floatVal(row[6]), floatVal(row[7]))
		count++
	}
	return count
}

// extractYear returns the first 4-digit number from a string, or 0.
func extractYear(s string) int {
	for i := 0; i < len(s)-3; i++ {
		if s[i] >= '0' && s[i] <= '9' &&
			s[i+1] >= '0' && s[i+1] <= '9' &&
			s[i+2] >= '0' && s[i+2] <= '9' &&
			s[i+3] >= '0' && s[i+3] <= '9' {
			yr := 0
			fmt.Sscanf(s[i:i+4], "%d", &yr)
			if yr >= 2020 && yr <= 2030 {
				return yr
			}
		}
	}
	return 0
}

// ImportStock handles the daily Stock Balance History Report import.
// Uses fixed column positions matching the Python items_screen._import_stock_excel:
//   col 4 (D): SKU Code → matched against items.stock_id
//   col 11 (K): Actual Stock → written to items.current_stock
// Returns counts: {updated, skipped_empty, skipped_dash, errors}.
func (s *Service) ImportStock(r io.Reader) (map[string]int, error) {
	f, err := excelize.OpenReader(r)
	if err != nil {
		return nil, fmt.Errorf("open xlsx: %w", err)
	}
	defer f.Close()

	// Use active/first sheet
	if f.SheetCount == 0 {
		return nil, fmt.Errorf("no sheets in workbook")
	}
	rows, err := f.GetRows(f.GetSheetName(0))
	if err != nil {
		return nil, fmt.Errorf("read sheet: %w", err)
	}

	updated, skippedEmpty, skippedDash, errors := 0, 0, 0, 0
	for i, row := range rows {
		if i == 0 {
			continue // skip header
		}
		// col 4 (index 3): SKU Code
		sku := ""
		if len(row) > 3 {
			sku = strings.TrimSpace(row[3])
		}
		if sku == "" {
			continue
		}
		// col 11 (index 10): Actual Stock
		stockRaw := ""
		if len(row) > 10 {
			stockRaw = strings.TrimSpace(row[10])
		}
		if stockRaw == "" {
			skippedEmpty++
			continue
		}
		var stockVal int
		if stockRaw == "-" {
			stockVal = 0
			skippedDash++
		} else {
			f, err := parseFloat(stockRaw)
			if err != nil {
				errors++
				continue
			}
			stockVal = int(f)
		}
		result, err := s.DB.Exec("UPDATE items SET current_stock = ? WHERE stock_id = ?", stockVal, sku)
		if err != nil {
			errors++
			continue
		}
		n, _ := result.RowsAffected()
		if n > 0 {
			updated++
		}
	}

	return map[string]int{
		"updated":       updated,
		"skipped_empty": skippedEmpty,
		"skipped_dash":  skippedDash,
		"errors":        errors,
	}, nil
}

func parseFloat(s string) (float64, error) {
	var f float64
	_, err := fmt.Sscanf(strings.ReplaceAll(s, ",", ""), "%f", &f)
	return f, err
}

// ImportMovements handles standalone single-sheet Stock Movement Report (Sheet1, 7 columns).
func (s *Service) ImportMovements(r io.Reader, filename string, year, month int) (int, error) {
	f, err := excelize.OpenReader(r)
	if err != nil {
		return 0, fmt.Errorf("open xlsx: %w", err)
	}
	defer f.Close()

	rows, err := f.GetRows("Sheet1")
	if err != nil {
		// Try active sheet
		if f.SheetCount > 0 {
			rows, err = f.GetRows(f.GetSheetName(0))
		}
		if err != nil {
			return 0, fmt.Errorf("no Sheet1 or active sheet found")
		}
	}
	if len(rows) < 2 || len(rows[0]) < 7 {
		return 0, fmt.Errorf("expected 7 columns (SKU Code, Product Name, Purchase Qty, Sales Qty, Adj In, Adj Out, Closing), got %d", len(rows[0]))
	}

	// Delete existing rows for this year/month
	s.DB.Exec("DELETE FROM stock_movements WHERE year = ? AND month = ?", year, month)

	count := 0
	for _, row := range rows[1:] {
		if len(row) < 7 {
			continue
		}
		sid := strVal(row[0])
		if sid == "" {
			continue
		}
		s.DB.Exec(`
			INSERT INTO stock_movements (stock_id, item_name, year, month, in_qty, out_qty, adj_in, adj_out, report_closing)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, sid, strVal(row[1]), year, month, floatVal(row[2]), floatVal(row[3]), floatVal(row[4]), floatVal(row[5]), floatVal(row[6]))
		count++
	}
	return count, nil
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
