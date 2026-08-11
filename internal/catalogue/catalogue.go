package catalogue

import "database/sql"

type Item struct {
	ID             int     `json:"id"`
	SupplierName   string  `json:"supplier_name"`
	SupplierCode   string  `json:"supplier_item_code"`
	ItemName       string  `json:"supplier_item_name"`
	NormName       string  `json:"normalized_item_name"`
	Brand          string  `json:"brand"`
	Pack           string  `json:"pack"`
	UOM            string  `json:"uom"`
	IndicativePrice float64 `json:"indicative_price"`
	Currency       string  `json:"currency"`
	FreshnessStatus string `json:"freshness_status"`
}

type Deal struct {
	ID                int     `json:"id"`
	CatalogueItemID   int     `json:"catalogue_item_id"`
	RuleType          string  `json:"rule_type"`
	TriggerQty        float64 `json:"trigger_qty"`
	PaidQty           float64 `json:"paid_qty"`
	FreeQty           float64 `json:"free_qty"`
	TierPrice         float64 `json:"tier_price"`
	BonusPrice        float64 `json:"bonus_price"`
	EffectiveUnitPrice float64 `json:"effective_unit_price"`
	FreeTextRule      string  `json:"free_text_rule"`
}

type Source struct {
	ID             int    `json:"id"`
	SupplierName   string `json:"supplier_name"`
	SourceType     string `json:"source_type"`
	SourceAsOf     string `json:"source_as_of"`
	FreshnessStatus string `json:"freshness_status"`
	IsActive       bool   `json:"is_active"`
}

type Service struct{ DB *sql.DB }

func (s *Service) Items(search string, supplier string, limit int) []Item {
	where := "WHERE c.is_active = 1"
	args := []interface{}{}
	if search != "" {
		where += " AND (LOWER(c.supplier_item_name) LIKE ? OR LOWER(c.normalized_item_name) LIKE ?)"
		term := "%" + search + "%"
		args = append(args, term, term)
	}
	if supplier != "" {
		where += " AND c.supplier_name = ?"
		args = append(args, supplier)
	}
	if limit <= 0 { limit = 100 }
	args = append(args, limit)
	rows, _ := s.DB.Query(`
		SELECT c.id, c.supplier_name, COALESCE(c.supplier_item_code,''), c.supplier_item_name, COALESCE(c.normalized_item_name,''),
		       COALESCE(c.brand,''), COALESCE(c.pack,''), COALESCE(c.uom,''), c.indicative_price, COALESCE(c.currency,'MYR'),
		       COALESCE(c.freshness_status,'current')
		FROM catalogue_items c `+where+` ORDER BY c.supplier_name, c.supplier_item_name LIMIT ?`, args...)
	if rows == nil { return []Item{} }
	defer rows.Close()
	var out []Item
	for rows.Next() {
		var it Item; rows.Scan(&it.ID, &it.SupplierName, &it.SupplierCode, &it.ItemName, &it.NormName,
			&it.Brand, &it.Pack, &it.UOM, &it.IndicativePrice, &it.Currency, &it.FreshnessStatus)
		out = append(out, it)
	}
	return out
}

func (s *Service) Deals(itemID int) []Deal {
	rows, _ := s.DB.Query("SELECT id, catalogue_item_id, COALESCE(rule_type,''), COALESCE(trigger_qty,0), COALESCE(paid_qty,0), COALESCE(free_qty,0), COALESCE(tier_price,0), COALESCE(bonus_price,0), COALESCE(effective_unit_price,0), COALESCE(free_text_rule,'') FROM catalogue_deals WHERE catalogue_item_id = ? AND is_active = 1", itemID)
	if rows == nil { return []Deal{} }
	defer rows.Close()
	var out []Deal
	for rows.Next() {
		var d Deal; rows.Scan(&d.ID, &d.CatalogueItemID, &d.RuleType, &d.TriggerQty, &d.PaidQty, &d.FreeQty, &d.TierPrice, &d.BonusPrice, &d.EffectiveUnitPrice, &d.FreeTextRule)
		out = append(out, d)
	}
	return out
}

func (s *Service) Sources() []Source {
	rows, _ := s.DB.Query("SELECT id, COALESCE(supplier_name,''), COALESCE(source_type,''), COALESCE(source_as_of,''), COALESCE(freshness_status,''), COALESCE(is_active,1) FROM catalogue_sources ORDER BY supplier_name")
	if rows == nil { return []Source{} }
	defer rows.Close()
	var out []Source
	for rows.Next() {
		var so Source; var act int; rows.Scan(&so.ID, &so.SupplierName, &so.SourceType, &so.SourceAsOf, &so.FreshnessStatus, &act)
		so.IsActive = act != 0; out = append(out, so)
	}
	return out
}

func (s *Service) SupplierNames() []string {
	rows, _ := s.DB.Query("SELECT DISTINCT supplier_name FROM catalogue_sources WHERE COALESCE(is_active,1)=1 ORDER BY supplier_name")
	if rows == nil { return []string{} }
	defer rows.Close()
	var out []string
	for rows.Next() { var n string; rows.Scan(&n); out = append(out, n) }
	return out
}
