package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

// ExtractorsService wraps /v1/extractors and
// /v1/selectors/:selector_id/extractors (api/v1/extractors.rs) — the field
// extractors turning a selector's captured content into typed values.
type ExtractorsService struct {
	c *Client
}

// List is GET /v1/selectors/:selector_id/extractors (?enabled_only). Bare
// array on the wire, normalized into a Page.
func (s *ExtractorsService) List(ctx context.Context, selectorID int64, params url.Values) (Page[Extractor], error) {
	return getPage[Extractor](ctx, s.c, fmt.Sprintf("/v1/selectors/%d/extractors", selectorID), params)
}

// Create is POST /v1/extractors (target_selector_id and a non-empty
// output_name are required; name defaults to the output name).
func (s *ExtractorsService) Create(ctx context.Context, body any) (*Extractor, error) {
	var out Extractor
	if err := s.c.callJSON(ctx, http.MethodPost, "/v1/extractors", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get is GET /v1/extractors/:extractor_id.
func (s *ExtractorsService) Get(ctx context.Context, extractorID int64) (*Extractor, error) {
	var out Extractor
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/extractors/%d", extractorID), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Update is PATCH /v1/extractors/:extractor_id.
func (s *ExtractorsService) Update(ctx context.Context, extractorID int64, patch any) (*Extractor, error) {
	var out Extractor
	if err := s.c.callJSON(ctx, http.MethodPatch, fmt.Sprintf("/v1/extractors/%d", extractorID), nil, patch, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete is DELETE /v1/extractors/:extractor_id.
func (s *ExtractorsService) Delete(ctx context.Context, extractorID int64) error {
	return s.c.callJSON(ctx, http.MethodDelete, fmt.Sprintf("/v1/extractors/%d", extractorID), nil, nil, nil)
}

// Toggle is PATCH /v1/extractors/:extractor_id/toggle — flips the enabled
// flag (open shape).
func (s *ExtractorsService) Toggle(ctx context.Context, extractorID int64) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodPatch, fmt.Sprintf("/v1/extractors/%d/toggle", extractorID), nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Test is POST /v1/extractors/:extractor_id/test — runs the saved extractor
// over caller-supplied content ({"content": ..., "content_type"?: ...}) and
// returns the extraction preview (open shape).
func (s *ExtractorsService) Test(ctx context.Context, extractorID int64, body any) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/extractors/%d/test", extractorID), nil, body, &out); err != nil {
		return nil, err
	}
	return out, nil
}
