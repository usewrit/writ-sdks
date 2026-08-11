package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// CloudPersonasService is the cloud personas surface, mounted at
// client.Cloud.Personas. It mirrors the local daemon's PersonasService
// (client.Personas) verb for verb. Scopes: personas:*.
//
// SECRET MATERIAL IS WRITE-ONLY, on the server and therefore here. A password, a
// TOTP seed and proxy credentials go IN on create/update and are stored
// encrypted; they never come back. A persona reads back as HasPassword /
// HasTOTPSeed / HasProxy booleans, exactly like the daemon's.
//
// Use personas only with sites and accounts you are authorized to access.
type CloudPersonasService struct{ c *CloudService }

const cloudPersonasPath = "/api/personas"

// CloudPersona is the login identity a cloud run acts as. Note what is NOT here:
// no password, no TOTP seed, no session — only the Has* booleans.
//
// ⚠️ RelayToken IS returned, because the owner needs it to point OTP forwarding
// at the right address. It is a DEPOSIT-only credential (it can add messages to
// this persona's relay mailbox, never read them) — treat it as a secret in logs
// and screenshots even though it cannot read anything.
type CloudPersona struct {
	ID                  int64            `json:"id"`
	Name                string           `json:"name"`
	Description         *string          `json:"description"`
	TargetDomain        *string          `json:"target_domain"`
	LoginUsername       *string          `json:"login_username"`
	HasPassword         bool             `json:"has_password"`
	TwoFAMethod         string           `json:"twofa_method"`
	HasTOTPSeed         bool             `json:"has_totp_seed"`
	EmailOTPMode        *string          `json:"email_otp_mode"`
	MailConnectionID    *int64           `json:"mail_connection_id"`
	ConnectedMailbox    *string          `json:"connected_mailbox"`
	RelayAddress        *string          `json:"relay_address"`
	RelayToken          *string          `json:"relay_token"`
	RelayInboundAddress *string          `json:"relay_inbound_address"`
	RelayInboundURL     *string          `json:"relay_inbound_url"`
	HasFingerprint      bool             `json:"has_fingerprint"`
	PreferredAgentID    *string          `json:"preferred_agent_id"`
	HasProxy            bool             `json:"has_proxy"`
	ProxyProvider       *string          `json:"proxy_provider"`
	ProxyLawfulUseAckAt *string          `json:"proxy_lawful_use_ack_at"`
	IsActive            bool             `json:"is_active"`
	ValidationStatus    string           `json:"validation_status"`
	HasWarmSession      bool             `json:"has_warm_session"`
	SessionExpiresAt    *string          `json:"session_expires_at"`
	LastLoginAt         *string          `json:"last_login_at"`
	LastUsedAt          *string          `json:"last_used_at"`
	CreatedAt           *string          `json:"created_at"`
	UpdatedAt           *string          `json:"updated_at"`
	LinkedWorkflows     []map[string]any `json:"linked_workflows"`
	LinkedSecrets       map[string]any   `json:"linked_secrets"`
}

// CloudPersonaParams is the create/update body. Only Name is required on create.
// Password, TOTPSeed and ProxyPassword are WRITE-ONLY — stored encrypted and
// never returned. On update, a secret is replaced only when you send it.
type CloudPersonaParams struct {
	Name          string  `json:"name,omitempty"`
	Description   *string `json:"description,omitempty"`
	TargetDomain  *string `json:"target_domain,omitempty"`
	LoginUsername *string `json:"login_username,omitempty"`
	// Password is WRITE-ONLY.
	Password          *string        `json:"password,omitempty"`
	ExtraLoginFields  map[string]any `json:"extra_login_fields,omitempty"`
	TwoFAMethod       string         `json:"twofa_method,omitempty"`
	TOTPSeed          *string        `json:"totp_seed,omitempty"`
	TOTPDigits        *int           `json:"totp_digits,omitempty"`
	TOTPPeriodSeconds *int           `json:"totp_period_seconds,omitempty"`
	TOTPAlgorithm     string         `json:"totp_algorithm,omitempty"`
	EmailOTPMode      *string        `json:"email_otp_mode,omitempty"`
	MailConnectionID  *int64         `json:"mail_connection_id,omitempty"`
	RelayAddress      *string        `json:"relay_address,omitempty"`
	OTPExtractConfig  map[string]any `json:"otp_extract_config,omitempty"`
	Fingerprint       map[string]any `json:"fingerprint,omitempty"`
	PreferredAgentID  *string        `json:"preferred_agent_id,omitempty"`
	ProxyServer       *string        `json:"proxy_server,omitempty"`
	ProxyUsername     *string        `json:"proxy_username,omitempty"`
	// ProxyPassword is WRITE-ONLY.
	ProxyPassword     *string `json:"proxy_password,omitempty"`
	ProxyLawfulUseAck *bool   `json:"proxy_lawful_use_ack,omitempty"`
	ProxyProvider     *string `json:"proxy_provider,omitempty"`
	IsActive          *bool   `json:"is_active,omitempty"`
}

// TOTPValidation is the answer from CloudPersonasService.ValidateTOTP.
type TOTPValidation struct {
	ValidBase32 bool  `json:"valid_base32"`
	MatchesCode *bool `json:"matches_code"`
}

// List returns every persona on the account. domain (optional) suggests by site.
func (s *CloudPersonasService) List(ctx context.Context, domain string) ([]CloudPersona, error) {
	if err := s.c.requireKey("Listing cloud personas"); err != nil {
		return nil, err
	}
	q := url.Values{}
	if domain != "" {
		q.Set("domain", domain)
	}
	data, err := s.c.sendQuery(ctx, http.MethodGet, cloudPersonasPath, nil, q)
	if err != nil {
		return nil, err
	}
	var out []CloudPersona
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return out, nil
}

// Create creates a persona. Name is required; secrets are write-only.
func (s *CloudPersonasService) Create(ctx context.Context, body CloudPersonaParams) (*CloudPersona, error) {
	if err := s.c.requireKey("Creating a cloud persona"); err != nil {
		return nil, err
	}
	return s.one(ctx, http.MethodPost, cloudPersonasPath, body)
}

// Get returns one persona.
func (s *CloudPersonasService) Get(ctx context.Context, id int64) (*CloudPersona, error) {
	if err := s.c.requireKey("Reading a cloud persona"); err != nil {
		return nil, err
	}
	return s.one(ctx, http.MethodGet, fmt.Sprintf("%s/%d", cloudPersonasPath, id), nil)
}

// Update partially updates a persona. A secret is replaced only when sent.
func (s *CloudPersonasService) Update(ctx context.Context, id int64, patch CloudPersonaParams) (*CloudPersona, error) {
	if err := s.c.requireKey("Updating a cloud persona"); err != nil {
		return nil, err
	}
	return s.one(ctx, http.MethodPatch, fmt.Sprintf("%s/%d", cloudPersonasPath, id), patch)
}

// Delete removes a persona and its stored credentials.
func (s *CloudPersonasService) Delete(ctx context.Context, id int64) error {
	if err := s.c.requireKey("Deleting a cloud persona"); err != nil {
		return err
	}
	_, err := s.c.send(ctx, http.MethodDelete, fmt.Sprintf("%s/%d", cloudPersonasPath, id), nil)
	return err
}

// Runs lists recent runs that acted as this persona.
func (s *CloudPersonasService) Runs(ctx context.Context, id int64, limit *int) (json.RawMessage, error) {
	if err := s.c.requireKey("Reading cloud persona runs"); err != nil {
		return nil, err
	}
	q := url.Values{}
	if limit != nil {
		q.Set("limit", strconv.Itoa(*limit))
	}
	return s.c.sendQuery(ctx, http.MethodGet, fmt.Sprintf("%s/%d/runs", cloudPersonasPath, id), nil, q)
}

// Test2FA exercises this persona's configured 2FA path and reports whether it
// produced a code — without running a login.
func (s *CloudPersonasService) Test2FA(ctx context.Context, id int64) (json.RawMessage, error) {
	if err := s.c.requireKey("Testing a cloud persona's 2FA"); err != nil {
		return nil, err
	}
	return s.c.send(ctx, http.MethodPost, fmt.Sprintf("%s/%d/test-2fa", cloudPersonasPath, id), nil)
}

// ValidateTOTP checks a pasted seed is well-formed base32 — and, with a code,
// that it reproduces that code. The seed is NEVER stored or logged by this call,
// so it is the safe way to check one BEFORE committing it to a persona.
func (s *CloudPersonasService) ValidateTOTP(ctx context.Context, totpSeed, code string) (*TOTPValidation, error) {
	if err := s.c.requireKey("Validating a TOTP seed"); err != nil {
		return nil, err
	}
	body := map[string]any{"totp_seed": totpSeed}
	if code != "" {
		body["code"] = code
	}
	data, err := s.c.send(ctx, http.MethodPost, cloudPersonasPath+"/validate-totp", body)
	if err != nil {
		return nil, err
	}
	var out TOTPValidation
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return &out, nil
}

func (s *CloudPersonasService) one(ctx context.Context, method, path string, body any) (*CloudPersona, error) {
	data, err := s.c.send(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	var out CloudPersona
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return &out, nil
}
