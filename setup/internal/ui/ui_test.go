package ui

import (
	"strings"
	"testing"

	"github.com/umuryavuz96/server-os/setup/internal/checks"
)

func TestRunPlainStopsOnFailure(t *testing.T) {
	ran := 0
	step := func(st Status, stop bool) Step {
		return Step{Title: "s", StopOnFail: stop, Run: func(log func(string)) Result { ran++; log("x"); return Result{Status: st} }}
	}
	res := runPlain([]Step{step(Done, true), step(Failed, true), step(Done, false)})
	if ran != 2 || res[2].Status != Skipped {
		t.Fatalf("ran %d, results %+v", ran, res)
	}
	res = runPlain([]Step{step(Failed, false), step(Done, false)})
	if res[1].Status != Done {
		t.Fatalf("non-stopping failure should continue: %+v", res)
	}
}

func TestCheckTable(t *testing.T) {
	out := CheckTable([]checks.Result{
		{Name: "Bun", Status: checks.OK, Detail: "1.3.1", Required: true},
		{Name: "Docker", Status: checks.Warn, Detail: "not found", Fix: "install it"},
	})
	for _, want := range []string{"Bun", "1.3.1", "Docker", "(optional)", "install it"} {
		if !strings.Contains(out, want) {
			t.Errorf("table missing %q:\n%s", want, out)
		}
	}
}
