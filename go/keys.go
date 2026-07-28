package writ

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// KeysService wraps /v1/keys (api/v1/keys.rs) — scoped wlk_ API keys for
// external clients. These routes require the manage scope (i.e. the wlt_
// runtime token).
type KeysService struct {
	c *Client
}

// List is GET /v1/keys (?limit) — key records; hashes never serialize.
func (s *KeysService) List(ctx context.Context, params url.Values) (Page[APIKey], error) {
	return getPage[APIKey](ctx, s.c, "/v1/keys", params)
}

// Create is POST /v1/keys — mints a new scoped key. scopes is a CSV of
// read|run|admin ("" lets the daemon default to "run"). The plaintext wlk_
// key appears ONLY in this response — capture it now; it cannot be recovered
// later.
func (s *KeysService) Create(ctx context.Context, name, scopes string) (*APIKeyCreated, error) {
	body := map[string]any{"name": name}
	if scopes != "" {
		body["scopes"] = scopes
	}
	var out APIKeyCreated
	if err := s.c.callJSON(ctx, http.MethodPost, "/v1/keys", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get is GET /v1/keys/:id.
func (s *KeysService) Get(ctx context.Context, id int64) (*APIKey, error) {
	var out APIKey
	if err := s.c.callJSON(ctx, http.MethodGet, fmt.Sprintf("/v1/keys/%d", id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete is DELETE /v1/keys/:id (hard delete — the key stops working).
func (s *KeysService) Delete(ctx context.Context, id int64) error {
	return s.c.callJSON(ctx, http.MethodDelete, fmt.Sprintf("/v1/keys/%d", id), nil, nil, nil)
}
