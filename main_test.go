package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"procura/internal/core"
	"procura/internal/po"
	"procura/internal/rfq"
)

func TestOrderSaveErrorsReturn400OnlyForPendingUOM(t *testing.T) {
	for _, route := range []string{"PO", "RFQ"} {
		t.Run(route, func(t *testing.T) {
			db, err := core.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err := db.Exec(`INSERT INTO items(stock_id,item_name,uom_confirmation_pending) VALUES('A','Fixture item',1)`); err != nil {
				t.Fatal(err)
			}
			save := func() (string, error) {
				if route == "PO" {
					return (&po.Service{DB: db}).Save(po.PO{Date: "2026-01-02", Supplier: "Fixture supplier", Department: "Ward", Items: []po.Item{{StockID: "A", Qty: 1}}})
				}
				return (&rfq.Service{DB: db}).Save(rfq.RFQ{Supplier: "Fixture supplier", Items: []rfq.Item{{StockID: "A", Qty: 1}}}, "editor@example.test")
			}
			for _, want := range []int{http.StatusBadRequest, http.StatusInternalServerError} {
				if want == http.StatusInternalServerError {
					if err := db.Close(); err != nil {
						t.Fatal(err)
					}
				}
				_, err := save()
				if err == nil {
					t.Fatal("expected save error")
				}
				if errors.Is(err, core.ErrPendingUOM) != (want == http.StatusBadRequest) {
					t.Fatalf("wrong save error: %v", err)
				}
				w := httptest.NewRecorder()
				writeOrderSaveError(w, fmt.Errorf("save failed: %w", err))
				var body struct {
					Success bool   `json:"success"`
					Error   string `json:"error"`
				}
				if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if w.Code != want || body.Success || body.Error == "" {
					t.Fatalf("response %d: %s; want %d", w.Code, w.Body.String(), want)
				}
			}
		})
	}
}
