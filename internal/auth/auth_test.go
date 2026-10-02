package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"procura/internal/core"
)

func TestViewerReadOnly(t *testing.T) {
	t.Setenv("PROCURA_DEMO", "1")
	s := &Service{}
	token, _, err := s.DemoLogin()
	if err != nil {
		t.Fatal(err)
	}
	ok := func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) }
	mw := s.Middleware(ok)
	do := func(method, path string) int {
		req := httptest.NewRequest(method, path, nil)
		req.AddCookie(&http.Cookie{Name: "token", Value: token})
		rec := httptest.NewRecorder()
		mw(rec, req)
		return rec.Code
	}
	// reads allowed
	if c := do(http.MethodGet, "/"); c != http.StatusTeapot {
		t.Errorf("GET / = %d, want %d", c, http.StatusTeapot)
	}
	// writes blocked
	if c := do(http.MethodPost, "/api/inventory/1"); c != http.StatusForbidden {
		t.Errorf("POST /api/inventory/1 = %d, want %d", c, http.StatusForbidden)
	}
	// read-via-POST whitelisted
	if c := do(http.MethodPost, "/api/reports/item-history"); c != http.StatusTeapot {
		t.Errorf("POST item-history = %d, want %d", c, http.StatusTeapot)
	}
}

func TestUserRolesRejectUnknownValuesWithoutMutation(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := &Service{DB: db}
	for _, role := range []string{"VIEWER", "ASSISTANT", "EDITOR", "ADMIN"} {
		if _, err := s.AddUser(role+"@example.test", "Fixture user", role); err != nil {
			t.Fatalf("add %s: %v", role, err)
		}
		if err := s.UpdateUser("viewer@example.test", "Updated fixture", role); err != nil {
			t.Fatalf("update %s: %v", role, err)
		}
	}
	for _, role := range []string{"", "ROOT", "admin", " ADMIN ", "EDITOR,ADMIN"} {
		if _, err := s.AddUser("invalid@example.test", "Invalid fixture", role); err == nil {
			t.Errorf("added unknown role %q", role)
		}
		if err := s.UpdateUser("viewer@example.test", "Must not change", role); err == nil {
			t.Errorf("updated unknown role %q", role)
		}
	}
	var count int
	var name, role string
	if err := db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT name,role FROM users WHERE email='viewer@example.test'`).Scan(&name, &role); err != nil {
		t.Fatal(err)
	}
	if count != 4 || name != "Updated fixture" || role != "ADMIN" {
		t.Fatalf("invalid role mutated users: %d %s %s", count, name, role)
	}
}

func TestSessionCookieUsesIdleTimeout(t *testing.T) {
	rec := httptest.NewRecorder()
	SetSessionCookie(rec, "token")
	if got := rec.Result().Cookies()[0].MaxAge; got != int(idleTimeout.Seconds()) {
		t.Fatalf("MaxAge = %d, want %d", got, int(idleTimeout.Seconds()))
	}
}
