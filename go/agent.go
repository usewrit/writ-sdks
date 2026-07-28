package writ

import (
	"context"
	"net/http"
)

// AgentService wraps the daemon status routes.
type AgentService struct {
	c *Client
}

// Status is GET /v1/agent — the lightweight liveness/status snapshot.
func (s *AgentService) Status(ctx context.Context) (*AgentStatus, error) {
	var out AgentStatus
	if err := s.c.callJSON(ctx, http.MethodGet, "/v1/agent", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Health is GET /v1/health — the deeper self-checking probe (encrypted-store
// reachability, keyring, scheduler liveness, cloud-link reflection).
func (s *AgentService) Health(ctx context.Context) (*AgentHealth, error) {
	var out AgentHealth
	if err := s.c.callJSON(ctx, http.MethodGet, "/v1/health", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
