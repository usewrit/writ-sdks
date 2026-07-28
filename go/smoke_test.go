package writ

import (
	"context"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"
)

// TestLiveSmoke is an env-gated smoke test against a real local daemon:
//
//	WRIT_SMOKE=1 go test -run TestLiveSmoke ./...
//
// It discovers the daemon like any client would and performs READ-ONLY
// calls: agent status, workflow list, and a one-item run list.
func TestLiveSmoke(t *testing.T) {
	if os.Getenv("WRIT_SMOKE") != "1" {
		t.Skip("set WRIT_SMOKE=1 to run the live smoke test against a local daemon")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	c, err := Discover(ctx)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}

	status, err := c.Agent.Status(ctx)
	if err != nil {
		t.Fatalf("Agent.Status: %v", err)
	}
	if status.Status == "" || status.Version == "" {
		t.Errorf("suspicious agent status: %+v", status)
	}
	t.Logf("agent %s (v%s), active_runs=%d", status.Status, status.Version, status.ActiveRuns)

	workflows, err := c.Workflows.List(ctx, nil)
	if err != nil {
		t.Fatalf("Workflows.List: %v", err)
	}
	if workflows.Count != len(workflows.Data) {
		t.Errorf("count %d != len(data) %d", workflows.Count, len(workflows.Data))
	}
	t.Logf("%d workflows", workflows.Count)

	runs, err := c.Runs.List(ctx, url.Values{"limit": {"1"}})
	if err != nil {
		t.Fatalf("Runs.List: %v", err)
	}
	if len(runs.Data) > 1 {
		t.Errorf("limit=1 returned %d rows", len(runs.Data))
	}
	if len(runs.Data) == 1 {
		if _, ok := runs.Data[0].RowID(); !ok {
			t.Errorf("run feed id %q has no numeric row id", runs.Data[0].ID)
		}
	}
	// Total is *int (nil when the daemon's envelope omits it — see Page). %v on a
	// pointer prints its ADDRESS, so this line used to read `total=0xc000123456`,
	// which looks like a plausible-but-enormous count. The smoke log is the
	// evidence a maintainer reads to decide the run was healthy; it has to say
	// what the daemon actually reported.
	total := "absent"
	if runs.Total != nil {
		total = strconv.Itoa(*runs.Total)
	}
	t.Logf("runs page: count=%d total=%s", runs.Count, total)
}
