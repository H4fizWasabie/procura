package tasks

import "database/sql"

type Task struct {
	TaskID      string `json:"task_id"`
	Title       string `json:"title"`
	Notes       string `json:"notes"`
	Attachments string `json:"attachments"`
	Status      string `json:"status"`
	CreatedBy   string `json:"created_by"`
	CreatedDate string `json:"created_date"`
}

type Service struct{ DB *sql.DB }

func (s *Service) List() []Task {
	rows, _ := s.DB.Query("SELECT task_id, title, notes, attachments, status, created_by, created_date FROM tasks ORDER BY created_date DESC")
	if rows == nil { return []Task{} }
	defer rows.Close()
	return scanTasks(rows)
}

func (s *Service) Save(t Task) error {
	_, err := s.DB.Exec(`
		INSERT OR REPLACE INTO tasks (task_id, title, notes, attachments, status, created_by, created_date)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, t.TaskID, t.Title, t.Notes, t.Attachments, t.Status, t.CreatedBy, t.CreatedDate)
	return err
}

func (s *Service) Delete(taskID string) error {
	_, err := s.DB.Exec("DELETE FROM tasks WHERE task_id = ?", taskID)
	return err
}

func scanTasks(rows *sql.Rows) []Task {
	var out []Task
	for rows.Next() {
		var t Task
		var tid, title, notes, att, status, by, date sql.NullString
		rows.Scan(&tid, &title, &notes, &att, &status, &by, &date)
		t.TaskID = strv(tid); t.Title = strv(title); t.Notes = strv(notes)
		t.Attachments = strv(att); t.Status = strv(status)
		t.CreatedBy = strv(by); t.CreatedDate = strv(date)
		out = append(out, t)
	}
	return out
}

func strv(s sql.NullString) string { if s.Valid { return s.String }; return "" }
