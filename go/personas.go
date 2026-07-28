package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

// PersonasService wraps /v1/personas (api/v1/personas.rs). Plaintext
// credentials in create/update bodies are sealed daemon-side and never echoed
// back; responses carry has_* booleans and linked names only.
// (The authenticator-import endpoints are out of scope for SDK v1.)
type PersonasService struct {
	c *Client
}

// List is GET /v1/personas (?limit, ?domain for suffix suggestions).
func (s *PersonasService) List(ctx context.Context, params url.Values) (Page[Persona], error) {
	return getPage[Persona](ctx, s.c, "/v1/personas", params)
}

// Create is POST /v1/personas — the cloud-shaped wizard payload (name,
// login_username, password, twofa_method, totp_seed, proxy_*, …).
func (s *PersonasService) Create(ctx context.Context, body any) (*Persona, error) {
	var out Persona
	if err := s.c.callJSON(ctx, http.MethodPost, "/v1/personas", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get is GET /v1/personas/:id.
func (s *PersonasService) Get(ctx context.Context, id int64) (*Persona, error) {
	var out Persona
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/personas/%d", id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Update is PATCH /v1/personas/:id (partial update; sending password/
// extra_login_fields REPLACES the stored credential set — cloud semantics).
func (s *PersonasService) Update(ctx context.Context, id int64, patch any) (*Persona, error) {
	var out Persona
	if err := s.c.callJSON(ctx, http.MethodPatch, fmt.Sprintf("/v1/personas/%d", id), nil, patch, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete is DELETE /v1/personas/:id (hard delete).
func (s *PersonasService) Delete(ctx context.Context, id int64) error {
	return s.c.callJSON(ctx, http.MethodDelete, fmt.Sprintf("/v1/personas/%d", id), nil, nil, nil)
}

// Runs is GET /v1/personas/:id/runs (?limit) — recent runs that acted as
// this persona.
func (s *PersonasService) Runs(ctx context.Context, id int64, params url.Values) (Page[PersonaRun], error) {
	return getPage[PersonaRun](ctx, s.c, fmt.Sprintf("/v1/personas/%d/runs", id), params)
}

// ValidateTOTP is POST /v1/personas/validate-totp — checks a base32 seed
// (and optionally whether a code matches). The seed is validated only, never
// stored. Body: {totp_seed, code?, digits?, period?, algorithm?}.
func (s *PersonasService) ValidateTOTP(ctx context.Context, body any) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodPost, "/v1/personas/validate-totp", nil, body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Test2FA is POST /v1/personas/:id/test-2fa — smoke-tests the persona's 2FA
// method (TOTP mints locally; email/SMS reads are cloud-gated).
func (s *PersonasService) Test2FA(ctx context.Context, id int64) (json.RawMessage, error) {
	var out json.RawMessage
	if err := s.c.callJSON(ctx, http.MethodPost, fmt.Sprintf("/v1/personas/%d/test-2fa", id), nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}
