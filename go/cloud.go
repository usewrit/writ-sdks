package writ

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// CloudService is the tiered Writ Cloud surface: scrape, map, whole-site crawl
// and monitors. Unlike the rest of this SDK (which talks to the LOCAL daemon),
// these verbs run on Writ Cloud — never on the calling machine — with a
// Firecrawl-style tier model resolved from the caller's credential:
//
//   - Metered — an API key (WithAPIKey → WRIT_API_KEY env) → the authed
//     /api/crawl/* and /api/targets/* surfaces, billed against your plan.
//     Scrape, Map, Crawl AND Monitors all work.
//   - Keyless — no key → the free /v1/keyless/* tier, daily-capped per install
//     (a stable client-id header) and per IP. Scrape + Map only; Crawl and
//     Monitors return *APIKeyRequiredError.
//
// The credential fallback chain (WithAPIKey → WRIT_API_KEY → keyless) mirrors
// Firecrawl's, so the same code scales from an anonymous test to a metered
// production key with no branching at the call site. Mounted at client.Cloud.
//
// client.Cloud.Monitors mirrors the local daemon's client.Monitors verb for
// verb, so the same program runs against either venue by changing which service
// it talks to. The wire paths differ (the cloud calls the resource "targets")
// and so does the JSON casing — the cloud answers checkPeriodMs where the daemon
// answers check_period_ms — because these are two independently versioned
// services, not one service behind two hostnames. Each type below carries the
// tags of the service it actually speaks to.
type CloudService struct {
	apiKey           string
	base             string
	clientIDOverride string
	httpc            *http.Client
	retry            RetryPolicy

	mu       sync.Mutex
	clientID string // resolved (read/minted) keyless device id, cached

	// Monitors is the cloud monitors surface — the same verbs as client.Monitors
	// on the local daemon.
	Monitors *CloudMonitorsService
	// Automations is the cloud automations surface — the same verbs as
	// client.Automations (trigger rules: event -> conditions -> actions).
	Automations *CloudAutomationsService
	// Personas is the cloud personas surface — the same verbs as client.Personas.
	// Secret material is write-only; personas read back as Has* booleans.
	Personas *CloudPersonasService
	// Builds turns a website into a callable API — the REST twin of the MCP tool
	// writ_website_to_api.
	Builds *CloudBuildsService
}

const (
	defaultCloudURL = "https://api.usewrit.app"
	clientIDHeader  = "X-Writ-Client-Id"
)

// CloudTier is which access tier a call resolved to.
type CloudTier string

const (
	// TierKeyless is the free daily-capped tier used when no API key is present.
	TierKeyless CloudTier = "keyless"
	// TierMetered is the authed per-page tier used when an API key is present.
	TierMetered CloudTier = "metered"
)

// KeylessQuota is the remaining keyless allowance echoed back on keyless calls.
type KeylessQuota struct {
	Tier              CloudTier `json:"tier"`
	RequestsRemaining int       `json:"requests_remaining"`
	PagesRemaining    int       `json:"pages_remaining"`
	RequestsPerDay    int       `json:"requests_per_day"`
	PagesPerDay       int       `json:"pages_per_day"`
	ResetAt           string    `json:"reset_at"`
	UpgradeURL        string    `json:"upgrade_url,omitempty"`
}

// CloudScrapeResult is one page scraped to clean markdown. Tier records which
// tier the call resolved to; Quota is present on the keyless tier only.
type CloudScrapeResult struct {
	URL      string         `json:"url"`
	Title    string         `json:"title"`
	Format   string         `json:"format"`
	Markdown string         `json:"markdown"`
	Counts   map[string]int `json:"counts"`
	Quota    *KeylessQuota  `json:"quota,omitempty"`
	Tier     CloudTier      `json:"-"`
}

// CloudMapEntry is one ranked URL from a site map.
type CloudMapEntry struct {
	URL   string  `json:"url"`
	Score float64 `json:"score"`
	Title string  `json:"title"`
}

// CloudMapCounts is the returned/total summary of a site map.
type CloudMapCounts struct {
	Returned int `json:"returned"`
	Total    int `json:"total"`
}

// CloudMapResult is a site's URLs, ranked by an optional search query.
type CloudMapResult struct {
	URL    string          `json:"url"`
	Host   string          `json:"host,omitempty"`
	URLs   []CloudMapEntry `json:"urls"`
	Counts CloudMapCounts  `json:"counts"`
	Quota  *KeylessQuota   `json:"quota,omitempty"`
	Tier   CloudTier       `json:"-"`
}

// CloudMapOptions tunes CloudService.Map. Limit is a pointer so an unset value
// is omitted and the cloud applies its default.
type CloudMapOptions struct {
	Search string
	Limit  *int
}

// newCloudService resolves the cloud config from the client's options then the
// environment (WRIT_API_KEY / WRIT_CLOUD_URL / WRIT_CLIENT_ID), applying the
// documented fallback chain. It performs no I/O — a keyless client mints its
// device id lazily on the first keyless call.
func newCloudService(c *Client) *CloudService {
	apiKey := firstNonEmpty(c.apiKey, os.Getenv("WRIT_API_KEY"))
	base := firstNonEmpty(c.cloudURL, os.Getenv("WRIT_CLOUD_URL"), defaultCloudURL)
	httpc := c.cloudHTTP
	if httpc == nil {
		httpc = &http.Client{}
	}
	// Unsafe methods ARE retried on the cloud surface: every POST/PUT/PATCH
	// below carries an Idempotency-Key, and the cloud replays the recorded
	// response instead of executing a second time.
	retry := DefaultRetryPolicy
	if c.retry != nil {
		retry = *c.retry
	}
	retry.RetryUnsafeMethods = true

	svc := &CloudService{
		apiKey:           apiKey,
		base:             strings.TrimRight(base, "/"),
		clientIDOverride: firstNonEmpty(c.clientID, os.Getenv("WRIT_CLIENT_ID")),
		httpc:            httpc,
		retry:            retry,
	}
	svc.Monitors = &CloudMonitorsService{c: svc}
	svc.Automations = &CloudAutomationsService{c: svc}
	svc.Personas = &CloudPersonasService{c: svc}
	svc.Builds = &CloudBuildsService{c: svc}
	return svc
}

// Tier is the tier this client will use: TierMetered when an API key is
// present, else TierKeyless.
func (s *CloudService) Tier() CloudTier {
	if s.apiKey != "" {
		return TierMetered
	}
	return TierKeyless
}

// Scrape scrapes ONE page to clean markdown. Works on both tiers.
func (s *CloudService) Scrape(ctx context.Context, url string) (*CloudScrapeResult, error) {
	path := "/v1/keyless/scrape"
	if s.apiKey != "" {
		path = "/api/crawl/scrape"
	}
	data, err := s.send(ctx, http.MethodPost, path, map[string]any{"url": url})
	if err != nil {
		return nil, err
	}
	var out CloudScrapeResult
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	out.Tier = s.Tier()
	return &out, nil
}

// Map maps a site's URLs, ranked by an optional search query. Works on both
// tiers. opts may be nil.
func (s *CloudService) Map(ctx context.Context, url string, opts *CloudMapOptions) (*CloudMapResult, error) {
	path := "/v1/keyless/map"
	if s.apiKey != "" {
		path = "/api/crawl/map"
	}
	body := map[string]any{"url": url, "search": ""}
	if opts != nil {
		body["search"] = opts.Search
		if opts.Limit != nil {
			body["limit"] = *opts.Limit
		}
	}
	data, err := s.send(ctx, http.MethodPost, path, body)
	if err != nil {
		return nil, err
	}
	var out CloudMapResult
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	out.Tier = s.Tier()
	return &out, nil
}

// Crawl starts a whole-site crawl. METERED ONLY — requires an API key; on the
// keyless tier it returns *APIKeyRequiredError before any network call (use
// Scrape/Map instead). Reuses the CrawlStartParams body shape.
func (s *CloudService) Crawl(ctx context.Context, body CrawlStartParams) (*CrawlJob, error) {
	if err := s.requireKey("Whole-site crawl"); err != nil {
		return nil, err
	}
	data, err := s.send(ctx, http.MethodPost, "/api/crawl", body)
	if err != nil {
		return nil, err
	}
	var out CrawlJob
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return &out, nil
}

// CrawlStatus polls a metered crawl's status (requires an API key). On the
// keyless tier it returns *APIKeyRequiredError before any network call.
func (s *CloudService) CrawlStatus(ctx context.Context, id int64) (*CrawlJob, error) {
	if err := s.requireKey("Crawl status"); err != nil {
		return nil, err
	}
	data, err := s.send(ctx, http.MethodGet, fmt.Sprintf("/api/crawl/%d", id), nil)
	if err != nil {
		return nil, err
	}
	var out CrawlJob
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return &out, nil
}

// KeylessCrawlPage is one page from a bounded keyless crawl.
type KeylessCrawlPage struct {
	URL      string `json:"url"`
	Title    string `json:"title"`
	Markdown string `json:"markdown"`
}

// KeylessCrawlLimits are the ceilings that applied, stated so a caller need not
// discover them by hitting them.
type KeylessCrawlLimits struct {
	PageCap    int    `json:"page_cap"`
	MaxDepth   int    `json:"max_depth"`
	SameDomain bool   `json:"same_domain"`
	Note       string `json:"note"`
}

// KeylessCrawlResult is a bounded, no-account crawl: a few same-domain pages
// fetched in process and returned inline.
//
// Deliberately NOT a CrawlJob — that one is a fleet job you poll, and one type
// must never pretend to be both shapes.
type KeylessCrawlResult struct {
	Verb   string             `json:"verb"`
	URL    string             `json:"url"`
	Pages  []KeylessCrawlPage `json:"pages"`
	Counts struct {
		Pages     int `json:"pages"`
		Requested int `json:"requested"`
	} `json:"counts"`
	Tier       CloudTier          `json:"tier"`
	Limits     KeylessCrawlLimits `json:"limits"`
	Quota      *KeylessQuota      `json:"quota,omitempty"`
	UpgradeURL string             `json:"upgrade_url,omitempty"`
}

// KeylessCrawlOptions tunes CrawlKeyless. Limit is a pointer so an unset value
// lets the server apply its own cap.
type KeylessCrawlOptions struct {
	Search string
	Limit  *int
}

// CrawlKeyless runs a bounded crawl with NO account — the free tier's version.
//
// Separate from Crawl because the two return genuinely different things: Crawl
// queues a fleet job you poll, this fetches a few same-domain pages in process
// and returns their markdown inline. Capped per request (see Limits.PageCap),
// one level deep, and every page spends the same daily allowance as Scrape — so
// the daily cap, not the per-request cap, is the real ceiling.
func (s *CloudService) CrawlKeyless(ctx context.Context, url string, opts *KeylessCrawlOptions) (*KeylessCrawlResult, error) {
	body := map[string]any{"url": url}
	if opts != nil {
		if opts.Search != "" {
			body["search"] = opts.Search
		}
		if opts.Limit != nil {
			body["limit"] = *opts.Limit
		}
	}
	data, err := s.send(ctx, http.MethodPost, "/v1/keyless/crawl", body)
	if err != nil {
		return nil, err
	}
	var out KeylessCrawlResult
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return &out, nil
}

// Quota reports the remaining keyless allowance for this install (keyless tier
// only; returns nil when metered).
func (s *CloudService) Quota(ctx context.Context) (*KeylessQuota, error) {
	if s.apiKey != "" {
		return nil, nil
	}
	data, err := s.send(ctx, http.MethodGet, "/v1/keyless/quota", nil)
	if err != nil {
		return nil, err
	}
	return decodeQuota(data)
}

// --- transport --------------------------------------------------------------

// requireKey returns *APIKeyRequiredError when this verb needs a metered key and
// none is configured, so a keyless caller fails BEFORE the network call rather
// than on a 401 it cannot act on.
func (s *CloudService) requireKey(what string) error {
	if s.apiKey != "" {
		return nil
	}
	return &APIKeyRequiredError{APIError{
		Status:  http.StatusPaymentRequired,
		Code:    "api_key_required",
		Message: what + " needs an API key — set WithAPIKey or WRIT_API_KEY. Without one, Scrape, Map and the bounded CrawlKeyless still work.",
	}}
}

// send performs a cloud request with the tier-appropriate auth header. A body
// is JSON-encoded and sent with Content-Type application/json. Non-2xx
// responses are mapped by cloudErrorFrom; network failures give *ConnectionError.
func (s *CloudService) send(ctx context.Context, method, path string, body any) ([]byte, error) {
	return s.sendQuery(ctx, method, path, body, nil)
}

// sendQuery is send with a query string. An empty url.Values appends nothing —
// "?limit=" is not the same as omitting limit, and the API rejects the former.
func (s *CloudService) sendQuery(ctx context.Context, method, path string, body any, query url.Values) ([]byte, error) {
	var payload []byte
	hasBody := body != nil
	if hasBody {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("writ: encode request body: %w", err)
		}
		payload = b
	}
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	url := s.base + path

	// One key per logical call, reused by every retry of it — that is what makes
	// repeating an unsafe method safe rather than duplicative.
	idempotencyKey := ""
	if !methodIsSafe(method) {
		idempotencyKey = newIdempotencyKey()
	}

	build := func() (*http.Request, error) {
		var reader io.Reader
		if payload != nil {
			reader = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, method, url, reader)
		if err != nil {
			return nil, fmt.Errorf("writ: build request: %w", err)
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Accept", "application/json")
		if s.apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+s.apiKey)
		} else {
			id, err := s.resolveClientID()
			if err != nil {
				return nil, err
			}
			req.Header.Set(clientIDHeader, id)
		}
		if hasBody {
			req.Header.Set("Content-Type", "application/json")
		}
		if idempotencyKey != "" {
			req.Header.Set("Idempotency-Key", idempotencyKey)
		}
		return req, nil
	}

	policy := s.retry
	// A key we could not mint means we cannot prove a repeat is the same call,
	// so this one request falls back to no-retry rather than risking a duplicate.
	if !methodIsSafe(method) && idempotencyKey == "" {
		policy.RetryUnsafeMethods = false
	}

	resp, err := doWithRetry(ctx, s.httpc, policy, method, build)
	if err != nil {
		return nil, &ConnectionError{URL: url, Err: err}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &ConnectionError{URL: url, Err: err}
	}
	if resp.StatusCode/100 == 2 {
		return data, nil
	}
	return nil, cloudErrorFrom(resp.StatusCode, data)
}

// resolveClientID returns the override, the cached id, or reads/mints the
// stable keyless device id at ~/.writ/client_id (once, memoized).
func (s *CloudService) resolveClientID() (string, error) {
	if s.clientIDOverride != "" {
		return s.clientIDOverride, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.clientID != "" {
		return s.clientID, nil
	}
	s.clientID = loadOrMintClientID()
	return s.clientID, nil
}

// --- error mapping ----------------------------------------------------------

// cloudErrorFrom maps a non-2xx cloud response into a typed error. The body is
// shaped {"detail":{"message","code","reset_at","requests_remaining",
// "pages_remaining"}}; some errors are flat {"code","message"}. 429 →
// *RateLimitedError, 402 api_key_required → *APIKeyRequiredError, other 402 →
// *InsufficientCreditsError, else → *APIError.
func cloudErrorFrom(status int, body []byte) error {
	// Locate the "detail" object when present, else use the top-level object.
	var top map[string]json.RawMessage
	_ = json.Unmarshal(body, &top)
	d := top
	if raw, ok := top["detail"]; ok {
		var dm map[string]json.RawMessage
		if json.Unmarshal(raw, &dm) == nil && dm != nil {
			d = dm
		}
	}

	code := rawString(d, "code")
	if code == "" {
		code = codeForStatus(status)
	}
	message := rawString(d, "message")
	if message == "" {
		// A plain-string "detail" (e.g. {"detail":"..."}) is the message.
		if raw, ok := top["detail"]; ok {
			var s string
			if json.Unmarshal(raw, &s) == nil {
				message = s
			}
		}
	}
	if message == "" {
		message = http.StatusText(status)
	}
	base := APIError{Status: status, Code: code, Message: message, Body: body}

	switch {
	case status == http.StatusTooManyRequests:
		return &RateLimitedError{
			APIError:          base,
			ResetAt:           rawString(d, "reset_at"),
			RequestsRemaining: rawInt(d, "requests_remaining"),
			PagesRemaining:    rawInt(d, "pages_remaining"),
		}
	case status == http.StatusPaymentRequired && code == "api_key_required":
		return &APIKeyRequiredError{base}
	case status == http.StatusPaymentRequired:
		// Two different 402s share this status. Distinguish them STRUCTURALLY
		// rather than by a code allowlist that would drift as the backend adds
		// limits: a plan denial (services.plan_enforcer.PlanLimitDenied) always
		// reports the ceiling it hit as a numeric `limit`, while a credits/wallet
		// 402 never does. Calling a plan ceiling "insufficient credits" would
		// send the caller to top up a wallet that was never the problem.
		if lim := rawInt(d, "limit"); lim != nil {
			return &PlanLimitError{
				APIError:    base,
				Current:     derefInt(rawInt(d, "current")),
				Limit:       *lim,
				UpgradeHint: rawString(d, "upgrade_hint"),
			}
		}
		return &InsufficientCreditsError{base}
	default:
		return &base
	}
}

func derefInt(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}

// decodeQuota parses a quota body, accepting either {"quota": {...}} or a flat
// object, and stamps the tier.
func decodeQuota(data []byte) (*KeylessQuota, error) {
	var wrap struct {
		Quota *KeylessQuota `json:"quota"`
	}
	if json.Unmarshal(data, &wrap) == nil && wrap.Quota != nil {
		wrap.Quota.Tier = TierKeyless
		return wrap.Quota, nil
	}
	var q KeylessQuota
	if err := json.Unmarshal(data, &q); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	q.Tier = TierKeyless
	return &q, nil
}

// --- helpers ----------------------------------------------------------------

func rawString(m map[string]json.RawMessage, key string) string {
	raw, ok := m[key]
	if !ok {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

func rawInt(m map[string]json.RawMessage, key string) *int {
	raw, ok := m[key]
	if !ok {
		return nil
	}
	var n int
	if json.Unmarshal(raw, &n) == nil {
		return &n
	}
	return nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// loadOrMintClientID reads (or mints + best-effort persists) the stable keyless
// device id at ~/.writ/client_id. A read-only filesystem falls back to an
// ephemeral id (per contract).
func loadOrMintClientID() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return randomID()
	}
	dir := filepath.Join(home, ".writ")
	file := filepath.Join(dir, "client_id")
	if data, err := os.ReadFile(file); err == nil {
		if id := strings.TrimSpace(string(data)); id != "" {
			return id
		}
	}
	id := randomID()
	if os.MkdirAll(dir, 0o700) == nil {
		_ = os.WriteFile(file, []byte(id), 0o600)
	}
	return id
}

// randomID returns a 128-bit URL-safe base64 id with no padding.
func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		for i := range b {
			b[i] = byte(i * 2654435761)
		}
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
