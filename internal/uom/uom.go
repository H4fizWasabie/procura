package uom

import "database/sql"

type UOM struct {
	ID           int    `json:"id"`
	SupplierName string `json:"supplier_name"`
	SupplierUOM  string `json:"supplier_uom"`
	StandardUOM  string `json:"standard_uom"`
}

// ItemUsage is one item's supplier unit, joined to its standard UOM conversion.
type ItemUsage struct {
	SupplierName    string `json:"supplier_name"`
	SupplierItemName string `json:"supplier_item_name"`
	StockID         string `json:"stock_id"`
	Brand           string `json:"brand"`
	SupplierUOM     string `json:"supplier_uom"`
	StandardUOM     string `json:"standard_uom"`
}

type Service struct{ DB *sql.DB }

func (s *Service) ItemUsages(supplier string) []ItemUsage {
	q := `SELECT m.supplier_name, COALESCE(m.supplier_item_name,''), COALESCE(m.stock_id,''), COALESCE(m.brand,''),
	       COALESCE(m.supplier_uom,''), COALESCE(u.standard_uom,'')
	       FROM supplier_item_mappings m
	       LEFT JOIN (SELECT UPPER(supplier_name) sn, UPPER(supplier_uom) su, MIN(standard_uom) standard_uom FROM supplier_uom GROUP BY 1,2) u
	       ON u.sn=UPPER(m.supplier_name) AND u.su=UPPER(m.supplier_uom)
	       WHERE m.is_active=1`
	args := []interface{}{}
	if supplier != "" {
		q += " AND m.supplier_name = ?"
		args = append(args, supplier)
	}
	q += " ORDER BY m.supplier_name, m.supplier_item_name"
	rows, err := s.DB.Query(q, args...)
	if err != nil { return []ItemUsage{} }
	defer rows.Close()
	var out []ItemUsage
	for rows.Next() {
		var u ItemUsage; rows.Scan(&u.SupplierName, &u.SupplierItemName, &u.StockID, &u.Brand, &u.SupplierUOM, &u.StandardUOM)
		out = append(out, u)
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
