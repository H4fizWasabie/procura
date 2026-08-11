package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestViewerReadOnly(t *testing.T) {
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
