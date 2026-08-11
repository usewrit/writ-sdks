package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// MonitorsService wraps /v1/monitors (api/v1/monitors.rs; rows live in the
// targets table).
type MonitorsService struct {
	c *Client
}

// List is GET /v1/monitors (?limit, ?check_type=content|uptime). The daemon
// answers a bare array; the SDK normalizes it into a Page.
func (s *MonitorsService) List(ctx context.Context, params url.Values) (Page[Monitor], error) {
	return getPage[Monitor](ctx, s.c, "/v1/monitors", params)
}

// Create is POST /v1/monitors. A non-empty "url" is required; a 409
// device_capacity refusal surfaces as a normal *APIError.
func (s *MonitorsService) Create(ctx context.Context, body any) (*Monitor, error) {
	var out Monitor
	if err := s.c.callJSON(ctx, http.MethodPost, "/v1/monitors", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get is GET /v1/monitors/:id (enriched with live check state).
func (s *MonitorsService) Get(ctx context.Context, id int64) (*Monitor, error) {
	var out Monitor
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/monitors/%d", id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Update is PATCH /v1/monitors/:id (partial update).
func (s *MonitorsService) Update(ctx context.Context, id int64, patch any) (*Monitor, error) {
	var out Monitor
	if err := s.c.callJSON(ctx, http.MethodPatch, fmt.Sprintf("/v1/monitors/%d", id), nil, patch, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete is DELETE /v1/monitors/:id (hard delete; selectors/state/changes
// cascade).
func (s *MonitorsService) Delete(ctx context.Context, id int64) error {
	return s.c.callJSON(ctx, http.MethodDelete, fmt.Sprintf("/v1/monitors/%d", id), nil, nil, nil)
}

// Run is POST /v1/monitors/:id/run — runs the check NOW and returns the
// check outcome (open shape).
func (s *MonitorsService) Run(ctx context.Context, id int64) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/monitors/%d/run", id), nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Changes is GET /v1/monitors/:id/changes (?limit, ?offset) — paginated
// change + uptime history.
func (s *MonitorsService) Changes(ctx context.Context, id int64, params url.Values) (*MonitorChanges, error) {
	var out MonitorChanges
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/monitors/%d/changes", id), params, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Capacity is GET /v1/monitors/capacity — the device check-capacity meter
// (open shape).
func (s *MonitorsService) Capacity(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodGet, "/v1/monitors/capacity", nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// RecentChanges is GET /v1/changes/recent — detected content changes across ALL
// monitors, newest-first.
//
// opts.Since switches the daemon to an oldest-first keyset walk returning only
// what was detected after that cursor. Prefer that for polling: newest-first
// plus a limit silently drops changes whenever more than `limit` of them land
// between two polls. For a continuous feed use Watch, which manages the cursor.
func (s *MonitorsService) RecentChanges(ctx context.Context, opts *ChangeListOptions) (Page[RecentChange], error) {
	return getPage[RecentChange](ctx, s.c, "/v1/changes/recent", opts.values())
}

// ChangeListOptions filters the daemon's recent-changes feed. It mirrors
// CloudChangeListOptions so the same polling code drives either venue.
type ChangeListOptions struct {
	// Limit caps the page. Nil uses the daemon default.
	Limit *int
	// Since is an ISO-8601 cursor — the LastDetectedAt of the last row processed.
	Since string
	// SinceID is that row's id, breaking ties between changes sharing one
	// timestamp so neither is lost at a page boundary.
	SinceID *int64
}

func (o *ChangeListOptions) values() url.Values {
	q := url.Values{}
	if o == nil {
		return q
	}
	if o.Limit != nil {
		q.Set("limit", strconv.Itoa(*o.Limit))
	}
	if o.Since != "" {
		q.Set("since", o.Since)
	}
	if o.SinceID != nil {
		q.Set("since_id", strconv.FormatInt(*o.SinceID, 10))
	}
	return q
}
