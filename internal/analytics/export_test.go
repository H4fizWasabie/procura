package analytics

import (
	"bytes"
	"database/sql"
	"os"
	"testing"

	_ "modernc.org/sqlite"
)

func TestFreezeExport(t *testing.T) {
	dbPath := os.Getenv("PROCURA_TEST_DB")
	if dbPath == "" { dbPath = "../../data/procura.sqlite" }
	db, err := sql.Open("sqlite", dbPath)
	if err != nil { t.Fatal(err) }
	defer db.Close()
	s := &Service{DB: db}

	vals, err := s.Freeze(2026, 6)
	if err != nil { t.Fatal(err) }
	if vals["ih"] != 20851.69 { t.Fatalf("ih frozen = %v, want 20851.69", vals["ih"]) }

	// settings override survives recompute
	m := s.Compute(2026, 6, 2026, 6)
	if m.Operation.InHouseConsumption[0] != 20851.69 { t.Fatalf("recompute ih = %v", m.Operation.InHouseConsumption[0]) }

	b, err := s.Export(2026, 6, 2026, 6)
	if err != nil { t.Fatal(err) }
	if !bytes.HasPrefix(b, []byte("PK\x03\x04")) { t.Fatal("not a valid xlsx") }
	if len(b) < 10000 { t.Fatalf("xlsx too small: %d bytes", len(b)) }
}
