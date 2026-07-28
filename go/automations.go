package writ

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// AutomationsService wraps /v1/automations (api/v1/automations.rs) —
// event→action rules.
type AutomationsService struct {
	c *Client
}

// List is GET /v1/automations (?limit). Bare array on the wire, normalized
// into a Page.
func (s *AutomationsService) List(ctx context.Context, params url.Values) (Page[Automation], error) {
	return getPage[Automation](ctx, s.c, "/v1/automations", params)
}

// Create is POST /v1/automations (a non-empty "name" is required).
func (s *AutomationsService) Create(ctx context.Context, body any) (*Automation, error) {
	var out Automation
	if err := s.c.callJSON(ctx, http.MethodPost, "/v1/automations", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get is GET /v1/automations/:id.
func (s *AutomationsService) Get(ctx context.Context, id int64) (*Automation, error) {
	var out Automation
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/automations/%d", id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Update is PATCH /v1/automations/:id (partial update).
func (s *AutomationsService) Update(ctx context.Context, id int64, patch any) (*Automation, error) {
	var out Automation
	if err := s.c.callJSON(ctx, http.MethodPatch, fmt.Sprintf("/v1/automations/%d", id), nil, patch, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete is DELETE /v1/automations/:id.
func (s *AutomationsService) Delete(ctx context.Context, id int64) error {
	return s.c.callJSON(ctx, http.MethodDelete, fmt.Sprintf("/v1/automations/%d", id), nil, nil, nil)
}

// Enable is POST /v1/automations/:id/enable — sets the enabled flag and
// returns the refreshed row.
func (s *AutomationsService) Enable(ctx context.Context, id int64, enabled bool) (*Automation, error) {
	var out Automation
	body := map[string]bool{"enabled": enabled}
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/automations/%d/enable", id), nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Run is POST /v1/automations/:id/run — fires the automation now (manual
// trigger). inputs may be nil.
func (s *AutomationsService) Run(ctx context.Context, id int64, inputs map[string]any) (*AutomationRunResult, error) {
	var body any
	if inputs != nil {
		body = map[string]any{"inputs": inputs}
	} else {
		body = map[string]any{}
	}
	var out AutomationRunResult
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/automations/%d/run", id), nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
