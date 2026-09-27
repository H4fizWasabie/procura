package po

import (
	"strings"
	"testing"
)

func TestValidateRequired(t *testing.T) {
	p := PO{Date: "  ", Supplier: "Supplier"}
	err := ValidateRequired(p)
	if err == nil || !strings.Contains(err.Error(), "date, department") {
		t.Fatalf("ValidateRequired() error = %v, want date and department required", err)
	}

	p.Date = "2026-09-27"
	p.Department = "Pharmacy"
	if err := ValidateRequired(p); err != nil {
		t.Fatalf("optional PO fields should not be required: %v", err)
	}
}
