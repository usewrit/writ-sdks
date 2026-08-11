package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// CloudBuildsService turns a website into a callable API, mounted at
// client.Cloud.Builds. It is the REST twin of the MCP tool writ_website_to_api.
//
// ASYNCHRONOUS for a reason: the MCP tool works because the caller is a MODEL
// that drives the browser turn by turn. A program cannot, so Writ's own agent
// loop drives and this surface hands back a build id to poll.
//
// The server checks two cheap rungs before spending any AI — your own matching
// workflows, then ready-made marketplace listings — so Status may come back as
// "existing_workflows" or "marketplace_candidates" with no build at all.
//
// Scopes: workflows:write to start, workflows:read to poll. A build spends AI
// credits, so the key must have AI enabled.
type CloudBuildsService struct{ c *CloudService }

const cloudBuildsPath = "/api/v1/website-to-api"

// TerminalBuildStatuses are the states that will never change again.
var TerminalBuildStatuses = map[string]bool{
	"succeeded": true, "failed": true, "cancelled": true,
}

// CloudBuild is a website→API build, or the ladder answer that made one
// unnecessary. BuildID is zero on a ladder answer — check Status first.
type CloudBuild struct {
	BuildID int64 `json:"build_id"`
	// Status is queued|building|succeeded|failed|cancelled, or a ladder answer:
	// existing_workflows|marketplace_candidates.
	Status string `json:"status"`
	URL    string `json:"url"`
	Goal   string `json:"goal"`
	// WorkflowID is set once the agent saves — this is what the build was for.
	WorkflowID  *int64 `json:"workflow_id"`
	Error       string `json:"error"`
	Next        string `json:"next"`
	Message     string `json:"message"`
	CreatedAt   string `json:"created_at"`
	CompletedAt string `json:"completed_at"`
	// Ladder answers carry these instead of a build.
	Workflows  []map[string]any `json:"workflows"`
	Candidates []map[string]any `json:"candidates"`
}

// IsTerminal reports whether this build will never change again.
func (b *CloudBuild) IsTerminal() bool { return TerminalBuildStatuses[b.Status] }

// CloudBuildParams tunes a build. Only URL and Goal are required.
type CloudBuildParams struct {
	URL  string `json:"url"`
	Goal string `json:"goal"`
	// PersonaID signs in with a saved identity, for sites behind a login.
	PersonaID *int64 `json:"persona_id,omitempty"`
	// MaxSteps bounds the agent loop.
	MaxSteps *int   `json:"max_steps,omitempty"`
	SaveAs   string `json:"save_as,omitempty"`
	// SkipExisting skips proposing your own matching workflows (replaying one is
	// instant and free); SkipMarketplace skips the ready-made listings.
	SkipExisting    bool `json:"skip_existing,omitempty"`
	SkipMarketplace bool `json:"skip_marketplace,omitempty"`
}

// Start turns a website into a callable API — one call.
func (s *CloudBuildsService) Start(ctx context.Context, params CloudBuildParams) (*CloudBuild, error) {
	if err := s.c.requireKey("Building an API from a website"); err != nil {
		return nil, err
	}
	return s.one(ctx, http.MethodPost, cloudBuildsPath, params)
}

// Get polls a build.
func (s *CloudBuildsService) Get(ctx context.Context, buildID int64) (*CloudBuild, error) {
	if err := s.c.requireKey("Reading a website-to-API build"); err != nil {
		return nil, err
	}
	return s.one(ctx, http.MethodGet, fmt.Sprintf("%s/%d", cloudBuildsPath, buildID), nil)
}

// StartAndWait starts a build and polls until it reaches a terminal state.
//
// Returns the ladder answer unchanged when the server resolved it without
// building — there is nothing to wait for. On timeout it returns the last view
// with a non-nil error: the build keeps going and BuildID still addresses it.
func (s *CloudBuildsService) StartAndWait(
	ctx context.Context, params CloudBuildParams, timeout, poll time.Duration,
) (*CloudBuild, error) {
	if poll <= 0 {
		poll = 5 * time.Second
	}
	if timeout <= 0 {
		timeout = 15 * time.Minute
	}
	started, err := s.Start(ctx, params)
	if err != nil || started.BuildID == 0 {
		return started, err
	}
	deadline := time.Now().Add(timeout)
	for {
		current, err := s.Get(ctx, started.BuildID)
		if err != nil {
			return current, err
		}
		if current.IsTerminal() {
			return current, nil
		}
		if time.Now().After(deadline) {
			return current, fmt.Errorf(
				"writ: website-to-API build %d did not finish within %s; it is still running — poll Builds.Get(%d)",
				started.BuildID, timeout, started.BuildID)
		}
		select {
		case <-ctx.Done():
			return current, ctx.Err()
		case <-time.After(poll):
		}
	}
}

func (s *CloudBuildsService) one(ctx context.Context, method, path string, body any) (*CloudBuild, error) {
	data, err := s.c.send(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	var out CloudBuild
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return &out, nil
}
