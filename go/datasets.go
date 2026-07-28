package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// DatasetsService wraps /v1/datasets (api/v1/datasets.rs) — the unified
// dataset surface over both crawl and workflow extracted data. A dataset is
// the aggregate table a source (a whole-site crawl or a workflow) has
// accumulated across its runs; List enumerates them, Get returns one's schema
// (columns + facets), Records reads the rows, and Export streams the whole
// table as CSV or JSON.
type DatasetsService struct {
	c *Client
}

// Dataset is one row of GET /v1/datasets — a source that owns extracted data.
// SourceType is an open string enum: "crawl" | "workflow". LastUpdated is the
// most-recent run timestamp (null until the first run lands).
type Dataset struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	SourceType  string  `json:"source_type"`
	RunCount    int64   `json:"run_count"`
	LastUpdated *string `json:"last_updated"`
	Origin      string  `json:"origin"`
}

// DatasetList is GET /v1/datasets — the {"datasets": [...]} envelope (mirrors
// the crawl resource's {"crawls": [...]} shape), not a Page.
type DatasetList struct {
	Datasets []Dataset `json:"datasets"`
}

// DatasetMeta is GET /v1/datasets/:id — a dataset's metadata and schema. The
// Columns and Facets shapes are dynamic (they depend on what the source
// extracted), so they stay json.RawMessage; the scalar fields are typed.
// Truncated reports whether the schema view was capped.
type DatasetMeta struct {
	ID         int64           `json:"id"`
	Name       string          `json:"name"`
	SourceType string          `json:"source_type"`
	Columns    json.RawMessage `json:"columns"`
	Facets     json.RawMessage `json:"facets"`
	RowCount   int64           `json:"row_count"`
	RunCount   int64           `json:"run_count"`
	Truncated  bool            `json:"truncated"`
}

// DatasetSearchResult is the response of the two /search endpoints — the
// full-text search result across one or all datasets. Query echoes the raw
// query; Terms are the tokenized search terms. Total is the number of matching
// runs, Truncated reports whether Results was capped, and ScannedRuns is how
// many runs were examined to produce the hits.
type DatasetSearchResult struct {
	Query       string             `json:"query"`
	Terms       []string           `json:"terms"`
	Results     []DatasetSearchHit `json:"results"`
	Total       int                `json:"total"`
	Truncated   bool               `json:"truncated"`
	ScannedRuns int                `json:"scanned_runs"`
}

// DatasetSearchHit is one row of DatasetSearchResult.Results — a matching run
// with the dataset it belongs to. Fields is the matched run's dynamic record
// document and Highlight the match context, both left as raw JSON since their
// shapes depend on the source's extracted schema.
type DatasetSearchHit struct {
	Dataset struct {
		ID         int64   `json:"id"`
		Name       *string `json:"name"`
		SourceType string  `json:"source_type"`
	} `json:"dataset"`
	RunID     *int64          `json:"run_id"`
	RunAt     *string         `json:"run_at"`
	Fields    json.RawMessage `json:"fields"`
	Highlight json.RawMessage `json:"highlight"`
}

// List is GET /v1/datasets — the {"datasets": [...]} envelope. params may be
// nil.
func (s *DatasetsService) List(ctx context.Context, params url.Values) (*DatasetList, error) {
	var out DatasetList
	if err := s.c.callJSON(ctx, http.MethodGet, "/v1/datasets", params, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get is GET /v1/datasets/:id — one dataset's metadata + schema (404 if
// missing).
func (s *DatasetsService) Get(ctx context.Context, id int64) (*DatasetMeta, error) {
	var out DatasetMeta
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/datasets/%d", id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Records is GET /v1/datasets/:id/records — the dataset's rows plus its column
// schema and total ({"dataset": {...}, "columns", "records", "total", ...}).
// The table shape is dynamic, so the raw JSON document is returned. Query
// params (all optional): q, filter, filters, sort_by, sort_dir, limit, offset,
// include_inputs, collection. params may be nil.
func (s *DatasetsService) Records(ctx context.Context, id int64, params url.Values) (json.RawMessage, error) {
	if isTextFormat(params) {
		return nil, fmt.Errorf(
			"writ: format=%q renders text, not JSON — use RecordsText instead",
			params.Get("format"))
	}
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/datasets/%d/records", id), params, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Export is GET /v1/datasets/:id/export — the exported table (CSV or JSON per
// the "format" query param, plus the same filter/sort params as Records) as
// raw bytes. params may be nil.
func (s *DatasetsService) Export(ctx context.Context, id int64, params url.Values) ([]byte, error) {
	_, data, err := s.c.call(ctx, http.MethodGet, fmt.Sprintf("/v1/datasets/%d/export", id), params, nil, nil)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// searchParams clones params (nil-safe) and sets q, so the caller's Values are
// never mutated.
func searchParams(q string, params url.Values) url.Values {
	out := url.Values{}
	for k, v := range params {
		out[k] = append([]string(nil), v...)
	}
	out.Set("q", q)
	return out
}

// Search is GET /v1/datasets/search — global full-text search across all
// datasets. q is the query; params carries the optional limit/offset (params
// may be nil). q is injected into a copy of params, so the caller's Values are
// left unmodified.
func (s *DatasetsService) Search(ctx context.Context, q string, params url.Values) (*DatasetSearchResult, error) {
	if isTextFormat(params) {
		return nil, fmt.Errorf(
			"writ: format=%q renders text, not JSON — use SearchText instead",
			params.Get("format"))
	}
	var out DatasetSearchResult
	if err := s.c.callJSON(ctx, http.MethodGet, "/v1/datasets/search", searchParams(q, params), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SearchOne is GET /v1/datasets/:id/search — full-text search within a single
// dataset. q is the query; params carries the optional limit/offset (params
// may be nil). q is injected into a copy of params, so the caller's Values are
// left unmodified.
func (s *DatasetsService) SearchOne(ctx context.Context, id int64, q string, params url.Values) (*DatasetSearchResult, error) {
	if isTextFormat(params) {
		return nil, fmt.Errorf(
			"writ: format=%q renders text, not JSON — use SearchOneText instead",
			params.Get("format"))
	}
	var out DatasetSearchResult
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/datasets/%d/search", id), searchParams(q, params), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---------------------------------------------------------------------------
// Output formats (?format=)
//
// A dataset read serves the documented JSON envelope (FormatJSON, the default)
// or a RENDERED text body. The rendered formats are CONTENT-AWARE: a dataset
// whose records carry long-form content (a crawl's pages have `markdown`)
// renders as documents, anything else as a table. Because those come back as
// text rather than JSON, they have their own *Text methods — asking the JSON
// methods for one is an error rather than a confusing unmarshal failure.
// ---------------------------------------------------------------------------

// Output shapes accepted by the datasets endpoints' "format" query param.
const (
	FormatJSON     = "json"
	FormatCSV      = "csv"
	FormatMarkdown = "markdown"
	FormatHTML     = "html"
)

// isTextFormat reports whether params ask for a rendered (non-JSON) output.
func isTextFormat(params url.Values) bool {
	f := strings.ToLower(strings.TrimSpace(params.Get("format")))
	return f != "" && f != FormatJSON
}

// withFormat clones params (nil-safe) and sets format, so the caller's Values
// are never mutated.
func withFormat(params url.Values, format string) url.Values {
	out := url.Values{}
	for k, v := range params {
		out[k] = append([]string(nil), v...)
	}
	out.Set("format", format)
	return out
}

// RecordsText is GET /v1/datasets/:id/records rendered as text — pass
// FormatMarkdown to read a crawl's pages as documents (or a structured
// dataset as a table), FormatCSV for a compact table, FormatHTML for a
// standalone document. Same filter/sort params as Records; params may be nil.
func (s *DatasetsService) RecordsText(ctx context.Context, id int64, format string, params url.Values) ([]byte, error) {
	_, data, err := s.c.call(ctx, http.MethodGet,
		fmt.Sprintf("/v1/datasets/%d/records", id), withFormat(params, format), nil, nil)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// SearchText is GET /v1/datasets/search rendered as text (see RecordsText).
// The per-result dataset tag and highlight snippet exist only in the JSON
// shape. params may be nil.
func (s *DatasetsService) SearchText(ctx context.Context, q string, format string, params url.Values) ([]byte, error) {
	_, data, err := s.c.call(ctx, http.MethodGet, "/v1/datasets/search",
		withFormat(searchParams(q, params), format), nil, nil)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// SearchOneText is GET /v1/datasets/:id/search rendered as text (see
// RecordsText). params may be nil.
func (s *DatasetsService) SearchOneText(ctx context.Context, id int64, q string, format string, params url.Values) ([]byte, error) {
	_, data, err := s.c.call(ctx, http.MethodGet,
		fmt.Sprintf("/v1/datasets/%d/search", id),
		withFormat(searchParams(q, params), format), nil, nil)
	if err != nil {
		return nil, err
	}
	return data, nil
}
