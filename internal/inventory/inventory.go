package inventory

import (
	"bytes"
	"database/sql"
	"encoding/csv"
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
	"cost", "uom", "selling_price", "rop", "pack_size",
}

type Item struct {
	StockID       string  `json:"stock_id"`
	ItemName      string  `json:"item_name"`
	Cost          float64 `json:"cost"`
	UOM           string  `json:"uom"`
	ProductType   string  `json:"product_type"`
	Category      string  `json:"category"`
	CurrentStock  float64 `json:"current_stock"`
	ROP           float64 `json:"rop"`
	SellingPrice  float64 `json:"selling_price"`
	LastUpdated   string  `json:"last_updated"`
	PackSize      string  `json:"pack_size"`
	Exclude       string  `json:"exclude"`
	ProductStatus string  `json:"product_status"`
	VelocityOv    string  `json:"velocity_override"`
	SupplierName  string  `json:"supplier_name"`
	ItemBehaviour string  `json:"item_behaviour"`
	SupplierUOM   string  `json:"supplier_uom,omitempty"`
}

type Service struct {
	DB *sql.DB
}

// Filters apply to the full inventory before pagination or export.
type Filters struct {
	Search, StockID, Name, Supplier, Category string
	LowStock, Active                          bool
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
	if f.Active {
		where = append(where, "UPPER(TRIM(COALESCE(i.exclude,''))) NOT IN ('1','TRUE','YES','EXCLUDE') AND LOWER(TRIM(COALESCE(i.item_behaviour,''))) != 'exclude'")
	}
	order := "i.stock_id DESC"
	if f.Search != "" || f.StockID != "" || f.Name != "" {
		order = "i.item_name, i.stock_id"
	}
	query := `SELECT i.stock_id, i.item_name, i.cost, i.uom, i.product_type, i.category,
 i.current_stock, i.rop, i.selling_price, i.last_updated, i.pack_size,
 i.exclude, i.product_status, i.velocity_override, i.supplier_name, i.item_behaviour,
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

// UpdateAnchors applies anchor field edits. GAS logic: Service/Asset → ROP=0.
func (s *Service) UpdateAnchors(stockID string, updates map[string]interface{}) error {
	// Service/Asset validation: force ROP to 0
	if beh, ok := updates["item_behaviour"]; ok {
		b := strings.ToLower(stringOrEmpty(beh))
		if b == "service" || b == "asset" {
			updates["rop"] = 0
		}
	}

	sets := []string{}
	args := []interface{}{}
	for _, field := range anchorFields {
		if v, ok := updates[field]; ok {
			sets = append(sets, field+" = ?")
			args = append(args, v)
		}
	}
	if len(sets) == 0 {
		return nil
	}

	sets = append(sets, "last_updated = ?")
	args = append(args, time.Now().Format("2006-01-02T15:04:05"))
	args = append(args, stockID)

	res, err := s.DB.Exec(
		"UPDATE items SET "+strings.Join(sets, ", ")+" WHERE stock_id = ?",
		args...,
	)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
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
		var stockID, name, uom, ptype, cat, updated, pack, exclude, status, velOv, supplier, beh, supUom sql.NullString
		if err := rows.Scan(&stockID, &name, &cost, &uom, &ptype, &cat, &current, &rop,
			&selling, &updated, &pack, &exclude, &status, &velOv, &supplier, &beh, &supUom); err != nil {
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
			SupplierUOM: str(supUom),
		}
		out = append(out, it)
	}
	return out, rows.Err()
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
func stringOrEmpty(v interface{}) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
