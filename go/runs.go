package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"net/http"
	"net/url"
)

// RunsService wraps /v1/runs (api/v1/runs.rs) — read + control over run rows.
// Run ids here are the NUMERIC row ids (use RunFeedItem.RowID to extract one
// from a composite feed id like "workflow-3").
type RunsService struct {
	c *Client
}

// List is GET /v1/runs (filters: entity_id, workflow_id, run_type, status,
// limit, offset). params may be nil.
func (s *RunsService) List(ctx context.Context, params url.Values) (Page[RunFeedItem], error) {
	return getPage[RunFeedItem](ctx, s.c, "/v1/runs", params)
}

// Get is GET /v1/runs/:id — one run as the enriched feed projection.
func (s *RunsService) Get(ctx context.Context, runID int64) (*RunFeedItem, error) {
	var out RunFeedItem
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/runs/%d", runID), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Results is GET /v1/runs/:id/results — the raw result payload (null while
// the run is still going, or when it produced none).
func (s *RunsService) Results(ctx context.Context, runID int64) (*RunResults, error) {
	var out RunResults
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/runs/%d/results", runID), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Data is GET /v1/runs/:id/data — the run's extracted rows as JSON.
func (s *RunsService) Data(ctx context.Context, runID int64) (*RunData, error) {
	var out RunData
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/runs/%d/data", runID), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DataCSV is GET /v1/runs/:id/data?format=csv — the run's extracted rows
// flattened to a CSV document, returned verbatim.
func (s *RunsService) DataCSV(ctx context.Context, runID int64) (string, error) {
	q := url.Values{"format": {"csv"}}
	_, data, err := s.c.call(ctx, http.MethodGet, fmt.Sprintf("/v1/runs/%d/data", runID), q, nil, nil)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// Events is GET /v1/runs/:id/events — the run's live SSE lifecycle stream as
// a range-over-func sequence:
//
//	for ev, err := range client.Runs.Events(ctx, runID) {
//	    if err != nil { ... }
//	    if ev.Terminal() { break } // "finished" or "error"
//	}
//
// The sequence ends after a terminal event (a run that already finished
// yields exactly one). Keep-alive comment frames are ignored. Cancelling ctx
// tears the stream down (surfaced as a *ConnectionError). No reconnect logic:
// a dropped stream ends the sequence with an error — RunAndWait handles the
// polling fallback.
func (s *RunsService) Events(ctx context.Context, runID int64) iter.Seq2[RunEvent, error] {
	path := fmt.Sprintf("/v1/runs/%d/events", runID)
	return func(yield func(RunEvent, error) bool) {
		resp, err := s.c.openStream(ctx, path)
		if err != nil {
			yield(RunEvent{}, err)
			return
		}
		defer resp.Body.Close()
		for ev, evErr := range sseFrames(resp.Body, resp.Request.URL.String()) {
			if !yield(ev, evErr) {
				return
			}
			if evErr != nil || ev.Terminal() {
				return
			}
		}
	}
}

// Cancel is POST /v1/runs/:id/cancel. A 202 answers
// {run_id, status:"cancel_requested"}; a 409 answers
// {run_id, status:"not_running"} — the 409 is a valid result here, returned
// as a CancelResult rather than an error. An unknown run id is still a 404
// *APIError.
func (s *RunsService) Cancel(ctx context.Context, runID int64) (*CancelResult, error) {
	allow := func(status int) bool { return status == http.StatusConflict }
	_, data, err := s.c.call(ctx, http.MethodPost, fmt.Sprintf("/v1/runs/%d/cancel", runID), nil, nil, allow)
	if err != nil {
		return nil, err
	}
	var out CancelResult
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return &out, nil
}
