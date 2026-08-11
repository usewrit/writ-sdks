package writ

import (
	"errors"
	"os"
	"testing"
)

// Env-gated LIVE test: drives client.Cloud.Monitors and client.Cloud.Crawl
// against a REAL running coordinator. No stub server — this is the test that
// would catch a wrong path, a wrong JSON casing, or a scope the route map never
// mapped.
//
//	WRIT_E2E=1 WRIT_CLOUD_URL=http://localhost:8000 WRIT_API_KEY=wt_… go test -run Live -v ./...
//
// The key needs monitors:read/write/execute/delete and crawl:read/execute.
// Skipped (not failed) when WRIT_E2E is unset so `go test ./...` stays hermetic.
func TestCloudMonitorsLive(t *testing.T) {
	if os.Getenv("WRIT_E2E") != "1" {
		t.Skip("set WRIT_E2E=1 (plus WRIT_CLOUD_URL/WRIT_API_KEY) to run against a live coordinator")
	}
	// example.com is the one seed guaranteed to answer 200 — the API fetches the
	// page to establish a baseline, so a 404 seed is rejected outright.
	const seed = "https://example.com"

	c := New(
		WithCloudURL(envOr("WRIT_CLOUD_URL", "http://localhost:8000")),
		WithAPIKey(os.Getenv("WRIT_API_KEY")),
	)
	if c.Cloud.Tier() != TierMetered {
		t.Fatalf("tier = %q, want metered (is WRIT_API_KEY set?)", c.Cloud.Tier())
	}
	ctx := ctxT(t)
	m := c.Cloud.Monitors

	period := int64(300000)
	mon, err := m.Create(ctx, CloudMonitorParams{
		URL: seed, CheckType: "content",
		Selector: strPtr("h1"), CheckPeriodMs: &period,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Never leave a monitor behind, even if an assertion below fails.
	defer func() { _ = m.Delete(ctx, mon.ID) }()

	// The struct tags in cloud_monitors.go claim camelCase — assert the server agrees.
	if mon.CheckPeriodMs == nil || *mon.CheckPeriodMs != 300000 {
		t.Errorf("checkPeriodMs = %v, want 300000", mon.CheckPeriodMs)
	}
	if mon.Selector == nil || *mon.Selector != "h1" {
		t.Errorf("selector = %v, want h1", mon.Selector)
	}
	if !mon.Enabled {
		t.Error("a new monitor should be enabled")
	}

	limit := 100
	listed, err := m.List(ctx, &CloudMonitorListOptions{Limit: &limit})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !containsMonitor(listed, mon.ID) {
		t.Errorf("list did not contain the monitor just created (%d rows)", len(listed))
	}

	got, err := m.Get(ctx, mon.ID)
	if err != nil || got.URL != seed {
		t.Fatalf("get: %v (url=%q)", err, got.URL)
	}

	slower := int64(600000)
	upd, err := m.Update(ctx, mon.ID, CloudMonitorParams{CheckPeriodMs: &slower})
	if err != nil || upd.CheckPeriodMs == nil || *upd.CheckPeriodMs != 600000 {
		t.Fatalf("update: %v (period=%v)", err, upd.CheckPeriodMs)
	}

	off, err := m.Toggle(ctx, mon.ID, false)
	if err != nil || off.Enabled {
		t.Fatalf("toggle(false): %v (enabled=%v)", err, off.Enabled)
	}
	on, err := m.Toggle(ctx, mon.ID, true)
	if err != nil || !on.Enabled {
		t.Fatalf("toggle(true): %v (enabled=%v)", err, on.Enabled)
	}

	if _, err := m.Run(ctx, mon.ID); err != nil {
		t.Fatalf("run: %v", err)
	}
	five := 5
	if _, err := m.Changes(ctx, mon.ID, &CloudChangeListOptions{Limit: &five}); err != nil {
		t.Fatalf("changes: %v", err)
	}
	if _, err := m.RecentChanges(ctx, &CloudChangeListOptions{Limit: &five}); err != nil {
		t.Fatalf("recent changes: %v", err)
	}

	// The plan floor is ENFORCED, not clamped: a sub-floor interval must surface
	// as an error, never as a quietly slowed-down monitor.
	tooFast := int64(1000)
	if _, err := m.Create(ctx, CloudMonitorParams{URL: seed, CheckPeriodMs: &tooFast}); err == nil {
		t.Error("a sub-floor check_period_ms was accepted; it must be rejected")
	} else {
		// It is a PLAN CEILING, not a wallet balance: mapping it to
		// InsufficientCredits would send the caller to top up for nothing.
		var planErr *PlanLimitError
		if !errors.As(err, &planErr) {
			t.Errorf("sub-floor error = %T (%v), want *PlanLimitError", err, err)
		} else if planErr.Code != "interval_too_short" || planErr.Limit == 0 {
			t.Errorf("plan error lost its structure: %+v", planErr)
		}
	}

	if err := m.Delete(ctx, mon.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	after, err := m.List(ctx, &CloudMonitorListOptions{Limit: &limit})
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	if containsMonitor(after, mon.ID) {
		t.Error("the monitor is still listed after delete")
	}

	depth, budget := int64(0), int64(1)
	job, err := c.Cloud.Crawl(ctx, CrawlStartParams{URL: seed, MaxDepth: &depth, PageBudget: &budget})
	if err != nil {
		t.Fatalf("crawl: %v", err)
	}
	status, err := c.Cloud.CrawlStatus(ctx, job.ID)
	if err != nil {
		t.Fatalf("crawl status: %v", err)
	}
	if status.SeedURL == "" {
		t.Errorf("crawl status carried no seed_url: %+v", status)
	}
}

func containsMonitor(rows []CloudMonitor, id int64) bool {
	for _, r := range rows {
		if r.ID == id {
			return true
		}
	}
	return false
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
