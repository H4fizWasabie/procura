package movement

import (
	"math"
	"testing"
	"time"

	"procura/internal/core"
)

func testDB(t *testing.T) *Service {
	db, err := core.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &Service{DB: db}
}

func exec(t *testing.T, s *Service, q string, args ...interface{}) {
	t.Helper()
	if _, err := s.DB.Exec(q, args...); err != nil {
		t.Fatalf("exec: %v", err)
	}
}

func TestRecalcROPPersistsVelocityAndROP(t *testing.T) {
	s := testDB(t)
	exec(t, s, `INSERT INTO items (stock_id, item_name, rop) VALUES ('X','Item X',99)`)
	// steady 4/month over recent months (offsets from current month)
	nowIdx := recalcNowIdx()
	for i := 0; i < 4; i++ {
		idx := nowIdx - i
		exec(t, s, `INSERT INTO stock_movements (stock_id, year, month, out_qty) VALUES ('X',?, ?, 4)`, idx/12, idx%12+1)
	}

	n := s.RecalcROP()
	if n == 0 {
		t.Fatal("expected updates")
	}
	var rop, vel float64
	s.DB.QueryRow("SELECT rop, COALESCE(velocity,0) FROM items WHERE stock_id='X'").Scan(&rop, &vel)
	// all points in 0-2mo bucket: avg 4 × weight .5 / .5 = 4 → ROP 8
	if vel != 4 || rop != 8 {
		t.Errorf("vel/rop = %v/%v, want 4/8", vel, rop)
	}
}

func TestSpikeCapBoundsOneOffAdjustment(t *testing.T) {
	s := testDB(t)
	exec(t, s, `INSERT INTO items (stock_id, item_name, rop) VALUES ('Y','Item Y',99)`)
	nowIdx := recalcNowIdx()
	usages := []float64{119, 1, 1, 1, 1} // one-off spike + steady baseline of 1
	for i, u := range usages {
		idx := nowIdx - i
		exec(t, s, `INSERT INTO stock_movements (stock_id, year, month, out_qty) VALUES ('Y',?, ?, ?)`, idx/12, idx%12+1, u)
	}

	s.RecalcROP()
	var vel float64
	s.DB.QueryRow("SELECT COALESCE(velocity,0) FROM items WHERE stock_id='Y'").Scan(&vel)
	// median active = 1 → cap = 3. Spike capped at 3.
	// bucket 0-2mo: (3+1+1)/3 = 5/3 ×.5 ; bucket 3-5mo: (1+1)/2 = 1 ×.3 ; totalW=.8
	want := (((5.0 / 3.0) * .5) + (1 * .3)) / .8
	if math.Abs(vel-want) > 0.01 {
		t.Errorf("velocity = %v, want ~%v", vel, want)
	}
	if vel > 3.5 {
		t.Errorf("spike not bounded: %v", vel)
	}
}

func TestVelocityOverridePersists(t *testing.T) {
	s := testDB(t)
	exec(t, s, `INSERT INTO items (stock_id, item_name, velocity_override) VALUES ('Z','Item Z','7')`)
	s.RecalcROP()
	var rop, vel float64
	s.DB.QueryRow("SELECT rop, COALESCE(velocity,0) FROM items WHERE stock_id='Z'").Scan(&rop, &vel)
	if vel != 7 || rop != 14 {
		t.Errorf("vel/rop = %v/%v, want 7/14", vel, rop)
	}
}

// recalcNowIdx mirrors RecalcROP's currentYearMonth convention (y*12 + m - 1).
func recalcNowIdx() int {
	n := time.Now()
	return n.Year()*12 + int(n.Month()) - 1
}
