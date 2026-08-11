package writ

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// crawlView is the daemon status view (crawl.rs::to_view): scope columns
// already parsed to arrays, brand + data_workflow_id alias + is_terminal
// attached, SQLite booleans as 0/1 ints.
const crawlView = `{
	"id":7,"name":"Dragnet: example.com","seed_url":"https://example.com",
	"include_paths":["^/docs"],"exclude_paths":[],
	"max_depth":3,"same_domain":1,"allow_subdomains":1,
	"extract_mode":"markdown","extract_schema":null,"persona_id":null,
	"respect_robots":1,"delay_ms":250,"max_concurrent":4,"page_budget":500,
	"workflow_id":42,"data_workflow_id":42,"concierge_session_id":null,
	"status":"queued","pages_discovered":0,"pages_done":0,"pages_failed":0,
	"pages_skipped":0,"workers_active":0,"current_depth":0,"error":null,
	"cancel_requested":0,"brand":"Dragnet","is_terminal":false,
	"created_at":"2026-07-13T00:00:00Z","updated_at":null,
	"started_at":null,"completed_at":null
}`

// List unwraps the non-Page {"crawls": [...]} envelope.
func TestCrawlList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/crawl" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("limit") != "10" {
			t.Errorf("limit = %q", r.URL.Query().Get("limit"))
		}
		_, _ = w.Write([]byte(`{"crawls":[` + crawlView + `]}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	list, err := c.Crawl.List(ctxT(t), map[string][]string{"limit": {"10"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Crawls) != 1 {
		t.Fatalf("crawls = %+v", list.Crawls)
	}
	job := list.Crawls[0]
	if job.ID != 7 || job.Brand.Crawl != "Dragnet" || job.SeedURL != "https://example.com" {
		t.Errorf("job = %+v", job)
	}
	if len(job.IncludePaths) != 1 || job.IncludePaths[0] != "^/docs" {
		t.Errorf("include_paths = %v", job.IncludePaths)
	}
	if job.SameDomain != 1 || job.RespectRobots != 1 || job.IsTerminal {
		t.Errorf("flags = %+v", job)
	}
}

// Start posts the body and returns the queued view (brand + data_workflow_id).
func TestCrawlStart(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/crawl" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["url"] != "https://example.com" {
			t.Errorf("url = %v", body["url"])
		}
		if body["max_depth"] != float64(2) {
			t.Errorf("max_depth = %v", body["max_depth"])
		}
		inc, _ := body["include_paths"].([]any)
		if len(inc) != 1 || inc[0] != "^/docs" {
			t.Errorf("include_paths = %v", body["include_paths"])
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(crawlView))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	depth := int64(2)
	job, err := c.Crawl.Start(ctxT(t), CrawlStartParams{
		URL:          "https://example.com",
		MaxDepth:     &depth,
		IncludePaths: []string{"^/docs"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if job.Brand.Crawl != "Dragnet" {
		t.Errorf("brand = %q", job.Brand.Crawl)
	}
	if job.DataWorkflowID == nil || *job.DataWorkflowID != 42 {
		t.Errorf("data_workflow_id = %v", job.DataWorkflowID)
	}
	if job.WorkflowID == nil || *job.WorkflowID != 42 {
		t.Errorf("workflow_id = %v", job.WorkflowID)
	}
	if job.Status != "queued" {
		t.Errorf("status = %q", job.Status)
	}
}

// Get returns one crawl's view.
func TestCrawlGet(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/crawl/7" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(crawlView))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	job, err := c.Crawl.Get(ctxT(t), 7)
	if err != nil {
		t.Fatal(err)
	}
	if job.ID != 7 || job.Brand.Crawl != "Dragnet" {
		t.Errorf("job = %+v", job)
	}
}

// Cancel returns the refreshed view plus CancelRequestedNow.
func TestCrawlCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/crawl/7/cancel" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		var view map[string]any
		_ = json.Unmarshal([]byte(crawlView), &view)
		view["status"] = "stopping"
		view["cancel_requested"] = 1
		view["cancel_requested_now"] = true
		b, _ := json.Marshal(view)
		_, _ = w.Write(b)
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	res, err := c.Crawl.Cancel(ctxT(t), 7)
	if err != nil {
		t.Fatal(err)
	}
	if !res.CancelRequestedNow {
		t.Errorf("cancel_requested_now = %v", res.CancelRequestedNow)
	}
	if res.Status != "stopping" || res.ID != 7 || res.CancelRequested != 1 {
		t.Errorf("res = %+v", res.CrawlJob)
	}
}

// An unknown crawl id is a 404 *APIError.
func TestCrawlNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found: crawl 999","code":"not_found"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	_, err := c.Crawl.Get(ctxT(t), 999)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 404 {
		t.Fatalf("want 404 *APIError, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// saved crawls — the callable crawl API and its MaxAge freshness contract
// ---------------------------------------------------------------------------

const definitionView = `{
	"id":4,"slug":"docs","name":"Docs","seed_url":"https://example.com/docs",
	"config":{"url":"https://example.com/docs","page_budget":200},
	"default_max_age_seconds":86400,
	"run_url":"/api/crawl/definitions/docs/run",
	"data_url":"/api/crawl/definitions/docs/data"
}`

// A freshness HIT must be distinguishable from a fresh crawl and carry the age —
// a caller cannot reason about staleness without it.
func TestRunSavedFreshnessHit(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/crawl/definitions/docs/run" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"cached":true,
			"_cache":{"hit":true,"age_seconds":1200,"source_crawl_id":9},
			"definition":` + definitionView + `,"crawl":` + crawlView + `,
			"data":{"columns":["url"],"rows":[{"url":"https://example.com/docs"}]}}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	res, err := c.Crawl.RunSaved(ctxT(t), "docs", RunSavedCrawlParams{MaxAge: 24 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Cached || res.Cache == nil || !res.Cache.Hit {
		t.Errorf("expected a cache hit, got cached=%v cache=%+v", res.Cached, res.Cache)
	}
	if res.Cache.AgeSeconds != 1200 || res.Cache.SourceCrawlID != 9 {
		t.Errorf("cache stamp = %+v", res.Cache)
	}
	if res.Data == nil || len(res.Data.Rows) != 1 {
		t.Errorf("a hit must hand back the collected rows: %+v", res.Data)
	}
	// MaxAge is a DELIVERY control — seconds on the wire, and the crawl settings
	// (the saved ones) must not be restated.
	if gotBody["max_age"] != float64(86400) {
		t.Errorf("max_age = %v, want 86400", gotBody["max_age"])
	}
	if _, restated := gotBody["url"]; restated {
		t.Error("a run must not restate the saved crawl config")
	}
}

// A cold call's 202 handle is the ANSWER — it must not be an error, or every
// caller would need an error branch just to learn what was started.
func TestRunSavedColdDispatchReturnsHandle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"cached":false,"_cache":{"hit":false},
			"definition":` + definitionView + `,"crawl":` + crawlView + `,
			"status_url":"/api/crawl/7"}`))
	}))
	defer srv.Close()

	res, err := testClient(srv.URL).Crawl.RunSaved(ctxT(t), "docs", RunSavedCrawlParams{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Cached || res.Data != nil {
		t.Errorf("a cold dispatch has collected nothing yet: %+v", res)
	}
	if res.StatusURL != "/api/crawl/7" {
		t.Errorf("status_url = %q", res.StatusURL)
	}
}

// A waiting call that outlives its budget is a typed timeout carrying the crawl
// id, so the work already started stays collectable.
func TestRunSavedWaitOverrunIsRunTimeoutError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["wait"] != true || body["timeout"] != float64(30) {
			t.Errorf("wait/timeout did not reach the wire: %+v", body)
		}
		w.WriteHeader(http.StatusGatewayTimeout)
		_, _ = w.Write([]byte(`{"crawl_id":11,"status_url":"/api/crawl/11","retryable":true}`))
	}))
	defer srv.Close()

	_, err := testClient(srv.URL).Crawl.RunSaved(ctxT(t), "docs", RunSavedCrawlParams{
		Wait: true, Timeout: 30 * time.Second,
	})
	var timeout *RunTimeoutError
	if !errors.As(err, &timeout) {
		t.Fatalf("expected *RunTimeoutError, got %v", err)
	}
	if timeout.RunID != 11 {
		t.Errorf("RunID = %d, want 11 (the crawl must stay collectable)", timeout.RunID)
	}
}

// Saving nothing is always a mistake — caught before any HTTP.
func TestSaveRequiresConfigOrSourceCrawl(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Error("Save must not reach the network with no settings")
	}))
	defer srv.Close()

	if _, err := testClient(srv.URL).Crawl.Save(ctxT(t), SaveCrawlParams{Name: "x"}); err == nil {
		t.Fatal("expected an error")
	}
}

// FromCrawlID must go over the wire WITHOUT a client-rebuilt config, which would
// silently substitute defaults for the knobs a status view never echoes.
func TestSaveFromCrawlSendsFromCrawlID(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(definitionView))
	}))
	defer srv.Close()

	if _, err := testClient(srv.URL).Crawl.Save(ctxT(t), SaveCrawlParams{
		Name: "Docs", FromCrawlID: 9,
	}); err != nil {
		t.Fatal(err)
	}
	if gotBody["from_crawl_id"] != float64(9) {
		t.Errorf("from_crawl_id = %v", gotBody["from_crawl_id"])
	}
	if _, invented := gotBody["config"]; invented {
		t.Error("the SDK must not invent a config when capturing an existing crawl")
	}
}

// Reading already-collected data must never be able to start a crawl.
func TestSavedDataIsARead(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Query().Get("limit") != "25" {
			t.Errorf("limit = %q", r.URL.Query().Get("limit"))
		}
		_, _ = w.Write([]byte(`{"definition":` + definitionView + `,"age_seconds":4000}`))
	}))
	defer srv.Close()

	res, err := testClient(srv.URL).Crawl.SavedData(ctxT(t), "docs",
		map[string][]string{"limit": {"25"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.AgeSeconds == nil || *res.AgeSeconds != 4000 {
		t.Errorf("age_seconds = %v", res.AgeSeconds)
	}
}

// The workflow half of the same contract: MaxAge is a query control, never a run
// input — inside inputs it would feed the workflow a stray value AND split the
// cache per distinct window.
func TestWorkflowRunMaxAgeIsAQueryControl(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("max_age") != "600" {
			t.Errorf("max_age query = %q", r.URL.Query().Get("max_age"))
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"run_id":5,"status":"running"}`))
	}))
	defer srv.Close()

	if _, err := testClient(srv.URL).Workflows.Run(ctxT(t), 3, &RunOptions{
		Inputs: map[string]any{"city": "paris"},
		MaxAge: 10 * time.Minute,
	}); err != nil {
		t.Fatal(err)
	}
	if _, leaked := gotBody["max_age"]; leaked {
		t.Error("max_age must not appear in the run body")
	}
}

// Brand arrives in two shapes: the LOCAL daemon sends a bare string, Writ Cloud
// sends {"crawl","agent"}. Typing it as a plain string broke Cloud.Crawl outright
// against the real coordinator, so lock BOTH shapes here.
func TestBrandAcceptsStringAndObject(t *testing.T) {
	var fromDaemon CrawlJob
	if err := json.Unmarshal([]byte(`{"id":7,"brand":"Dragnet"}`), &fromDaemon); err != nil {
		t.Fatalf("daemon shape: %v", err)
	}
	if fromDaemon.Brand.Crawl != "Dragnet" || fromDaemon.Brand.Agent != "" {
		t.Errorf("daemon brand = %+v", fromDaemon.Brand)
	}

	var fromCloud CrawlJob
	if err := json.Unmarshal([]byte(`{"id":7,"brand":{"crawl":"Dragnet","agent":"Scribe"}}`), &fromCloud); err != nil {
		t.Fatalf("cloud shape: %v", err)
	}
	if fromCloud.Brand.Crawl != "Dragnet" || fromCloud.Brand.Agent != "Scribe" {
		t.Errorf("cloud brand = %+v", fromCloud.Brand)
	}

	// A missing or null brand is a missing display label, not a broken crawl.
	var absent CrawlJob
	if err := json.Unmarshal([]byte(`{"id":7,"brand":null}`), &absent); err != nil {
		t.Fatalf("null brand: %v", err)
	}
	if absent.Brand.Crawl != "" {
		t.Errorf("null brand = %+v", absent.Brand)
	}

	// Round-trip: each shape marshals back to the shape it came from.
	daemonOut, _ := json.Marshal(fromDaemon.Brand)
	if string(daemonOut) != `"Dragnet"` {
		t.Errorf("daemon round-trip = %s", daemonOut)
	}
	cloudOut, _ := json.Marshal(fromCloud.Brand)
	if string(cloudOut) != `{"agent":"Scribe","crawl":"Dragnet"}` {
		t.Errorf("cloud round-trip = %s", cloudOut)
	}
}

// A 402 is either a wallet problem or a PLAN CEILING, and they need different
// fixes. The plan denial is the one that reports a numeric `limit`.
func TestPaymentRequiredSplitsPlanLimitFromCredits(t *testing.T) {
	planErr := cloudErrorFrom(402, []byte(
		`{"detail":"Check interval too short. Minimum for your plan: 10s.","code":"interval_too_short","current":1000,"limit":10000,"upgrade_hint":"growth"}`))
	var plan *PlanLimitError
	if !errors.As(planErr, &plan) {
		t.Fatalf("plan denial mapped to %T, want *PlanLimitError", planErr)
	}
	if plan.Code != "interval_too_short" || plan.Limit != 10000 || plan.Current != 1000 || plan.UpgradeHint != "growth" {
		t.Errorf("plan error = %+v", plan)
	}

	creditErr := cloudErrorFrom(402, []byte(
		`{"detail":{"message":"allotment spent","code":"insufficient_credits"}}`))
	var credits *InsufficientCreditsError
	if !errors.As(creditErr, &credits) {
		t.Fatalf("credits 402 mapped to %T, want *InsufficientCreditsError", creditErr)
	}
}
