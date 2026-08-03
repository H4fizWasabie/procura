package planning

import "testing"

// Pins velocity classification + cap months to GAS MOV_CONFIG values.
func TestVelocityClassAndCaps(t *testing.T) {
	cases := []struct {
		tr   float64
		want string
	}{
		{0.50, "FAST"},
		{0.49, "MEDIUM"},
		{0.10, "MEDIUM"},
		{0.09, "SLOW"},
	}
	for _, c := range cases {
		if got := velocityClass(c.tr); got != c.want {
			t.Errorf("velocityClass(%v) = %v, want %v", c.tr, got, c.want)
		}
	}

	caps := map[string]float64{"FAST": 1.5, "MEDIUM": 1.5, "SLOW": 2.0}
	for cls, want := range caps {
		if got := capMonthsFor(cls); got != want {
			t.Errorf("capMonthsFor(%q) = %v, want %v", cls, got, want)
		}
	}
}
