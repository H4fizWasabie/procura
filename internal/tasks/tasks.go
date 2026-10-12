package tasks

import (
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"
)

type Task struct {
	TaskID         string `json:"id"`
	Title          string `json:"title"`
	Notes          string `json:"notes"`
	Attachments    string `json:"attachments"`
	Status         string `json:"status"`
	CreatedBy      string `json:"created_by"`
	CreatedDate    string `json:"created_date"`
	AssignedTo     string `json:"assigned_to"`
	CreatedByName  string `json:"created_by_name"`
	AssignedToName string `json:"assigned_to_name"`
}

var ErrUnknownAssignee = errors.New("assigned_to is not a user")

type Service struct{ DB *sql.DB }

// List returns tasks newest first, without deleted ones, with user names.
func (s *Service) List() ([]Task, error) {
	rows, err := s.DB.Query(`
		SELECT t.task_id, t.title, t.notes, t.attachments, t.status, t.created_by, t.created_date, t.assigned_to,
		       COALESCE(c.name, ''), COALESCE(a.name, '')
		FROM tasks t
		LEFT JOIN users c ON c.email = t.created_by
		LEFT JOIN users a ON a.email = t.assigned_to
		WHERE COALESCE(t.status, '') != 'Deleted'
		ORDER BY t.created_date DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		var t Task
		var tid, title, notes, att, status, by, date, to sql.NullString
		if err := rows.Scan(&tid, &title, &notes, &att, &status, &by, &date, &to, &t.CreatedByName, &t.AssignedToName); err != nil {
			return nil, err
		}
		t.TaskID, t.Title, t.Notes, t.Attachments = tid.String, title.String, notes.String, att.String
		t.Status, t.CreatedBy, t.CreatedDate, t.AssignedTo = status.String, by.String, date.String, to.String
		out = append(out, t)
	}
	return out, rows.Err()
}

// Save creates a task as user, or updates its title, notes, status and
// assignee; the creator and created date are never overwritten.
func (s *Service) Save(t Task, user string) error {
	t.AssignedTo = strings.TrimSpace(t.AssignedTo)
	if t.AssignedTo != "" {
		var ok bool
		if err := s.DB.QueryRow(`SELECT EXISTS(SELECT 1 FROM users WHERE email = ?)`, t.AssignedTo).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return ErrUnknownAssignee
		}
	}
	if t.TaskID == "" {
		t.TaskID = "TK-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	if t.Status == "" {
		t.Status = "Pending"
	}
	_, err := s.DB.Exec(`
		INSERT INTO tasks (task_id, title, notes, attachments, status, created_by, created_date, assigned_to)
		VALUES (?, ?, ?, '', ?, ?, ?, NULLIF(?, ''))
		ON CONFLICT(task_id) DO UPDATE SET title = excluded.title, notes = excluded.notes,
			status = excluded.status, assigned_to = excluded.assigned_to
	`, t.TaskID, t.Title, t.Notes, t.Status, user, time.Now().Format("2006-01-02T15:04:05"), t.AssignedTo)
	return err
}

func (s *Service) Delete(taskID string) error {
	_, err := s.DB.Exec("DELETE FROM tasks WHERE task_id = ?", taskID)
	return err
}
