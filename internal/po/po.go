package po

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type PO struct {
	POID       string  `json:"po_id"`
	Date       string  `json:"date"`
	Supplier   string  `json:"supplier"`
	BillNo     string  `json:"bill_no"`
	Total      float64 `json:"total"`
	Paid       float64 `json:"paid"`
	Balance    float64 `json:"balance"`
	Status     string  `json:"status"`
	ShipStatus string  `json:"ship_status"`
	Department string  `json:"department"`
	Terms      string  `json:"terms"`
	InvoiceDate string `json:"invoice_date"`
	Items      []Item  `json:"items"`
}

type Item struct {
	StockID     string  `json:"stock_id"`
	Name        string  `json:"item_name"`
	Qty         float64 `json:"quantity"`
	Cost        float64 `json:"cost"`
	Total       float64 `json:"total"`
	UOM         string  `json:"uom"`
	SupplierUOM string  `json:"supplier_uom"`
}

func (it *Item) UnmarshalJSON(data []byte) error {
	// Detect GAS legacy short-format keys (id/n/q/c/t/u or n/q/c/t/u)
	var probe map[string]json.RawMessage
	json.Unmarshal(data, &probe)
	_, hasID := probe["id"]
	_, hasN := probe["n"]
	if hasID || hasN {
		var si struct {
			StockID string  `json:"id"`
			Name    string  `json:"n"`
			Qty     float64 `json:"q"`
			Cost    float64 `json:"c"`
			Total   float64 `json:"t"`
			UOM     string  `json:"u"`
		}
		json.Unmarshal(data, &si)
		it.StockID = si.StockID
		it.Name = si.Name
		it.Qty = si.Qty
		it.Cost = si.Cost
		it.Total = si.Total
		it.UOM = si.UOM
		return nil
	}
	// Go long-format — use type alias to avoid recursion
	type ItemAlias Item
	var ai ItemAlias
	if err := json.Unmarshal(data, &ai); err != nil {
		return err
	}
	*it = Item(ai)
	return nil
}

type Service struct {
	DB *sql.DB
}

// List returns POs filtered by search/supplier/status/unpaid. Max 200 rows.
func (s *Service) List(search, supplier, status, shipStatus string, unpaidOnly bool) []PO {
	where := []string{"1=1"}
	args := []interface{}{}
	if search != "" {
		where = append(where, "(LOWER(po_id) LIKE ? OR LOWER(supplier) LIKE ? OR LOWER(COALESCE(bill_no,'')) LIKE ?)")
		term := "%" + strings.ToLower(search) + "%"
		args = append(args, term, term, term)
	}
	if supplier != "" {
		where = append(where, "supplier = ?")
		args = append(args, supplier)
	}
	if status != "" {
		where = append(where, "status = ?")
		args = append(args, status)
	}
	if shipStatus != "" {
		where = append(where, "ship_status = ?")
		args = append(args, shipStatus)
	}
	if unpaidOnly {
		where = append(where, "COALESCE(balance, total - COALESCE(paid,0)) > 0")
	}

	rows, err := s.DB.Query(`
		SELECT po_id, date, supplier, bill_no, total, paid, balance,
		       status, ship_status, department, terms, invoice_date, raw_po_json
		FROM purchase_orders
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY date DESC, po_id DESC LIMIT 200
	`, args...)
	if err != nil {
		return []PO{}
	}
	defer rows.Close()

	var out []PO
	for rows.Next() {
		var p PO
		var rawJSON sql.NullString
		var date, bill, dep, terms, invDate, sup, st, ship sql.NullString
		var total, paid, balance sql.NullFloat64
		rows.Scan(&p.POID, &date, &sup, &bill, &total, &paid, &balance,
			&st, &ship, &dep, &terms, &invDate, &rawJSON)
		p.Date = strv(date)
		p.Supplier = strv(sup)
		p.BillNo = strv(bill)
		p.Total = f64v(total)
		p.Paid = f64v(paid)
		p.Balance = f64v(balance)
		p.Status = strv(st)
		p.ShipStatus = strv(ship)
		p.Department = strv(dep)
		p.Terms = strv(terms)
		p.InvoiceDate = strv(invDate)
		if rawJSON.Valid {
			json.Unmarshal([]byte(rawJSON.String), &p.Items)
		}
		out = append(out, p)
	}
	return out
}

// GenerateID creates next PO ID in format "PO - MMYYYY - NNN".
func (s *Service) GenerateID() string {
	now := time.Now()
	prefix := "PO - " + now.Format("012006") + " - "
	var maxSeq int
	rows, _ := s.DB.Query("SELECT po_id FROM purchase_orders WHERE po_id LIKE ?", prefix+"%")
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var id string
			rows.Scan(&id)
			id = strings.TrimPrefix(id, prefix)
			var n int
			fmt.Sscanf(id, "%d", &n)
			if n > maxSeq {
				maxSeq = n
			}
		}
	}
	return prefix + fmt.Sprintf("%03d", maxSeq+1)
}

// Save creates or updates a PO with its items.
func (s *Service) Save(p PO) (string, error) {
	isNew := p.POID == ""
	if isNew {
		p.POID = s.GenerateID()
	}

	// Block duplicate invoice numbers
	if strings.TrimSpace(p.BillNo) != "" {
		var existing string
		s.DB.QueryRow("SELECT po_id FROM purchase_orders WHERE bill_no = ? AND po_id != ? LIMIT 1",
			p.BillNo, p.POID).Scan(&existing)
		if existing != "" {
			return "", fmt.Errorf("invoice number %s already used by %s", p.BillNo, existing)
		}
	}

	p.Total = 0
	for _, it := range p.Items {
		it.Total = it.Qty * it.Cost
		p.Total += it.Total
	}

	itemsJSON, _ := json.Marshal(p.Items)

	_, err := s.DB.Exec(`
		INSERT OR REPLACE INTO purchase_orders
			(po_id, date, supplier, bill_no, total, status, ship_status, department, terms, invoice_date, raw_po_json)
		VALUES (?, ?, ?, ?, ?, COALESCE(?, 'Pending Approval'), COALESCE(?, 'Pending'),
		        ?, ?, ?, ?)
	`, p.POID, p.Date, p.Supplier, p.BillNo, p.Total, p.Status, p.ShipStatus,
		p.Department, p.Terms, p.InvoiceDate, string(itemsJSON))
	if err != nil {
		return "", err
	}

	// Replace items
	s.DB.Exec("DELETE FROM purchase_order_items WHERE po_id = ?", p.POID)
	for _, it := range p.Items {
		s.DB.Exec(`
			INSERT INTO purchase_order_items (po_id, item_name, quantity, cost, total, uom, stock_id, supplier_uom)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`, p.POID, it.Name, it.Qty, it.Cost, it.Total, it.UOM, it.StockID, it.SupplierUOM)
	}

	return p.POID, nil
}

// UpdateStatus sets PO status or ship_status.
func (s *Service) UpdateStatus(poID, newStatus, field string) error {
	col := "status"
	if field == "ship" {
		col = "ship_status"
	}
	_, err := s.DB.Exec("UPDATE purchase_orders SET "+col+" = ? WHERE po_id = ?", newStatus, poID)
	return err
}

// Void marks a PO as VOID.
func (s *Service) Void(poID string) error {
	return s.UpdateStatus(poID, "VOID", "status")
}

// GetByID returns a single PO with items.
func (s *Service) GetByID(poID string) (PO, error) {
	var p PO
	var date, bill, dep, terms, invDate, sup, st, ship sql.NullString
	var total, paid, balance sql.NullFloat64
	var rawJSON sql.NullString
	err := s.DB.QueryRow(`
		SELECT po_id, date, supplier, bill_no, total, paid, balance,
		       status, ship_status, department, terms, invoice_date, raw_po_json
		FROM purchase_orders WHERE po_id = ?
	`, poID).Scan(&p.POID, &date, &sup, &bill, &total, &paid, &balance,
		&st, &ship, &dep, &terms, &invDate, &rawJSON)
	if err != nil {
		return p, err
	}
	p.Date = strv(date)
	p.Supplier = strv(sup)
	p.BillNo = strv(bill)
	p.Total = f64v(total)
	p.Paid = f64v(paid)
	p.Balance = f64v(balance)
	p.Status = strv(st)
	p.ShipStatus = strv(ship)
	p.Department = strv(dep)
	p.Terms = strv(terms)
	p.InvoiceDate = strv(invDate)
	if rawJSON.Valid {
		json.Unmarshal([]byte(rawJSON.String), &p.Items)
	}
	return p, nil
}

// FilterOptions returns distinct suppliers, statuses, ship_statuses for dropdowns.
func (s *Service) FilterOptions() ([]string, []string, []string) {
	var suppliers, statuses, ships []string
	rows, _ := s.DB.Query("SELECT DISTINCT supplier FROM purchase_orders WHERE supplier != '' ORDER BY supplier")
	if rows != nil {
		defer rows.Close()
		for rows.Next() { var v string; rows.Scan(&v); suppliers = append(suppliers, v) }
	}
	rows, _ = s.DB.Query("SELECT DISTINCT status FROM purchase_orders WHERE status != '' ORDER BY status")
	if rows != nil {
		defer rows.Close()
		for rows.Next() { var v string; rows.Scan(&v); statuses = append(statuses, v) }
	}
	rows, _ = s.DB.Query("SELECT DISTINCT ship_status FROM purchase_orders WHERE ship_status != '' ORDER BY ship_status")
	if rows != nil {
		defer rows.Close()
		for rows.Next() { var v string; rows.Scan(&v); ships = append(ships, v) }
	}
	return suppliers, statuses, ships
}

// helpers
func strv(s sql.NullString) string { if s.Valid { return s.String }; return "" }
func f64v(f sql.NullFloat64) float64 { if f.Valid { return f.Float64 }; return 0 }
