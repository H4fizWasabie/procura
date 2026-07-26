package uom

import "database/sql"

type Mapping struct {
	ID              int    `json:"id"`
	SupplierName    string `json:"supplier_name"`
	SupplierItemName string `json:"supplier_item_name"`
	SupplierUOM     string `json:"supplier_uom"`
	StockID         string `json:"stock_id"`
	Brand           string `json:"brand"`
	MatchPriority   int    `json:"match_priority"`
}

type UOM struct {
	ID           int    `json:"id"`
	SupplierName string `json:"supplier_name"`
	SupplierUOM  string `json:"supplier_uom"`
	StandardUOM  string `json:"standard_uom"`
}

type Service struct{ DB *sql.DB }

func (s *Service) Mappings(supplier string) []Mapping {
	var rows *sql.Rows
	if supplier != "" {
		rows, _ = s.DB.Query("SELECT id, supplier_name, COALESCE(supplier_item_name,''), COALESCE(supplier_uom,''), COALESCE(stock_id,''), COALESCE(brand,''), COALESCE(match_priority,0) FROM supplier_item_mappings WHERE supplier_name = ? ORDER BY supplier_item_name", supplier)
	} else {
		rows, _ = s.DB.Query("SELECT id, supplier_name, COALESCE(supplier_item_name,''), COALESCE(supplier_uom,''), COALESCE(stock_id,''), COALESCE(brand,''), COALESCE(match_priority,0) FROM supplier_item_mappings ORDER BY supplier_name, supplier_item_name")
	}
	if rows == nil { return []Mapping{} }
	defer rows.Close()
	var out []Mapping
	for rows.Next() {
		var m Mapping; rows.Scan(&m.ID, &m.SupplierName, &m.SupplierItemName, &m.SupplierUOM, &m.StockID, &m.Brand, &m.MatchPriority)
		out = append(out, m)
	}
	return out
}

func (s *Service) UOMs(supplier string) []UOM {
	var rows *sql.Rows
	if supplier != "" {
		rows, _ = s.DB.Query("SELECT id, supplier_name, supplier_uom, standard_uom FROM supplier_uom WHERE supplier_name = ? ORDER BY supplier_uom", supplier)
	} else {
		rows, _ = s.DB.Query("SELECT id, supplier_name, supplier_uom, standard_uom FROM supplier_uom ORDER BY supplier_name, supplier_uom")
	}
	if rows == nil { return []UOM{} }
	defer rows.Close()
	var out []UOM
	for rows.Next() {
		var u UOM; rows.Scan(&u.ID, &u.SupplierName, &u.SupplierUOM, &u.StandardUOM)
		out = append(out, u)
	}
	return out
}

func (s *Service) SaveMapping(m Mapping) error {
	if m.ID > 0 {
		_, err := s.DB.Exec("UPDATE supplier_item_mappings SET supplier_name=?, supplier_item_name=?, supplier_uom=?, stock_id=?, brand=?, match_priority=? WHERE id=?",
			m.SupplierName, m.SupplierItemName, m.SupplierUOM, m.StockID, m.Brand, m.MatchPriority, m.ID)
		return err
	}
	_, err := s.DB.Exec("INSERT INTO supplier_item_mappings (supplier_name, supplier_item_name, supplier_uom, stock_id, brand, match_priority) VALUES (?,?,?,?,?,?)",
		m.SupplierName, m.SupplierItemName, m.SupplierUOM, m.StockID, m.Brand, m.MatchPriority)
	return err
}

// UpsertItemMapping remembers the supplier unit used for a specific item.
// It deliberately stores no conversion: supplier quantity and stock quantity
// remain separate concerns until conversion rules are explicitly supported.
func (s *Service) UpsertItemMapping(supplier, stockID, itemName, supplierUOM string) error {
	if supplier == "" || stockID == "" || supplierUOM == "" {
		return nil
	}

	var id int
	err := s.DB.QueryRow(`
		SELECT id FROM supplier_item_mappings
		WHERE supplier_name = ? AND stock_id = ?
		ORDER BY id LIMIT 1
	`, supplier, stockID).Scan(&id)
	if err == nil {
		_, err = s.DB.Exec(`UPDATE supplier_item_mappings
			SET supplier_item_name = ?, supplier_uom = ? WHERE id = ?`, itemName, supplierUOM, id)
		return err
	}
	if err != sql.ErrNoRows {
		return err
	}
	// Imported mappings may already identify the same item by supplier name.
	// Reuse that row so the table's existing uniqueness rule is preserved.
	err = s.DB.QueryRow(`
		SELECT id FROM supplier_item_mappings
		WHERE supplier_name = ? AND supplier_item_name = ?
		ORDER BY id LIMIT 1
	`, supplier, itemName).Scan(&id)
	if err == nil {
		_, err = s.DB.Exec(`UPDATE supplier_item_mappings
			SET supplier_uom = ?, stock_id = ? WHERE id = ?`, supplierUOM, stockID, id)
		return err
	}
	if err != sql.ErrNoRows {
		return err
	}

	_, err = s.DB.Exec(`INSERT INTO supplier_item_mappings
		(supplier_name, supplier_item_name, supplier_uom, stock_id, match_priority)
		VALUES (?, ?, ?, ?, 0)`, supplier, itemName, supplierUOM, stockID)
	return err
}

func (s *Service) SaveUOM(u UOM) error {
	if u.ID > 0 {
		_, err := s.DB.Exec("UPDATE supplier_uom SET supplier_name=?, supplier_uom=?, standard_uom=? WHERE id=?", u.SupplierName, u.SupplierUOM, u.StandardUOM, u.ID)
		return err
	}
	_, err := s.DB.Exec("INSERT INTO supplier_uom (supplier_name, supplier_uom, standard_uom) VALUES (?,?,?)", u.SupplierName, u.SupplierUOM, u.StandardUOM)
	return err
}
