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
	exec(t, s, `UPDATE items SET exclude='YES',purchase_policy='do_not_reorder',product_status='not-available' WHERE stock_id='X'`)
	s.RecalcROP()
	if err := s.DB.QueryRow("SELECT rop, velocity FROM items WHERE stock_id='X'").Scan(&rop, &vel); err != nil || rop != 8 || vel != 4 {
		t.Fatalf("purchase controls changed weighted ROP/velocity=%v/%v err=%v", rop, vel, err)
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

func TestRecalcROPIgnoresPurchaseControlsButRespectsStockability(t *testing.T) {
	s := testDB(t)
	defer s.DB.Close()
	for _, tc := range []struct {
		id                                       string
		exclude, policy                          interface{}
		behaviour, status, productType, category string
		rop                                      float64
	}{
		{"INTEGER_EXCLUDE", 1, "routine", "", "Available", "", "", 10},
		{"STRING_EXCLUDE", "1", "routine", "", "Available", "", "", 10},
		{"TRUE_EXCLUDE", "TRUE", "routine", "", "Available", "", "", 10},
		{"YES_EXCLUDE", "YES", "routine", "", "Available", "", "", 10},
		{"WORD_EXCLUDE", "EXCLUDE", "routine", "", "Available", "", "", 10},
		{"UNCLASSIFIED", 0, nil, "Standard / Pack", "Available", "", "", 10},
		{"ON_DEMAND", 0, "on_demand", "In-House Use", "Available", "", "", 10},
		{"DO_NOT_REORDER", 0, "do_not_reorder", "", "Available", "", "", 10},
		{"NOT_AVAILABLE", 0, "routine", "", "not-available", "", "", 10},
		{"LEGACY_STATUS", 0, "routine", "", "Unavailable", "", "", 10},
		{"LEGACY_BEHAVIOUR", 0, "routine", "Exclude", "Available", "", "", 10},
		{"UNKNOWN_BEHAVIOUR", 0, "routine", "Unknown", "Available", "", "", 10},
		{"SERVICE", 0, "routine", "Service", "Available", "", "", 0},
		{"ASSET", 0, "routine", "Asset", "Available", "", "", 0},
		{"UNAVAILABLE_BEHAVIOUR", 0, "routine", "Unavailable", "Available", "", "", 0},
		{"SURGICAL_TYPE", 0, "routine", "", "Available", "Surgical", "", 0},
		{"SURGICAL_CATEGORY", 0, "routine", "", "Available", "", "Surgical", 0},
	} {
		exec(t, s, `INSERT INTO items(stock_id,item_name,rop,velocity_override,exclude,purchase_policy,
			item_behaviour,product_status,product_type,category) VALUES(?,?,99,5,?,?,?,?,?,?)`,
			tc.id, tc.id, tc.exclude, tc.policy, tc.behaviour, tc.status, tc.productType, tc.category)
		s.RecalcROP()
		var rop, vel float64
		if err := s.DB.QueryRow(`SELECT rop,COALESCE(velocity,0) FROM items WHERE stock_id=?`, tc.id).Scan(&rop, &vel); err != nil {
			t.Fatal(err)
		}
		wantVel := tc.rop / 2
		if rop != tc.rop || vel != wantVel {
			t.Errorf("%s: ROP/velocity=%v/%v want %v/%v", tc.id, rop, vel, tc.rop, wantVel)
		}
	}
	// Changing every purchase control on an already calculated item leaves its ROP intact.
	exec(t, s, `UPDATE items SET exclude='YES',purchase_policy=NULL,product_status='not-available' WHERE stock_id='ON_DEMAND'`)
	s.RecalcROP()
	var rop float64
	if err := s.DB.QueryRow(`SELECT rop FROM items WHERE stock_id='ON_DEMAND'`).Scan(&rop); err != nil || rop != 10 {
		t.Fatalf("seasonal toggle erased ROP=%v err=%v", rop, err)
	}
}

// recalcNowIdx mirrors RecalcROP's currentYearMonth convention (y*12 + m - 1).
func recalcNowIdx() int {
	n := time.Now()
	return n.Year()*12 + int(n.Month()) - 1
}
