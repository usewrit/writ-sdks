// Package writ is the official Go SDK for the Writ local agent (writ-agentd),
// the loopback HTTP daemon serving the /v1 REST API on 127.0.0.1:8131.
//
// Construct a client with New (no I/O) or Discover (runs daemon discovery):
//
//	client, err := writ.Discover(ctx)
//	if err != nil { ... }
//	page, err := client.Workflows.List(ctx, nil)
//
// A client built with New and no explicit base URL/token performs discovery
// lazily on its first request (once per client). Discovery follows the daemon's
// own algorithm: WRIT_API_URL/WRIT_TOKEN env overrides, then runtime.json
// descriptors under $WRIT_HOME, the active desktop profile, ~/.writ, and every
// ~/.writ/profiles/* directory — each candidate liveness-probed against
// GET /v1/agent with a 2 second budget.
//
// All request/response shapes mirror the Rust daemon source
// (writ-agent/src/local/); see DESIGN.md for the
// cross-language contract.
package writ

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Version is the SDK version reported in the User-Agent header.
const Version = "0.1.0"

// userAgent is sent on every request as required by the cross-SDK contract.
const userAgent = "writ-sdk-go/" + Version

// defaultTimeout is the per-request timeout applied when the caller's context
// carries no tighter deadline. Streaming requests (SSE) are exempt.
const defaultTimeout = 30 * time.Second

// Client talks to a Writ local agent. Construct with New or Discover.
// A Client is safe for concurrent use.
type Client struct {
	baseURL string
	token   string
	timeout time.Duration
	caFile  string
	httpc   *http.Client

	// Writ Cloud (client.Cloud) config — resolved into the CloudService.
	apiKey    string
	cloudURL  string
	clientID  string
	cloudHTTP *http.Client

	initOnce sync.Once
	initErr  error

	discoverOnce sync.Once
	discoverErr  error

	// Poll cadence for the RunAndWait fallback; overridable in tests.
	pollInterval time.Duration

	Agent       *AgentService
	Workflows   *WorkflowsService
	Runs        *RunsService
	Monitors    *MonitorsService
	Selectors   *SelectorsService
	Extractors  *ExtractorsService
	Automations *AutomationsService
	Personas    *PersonasService
	Secrets     *SecretsService
	Vault       *VaultService
	Files       *FilesService
	Data        *DataService
	Keys        *KeysService
	Crawl       *CrawlService
	Datasets    *DatasetsService
	Cloud       *CloudService
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL sets the agent base URL (e.g. "http://127.0.0.1:8131").
// No trailing "/v1" — the SDK appends path prefixes itself. A trailing "/"
// is stripped. An explicit base URL wins over discovery.
func WithBaseURL(u string) Option {
	return func(c *Client) { c.baseURL = strings.TrimRight(u, "/") }
}

// WithToken sets the bearer token (wlt_/wlk_/wlo_ — treated as opaque).
// An explicit token wins over discovery.
func WithToken(token string) Option {
	return func(c *Client) { c.token = token }
}

// WithHTTPClient supplies a custom *http.Client (e.g. with a custom TLS
// transport for the HTTPS twin port). When set, WithCAFile is ignored.
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) { c.httpc = h }
}

// WithTimeout sets the per-request timeout (default 30s). It does not apply
// to SSE streams; RunAndWait manages its own overall deadline.
func WithTimeout(d time.Duration) Option {
	return func(c *Client) { c.timeout = d }
}

// WithCAFile adds a PEM CA bundle (e.g. ~/.writ/tls/ca.pem) to the trust
// store, for talking to the daemon's HTTPS twin port. The file is read
// lazily on the first request (New performs no I/O). Ignored when
// WithHTTPClient is also given.
func WithCAFile(path string) Option {
	return func(c *Client) { c.caFile = path }
}

// WithAPIKey sets the metered Writ Cloud API key (wt_/wlk_) for the client.Cloud
// surface. Falls back to WRIT_API_KEY; absent → the free keyless tier. This is
// independent of WithToken, which authenticates the LOCAL daemon.
func WithAPIKey(key string) Option {
	return func(c *Client) { c.apiKey = key }
}

// WithCloudURL overrides the Writ Cloud base URL for client.Cloud. Falls back to
// WRIT_CLOUD_URL, then https://api.usewrit.app. A trailing "/" is stripped.
func WithCloudURL(u string) Option {
	return func(c *Client) { c.cloudURL = u }
}

// WithClientID overrides the keyless device/client id for client.Cloud (else the
// SDK reads/mints a stable id at ~/.writ/client_id). Falls back to
// WRIT_CLIENT_ID.
func WithClientID(id string) Option {
	return func(c *Client) { c.clientID = id }
}

// WithCloudHTTPClient supplies a custom *http.Client for the client.Cloud
// surface (mainly for tests). Defaults to a fresh *http.Client.
func WithCloudHTTPClient(h *http.Client) Option {
	return func(c *Client) { c.cloudHTTP = h }
}

// New builds a Client without performing any I/O. If no token/base URL is
// configured (explicitly or via WRIT_API_URL/WRIT_TOKEN at request time), the
// first request runs daemon discovery once (single-flight, memoized) and
// returns a *DiscoveryError on failure.
func New(opts ...Option) *Client {
	c := &Client{
		timeout:      defaultTimeout,
		pollInterval: time.Second,
	}
	for _, o := range opts {
		o(c)
	}
	c.baseURL = strings.TrimRight(c.baseURL, "/")

	c.Agent = &AgentService{c: c}
	c.Workflows = &WorkflowsService{c: c}
	c.Runs = &RunsService{c: c}
	c.Monitors = &MonitorsService{c: c}
	c.Selectors = &SelectorsService{c: c}
	c.Extractors = &ExtractorsService{c: c}
	c.Automations = &AutomationsService{c: c}
	c.Personas = &PersonasService{c: c}
	c.Secrets = &SecretsService{c: c}
	c.Vault = &VaultService{c: c}
	c.Files = &FilesService{c: c}
	c.Data = &DataService{c: c}
	c.Keys = &KeysService{c: c}
	c.Crawl = &CrawlService{c: c}
	c.Datasets = &DatasetsService{c: c}
	c.Cloud = newCloudService(c)
	return c
}

// Discover builds a Client and eagerly runs the daemon discovery algorithm
// (env overrides, WRIT_HOME, active profile, ~/.writ, profile scan — each
// candidate probed against GET /v1/agent within 2s; stale descriptors fall
// through to the next candidate). Explicit options always win over discovery.
// Returns a *DiscoveryError when no live daemon is found.
func Discover(ctx context.Context, opts ...Option) (*Client, error) {
	c := New(opts...)
	if err := c.ready(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// ready resolves the transport and (if needed) the endpoint before a request.
func (c *Client) ready(ctx context.Context) error {
	c.initOnce.Do(func() { c.initErr = c.initTransport() })
	if c.initErr != nil {
		return c.initErr
	}
	if c.baseURL != "" && c.token != "" {
		return nil
	}
	c.discoverOnce.Do(func() {
		base, token, err := discoverEndpoint(ctx, c.http(), c.baseURL, c.token)
		if err != nil {
			c.discoverErr = err
			return
		}
		c.baseURL, c.token = base, token
	})
	return c.discoverErr
}

// initTransport builds the default HTTP client, loading the CA file when one
// was configured. Runs once, lazily, so New never touches the filesystem.
func (c *Client) initTransport() error {
	if c.httpc != nil {
		return nil
	}
	if c.caFile == "" {
		c.httpc = &http.Client{}
		return nil
	}
	pem, err := os.ReadFile(c.caFile)
	if err != nil {
		return &ConnectionError{URL: c.caFile, Err: fmt.Errorf("reading CA file: %w", err)}
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		return &ConnectionError{URL: c.caFile, Err: fmt.Errorf("no PEM certificates found in CA file")}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool}
	c.httpc = &http.Client{Transport: transport}
	return nil
}

func (c *Client) http() *http.Client {
	return c.httpc
}

// WSTicket mints a single-use WebSocket connect ticket
// (POST /v1/ws-ticket). route is "record" or "ai-preview"; channel is
// required for "ai-preview" and must be empty for "record".
func (c *Client) WSTicket(ctx context.Context, route, channel string) (*WSTicket, error) {
	body := map[string]any{"route": route}
	if channel != "" {
		body["channel"] = channel
	}
	var out WSTicket
	if err := c.callJSON(ctx, http.MethodPost, "/v1/ws-ticket", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
