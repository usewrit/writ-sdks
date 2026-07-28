package writ

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// WorkflowsService wraps /v1/workflows (api/v1/workflows.rs).
type WorkflowsService struct {
	c *Client
}

// List is GET /v1/workflows. Query params (e.g. active_only, limit) pass
// through as given; params may be nil.
func (s *WorkflowsService) List(ctx context.Context, params url.Values) (Page[Workflow], error) {
	return getPage[Workflow](ctx, s.c, "/v1/workflows", params)
}

// Create is POST /v1/workflows. body is any JSON-marshalable value shaped
// like the daemon's create body (name is required; a plaintext "credentials"
// map is sealed daemon-side).
func (s *WorkflowsService) Create(ctx context.Context, body any) (*Workflow, error) {
	var out Workflow
	if err := s.c.callJSON(ctx, http.MethodPost, "/v1/workflows", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get is GET /v1/workflows/:id.
func (s *WorkflowsService) Get(ctx context.Context, id int64) (*Workflow, error) {
	var out Workflow
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/workflows/%d", id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Update is PATCH /v1/workflows/:id (sparse update; absent fields untouched).
func (s *WorkflowsService) Update(ctx context.Context, id int64, patch any) (*Workflow, error) {
	var out Workflow
	if err := s.c.callJSON(ctx, http.MethodPatch, fmt.Sprintf("/v1/workflows/%d", id), nil, patch, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete is DELETE /v1/workflows/:id — a HARD delete (runs cascade away).
// Deleting a marketplace proxy row also uninstalls the listing.
func (s *WorkflowsService) Delete(ctx context.Context, id int64) (*WorkflowDeleted, error) {
	var out WorkflowDeleted
	if err := s.c.callJSON(ctx, http.MethodDelete, fmt.Sprintf("/v1/workflows/%d", id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Run is POST /v1/workflows/:id/run — starts the workflow asynchronously and
// returns the 202 {run_id, status:"running"} handle. Observe progress with
// Runs.Events(runID) and read the outcome from Runs.Get / Runs.Results.
// opts may be nil.
//
// Set opts.Wait to have the DAEMON block until the run is terminal instead; use
// RunWait, which returns the terminal document directly.
func (s *WorkflowsService) Run(ctx context.Context, id int64, opts *RunOptions) (*RunStarted, error) {
	if opts == nil {
		opts = &RunOptions{}
	}
	var out RunStarted
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/workflows/%d/run", id), runQuery(opts), opts, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// runQuery renders the delivery options (Wait/Timeout) as query parameters. They
// are query, not body, because they steer HOW the daemon answers rather than what
// the run does — the body stays exactly the run's inputs.
func runQuery(opts *RunOptions) url.Values {
	if opts == nil || !opts.Wait {
		return nil
	}
	q := url.Values{}
	q.Set("wait", "true")
	if opts.Timeout > 0 {
		q.Set("timeout", strconv.FormatInt(int64(opts.Timeout/time.Second), 10))
	}
	return q
}

// RunWait is POST /v1/workflows/:id/run?wait=true — run the workflow and BLOCK on
// the daemon until it reaches a terminal state, returning the run's own result in
// the same call. One request: no SSE, no poll loop.
//
// A run that FAILS is returned normally with Status "failed" — check it. Only an
// expired budget is an error, and it is a *RunTimeoutError carrying the still-valid
// run id so you can collect the run rather than start a second one:
//
//	done, err := c.Workflows.RunWait(ctx, id, &writ.RunOptions{Timeout: 60 * time.Second})
//	var timeout *writ.RunTimeoutError
//	if errors.As(err, &timeout) {
//	    // still running — observe it, don't retry
//	    ev, _ := c.Runs.Events(ctx, timeout.RunID)
//	}
//
// Prefer RunAndWait when you want live events, the enriched run feed item, or a
// deadline longer than the daemon's own ceiling.
func (s *WorkflowsService) RunWait(ctx context.Context, id int64, opts *RunOptions) (*RunCompleted, error) {
	o := RunOptions{}
	if opts != nil {
		o = *opts
	}
	o.Wait = true

	// 504 is a documented, RECOVERABLE outcome of waiting, so it is allowed through
	// the transport's error mapping and converted below — a generic *APIError would
	// throw away the run id, which is the only thing that makes it recoverable.
	status, data, err := s.c.call(
		ctx, http.MethodPost, fmt.Sprintf("/v1/workflows/%d/run", id),
		runQuery(&o), &o, func(code int) bool { return code == http.StatusGatewayTimeout },
	)
	if err != nil {
		return nil, err
	}
	var out RunCompleted
	if err := unmarshalResponse(data, &out); err != nil {
		return nil, err
	}
	if status == http.StatusGatewayTimeout || !out.Done {
		return nil, &RunTimeoutError{
			RunID:     out.RunID,
			StatusURL: out.StatusURL,
			EventsURL: out.EventsURL,
		}
	}
	return &out, nil
}

// DryRun is POST /v1/workflows/:id/run with dry_run:true — a VALIDATE-ONLY
// call that never launches a browser or executes a step. Returns the 200
// dry-run plan report (dry_run, workflow_id, step_count, steps,
// required_secrets, provided_inputs, entry_url).
func (s *WorkflowsService) DryRun(ctx context.Context, id int64, opts *RunOptions) (json.RawMessage, error) {
	body := map[string]any{"dry_run": true}
	if opts != nil {
		if opts.Inputs != nil {
			body["inputs"] = opts.Inputs
		}
		if opts.PersonaID != nil {
			body["persona_id"] = *opts.PersonaID
		}
		if opts.Files != nil {
			body["files"] = opts.Files
		}
	}
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/workflows/%d/run", id), nil, body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Cancel is POST /v1/workflows/:id/cancel — cancels the workflow's newest
// live run. Both the 202 cancel_requested answer and the 409
// {status:"not_running"} answer are returned as a result, not an error.
func (s *WorkflowsService) Cancel(ctx context.Context, id int64) (*WorkflowCancelResult, error) {
	allow := func(status int) bool { return status == http.StatusConflict }
	_, data, err := s.c.call(ctx, http.MethodPost, fmt.Sprintf("/v1/workflows/%d/cancel", id), nil, nil, allow)
	if err != nil {
		return nil, err
	}
	var out WorkflowCancelResult
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return &out, nil
}

// Session is GET /v1/workflows/:id/session — the browserless-HTTP-lane
// session status.
func (s *WorkflowsService) Session(ctx context.Context, id int64) (*WorkflowSession, error) {
	var out WorkflowSession
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/workflows/%d/session", id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ClearSession is DELETE /v1/workflows/:id/session — drops the persisted
// session so the next run logs in fresh. A no-op when none is saved.
func (s *WorkflowsService) ClearSession(ctx context.Context, id int64) error {
	return s.c.callJSON(ctx, http.MethodDelete, fmt.Sprintf("/v1/workflows/%d/session", id), nil, nil, nil)
}

// RunAndWait starts the workflow and waits for it to finish:
//
//  1. POST /v1/workflows/:id/run → run_id.
//  2. Subscribe to the run's SSE event stream; resolve on finished/error.
//  3. If the SSE connection fails or drops before a terminal event, fall
//     back to polling Runs.Get every second until status != "running".
//  4. The overall deadline is opts.WaitTimeout (default 600s), combined with
//     any deadline already on ctx.
//
// On timeout the error wraps context.DeadlineExceeded and the run itself is
// NOT cancelled — it keeps executing in the daemon; call Runs.Cancel to stop
// it. Returns the final RunFeedItem (fetched once after the terminal event).
// opts may be nil; opts.WaitTimeout never crosses the wire.
func (s *WorkflowsService) RunAndWait(ctx context.Context, id int64, opts *RunOptions) (*RunFeedItem, error) {
	wait := 600 * time.Second
	if opts != nil && opts.WaitTimeout > 0 {
		wait = opts.WaitTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()

	started, err := s.Run(ctx, id, opts)
	if err != nil {
		return nil, err
	}
	runID := started.RunID

	// SSE first: resolve on a terminal frame; any drop/error falls through
	// to the polling loop below.
	terminal := false
	for ev, evErr := range s.c.Runs.Events(ctx, runID) {
		if evErr != nil {
			break
		}
		if ev.Terminal() {
			terminal = true
			break
		}
	}
	if terminal {
		return s.finalItem(ctx, runID)
	}

	// Polling fallback (1s cadence). Connection errors keep polling — the
	// overall deadline bounds the loop; API errors surface immediately.
	interval := s.c.pollInterval
	if interval <= 0 {
		interval = time.Second
	}
	for {
		item, err := s.c.Runs.Get(ctx, runID)
		if err == nil && item.Status != "running" {
			return item, nil
		}
		var apiErr *APIError
		if err != nil && errors.As(err, &apiErr) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("writ: RunAndWait: run %d did not finish in time (the run was NOT cancelled): %w", runID, ctx.Err())
		case <-time.After(interval):
		}
	}
}

// finalItem fetches the run row once after a terminal event.
func (s *WorkflowsService) finalItem(ctx context.Context, runID int64) (*RunFeedItem, error) {
	item, err := s.c.Runs.Get(ctx, runID)
	if err != nil {
		return nil, err
	}
	return item, nil
}
