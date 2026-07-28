package writ

import (
	"context"
	"net/http"
	"net/url"
)

// SecretsService wraps /v1/secrets (api/v1/secrets.rs). Secrets are addressed
// by their unique TEXT key. Values are sealed daemon-side and NEVER returned
// — every read is metadata only. Secret-touching routes answer 423
// (code "vault_locked") while the app-lock is engaged.
type SecretsService struct {
	c *Client
}

// List is GET /v1/secrets (?limit, ?search, ?category) — metadata only.
func (s *SecretsService) List(ctx context.Context, params url.Values) (Page[Secret], error) {
	return getPage[Secret](ctx, s.c, "/v1/secrets", params)
}

// Set is POST /v1/secrets — creates a secret named key. For a single-value
// secret pass the plaintext value; for credential (username+password) or
// card secrets leave value empty and fill opts. opts may be nil. A duplicate
// name is a 400 *APIError.
func (s *SecretsService) Set(ctx context.Context, key, value string, opts *SecretCreate) (*Secret, error) {
	body := SecretCreate{}
	if opts != nil {
		body = *opts
	}
	if body.Name == "" {
		body.Name = key
	}
	if value != "" {
		body.Value = value
	}
	var out Secret
	if err := s.c.callJSON(ctx, http.MethodPost, "/v1/secrets", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get is GET /v1/secrets/:key — the secret's METADATA (never the value).
func (s *SecretsService) Get(ctx context.Context, key string) (*Secret, error) {
	var out Secret
	if err := s.c.callJSON(ctx, http.MethodGet, "/v1/secrets/"+url.PathEscape(key), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete is DELETE /v1/secrets/:key (hard delete by key).
func (s *SecretsService) Delete(ctx context.Context, key string) error {
	return s.c.callJSON(ctx, http.MethodDelete, "/v1/secrets/"+url.PathEscape(key), nil, nil, nil)
}
