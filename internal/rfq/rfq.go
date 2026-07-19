package rfq

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type RFQ struct {
	RFQID    string `json:"rfq_id"`
	Date     string `json:"date"`
	Supplier string `json:"supplier"`
	Count    int    `json:"items_count"`
	Items    []Item `json:"items"`
}

type Item struct {
	StockID string `json:"stock_id"`
	Name    string `json:"item_name"`
	UOM     string `json:"uom"`
	Qty     float64 `json:"qty"`
}

type Service struct {
	DB *sql.DB
}

// GenerateID creates next RFQ ID in format "RFQ-MMYYYY-NN".
func (s *Service) GenerateID() string {
	now := time.Now()
	prefix := "RFQ-" + now.Format("012006") + "-"
	var maxSeq int
	rows, _ := s.DB.Query("SELECT rfq_id FROM rfq_logs WHERE rfq_id LIKE ?", prefix+"%")
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
	return prefix + fmt.Sprintf("%02d", maxSeq+1)
}

// Save creates or updates an RFQ.
func (s *Service) Save(rfq RFQ, createdBy string) (string, error) {
	if rfq.RFQID == "" {
		rfq.RFQID = s.GenerateID()
	}
	rfq.Count = len(rfq.Items)

	compact := make([]map[string]interface{}, len(rfq.Items))
	for i, it := range rfq.Items {
		compact[i] = map[string]interface{}{
			"id": it.StockID, "n": it.Name, "u": it.UOM, "q": it.Qty,
		}
	}
	rawJSON, _ := json.Marshal(compact)

	_, err := s.DB.Exec(`
		INSERT OR REPLACE INTO rfq_logs (rfq_id, date, supplier, items_count, created_by, raw_rfq_json)
		VALUES (?, ?, ?, ?, ?, ?)
	`, rfq.RFQID, time.Now().Format("2006-01-02T15:04:05"), rfq.Supplier, rfq.Count, createdBy, string(rawJSON))
	return rfq.RFQID, err
}

// History returns all RFQs ordered by date desc.
func (s *Service) History() []RFQ {
	rows, _ := s.DB.Query(`
		SELECT rfq_id, date, supplier, items_count, raw_rfq_json
		FROM rfq_logs ORDER BY date DESC LIMIT 100
	`)
	if rows == nil {
		return nil
	}
	defer rows.Close()
	var out []RFQ
	for rows.Next() {
		var r RFQ
		var raw sql.NullString
		var date, sup sql.NullString
		rows.Scan(&r.RFQID, &date, &sup, &r.Count, &raw)
		r.Date = strv(date)
		r.Supplier = strv(sup)
		if raw.Valid {
			var items []map[string]interface{}
			json.Unmarshal([]byte(raw.String), &items)
			for _, it := range items {
				r.Items = append(r.Items, Item{
					StockID: strv2(it["id"]),
					Name:    strv2(it["n"]),
					UOM:     strv2(it["u"]),
					Qty:     f64v2(it["q"]),
				})
			}
		}
		out = append(out, r)
	}
	return out
}

// Delete removes an RFQ.
func (s *Service) Delete(rfqID string) error {
	_, err := s.DB.Exec("DELETE FROM rfq_logs WHERE rfq_id = ?", rfqID)
	return err
}

// helpers
func strv(s sql.NullString) string { if s.Valid { return s.String }; return "" }
func strv2(v interface{}) string { if v == nil { return "" }; if s, ok := v.(string); ok { return s }; return "" }
func f64v2(v interface{}) float64 {
	if v == nil { return 0 }
	switch n := v.(type) {
	case float64: return n
	case json.Number: f, _ := n.Float64(); return f
	}
	return 0
}
