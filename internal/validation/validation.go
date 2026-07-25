package validation

import (
	"database/sql"
	"fmt"
	"strings"
)

type Issue struct {
	Type    string `json:"type"`
	StockID string `json:"stock_id"`
	Name    string `json:"item_name"`
	Detail  string `json:"detail"`
}

type Service struct{ DB *sql.DB }

// Run returns all validation issues.
func (s *Service) Run(nonzeroOnly bool) []Issue {
	var issues []Issue

	// 1. Items with no stock_movements
	rows, _ := s.DB.Query(`
		SELECT i.stock_id, COALESCE(i.item_name,'')
		FROM items i
		LEFT JOIN (SELECT DISTINCT stock_id FROM stock_movements) sm ON sm.stock_id = i.stock_id
		WHERE sm.stock_id IS NULL
		  AND COALESCE(i.exclude,0) = 0
		ORDER BY i.stock_id
	`)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var id, name string
			rows.Scan(&id, &name)
			issues = append(issues, Issue{Type: "MISSING_MOVEMENT", StockID: id, Name: name, Detail: "Item has no movement records"})
		}
	}

	// 2. Movement rows referencing unknown stock_ids
	rows, _ = s.DB.Query(`
		SELECT sm.stock_id, COALESCE(sm.item_name,''), sm.year, sm.month
		FROM stock_movements sm
		LEFT JOIN items i ON i.stock_id = sm.stock_id
		WHERE i.stock_id IS NULL
		ORDER BY sm.year, sm.month, sm.stock_id
		LIMIT 200
	`)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var id, name string
			var yr, mo int
			rows.Scan(&id, &name, &yr, &mo)
			issues = append(issues, Issue{Type: "ORPHAN_MOVEMENT", StockID: id, Name: name, Detail: fmt.Sprintf("Movement %d-%02d references unknown item", yr, mo)})
		}
	}

	// 3. PO items referencing unknown stock_ids (non-empty, not matched)
	rows, _ = s.DB.Query(`
		SELECT poi.po_id, poi.stock_id, COALESCE(poi.item_name,'')
		FROM purchase_order_items poi
		LEFT JOIN items i ON i.stock_id = poi.stock_id
		WHERE i.stock_id IS NULL
		  AND poi.stock_id IS NOT NULL
		  AND poi.stock_id != ''
		ORDER BY poi.po_id
		LIMIT 200
	`)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var poID, stockID, name string
			rows.Scan(&poID, &stockID, &name)
			issues = append(issues, Issue{Type: "ORPHAN_PO_ITEM", StockID: stockID, Name: name, Detail: fmt.Sprintf("PO %s references unknown item", poID)})
		}
	}

	// 4. Items with negative current_stock
	rows, _ = s.DB.Query(`
		SELECT stock_id, COALESCE(item_name,''), current_stock
		FROM items
		WHERE current_stock < 0
		ORDER BY current_stock
	`)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var id, name string
			var curr float64
			rows.Scan(&id, &name, &curr)
			issues = append(issues, Issue{Type: "NEGATIVE_STOCK", StockID: id, Name: name, Detail: fmt.Sprintf("Current stock is %.2f", curr)})
		}
	}

	// 5. Items with ROP > 0 but zero current stock (potential dead stock not marked)
	rows, _ = s.DB.Query(`
		SELECT stock_id, COALESCE(item_name,''), rop, current_stock
		FROM items
		WHERE rop > 0 AND current_stock = 0 AND COALESCE(exclude,0) = 0
		ORDER BY stock_id
		LIMIT 200
	`)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var id, name string
			var rop, curr float64
			rows.Scan(&id, &name, &rop, &curr)
			issues = append(issues, Issue{Type: "ZERO_STOCK_WITH_ROP", StockID: id, Name: name, Detail: fmt.Sprintf("ROP=%.0f but stock is 0", rop)})
		}
	}

	// 6. Duplicate stock_ids
	rows, _ = s.DB.Query(`
		SELECT stock_id, COUNT(*) as cnt
		FROM items
		GROUP BY stock_id
		HAVING cnt > 1
		ORDER BY cnt DESC
	`)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var id string
			var cnt int
			rows.Scan(&id, &cnt)
			issues = append(issues, Issue{Type: "DUPLICATE_STOCK_ID", StockID: id, Detail: fmt.Sprintf("Appears %d times in items table", cnt)})
		}
	}

	// Filter nonzero if requested
	if nonzeroOnly {
		filtered := []Issue{}
		for _, is := range issues {
			if is.Type != "NONE" && is.Detail != "" {
				filtered = append(filtered, is)
			}
		}
		return filtered
	}

	if issues == nil {
		issues = []Issue{}
	}
	return issues
}

// ReportMD generates a markdown validation report.
func (s *Service) ReportMD(nonzeroOnly bool) string {
	issues := s.Run(nonzeroOnly)
	var b strings.Builder
	b.WriteString("# Validation Report\n\n")
	if len(issues) == 0 {
		b.WriteString("✅ No issues found.\n")
		return b.String()
	}

	typeCounts := map[string]int{}
	for _, is := range issues {
		typeCounts[is.Type]++
	}

	b.WriteString("## Summary\n\n")
	b.WriteString("| Issue Type | Count |\n")
	b.WriteString("|------------|-------|\n")
	for t, c := range typeCounts {
		b.WriteString(fmt.Sprintf("| %s | %d |\n", t, c))
	}

	b.WriteString("\n## Issues\n\n")
	for _, is := range issues {
		b.WriteString(fmt.Sprintf("- **[%s]** %s", is.Type, is.StockID))
		if is.Name != "" {
			b.WriteString(fmt.Sprintf(" — %s", is.Name))
		}
		b.WriteString(fmt.Sprintf(": %s\n", is.Detail))
	}

	return b.String()
}
