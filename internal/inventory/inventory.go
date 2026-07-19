package inventory

import (
	"database/sql"
	"math"
	"strings"
	"time"
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
}

type Service struct {
	DB *sql.DB
}

// List returns paginated items. Empty search = newest first (page 1 = most recent).
func (s *Service) List(search string, page, pageSize int) []Item {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 50
	}

	if search == "" {
		// No search: paginate from bottom (newest first — mimics GAS sheet behavior)
		var total int
		s.DB.QueryRow("SELECT COUNT(*) FROM items").Scan(&total)
		endRow := total - ((page - 1) * pageSize)
		startRow := endRow - pageSize
		if startRow < 0 {
			startRow = 0
		}
		if endRow <= 0 {
			return nil
		}
		limit := endRow - startRow
		if limit <= 0 {
			return nil
		}

		rows, err := s.DB.Query(`
			SELECT stock_id, item_name, cost, uom, product_type, category,
			       current_stock, rop, selling_price, last_updated, pack_size,
			       exclude, product_status, velocity_override, supplier_name, item_behaviour
			FROM items
			ORDER BY stock_id DESC
			LIMIT ? OFFSET ?
		`, limit, startRow)
		if err != nil {
			return []Item{}
		}
		defer rows.Close()
		return scanItems(rows)
	}

	// Search: filter all matching rows, then paginate
	term := "%" + strings.ToLower(search) + "%"
	rows, err := s.DB.Query(`
		SELECT stock_id, item_name, cost, uom, product_type, category,
		       current_stock, rop, selling_price, last_updated, pack_size,
		       exclude, product_status, velocity_override, supplier_name, item_behaviour
		FROM items
		WHERE LOWER(COALESCE(stock_id,'')) LIKE ?
		   OR LOWER(COALESCE(item_name,'')) LIKE ?
		   OR LOWER(COALESCE(supplier_name,'')) LIKE ?
		ORDER BY item_name
		LIMIT ? OFFSET ?
	`, term, term, term, pageSize, (page-1)*pageSize)
	if err != nil {
		return []Item{}
	}
	defer rows.Close()
	return scanItems(rows)
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

	_, err := s.DB.Exec(
		"UPDATE items SET "+strings.Join(sets, ", ")+" WHERE stock_id = ?",
		args...,
	)
	return err
}

// BasicList returns ID + Name for dropdowns. Excludes Unavailable items.
func (s *Service) BasicList() []map[string]string {
	rows, _ := s.DB.Query(`
		SELECT stock_id, item_name, category
		FROM items
		WHERE COALESCE(product_status,'') != 'Unavailable'
		ORDER BY item_name
	`)
	defer rows.Close()
	var out []map[string]string
	for rows.Next() {
		var id, name, cat string
		rows.Scan(&id, &name, &cat)
		out = append(out, map[string]string{"Stock ID": id, "Item Name": name, "Category": cat})
	}
	return out
}

func scanItems(rows *sql.Rows) []Item {
	out := []Item{}
	for rows.Next() {
		var it Item
		var cost, current, rop, selling sql.NullFloat64
		var stockID, name, uom, ptype, cat, updated, pack, exclude, status, velOv, supplier, beh sql.NullString
		rows.Scan(&stockID, &name, &cost, &uom, &ptype, &cat, &current, &rop,
			&selling, &updated, &pack, &exclude, &status, &velOv, &supplier, &beh)

		it = Item{
			StockID: str(stockID), ItemName: str(name),
			Cost: f64(cost), UOM: str(uom),
			ProductType: str(ptype), Category: str(cat),
			CurrentStock: round(f64(current)), ROP: round(f64(rop)),
			SellingPrice: f64(selling), LastUpdated: str(updated),
			PackSize: str(pack), Exclude: str(exclude),
			ProductStatus: str(status), VelocityOv: str(velOv),
			SupplierName: str(supplier), ItemBehaviour: str(beh),
		}
		out = append(out, it)
	}
	return out
}

func str(s sql.NullString) string { if s.Valid { return s.String }; return "" }
func f64(f sql.NullFloat64) float64 { if f.Valid { return f.Float64 }; return 0 }
func round(f float64) float64 { return math.Round(f*100) / 100 }
func stringOrEmpty(v interface{}) string {
	if v == nil { return "" }
	if s, ok := v.(string); ok { return s }
	return ""
}
