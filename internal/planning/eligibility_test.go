package planning

import "testing"

func TestSharedEligibilityRules(t *testing.T) {
	for _, exclude := range []string{"1", "TRUE", "YES", "EXCLUDE", " true ", "Yes", " exclude "} {
		if !Excluded(exclude) || RoutineEligible("routine", exclude, "", "Available", "", "") {
			t.Errorf("exclude %q was not normalized", exclude)
		}
	}
	for _, exclude := range []string{"", "0", "FALSE", "no"} {
		if Excluded(exclude) || !RoutineEligible("routine", exclude, "", "Available", "", "") {
			t.Errorf("exclude %q blocks routine item", exclude)
		}
	}
	for _, tc := range []struct {
		behaviour string
		want      bool
	}{
		{"", true}, {"Standard / Pack", true}, {" in-house USE ", true},
		{"Service", false}, {"Asset", false}, {"Unavailable", false}, {"Exclude", false}, {"Unknown", false},
	} {
		if got := RoutineEligible("routine", "0", tc.behaviour, "Available", "", ""); got != tc.want {
			t.Errorf("behaviour %q eligible=%t", tc.behaviour, got)
		}
	}
	for _, tc := range []struct {
		status      string
		unavailable bool
	}{
		{"Available", false}, {" available ", false}, {"", false}, {"Unknown", false},
		{"not-available", true}, {" NOT-AVAILABLE ", true}, {"Unavailable", true}, {"unavailable", true},
	} {
		if NotAvailable(tc.status) != tc.unavailable || RoutineEligible("routine", "0", "", tc.status, "", "") == tc.unavailable {
			t.Errorf("availability %q", tc.status)
		}
	}
	for _, policy := range []string{"routine", "on_demand", "do_not_reorder", "", "unknown"} {
		if RoutineEligible(policy, "0", "", "Available", "", "") != (policy == "routine") {
			t.Errorf("routine policy %q", policy)
		}
		if Purchasable(policy) != (policy == "routine" || policy == "on_demand") {
			t.Errorf("purchase policy %q", policy)
		}
	}
	for _, tc := range [][2]string{{"SURGICAL supplies", ""}, {"", "surgical tools"}} {
		if RoutineEligible("routine", "0", "", "Available", tc[0], tc[1]) || !Purchasable("on_demand") {
			t.Errorf("surgical routine vs explicit: %v", tc)
		}
	}
	for _, tc := range []struct {
		stock, rop float64
		want       bool
	}{{9, 10, true}, {10, 10, false}, {11, 10, false}, {0, 0, false}, {0, 10, true}, {9.999, 10, true}} {
		if BelowROP(tc.stock, tc.rop) != tc.want {
			t.Errorf("threshold %v < %v", tc.stock, tc.rop)
		}
	}
}
