package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
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

	Brand      Brand `json:"brand"`
	IsTerminal bool  `json:"is_terminal"`

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

// ---------------------------------------------------------------------------
// saved crawls (the callable crawl API)
//
// A crawl row is one RUN and its id dies with that run. A SAVED crawl owns the
// settings under a stable slug, so it can be re-run with exactly those settings
// and — with MaxAge — answered from the data it already collected.
// ---------------------------------------------------------------------------

// Saved is GET /v1/crawl/definitions (?limit) — the {"definitions": [...]}
// envelope, not a Page. params may be nil.
func (s *CrawlService) Saved(ctx context.Context, params url.Values) (*CrawlDefinitionList, error) {
	var out CrawlDefinitionList
	if err := s.c.callJSON(ctx, http.MethodGet, "/v1/crawl/definitions", params, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Save is POST /v1/crawl/definitions — save a crawl configuration so it becomes
// callable and re-runnable.
//
// Set exactly one of params.Config or params.FromCrawlID. Prefer FromCrawlID when
// capturing an existing crawl: its status view does not echo every knob it ran
// with (politeness, shard sizing, path filters), so a config rebuilt client-side
// would silently substitute defaults and save a crawl that behaves differently.
func (s *CrawlService) Save(ctx context.Context, params SaveCrawlParams) (*CrawlDefinition, error) {
	if params.Config == nil && params.FromCrawlID == 0 {
		// Fail here rather than POST a definition with no settings, which would only
		// break later at run time, far from the mistake.
		return nil, fmt.Errorf("writ: Save needs either Config or FromCrawlID")
	}
	var out CrawlDefinition
	if err := s.c.callJSON(ctx, http.MethodPost, "/v1/crawl/definitions", nil, params, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SavedGet is GET /v1/crawl/definitions/:ref — one saved crawl by id or slug.
func (s *CrawlService) SavedGet(ctx context.Context, ref string) (*CrawlDefinition, error) {
	var out CrawlDefinition
	path := "/v1/crawl/definitions/" + url.PathEscape(ref)
	if err := s.c.callJSON(ctx, http.MethodGet, path, nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SavedUpdate is PATCH /v1/crawl/definitions/:ref — sparse update; omitted fields
// stay untouched.
func (s *CrawlService) SavedUpdate(ctx context.Context, ref string, patch SaveCrawlParams) (*CrawlDefinition, error) {
	var out CrawlDefinition
	path := "/v1/crawl/definitions/" + url.PathEscape(ref)
	if err := s.c.callJSON(ctx, http.MethodPatch, path, nil, patch, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SavedDelete is DELETE /v1/crawl/definitions/:ref — remove a saved crawl. Its
// past runs and their collected data survive; only the reusable configuration
// goes away.
func (s *CrawlService) SavedDelete(ctx context.Context, ref string) error {
	path := "/v1/crawl/definitions/" + url.PathEscape(ref)
	return s.c.callJSON(ctx, http.MethodDelete, path, nil, nil, nil)
}

// RunSaved is POST /v1/crawl/definitions/:ref/run — run a saved crawl, reusing
// its data when MaxAge allows.
//
// MaxAge is a freshness contract, not a cache flag: "data collected within this
// window is acceptable, otherwise go get it again". On a hit the previous run's
// rows come back inline with Cache.Hit true and nothing is crawled or metered;
// zero always re-crawls.
//
// A cold call returns a dispatched crawl (Cached false, Data nil) — a whole-site
// crawl outlives an HTTP request, so poll StatusURL or set Wait. With Wait an
// overrun is a *RunTimeoutError carrying the crawl id, so work already started
// stays collectable instead of being blindly re-run:
//
//	res, err := c.Crawl.RunSaved(ctx, "docs", writ.RunSavedCrawlParams{MaxAge: 24 * time.Hour})
//	var timeout *writ.RunTimeoutError
//	if errors.As(err, &timeout) {
//	    job, _ := c.Crawl.Get(ctx, timeout.RunID) // still crawling — poll, don't retry
//	}
func (s *CrawlService) RunSaved(ctx context.Context, ref string, params RunSavedCrawlParams) (*SavedCrawlRun, error) {
	body := map[string]any{}
	if params.MaxAge > 0 {
		body["max_age"] = int64(params.MaxAge / time.Second)
	}
	if params.Wait {
		body["wait"] = true
		if params.Timeout > 0 {
			body["timeout"] = int64(params.Timeout / time.Second)
		}
	}
	if params.Limit > 0 {
		body["limit"] = params.Limit
	}

	path := "/v1/crawl/definitions/" + url.PathEscape(ref) + "/run"
	// 504 is a documented, RECOVERABLE outcome of a WAITING call (the crawl is still
	// converging and its id is still valid), so it is allowed through the transport's
	// error mapping and converted below. A generic *APIError would throw away the
	// crawl id — the only thing that makes it recoverable. Without Wait there is
	// nothing to time out, so a 504 there is a real gateway failure and stays one.
	allow := func(int) bool { return false }
	if params.Wait {
		allow = func(code int) bool { return code == http.StatusGatewayTimeout }
	}
	status, data, err := s.c.call(ctx, http.MethodPost, path, nil, body, allow)
	if err != nil {
		return nil, err
	}
	var out SavedCrawlRun
	if err := unmarshalResponse(data, &out); err != nil {
		return nil, err
	}
	if status == http.StatusGatewayTimeout {
		id := out.CrawlID
		if id == 0 {
			id = out.Crawl.ID
		}
		return nil, &RunTimeoutError{RunID: id, StatusURL: out.StatusURL}
	}
	return &out, nil
}

// SavedData is GET /v1/crawl/definitions/:ref/data — the rows a saved crawl
// already collected on its latest completed run. A pure read at any age; never
// starts a crawl. Use RunSaved with MaxAge when you need a recency guarantee.
func (s *CrawlService) SavedData(ctx context.Context, ref string, params url.Values) (*SavedCrawlData, error) {
	var out SavedCrawlData
	path := "/v1/crawl/definitions/" + url.PathEscape(ref) + "/data"
	if err := s.c.callJSON(ctx, http.MethodGet, path, params, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Brand is the display naming a crawl view carries, and it arrives in TWO
// shapes because two different services answer with it:
//
//   - the LOCAL daemon sends a bare string — "Dragnet"
//   - Writ Cloud sends an object — {"crawl": "Dragnet", "agent": "Scribe"}
//
// Typing this as a plain string made CloudService.Crawl fail outright against
// the real cloud ("cannot unmarshal object into Go struct field CrawlJob.brand
// of type string"); a stub server that hand-wrote the body never showed it.
// Accepting both keeps ONE CrawlJob decoding from either venue, which is the
// whole point of the local/cloud symmetry.
type Brand struct {
	// Crawl is the crawler's display name (both shapes carry it).
	Crawl string
	// Agent is the AI-executor display name — cloud only, empty from the daemon.
	Agent string
}

// UnmarshalJSON accepts the bare-string form and the object form. An absent or
// null brand decodes to the zero Brand rather than an error: it is a display
// label, and a missing label must never fail a whole crawl view.
func (b *Brand) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		*b = Brand{}
		return nil
	}
	var name string
	if err := json.Unmarshal(data, &name); err == nil {
		*b = Brand{Crawl: name}
		return nil
	}
	var pair struct {
		Crawl string `json:"crawl"`
		Agent string `json:"agent"`
	}
	if err := json.Unmarshal(data, &pair); err != nil {
		return fmt.Errorf("writ: brand is neither a string nor {crawl,agent}: %w", err)
	}
	*b = Brand{Crawl: pair.Crawl, Agent: pair.Agent}
	return nil
}

// MarshalJSON round-trips the shape it came from: the object form when an agent
// name is present, the bare string otherwise.
func (b Brand) MarshalJSON() ([]byte, error) {
	if b.Agent != "" {
		return json.Marshal(map[string]string{"crawl": b.Crawl, "agent": b.Agent})
	}
	return json.Marshal(b.Crawl)
}

// String is the crawler's display name, so a Brand prints like the plain string
// this field used to be.
func (b Brand) String() string { return b.Crawl }
