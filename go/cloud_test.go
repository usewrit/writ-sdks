package writ

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// clearCloudEnv removes the cloud env overrides so tests are hermetic.
func clearCloudEnv(t *testing.T) {
	t.Helper()
	t.Setenv("WRIT_API_KEY", "")
	t.Setenv("WRIT_CLOUD_URL", "")
	t.Setenv("WRIT_CLIENT_ID", "")
}

// (a) Keyless scrape hits /v1/keyless/scrape with the X-Writ-Client-Id header
// and no bearer.
func TestCloudScrapeKeyless(t *testing.T) {
	clearCloudEnv(t)
	var gotAuth, gotClientID, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotClientID = r.Header.Get(clientIDHeader)
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"url":"https://example.com","title":"Example","format":"markdown","markdown":"# Hi","counts":{"links":3}}`))
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithClientID("dev-123"))
	if c.Cloud.Tier() != TierKeyless {
		t.Fatalf("tier = %q, want keyless", c.Cloud.Tier())
	}
	res, err := c.Cloud.Scrape(ctxT(t), "https://example.com")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/keyless/scrape" {
		t.Errorf("path = %q, want /v1/keyless/scrape", gotPath)
	}
	if gotAuth != "" {
		t.Errorf("Authorization = %q, want empty", gotAuth)
	}
	if gotClientID != "dev-123" {
		t.Errorf("%s = %q, want dev-123", clientIDHeader, gotClientID)
	}
	if gotBody["url"] != "https://example.com" {
		t.Errorf("body url = %v", gotBody["url"])
	}
	if res.Tier != TierKeyless || res.Markdown != "# Hi" || res.Title != "Example" {
		t.Errorf("res = %+v", res)
	}
	if res.Counts["links"] != 3 {
		t.Errorf("counts = %v", res.Counts)
	}
}

// (b) Metered scrape hits /api/crawl/scrape with Bearer and no client-id.
func TestCloudScrapeMetered(t *testing.T) {
	clearCloudEnv(t)
	var gotAuth, gotClientID, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotClientID = r.Header.Get(clientIDHeader)
		_, _ = w.Write([]byte(`{"url":"https://example.com","title":null,"format":"markdown","markdown":"body","counts":{}}`))
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithAPIKey("wt_secret"))
	if c.Cloud.Tier() != TierMetered {
		t.Fatalf("tier = %q, want metered", c.Cloud.Tier())
	}
	res, err := c.Cloud.Scrape(ctxT(t), "https://example.com")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/crawl/scrape" {
		t.Errorf("path = %q, want /api/crawl/scrape", gotPath)
	}
	if gotAuth != "Bearer wt_secret" {
		t.Errorf("Authorization = %q, want Bearer wt_secret", gotAuth)
	}
	if gotClientID != "" {
		t.Errorf("%s = %q, want empty", clientIDHeader, gotClientID)
	}
	if res.Tier != TierMetered {
		t.Errorf("tier = %q", res.Tier)
	}
}

// (c) Crawl with no key returns *APIKeyRequiredError and makes zero requests.
func TestCloudCrawlKeylessNoRequest(t *testing.T) {
	clearCloudEnv(t)
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithClientID("dev-123"))
	_, err := c.Cloud.Crawl(ctxT(t), CrawlStartParams{URL: "https://example.com"})
	var keyErr *APIKeyRequiredError
	if !errors.As(err, &keyErr) {
		t.Fatalf("want *APIKeyRequiredError, got %v", err)
	}
	if keyErr.Status != http.StatusPaymentRequired || keyErr.Code != "api_key_required" {
		t.Errorf("err = %+v", keyErr.APIError)
	}
	if hits != 0 {
		t.Errorf("server hits = %d, want 0 (no network call)", hits)
	}
}

// (d) A 429 maps to *RateLimitedError carrying ResetAt (+ remaining counts).
func TestCloudRateLimited(t *testing.T) {
	clearCloudEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"detail":{"code":"rate_limited","message":"daily cap reached","reset_at":"2026-07-17T00:00:00Z","requests_remaining":0,"pages_remaining":0}}`))
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithClientID("dev-123"))
	_, err := c.Cloud.Scrape(ctxT(t), "https://example.com")
	var rl *RateLimitedError
	if !errors.As(err, &rl) {
		t.Fatalf("want *RateLimitedError, got %v", err)
	}
	if rl.Status != http.StatusTooManyRequests {
		t.Errorf("status = %d", rl.Status)
	}
	if rl.ResetAt != "2026-07-17T00:00:00Z" {
		t.Errorf("reset_at = %q", rl.ResetAt)
	}
	if rl.Code != "rate_limited" || rl.Message != "daily cap reached" {
		t.Errorf("err = %+v", rl.APIError)
	}
	if rl.RequestsRemaining == nil || *rl.RequestsRemaining != 0 {
		t.Errorf("requests_remaining = %v", rl.RequestsRemaining)
	}
}

// Map posts to the keyless endpoint with search + limit and unwraps the result.
func TestCloudMapKeyless(t *testing.T) {
	clearCloudEnv(t)
	var gotBody map[string]any
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"url":"https://example.com","host":"example.com","urls":[{"url":"https://example.com/a","score":0.9,"title":"A"}],"counts":{"returned":1,"total":10}}`))
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithClientID("dev-123"))
	limit := 5
	res, err := c.Cloud.Map(ctxT(t), "https://example.com", &CloudMapOptions{Search: "docs", Limit: &limit})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/keyless/map" {
		t.Errorf("path = %q", gotPath)
	}
	if gotBody["search"] != "docs" || gotBody["limit"] != float64(5) {
		t.Errorf("body = %v", gotBody)
	}
	if res.Host != "example.com" || len(res.URLs) != 1 || res.URLs[0].Title != "A" {
		t.Errorf("res = %+v", res)
	}
	if res.Counts.Returned != 1 || res.Counts.Total != 10 || res.Tier != TierKeyless {
		t.Errorf("counts/tier = %+v %q", res.Counts, res.Tier)
	}
}

// Quota returns nil when metered and the parsed allowance when keyless.
func TestCloudQuota(t *testing.T) {
	clearCloudEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/keyless/quota" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"quota":{"requests_remaining":4,"pages_remaining":40,"requests_per_day":5,"pages_per_day":50,"reset_at":"2026-07-17T00:00:00Z"}}`))
	}))
	defer srv.Close()

	metered := New(WithCloudURL(srv.URL), WithAPIKey("wt_secret"))
	q, err := metered.Cloud.Quota(ctxT(t))
	if err != nil {
		t.Fatal(err)
	}
	if q != nil {
		t.Errorf("metered quota = %+v, want nil", q)
	}

	keyless := New(WithCloudURL(srv.URL), WithClientID("dev-123"))
	q, err = keyless.Cloud.Quota(ctxT(t))
	if err != nil {
		t.Fatal(err)
	}
	if q == nil || q.RequestsRemaining != 4 || q.PagesPerDay != 50 || q.Tier != TierKeyless {
		t.Errorf("quota = %+v", q)
	}
}

// A 402 api_key_required from the wire maps to *APIKeyRequiredError; a plain
// 402 maps to *InsufficientCreditsError.
func TestCloudPaymentErrors(t *testing.T) {
	clearCloudEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = w.Write([]byte(`{"detail":{"code":"insufficient_credits","message":"wallet empty"}}`))
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithAPIKey("wt_secret"))
	_, err := c.Cloud.Scrape(ctxT(t), "https://example.com")
	var credErr *InsufficientCreditsError
	if !errors.As(err, &credErr) {
		t.Fatalf("want *InsufficientCreditsError, got %v", err)
	}
	if credErr.Message != "wallet empty" {
		t.Errorf("message = %q", credErr.Message)
	}
}
