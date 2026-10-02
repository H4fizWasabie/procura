package validation

import (
	"strings"
	"testing"

	"procura/internal/core"
)

func TestValidationShowsPendingUOMAndMissingImport(t *testing.T) {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(stock_id,item_name,uom,uom_confirmation_pending,last_updated) VALUES
		('A','Pending fixture','box',1,'2026-01-01'),('B','Latest fixture','ea',0,'2026-01-02')`); err != nil {
		t.Fatal(err)
	}
	issues := (&Service{DB: db}).Run(false)
	var uom, missing bool
	for _, issue := range issues {
		if issue.StockID == "A" && issue.Type == "UOM_CONFIRMATION" && strings.Contains(issue.Detail, "Confirm UOM") {
			uom = true
		}
		if issue.StockID == "A" && issue.Type == "MISSING_LATEST_IMPORT" {
			missing = true
		}
	}
	if !uom || !missing {
		t.Fatalf("pending UOM=%v missing import=%v: %#v", uom, missing, issues)
	}
}
