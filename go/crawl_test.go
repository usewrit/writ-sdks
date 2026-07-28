package writ

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
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
	if job.ID != 7 || job.Brand != "Dragnet" || job.SeedURL != "https://example.com" {
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
	if job.Brand != "Dragnet" {
		t.Errorf("brand = %q", job.Brand)
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
	if job.ID != 7 || job.Brand != "Dragnet" {
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
