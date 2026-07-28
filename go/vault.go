package writ

import (
	"context"
	"net/http"
)

// VaultService wraps /v1/vault/* (api/v1/vault.rs) — the app-lock control
// surface. While the lock is engaged, secret-touching routes across the API
// answer 423 (code "vault_locked").
type VaultService struct {
	c *Client
}

// Status is GET /v1/vault/status.
func (s *VaultService) Status(ctx context.Context) (*VaultStatus, error) {
	var out VaultStatus
	if err := s.c.callJSON(ctx, http.MethodGet, "/v1/vault/status", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Lock is POST /v1/vault/lock — relocks the vault now. Idempotent.
func (s *VaultService) Lock(ctx context.Context) error {
	return s.c.callJSON(ctx, http.MethodPost, "/v1/vault/lock", nil, map[string]any{}, nil)
}

// Unlock is POST /v1/vault/unlock — unlocks with the passphrase (verified
// daemon-side; a wrong passphrase is a 401 *APIError). The passphrase is
// never logged by the SDK.
func (s *VaultService) Unlock(ctx context.Context, passphrase string) error {
	body := map[string]string{"passphrase": passphrase}
	return s.c.callJSON(ctx, http.MethodPost, "/v1/vault/unlock", nil, body, nil)
}
