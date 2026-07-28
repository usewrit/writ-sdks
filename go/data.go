package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

// DataService wraps the extracted-data query surface (api/v1/data.rs). The
// table/facet shapes are dynamic (they depend on what each workflow
// extracted), so these methods return the raw JSON documents.
type DataService struct {
	c *Client
}

// Query is GET /v1/data — the Data-explorer picker: every workflow that owns
// extracted data ({"workflows": [...]}). params may be nil.
func (s *DataService) Query(ctx context.Context, params url.Values) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodGet, "/v1/data", params, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// WorkflowData is GET /v1/workflows/:id/data — the workflow's aggregated
// extracted-data table (sortable/searchable/paginated via query params).
func (s *DataService) WorkflowData(ctx context.Context, workflowID int64, params url.Values) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/workflows/%d/data", workflowID), params, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteWorkflowData is DELETE /v1/workflows/:id/data — removes extracted
// rows. body names explicit rows and/or record uids (open shape, e.g.
// {"uids": [...]}); nil deletes nothing.
func (s *DataService) DeleteWorkflowData(ctx context.Context, workflowID int64, body any) (*DataDeleteResult, error) {
	if body == nil {
		body = map[string]any{}
	}
	var out DataDeleteResult
	if err := s.c.callJSON(ctx, http.MethodDelete, fmt.Sprintf("/v1/workflows/%d/data", workflowID), nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Facets is GET /v1/workflows/:id/data/facets — filterable facet values for
// the workflow's data table.
func (s *DataService) Facets(ctx context.Context, workflowID int64, params url.Values) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/workflows/%d/data/facets", workflowID), params, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Export is GET /v1/workflows/:id/data/export — the exported document
// (CSV/JSON per the "format" query param) as raw bytes.
func (s *DataService) Export(ctx context.Context, workflowID int64, params url.Values) ([]byte, error) {
	_, data, err := s.c.call(ctx, http.MethodGet, fmt.Sprintf("/v1/workflows/%d/data/export", workflowID), params, nil, nil)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// DataRuns is GET /v1/workflows/:id/data/runs — the per-run breakdown behind
// the workflow's data table.
func (s *DataService) DataRuns(ctx context.Context, workflowID int64, params url.Values) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/workflows/%d/data/runs", workflowID), params, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}
