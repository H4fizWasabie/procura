package tasks

import (
	"errors"
	"testing"

	"procura/internal/core"
)

func TestSaveRecordsCreatorAndAssignee(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO users(email,name,role,pin_hash) VALUES('boss@x','Hafiz','ADMIN',''),('staff@x','Staff','ADMIN','');
		INSERT INTO tasks(task_id,title,status,created_date) VALUES('TK-OLD','gone','Deleted','2026-01-01')`); err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: db}
	if err := s.Save(Task{Title: "x", AssignedTo: "nobody@x"}, "boss@x"); !errors.Is(err, ErrUnknownAssignee) {
		t.Fatalf("unknown assignee: %v", err)
	}
	if err := s.Save(Task{Title: "Call supplier", AssignedTo: "staff@x"}, "boss@x"); err != nil {
		t.Fatal(err)
	}
	list := s.List()
	if len(list) != 1 {
		t.Fatalf("deleted tasks must be hidden: %+v", list)
	}
	got := list[0]
	if got.Status != "Pending" || got.CreatedBy != "boss@x" || got.CreatedByName != "Hafiz" || got.AssignedToName != "Staff" || got.CreatedDate == "" {
		t.Fatalf("new task: %+v", got)
	}
	got.Status, got.AssignedTo = "Done", ""
	if err := s.Save(got, "staff@x"); err != nil {
		t.Fatal(err)
	}
	after := s.List()[0]
	if after.Status != "Done" || after.AssignedTo != "" || after.CreatedBy != "boss@x" || after.CreatedDate != got.CreatedDate {
		t.Fatalf("update must keep creator and date: %+v", after)
	}
}
