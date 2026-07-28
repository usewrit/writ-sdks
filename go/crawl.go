package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

// CrawlService wraps /v1/crawl (api/v1/crawl.rs) — the Dragnet whole-site
// crawl. One crawl fans a seed URL across a bounded in-process worker pool;
// extracted pages aggregate under a synthetic per-crawl workflow, read back
// through the Data API (GET /v1/workflows/:data_workflow_id/data).
type CrawlService struct {
	c *Client
}

// CrawlJob is a crawl row as the daemon's status view (crawl.rs::to_view):
// the JSON-TEXT scope columns are parsed to real arrays/objects, the brand +
// data_workflow_id alias + is_terminal are attached. SQLite booleans arrive as
// 0/1 ints (same_domain, allow_subdomains, respect_robots, cancel_requested) —
// kept as ints, mirroring the monitor rows. status is an open string enum:
// queued | mapping | crawling | stopping | completed | failed | cancelled
// (the last three terminal).
type CrawlJob struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	SeedURL  string `json:"seed_url"`
	MaxDepth int64  `json:"max_depth"`

	IncludePaths []string `json:"include_paths"`
	ExcludePaths []string `json:"exclude_paths"`

	SameDomain      int64 `json:"same_domain"`
	AllowSubdomains int64 `json:"allow_subdomains"`
	RespectRobots   int64 `json:"respect_robots"`

	ExtractMode   string          `json:"extract_mode"`
	ExtractSchema json.RawMessage `json:"extract_schema"`
	PersonaID     *int64          `json:"persona_id"`

	DelayMS       int64 `json:"delay_ms"`
	MaxConcurrent int64 `json:"max_concurrent"`
	PageBudget    int64 `json:"page_budget"`

	WorkflowID         *int64 `json:"workflow_id"`
	DataWorkflowID     *int64 `json:"data_workflow_id"`
	ConciergeSessionID *int64 `json:"concierge_session_id"`

	Status          string `json:"status"`
	PagesDiscovered int64  `json:"pages_discovered"`
	PagesDone       int64  `json:"pages_done"`
	PagesFailed     int64  `json:"pages_failed"`
	PagesSkipped    int64  `json:"pages_skipped"`
	WorkersActive   int64  `json:"workers_active"`
	CurrentDepth    int64  `json:"current_depth"`
	Error           string `json:"error"`
	CancelRequested int64  `json:"cancel_requested"`

	Brand      string `json:"brand"`
	IsTerminal bool   `json:"is_terminal"`

	CreatedAt   string  `json:"created_at"`
	UpdatedAt   *string `json:"updated_at"`
	StartedAt   *string `json:"started_at"`
	CompletedAt *string `json:"completed_at"`
}

// CrawlList is GET /v1/crawl — the non-Page {"crawls": [...]} envelope
// (mirrors the data resource's {"workflows": [...]} shape), newest first.
type CrawlList struct {
	Crawls []CrawlJob `json:"crawls"`
}

// CrawlStartParams is the body of POST /v1/crawl (crawl.rs::StartCrawlRequest).
// URL is required; the optional fields are pointers/slices so an unset value
// is omitted and the daemon applies its default (extract_mode "markdown",
// max_depth 3, page_budget 500, max_concurrent 4, delay_ms 250, respect_robots
// / same_domain / allow_subdomains true). IncludePaths/ExcludePaths are
// path-regex allow/deny lists.
type CrawlStartParams struct {
	URL             string          `json:"url"`
	Name            string          `json:"name,omitempty"`
	ExtractMode     string          `json:"extract_mode,omitempty"`
	ExtractSchema   json.RawMessage `json:"extract_schema,omitempty"`
	PersonaID       *int64          `json:"persona_id,omitempty"`
	IncludePaths    []string        `json:"include_paths,omitempty"`
	ExcludePaths    []string        `json:"exclude_paths,omitempty"`
	MaxDepth        *int64          `json:"max_depth,omitempty"`
	PageBudget      *int64          `json:"page_budget,omitempty"`
	MaxConcurrent   *int64          `json:"max_concurrent,omitempty"`
	DelayMS         *int64          `json:"delay_ms,omitempty"`
	RespectRobots   *bool           `json:"respect_robots,omitempty"`
	SameDomain      *bool           `json:"same_domain,omitempty"`
	AllowSubdomains *bool           `json:"allow_subdomains,omitempty"`
}

// CrawlCancelResult is POST /v1/crawl/:id/cancel — the refreshed crawl view
// plus CancelRequestedNow (true iff this call flipped it to "stopping"; false
// when it was already terminal). This route always returns the view, never a
// 409; an unknown id is a 404 *APIError.
type CrawlCancelResult struct {
	CrawlJob
	CancelRequestedNow bool `json:"cancel_requested_now"`
}

// List is GET /v1/crawl (?limit, default 50, max 500) — the {"crawls": [...]}
// envelope, not a Page. params may be nil.
func (s *CrawlService) List(ctx context.Context, params url.Values) (*CrawlList, error) {
	var out CrawlList
	if err := s.c.callJSON(ctx, http.MethodGet, "/v1/crawl", params, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Start is POST /v1/crawl — mints the synthetic dataset workflow + crawl row
// and kicks the crawl off in the background, returning the queued status view.
// An empty URL is a 400 *APIError.
func (s *CrawlService) Start(ctx context.Context, params CrawlStartParams) (*CrawlJob, error) {
	var out CrawlJob
	if err := s.c.callJSON(ctx, http.MethodPost, "/v1/crawl", nil, params, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get is GET /v1/crawl/:id — one crawl's live status view (404 if missing).
func (s *CrawlService) Get(ctx context.Context, id int64) (*CrawlJob, error) {
	var out CrawlJob
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/crawl/%d", id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Cancel is POST /v1/crawl/:id/cancel — requests cancellation and returns the
// refreshed view plus CancelRequestedNow (404 if missing).
func (s *CrawlService) Cancel(ctx context.Context, id int64) (*CrawlCancelResult, error) {
	var out CrawlCancelResult
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/crawl/%d/cancel", id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
