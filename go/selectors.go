package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

// SelectorsService wraps /v1/monitors/:id/selectors (api/v1/selectors.rs) —
// the per-monitor content selectors. Every selector-scoped route verifies
// ownership, so a valid selector id under the wrong monitor is a 404.
type SelectorsService struct {
	c *Client
}

// List is GET /v1/monitors/:id/selectors (?enabled_only). Bare array on the
// wire, normalized into a Page.
func (s *SelectorsService) List(ctx context.Context, monitorID int64, params url.Values) (Page[Selector], error) {
	return getPage[Selector](ctx, s.c, fmt.Sprintf("/v1/monitors/%d/selectors", monitorID), params)
}

// Create is POST /v1/monitors/:id/selectors (a non-empty "selector" is
// required; "name" defaults to it).
func (s *SelectorsService) Create(ctx context.Context, monitorID int64, body any) (*Selector, error) {
	var out Selector
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/monitors/%d/selectors", monitorID), nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get is GET /v1/monitors/:id/selectors/:selector_id.
func (s *SelectorsService) Get(ctx context.Context, monitorID, selectorID int64) (*Selector, error) {
	var out Selector
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/monitors/%d/selectors/%d", monitorID, selectorID), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Update is PATCH /v1/monitors/:id/selectors/:selector_id.
func (s *SelectorsService) Update(ctx context.Context, monitorID, selectorID int64, patch any) (*Selector, error) {
	var out Selector
	if err := s.c.callJSON(ctx, http.MethodPatch, fmt.Sprintf("/v1/monitors/%d/selectors/%d", monitorID, selectorID), nil, patch, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete is DELETE /v1/monitors/:id/selectors/:selector_id (extractors
// cascade).
func (s *SelectorsService) Delete(ctx context.Context, monitorID, selectorID int64) error {
	return s.c.callJSON(ctx, http.MethodDelete, fmt.Sprintf("/v1/monitors/%d/selectors/%d", monitorID, selectorID), nil, nil, nil)
}

// Toggle is POST /v1/monitors/:id/selectors/:selector_id/toggle — flips the
// enabled flag.
func (s *SelectorsService) Toggle(ctx context.Context, monitorID, selectorID int64) (*SelectorToggle, error) {
	var out SelectorToggle
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/monitors/%d/selectors/%d/toggle", monitorID, selectorID), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Test is POST /v1/monitors/:id/selectors/:selector_id/test — a live one-off
// fetch reporting what the selector resolves to (open probe shape), without
// persisting anything.
func (s *SelectorsService) Test(ctx context.Context, monitorID, selectorID int64) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/monitors/%d/selectors/%d/test", monitorID, selectorID), nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetBaseline is POST /v1/monitors/:id/selectors/:selector_id/set-baseline —
// captures the selector's baseline from a fresh fetch (open probe shape).
func (s *SelectorsService) SetBaseline(ctx context.Context, monitorID, selectorID int64) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/monitors/%d/selectors/%d/set-baseline", monitorID, selectorID), nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ClearBaseline is POST /v1/monitors/:id/selectors/:selector_id/clear-baseline.
func (s *SelectorsService) ClearBaseline(ctx context.Context, monitorID, selectorID int64) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/monitors/%d/selectors/%d/clear-baseline", monitorID, selectorID), nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}
