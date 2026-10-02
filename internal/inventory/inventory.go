package inventory

import (
	"bytes"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

// Anchor fields that can be edited (matches GAS apiSaveInventoryItem).
var anchorFields = []string{
	"exclude", "velocity_override", "item_behaviour",
	"cost", "uom", "selling_price", "rop", "pack_size", "purchase_policy",
}

var ErrInvalidUpdate = errors.New("invalid inventory update")

type Item struct {
	StockID        string  `json:"stock_id"`
	ItemName       string  `json:"item_name"`
	Cost           float64 `json:"cost"`
	UOM            string  `json:"uom"`
	ProductType    string  `json:"product_type"`
	Category       string  `json:"category"`
	CurrentStock   float64 `json:"current_stock"`
	ROP            float64 `json:"rop"`
	SellingPrice   float64 `json:"selling_price"`
	LastUpdated    string  `json:"last_updated"`
	PackSize       string  `json:"pack_size"`
	Exclude        string  `json:"exclude"`
	ProductStatus  string  `json:"product_status"`
	VelocityOv     string  `json:"velocity_override"`
	SupplierName   string  `json:"supplier_name"`
	ItemBehaviour  string  `json:"item_behaviour"`
	PurchasePolicy *string `json:"purchase_policy"`
	SupplierUOM    string  `json:"supplier_uom,omitempty"`
}

type Service struct {
	DB *sql.DB
}

// Filters apply to the full inventory before pagination or export.
type Filters struct {
	Search, StockID, Name, Supplier, Category string
	LowStock, Active, Unclassified            bool
}

func (s *Service) List(search string, page, pageSize int) []Item {
	if pageSize < 1 {
		pageSize = 50
	}
	items, _ := s.ListFiltered(Filters{Search: search}, page, pageSize)
	if pageSize > 0 && len(items) > pageSize {
		items = items[:pageSize]
	}
	return items
}

// ListFiltered includes one extra row when paginated, so callers can detect a next page.
func (s *Service) ListFiltered(f Filters, page, pageSize int) ([]Item, error) {
	where := []string{"1=1"}
	args := []interface{}{}
	if f.Search != "" {
		where = append(where, "(LOWER(COALESCE(i.stock_id,'')) LIKE ? OR LOWER(COALESCE(i.item_name,'')) LIKE ? OR LOWER(COALESCE(i.supplier_name,'')) LIKE ?)")
		term := "%" + strings.ToLower(f.Search) + "%"
		args = append(args, term, term, term)
	}
	for _, filter := range []struct{ column, value string }{{"stock_id", f.StockID}, {"item_name", f.Name}} {
		if filter.value != "" {
			where = append(where, "LOWER(COALESCE(i."+filter.column+",'')) LIKE ?")
			args = append(args, "%"+strings.ToLower(filter.value)+"%")
		}
	}
	for _, filter := range []struct{ column, value string }{{"supplier_name", f.Supplier}, {"category", f.Category}} {
		if filter.value != "" {
			where = append(where, "i."+filter.column+" = ?")
			args = append(args, filter.value)
		}
	}
	if f.LowStock {
		where = append(where, "COALESCE(i.current_stock,0) <= COALESCE(i.rop,0) AND COALESCE(i.rop,0) > 0")
	}
	if f.Active && !f.Unclassified {
		where = append(where, "UPPER(TRIM(COALESCE(i.exclude,''))) NOT IN ('1','TRUE','YES','EXCLUDE') AND LOWER(TRIM(COALESCE(i.item_behaviour,''))) != 'exclude'")
	}
	if f.Unclassified {
		where = append(where, "i.purchase_policy IS NULL")
	}
	order := "i.stock_id DESC"
	if f.Search != "" || f.StockID != "" || f.Name != "" {
		order = "i.item_name, i.stock_id"
	}
	query := `SELECT i.stock_id, i.item_name, i.cost, i.uom, i.product_type, i.category,
 i.current_stock, i.rop, i.selling_price, i.last_updated, i.pack_size,
	 i.exclude, i.product_status, i.velocity_override, i.supplier_name, i.item_behaviour, i.purchase_policy,
 COALESCE((SELECT m.supplier_uom FROM supplier_item_mappings m
 WHERE m.stock_id = i.stock_id AND m.supplier_name = i.supplier_name ORDER BY m.id LIMIT 1), '')
 FROM items i WHERE ` + strings.Join(where, " AND ") + " ORDER BY " + order
	if pageSize > 0 {
		if page < 1 {
			page = 1
		}
		query += " LIMIT ? OFFSET ?"
		args = append(args, pageSize+1, (page-1)*pageSize)
	}
	rows, err := s.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanItems(rows)
}

// Export includes all matching rows, independent of the current page.
func (s *Service) Export(f Filters, format string) ([]byte, error) {
	items, err := s.ListFiltered(f, 1, 0)
	if err != nil {
		return nil, err
	}
	headings := []string{"Stock ID", "Item Name", "Supplier", "Sup.UOM", "Type", "Status", "UOM", "Cost", "Selling", "Stock", "ROP", "Behaviour", "Excluded"}
	rows := [][]string{headings}
	for _, it := range items {
		rows = append(rows, []string{it.StockID, it.ItemName, it.SupplierName, it.SupplierUOM, it.ProductType, it.ProductStatus, it.UOM,
			strconv.FormatFloat(it.Cost, 'f', 2, 64), strconv.FormatFloat(it.SellingPrice, 'f', 2, 64), strconv.FormatFloat(it.CurrentStock, 'f', -1, 64), strconv.FormatFloat(it.ROP, 'f', -1, 64), it.ItemBehaviour, it.Exclude})
	}
	if format == "csv" {
		var buf bytes.Buffer
		writer := csv.NewWriter(&buf)
		if err := writer.WriteAll(rows); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	}
	if format != "xlsx" {
		return nil, fmt.Errorf("format must be csv or xlsx")
	}
	book := excelize.NewFile()
	defer book.Close()
	for index, row := range rows {
		values := make([]interface{}, len(row))
		for col, val := range row {
			values[col] = val
		}
		if index > 0 {
			for _, col := range []int{7, 8, 9, 10} {
				values[col], _ = strconv.ParseFloat(row[col], 64)
			}
		}
		if err := book.SetSheetRow("Sheet1", fmt.Sprintf("A%d", index+1), &values); err != nil {
			return nil, err
		}
	}
	buf, err := book.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

var anchorValidation = map[string]func(interface{}) (interface{}, error){
	"item_behaviour": func(v interface{}) (interface{}, error) {
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("allowed values: Standard / Pack, In-House Use, Service, Unavailable, Asset")
		}
		s = strings.TrimSpace(s)
		for _, allowed := range []string{"Standard / Pack", "In-House Use", "Service", "Unavailable", "Asset"} {
			if s == allowed {
				return s, nil
			}
		}
		return nil, fmt.Errorf("allowed values: Standard / Pack, In-House Use, Service, Unavailable, Asset")
	},
	"exclude": func(v interface{}) (interface{}, error) {
		n, err := nonNegativeNumber(v)
		if err != nil || (n != 0 && n != 1) {
			return nil, fmt.Errorf("allowed values: 0 or 1")
		}
		return int(n), nil
	},
	"rop":               validateNonNegative,
	"velocity_override": validateNonNegative,
	"cost":              validateNonNegative,
	"selling_price":     validateNonNegative,
	"uom": func(v interface{}) (interface{}, error) {
		s, ok := v.(string)
		if !ok || strings.TrimSpace(s) == "" {
			return nil, fmt.Errorf("must be non-empty text")
		}
		return strings.TrimSpace(s), nil
	},
	"pack_size": func(v interface{}) (interface{}, error) {
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("must be text (empty is allowed)")
		}
		return strings.TrimSpace(s), nil
	},
	"purchase_policy": func(v interface{}) (interface{}, error) {
		if v == nil {
			return nil, nil
		}
		s, ok := v.(string)
		if ok {
			s = strings.TrimSpace(s)
		}
		for _, allowed := range []string{"routine", "on_demand", "do_not_reorder"} {
			if ok && s == allowed {
				return s, nil
			}
		}
		return nil, fmt.Errorf("allowed values: routine, on_demand, do_not_reorder, or NULL (unclassified)")
	},
}

func validateNonNegative(v interface{}) (interface{}, error) {
	n, err := nonNegativeNumber(v)
	if err != nil {
		return nil, fmt.Errorf("must be a number greater than or equal to 0")
	}
	return n, nil
}

func nonNegativeNumber(v interface{}) (float64, error) {
	var n float64
	switch value := v.(type) {
	case float64:
		n = value
	case float32:
		n = float64(value)
	case int:
		n = float64(value)
	case int64:
		n = float64(value)
	case json.Number:
		parsed, err := value.Float64()
		if err != nil {
			return 0, err
		}
		n = parsed
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err != nil {
			return 0, err
		}
		n = parsed
	default:
		return 0, fmt.Errorf("not a number")
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
		return 0, fmt.Errorf("out of range")
	}
	return n, nil
}

// UpdateAnchors validates, updates and audits all changed fields atomically.
func (s *Service) UpdateAnchors(stockID, changedBy, reason string, updates map[string]interface{}) error {
	reason = strings.TrimSpace(reason)
	changedBy = strings.TrimSpace(changedBy)
	if reason == "" || changedBy == "" {
		return fmt.Errorf("%w: changed_by and reason are required", ErrInvalidUpdate)
	}
	for field := range updates {
		if _, ok := anchorValidation[field]; !ok {
			return fmt.Errorf("%w: unknown field %q; editable fields: %s (reason is also allowed)", ErrInvalidUpdate, field, strings.Join(anchorFields, ", "))
		}
	}
	validated := make(map[string]interface{}, len(updates))
	for _, field := range anchorFields {
		if value, ok := updates[field]; ok {
			rule := anchorValidation[field]
			value, err := rule(value)
			if err != nil {
				return fmt.Errorf("%w: %s %v", ErrInvalidUpdate, field, err)
			}
			validated[field] = value
		}
	}

	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var itemName sql.NullString
	values := make([]interface{}, len(anchorFields))
	query := "SELECT item_name, " + strings.Join(anchorFields, ", ") + " FROM items WHERE stock_id = ?"
	scanArgs := make([]interface{}, 0, len(anchorFields)+1)
	scanArgs = append(scanArgs, &itemName)
	for i := range values {
		scanArgs = append(scanArgs, &values[i])
	}
	if err := tx.QueryRow(query, stockID).Scan(scanArgs...); err != nil {
		return err
	}
	oldValues := make(map[string]interface{}, len(anchorFields))
	for i, field := range anchorFields {
		oldValues[field] = values[i]
	}
	behaviour, behaviourSubmitted := validated["item_behaviour"].(string)
	if !behaviourSubmitted {
		behaviour = fmt.Sprint(oldValues["item_behaviour"])
	}
	if behaviour == "Service" || behaviour == "Asset" {
		validated["rop"] = float64(0)
	}

	sets, args := make([]string, 0, len(validated)), make([]interface{}, 0, len(validated)+1)
	changed := make([]string, 0, len(validated))
	for _, field := range anchorFields {
		value, ok := validated[field]
		if !ok || anchorValuesEqual(oldValues[field], value) {
			continue
		}
		sets = append(sets, field+" = ?")
		args = append(args, value)
		changed = append(changed, field)
	}
	if len(changed) == 0 {
		return tx.Commit()
	}
	args = append(args, stockID)
	if _, err := tx.Exec("UPDATE items SET "+strings.Join(sets, ", ")+" WHERE stock_id = ?", args...); err != nil {
		return err
	}
	now := time.Now().Format("2006-01-02T15:04:05")
	for _, field := range changed {
		if _, err := tx.Exec(`INSERT INTO item_anchor_audit
			(timestamp, stock_id, item_name, field_name, old_value, new_value, reason, changed_by)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, now, stockID, itemName, field,
			auditValue(oldValues[field]), auditValue(validated[field]), reason, changedBy); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func auditValue(v interface{}) string {
	if v == nil {
		return ""
	}
	if value, ok := v.(float64); ok {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	if value, ok := v.(float32); ok {
		return strconv.FormatFloat(float64(value), 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

func anchorValuesEqual(old, next interface{}) bool {
	if old == nil {
		return next == nil
	}
	if n, err := nonNegativeNumber(old); err == nil {
		if nextN, err := nonNegativeNumber(next); err == nil {
			return n == nextN
		}
	}
	return fmt.Sprint(old) == fmt.Sprint(next)
}

// BasicList returns ID + Name for dropdowns. Excludes Unavailable items.
func (s *Service) BasicList() []map[string]string {
	rows, _ := s.DB.Query(`
		SELECT stock_id, item_name, category, COALESCE(uom,''), COALESCE(supplier_name,'')
		FROM items
		WHERE COALESCE(product_status,'') != 'Unavailable'
		ORDER BY item_name
	`)
	defer rows.Close()
	var out []map[string]string
	for rows.Next() {
		var id, name, cat, uom, sup string
		rows.Scan(&id, &name, &cat, &uom, &sup)
		out = append(out, map[string]string{"Stock ID": id, "Item Name": name, "Category": cat, "UOM": uom, "Supplier": sup})
	}
	return out
}

func scanItems(rows *sql.Rows) ([]Item, error) {
	out := []Item{}
	for rows.Next() {
		var it Item
		var cost, current, rop, selling sql.NullFloat64
		var stockID, name, uom, ptype, cat, updated, pack, exclude, status, velOv, supplier, beh, supUom, policy sql.NullString
		if err := rows.Scan(&stockID, &name, &cost, &uom, &ptype, &cat, &current, &rop,
			&selling, &updated, &pack, &exclude, &status, &velOv, &supplier, &beh, &policy, &supUom); err != nil {
			return nil, err
		}

		it = Item{
			StockID: str(stockID), ItemName: str(name),
			Cost: f64(cost), UOM: str(uom),
			ProductType: str(ptype), Category: str(cat),
			CurrentStock: round(f64(current)), ROP: round(f64(rop)),
			SellingPrice: f64(selling), LastUpdated: str(updated),
			PackSize: str(pack), Exclude: str(exclude),
			ProductStatus: str(status), VelocityOv: str(velOv),
			SupplierName: str(supplier), ItemBehaviour: str(beh),
			PurchasePolicy: nullableString(policy),
			SupplierUOM:    str(supUom),
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

func nullableString(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

func str(s sql.NullString) string {
	if s.Valid {
		return s.String
	}
	return ""
}
func f64(f sql.NullFloat64) float64 {
	if f.Valid {
		return f.Float64
	}
	return 0
}
func round(f float64) float64 { return math.Round(f*100) / 100 }
