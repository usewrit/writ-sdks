package writ

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// (a) Every verb routes to the real /api/targets path and method, and unset
// query params are omitted — "?limit=" is not the same as no limit, and the API
// rejects the empty string for a typed int.
func TestCloudMonitorsRouting(t *testing.T) {
	clearCloudEnv(t)
	type call struct{ method, path, query string }
	var calls []call
	var createBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, call{r.Method, r.URL.Path, r.URL.RawQuery})
		if r.Method == http.MethodPost && r.URL.Path == "/api/targets" {
			_ = json.NewDecoder(r.Body).Decode(&createBody)
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		switch r.URL.Path {
		case "/api/targets":
			if r.Method == http.MethodGet {
				_, _ = w.Write([]byte(`[{"id":412,"url":"https://example.com/pricing","checkType":"content","checkPeriodMs":300000,"enabled":true}]`))
				return
			}
		// The two change routes answer DIFFERENT shapes and must be mocked
		// separately. Serving one camelCase body for both is what hid a shipped
		// bug: the global feed's numeric `id` cannot decode into a Go string, so
		// RecentChanges failed against every real response while the tests passed.
		case "/api/targets/412/changes":
			_, _ = w.Write([]byte(`[{"id":"9","targetId":"412","timestamp":"2026-08-05T00:00:00Z",` +
				`"firstDetectedAt":"2026-08-05T00:00:00Z","lastDetectedAt":"2026-08-05T00:01:00Z",` +
				`"oldContent":"$1,199","newContent":"$1,099","diff":"-+","detectedBy":"1 agent"}]`))
			return
		case "/api/targets/changes/recent":
			// Verbatim RecentChangeInfo (backend/routers/targets.py): snake_case,
			// integer ids, diff_snippet, both detection timestamps.
			_, _ = w.Write([]byte(`[{"id":9,"target_id":412,"target_url":"https://example.com/pricing",` +
				`"target_selector_id":null,"selector_name":null,"diff_snippet":"-$1,199 +$1,099",` +
				`"first_detected_at":"2026-08-05T00:00:00+00:00","last_detected_at":"2026-08-05T00:01:00+00:00"}]`))
			return
		case "/api/targets/412/run":
			_, _ = w.Write([]byte(`{"ok":true,"dispatched":2}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":412,"url":"https://example.com/pricing","checkType":"content","checkPeriodMs":300000,"enabled":true,"changesCount":0}`))
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithAPIKey("wt_test"))
	ctx := ctxT(t)
	period := int64(300000)

	mon, err := c.Cloud.Monitors.Create(ctx, CloudMonitorParams{
		URL: "https://example.com/pricing", CheckType: "content",
		Selector: strPtr(".price"), CheckPeriodMs: &period,
	})
	if err != nil {
		t.Fatal(err)
	}
	// The cloud ACCEPTS snake_case and ANSWERS camelCase — assert both halves.
	if createBody["check_period_ms"] != float64(300000) || createBody["selector"] != ".price" {
		t.Errorf("create body = %+v", createBody)
	}
	if mon.CheckPeriodMs == nil || *mon.CheckPeriodMs != 300000 {
		t.Errorf("monitor = %+v", mon)
	}

	if _, err := c.Cloud.Monitors.List(ctx, nil); err != nil {
		t.Fatal(err)
	}
	limit := 50
	if _, err := c.Cloud.Monitors.List(ctx, &CloudMonitorListOptions{EnabledOnly: true, Limit: &limit}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Cloud.Monitors.Get(ctx, 412); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Cloud.Monitors.Update(ctx, 412, CloudMonitorParams{CheckPeriodMs: &period}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Cloud.Monitors.Toggle(ctx, 412, false); err != nil {
		t.Fatal(err)
	}
	run, err := c.Cloud.Monitors.Run(ctx, 412)
	if err != nil {
		t.Fatal(err)
	}
	if !run.OK || run.Dispatched != 2 {
		t.Errorf("run = %+v", run)
	}
	changes, err := c.Cloud.Monitors.Changes(ctx, 412, &CloudChangeListOptions{Limit: &limit})
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 1 || changes[0].NewContent != "$1,099" {
		t.Errorf("changes = %+v", changes)
	}
	if changes[0].LastDetectedAt != "2026-08-05T00:01:00Z" {
		t.Errorf("per-monitor change must expose the field the feed is ORDERED by: %+v", changes[0])
	}
	recent, err := c.Cloud.Monitors.RecentChanges(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The regression this guards: every field below decoded as a zero value (or
	// failed outright) while the global feed shared the per-monitor type.
	if len(recent) != 1 {
		t.Fatalf("recent = %+v", recent)
	}
	if recent[0].ID != 9 || recent[0].TargetID != 412 {
		t.Errorf("recent ids must decode as integers: %+v", recent[0])
	}
	if recent[0].TargetURL != "https://example.com/pricing" {
		t.Errorf("recent target_url = %q", recent[0].TargetURL)
	}
	if recent[0].DiffSnippet == nil || *recent[0].DiffSnippet != "-$1,199 +$1,099" {
		t.Errorf("recent diff_snippet = %+v", recent[0].DiffSnippet)
	}
	if recent[0].LastDetectedAt != "2026-08-05T00:01:00+00:00" {
		t.Errorf("recent last_detected_at = %q (the cursor field)", recent[0].LastDetectedAt)
	}
	if err := c.Cloud.Monitors.Delete(ctx, 412); err != nil {
		t.Fatal(err)
	}

	want := []call{
		{"POST", "/api/targets", ""},
		{"GET", "/api/targets", ""},
		{"GET", "/api/targets", "enabled_only=true&limit=50"},
		{"GET", "/api/targets/412", ""},
		{"PATCH", "/api/targets/412", ""},
		{"PATCH", "/api/targets/412/toggle", "enabled=false"},
		{"POST", "/api/targets/412/run", ""},
		{"GET", "/api/targets/412/changes", "limit=50"},
		{"GET", "/api/targets/changes/recent", ""},
		{"DELETE", "/api/targets/412", ""},
	}
	if len(calls) != len(want) {
		t.Fatalf("made %d calls, want %d: %+v", len(calls), len(want), calls)
	}
	for i, w := range want {
		if calls[i] != w {
			t.Errorf("call %d = %+v, want %+v", i, calls[i], w)
		}
	}
}

// (b) The keyless tier has no account to own a monitor, so every verb fails
// BEFORE any network call rather than on a 401 the caller cannot act on.
func TestCloudMonitorsKeylessRefusesBeforeRequest(t *testing.T) {
	clearCloudEnv(t)
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithClientID("dev-123"))
	ctx := ctxT(t)
	m := c.Cloud.Monitors

	_, errList := m.List(ctx, nil)
	_, errCreate := m.Create(ctx, CloudMonitorParams{URL: "https://x.test"})
	_, errGet := m.Get(ctx, 1)
	_, errUpdate := m.Update(ctx, 1, CloudMonitorParams{})
	_, errToggle := m.Toggle(ctx, 1, true)
	_, errRun := m.Run(ctx, 1)
	_, errChanges := m.Changes(ctx, 1, nil)
	_, errRecent := m.RecentChanges(ctx, nil)
	errDelete := m.Delete(ctx, 1)

	for name, err := range map[string]error{
		"List": errList, "Create": errCreate, "Get": errGet, "Update": errUpdate,
		"Toggle": errToggle, "Run": errRun, "Changes": errChanges,
		"RecentChanges": errRecent, "Delete": errDelete,
	} {
		var want *APIKeyRequiredError
		if !errors.As(err, &want) {
			t.Errorf("%s error = %v, want *APIKeyRequiredError", name, err)
		}
	}
	if hits != 0 {
		t.Errorf("made %d network calls, want 0", hits)
	}
}

func strPtr(s string) *string { return &s }
