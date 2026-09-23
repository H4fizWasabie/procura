// Linkage audit (wayfinder ticket #8): surface PO line items without a
// stock_id and let a human link them to catalogue items. Links never create.
package po

import (
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

type UnlinkedLine struct {
	LineID   int64   `json:"lineId"`
	POID     string  `json:"poId"`
	Date     string  `json:"date"`
	Supplier string  `json:"supplier"`
	ItemName string  `json:"itemName"`
	Qty      float64 `json:"qty"`
}

// UnlinkedLines returns open-PO lines with no stock_id by default; pass
// all=true to include historical lines for cleanup.
func (s *Service) UnlinkedLines(all bool) []UnlinkedLine {
	q := `
		SELECT poi.id, poi.po_id, COALESCE(po.date,''), COALESCE(po.supplier,''),
		       COALESCE(poi.item_name,''), COALESCE(poi.quantity,0)
		FROM purchase_order_items poi
		JOIN purchase_orders po ON po.po_id = poi.po_id
		WHERE TRIM(COALESCE(poi.stock_id,'')) = ''
	`
	if !all {
		q += ` AND COALESCE(po.ship_status,'') NOT IN ('Received', 'Delivered') AND COALESCE(po.status,'') != 'VOID'`
	}
	q += ` ORDER BY po.date DESC, poi.id`
	rows, err := s.DB.Query(q)
	if err != nil {
		return []UnlinkedLine{}
	}
	defer rows.Close()

	var out []UnlinkedLine
	for rows.Next() {
		var l UnlinkedLine
		var name sql.NullString
		rows.Scan(&l.LineID, &l.POID, &l.Date, &l.Supplier, &name, &l.Qty)
		l.ItemName = strv(name)
		out = append(out, l)
	}
	return out
}

// LinkLine writes stock_id onto the line item and into the PO's raw JSON
// ("id" + "stock_id" keys) so every reader sees the link immediately.
func (s *Service) LinkLine(lineID int64, stockID string) error {
	stockID = strings.TrimSpace(stockID)
	if stockID == "" {
		return errBad("stock_id required")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var poID, itemName string
	err = tx.QueryRow(
		"SELECT po_id, COALESCE(item_name,'') FROM purchase_order_items WHERE id = ?", lineID,
	).Scan(&poID, &itemName)
	if err != nil {
		return err
	}
	var position int
	if err := tx.QueryRow("SELECT COUNT(*) FROM purchase_order_items WHERE po_id = ? AND id < ?", poID, lineID).Scan(&position); err != nil {
		return err
	}
	if err := updateRawJSON(tx, poID, position, itemName, stockID); err != nil {
		return err
	}
	if _, err := tx.Exec(
		"UPDATE purchase_order_items SET stock_id = ? WHERE id = ?", stockID, lineID); err != nil {
		return err
	}
	return tx.Commit()
}

// updateRawJSON links the raw entry at the selected relational line's position.
func updateRawJSON(tx *sql.Tx, poID string, position int, itemName, stockID string) error {
	var raw sql.NullString
	if err := tx.QueryRow(
		"SELECT raw_po_json FROM purchase_orders WHERE po_id = ?", poID).Scan(&raw); err != nil {
		return err
	}
	if !raw.Valid || strings.TrimSpace(raw.String) == "" {
		return nil
	}

	var items []map[string]interface{}
	if err := json.Unmarshal([]byte(raw.String), &items); err != nil {
		return err
	}
	if position >= len(items) {
		return errBad("PO line does not match raw JSON")
	}
	it := items[position]
	name := jsonString(it, "item_name")
	if name == "" {
		name = jsonString(it, "n")
	}
	if !strings.EqualFold(strings.TrimSpace(name), strings.TrimSpace(itemName)) {
		return errBad("PO line does not match raw JSON")
	}
	it["id"] = stockID
	it["stock_id"] = stockID
	b, err := json.Marshal(items)
	if err != nil {
		return err
	}
	_, err = tx.Exec("UPDATE purchase_orders SET raw_po_json = ? WHERE po_id = ?", string(b), poID)
	return err
}

// RememberAlias records a supplier-line-name → catalogue-item mapping in
// item_aliases so future imports auto-link without human help (ticket #8).
func (s *Service) RememberAlias(stockID, itemName, createdBy string) error {
	itemName = strings.TrimSpace(itemName)
	if stockID == "" || itemName == "" {
		return nil
	}
	var canonicalName string
	s.DB.QueryRow("SELECT COALESCE(item_name,'') FROM items WHERE stock_id = ?", stockID).Scan(&canonicalName)
	_, err := s.DB.Exec(`
		INSERT INTO item_aliases (canonical_item_name, canonical_stock_id, alias_item_name, created_at, created_by, is_active)
		VALUES (?, ?, ?, ?, ?, 1)
	`, canonicalName, stockID, itemName, time.Now().Format("2006-01-02T15:04:05"), createdBy)
	return err
}

func jsonString(obj map[string]interface{}, key string) string {
	v, ok := obj[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

type strErr string

func (e strErr) Error() string { return string(e) }

func errBad(s string) error { return strErr(s) }
