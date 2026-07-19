package scorecard

import "database/sql"

type Entry struct {
	ID            int     `json:"id"`
	Timestamp     string  `json:"timestamp"`
	POID          string  `json:"po_id"`
	SupplierName  string  `json:"supplier_name"`
	RatedBy       string  `json:"rated_by"`
	Quality       float64 `json:"quality"`
	Accuracy      float64 `json:"accuracy"`
	Speed         float64 `json:"speed"`
	WeightedScore float64 `json:"weighted_score"`
	Comments      string  `json:"comments"`
}

type SupplierSummary struct {
	Name    string  `json:"name"`
	AvgScore float64 `json:"avg_score"`
	Count   int     `json:"rating_count"`
}

type Service struct{ DB *sql.DB }

func (s *Service) List() []Entry {
	rows, _ := s.DB.Query("SELECT id, timestamp, po_id, supplier_name, rated_by, quality, accuracy, speed, weighted_score, comments FROM supplier_performance ORDER BY timestamp DESC")
	if rows == nil { return []Entry{} }
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		var e Entry
		var ts, po, sup, rated, comments sql.NullString
		var q, a, sp, ws sql.NullFloat64
		rows.Scan(&e.ID, &ts, &po, &sup, &rated, &q, &a, &sp, &ws, &comments)
		e.Timestamp = strv(ts); e.POID = strv(po); e.SupplierName = strv(sup)
		e.RatedBy = strv(rated); e.Comments = strv(comments)
		e.Quality = f64v(q); e.Accuracy = f64v(a); e.Speed = f64v(sp); e.WeightedScore = f64v(ws)
		out = append(out, e)
	}
	return out
}

func (s *Service) Save(e Entry) error {
	var err error
	if e.ID > 0 {
		_, err = s.DB.Exec(`UPDATE supplier_performance SET quality=?, accuracy=?, speed=?, weighted_score=?, comments=? WHERE id=?`,
			e.Quality, e.Accuracy, e.Speed, e.WeightedScore, e.Comments, e.ID)
	} else {
		_, err = s.DB.Exec(`INSERT INTO supplier_performance (timestamp, po_id, supplier_name, rated_by, quality, accuracy, speed, weighted_score, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			e.Timestamp, e.POID, e.SupplierName, e.RatedBy, e.Quality, e.Accuracy, e.Speed, e.WeightedScore, e.Comments)
	}
	return err
}

func (s *Service) Summary() []SupplierSummary {
	rows, _ := s.DB.Query(`
		SELECT supplier_name, ROUND(AVG(weighted_score), 2), COUNT(*)
		FROM supplier_performance GROUP BY supplier_name ORDER BY AVG(weighted_score) DESC
	`)
	if rows == nil { return []SupplierSummary{} }
	defer rows.Close()
	var out []SupplierSummary
	for rows.Next() {
		var ss SupplierSummary
		var name sql.NullString
		rows.Scan(&name, &ss.AvgScore, &ss.Count)
		ss.Name = strv(name)
		out = append(out, ss)
	}
	return out
}

func strv(s sql.NullString) string { if s.Valid { return s.String }; return "" }
func f64v(f sql.NullFloat64) float64 { if f.Valid { return f.Float64 }; return 0 }
