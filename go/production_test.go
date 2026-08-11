package writ

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// A transient 503 must not surface to the caller when a retry would clear it.
func TestRetriesTransientServerError(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"id":1,"url":"https://example.com"}`))
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL), WithToken("wlt_x"),
		WithRetry(RetryPolicy{MaxAttempts: 4, BaseDelay: time.Millisecond, MaxDelay: 5 * time.Millisecond}))
	if _, err := c.Monitors.Get(ctxT(t), 1); err != nil {
		t.Fatalf("expected the third attempt to succeed, got %v", err)
	}
	if got := hits.Load(); got != 3 {
		t.Errorf("made %d attempts, want 3", got)
	}
}

// A POST against the LOCAL daemon must NEVER be retried: the daemon has no
// Idempotency-Key lane, so a second attempt is a second monitor.
func TestUnsafeMethodNotRetriedOnDaemon(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL), WithToken("wlt_x"),
		WithRetry(RetryPolicy{MaxAttempts: 4, BaseDelay: time.Millisecond}))
	if _, err := c.Monitors.Create(ctxT(t), map[string]any{"url": "https://example.com"}); err == nil {
		t.Fatal("expected the 503 to surface")
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("POST was attempted %d times against the daemon, want exactly 1", got)
	}
}

// The cloud DOES retry unsafe methods — and every attempt must carry the same
// Idempotency-Key, which is what makes the repeat a replay rather than a
// duplicate creation.
func TestCloudRetriesUnsafeMethodWithStableIdempotencyKey(t *testing.T) {
	var hits atomic.Int32
	var keys []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		if hits.Add(1) < 2 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"id":7,"url":"https://example.com","checkType":"content"}`))
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithAPIKey("wt_test"),
		WithRetry(RetryPolicy{MaxAttempts: 3, BaseDelay: time.Millisecond}))
	mon, err := c.Cloud.Monitors.Create(ctxT(t), CloudMonitorParams{URL: "https://example.com"})
	if err != nil {
		t.Fatalf("expected the retry to succeed: %v", err)
	}
	if mon.ID != 7 {
		t.Errorf("monitor = %+v", mon)
	}
	if len(keys) != 2 {
		t.Fatalf("made %d attempts, want 2", len(keys))
	}
	if keys[0] == "" {
		t.Fatal("unsafe cloud request carried no Idempotency-Key; retrying it would duplicate")
	}
	if keys[0] != keys[1] {
		t.Errorf("retry changed the Idempotency-Key (%q → %q); the server would execute twice", keys[0], keys[1])
	}
}

// A Retry-After far in the future means the condition will not clear. Sleeping
// on it is worse than handing the caller the response, which carries the reset.
func TestLongRetryAfterIsNotSleptOn(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Retry-After", "36000") // 10 hours
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"detail":{"code":"rate_limited","message":"daily allowance spent"}}`))
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithAPIKey("wt_test"))
	start := time.Now()
	_, err := c.Cloud.Monitors.List(ctxT(t), nil)
	if err == nil {
		t.Fatal("expected a rate-limit error")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("waited %s on an unclearable Retry-After", elapsed)
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("made %d attempts, want 1", got)
	}
}

// A short Retry-After IS honoured, and beats the computed backoff.
func TestShortRetryAfterIsHonoured(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) < 2 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithAPIKey("wt_test"))
	start := time.Now()
	if _, err := c.Cloud.Monitors.List(ctxT(t), nil); err != nil {
		t.Fatalf("expected the retry to succeed: %v", err)
	}
	if elapsed := time.Since(start); elapsed < time.Second {
		t.Errorf("retried after %s, ignoring the server's Retry-After: 1", elapsed)
	}
}

// Watch must walk the keyset cursor forward: no gaps when a page fills, no
// repeats, and the cursor advances on last_detected_at + id.
func TestWatchWalksCursorWithoutGapsOrRepeats(t *testing.T) {
	// Three changes; the watcher pages two at a time.
	rows := []string{
		`{"id":1,"target_id":10,"target_url":"https://a","first_detected_at":"2026-08-05T00:00:00Z","last_detected_at":"2026-08-05T00:00:01Z"}`,
		`{"id":2,"target_id":10,"target_url":"https://a","first_detected_at":"2026-08-05T00:00:00Z","last_detected_at":"2026-08-05T00:00:02Z"}`,
		`{"id":3,"target_id":11,"target_url":"https://b","first_detected_at":"2026-08-05T00:00:00Z","last_detected_at":"2026-08-05T00:00:03Z"}`,
	}
	var queries []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		queries = append(queries, r.URL.RawQuery)
		since := q.Get("since")
		sinceID, _ := strconv.ParseInt(q.Get("since_id"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))

		// Mirror the server exactly: NO cursor is the newest-first browsing view;
		// a cursor is an oldest-first keyset walk.
		out := []string{}
		if since == "" {
			for i := len(rows) - 1; i >= 0; i-- {
				out = append(out, rows[i])
				if limit > 0 && len(out) == limit {
					break
				}
			}
		} else {
			for i, row := range rows {
				id := int64(i + 1)
				ts := fmt.Sprintf("2026-08-05T00:00:0%dZ", i+1)
				if ts < since || (ts == since && id <= sinceID) {
					continue
				}
				out = append(out, row)
				if limit > 0 && len(out) == limit {
					break
				}
			}
		}
		_, _ = w.Write([]byte("[" + join(out, ",") + "]"))
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithAPIKey("wt_test"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var got []int64
	for change, err := range c.Cloud.Monitors.Watch(ctx, &WatchOptions{
		PageSize:      2,
		Interval:      10 * time.Millisecond,
		ReplayHistory: true,
	}) {
		if err != nil {
			t.Fatalf("watch error: %v", err)
		}
		got = append(got, change.ID)
		if len(got) == 3 {
			break
		}
	}
	if len(got) != 3 || got[0] != 1 || got[1] != 2 || got[2] != 3 {
		t.Fatalf("watch delivered %v, want [1 2 3] exactly once each", got)
	}
	if len(queries) < 2 {
		t.Fatalf("watch made %d requests; a full page must be drained immediately, not after an interval", len(queries))
	}
}

// A fresh watcher must not replay the whole archive.
func TestWatchStartsAtHeadByDefault(t *testing.T) {
	var sawBootstrap bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("since") == "" && q.Get("limit") == "1" {
			sawBootstrap = true
			_, _ = w.Write([]byte(`[{"id":99,"target_id":1,"target_url":"https://a","first_detected_at":"2026-08-05T00:00:00Z","last_detected_at":"2026-08-05T09:00:00Z"}]`))
			return
		}
		if q.Get("since") != "2026-08-05T09:00:00Z" || q.Get("since_id") != "99" {
			t.Errorf("watcher did not start from the head: since=%q since_id=%q", q.Get("since"), q.Get("since_id"))
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	c := New(WithCloudURL(srv.URL), WithAPIKey("wt_test"))
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	for range c.Cloud.Monitors.Watch(ctx, &WatchOptions{Interval: 20 * time.Millisecond}) {
		t.Fatal("a head-started watcher must not deliver pre-existing history")
	}
	if !sawBootstrap {
		t.Error("watcher never read the feed head to establish its cursor")
	}
}

func TestVerifyWebhookAcceptsV1AndRejectsTampering(t *testing.T) {
	secret := "whsec_test"
	body := []byte(`{"event":"change_detected","target":{"id":42}}`)
	ts := strconv.FormatInt(time.Now().Unix(), 10)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "." + string(body)))
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	h := http.Header{}
	h.Set(WebhookTimestampHeader, ts)
	h.Set(WebhookSignatureV1Header, sig)

	if err := VerifyWebhook(h, body, secret, nil); err != nil {
		t.Fatalf("valid V1 delivery rejected: %v", err)
	}
	if err := VerifyWebhook(h, append(body, ' '), secret, nil); !errors.Is(err, ErrWebhookSignatureMismatch) {
		t.Errorf("tampered body: got %v, want a signature mismatch", err)
	}
	if err := VerifyWebhook(h, body, "wrong-secret", nil); !errors.Is(err, ErrWebhookSignatureMismatch) {
		t.Errorf("wrong secret: got %v, want a signature mismatch", err)
	}
}

func TestVerifyWebhookRejectsStaleAndBodyOnlyByDefault(t *testing.T) {
	secret := "whsec_test"
	body := []byte(`{"event":"change_detected"}`)

	// Stale: signed correctly, but an hour old — a replay.
	old := strconv.FormatInt(time.Now().Add(-time.Hour).Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(old + "." + string(body)))
	stale := http.Header{}
	stale.Set(WebhookTimestampHeader, old)
	stale.Set(WebhookSignatureV1Header, "sha256="+hex.EncodeToString(mac.Sum(nil)))
	if err := VerifyWebhook(stale, body, secret, nil); !errors.Is(err, ErrWebhookStale) {
		t.Errorf("hour-old delivery: got %v, want ErrWebhookStale", err)
	}

	// Body-only legacy signature: valid MAC, but unverifiable freshness.
	legacyMac := hmac.New(sha256.New, []byte(secret))
	legacyMac.Write(body)
	legacy := http.Header{}
	legacy.Set(WebhookSignatureHeader, "sha256="+hex.EncodeToString(legacyMac.Sum(nil)))
	if err := VerifyWebhook(legacy, body, secret, nil); err == nil {
		t.Error("body-only signature accepted by default; that silently allows unlimited replay")
	}
	if err := VerifyWebhook(legacy, body, secret, &WebhookVerifyOptions{AllowLegacyBodyOnly: true}); err != nil {
		t.Errorf("body-only signature rejected even when explicitly allowed: %v", err)
	}
}

// SignWebhookRequest must produce headers the server's own verifier accepts —
// i.e. the MAC covers "{timestamp}." + body, not the body alone.
func TestSignWebhookRequestRoundTrips(t *testing.T) {
	secret := "whsec_inbound"
	body := []byte(`{"sku":"SKU-123"}`)
	headers := SignWebhookRequest(body, secret)

	h := http.Header{}
	for k, v := range headers {
		h.Set(k, v)
	}
	// The inbound scheme is V1's scheme, so verifying it under the V1 header must
	// succeed — one recipe for both directions.
	h.Set(WebhookSignatureV1Header, h.Get(WebhookSignatureHeader))
	if err := VerifyWebhook(h, body, secret, nil); err != nil {
		t.Fatalf("signed request does not verify: %v", err)
	}
}

func join(parts []string, sep string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += sep
		}
		out += p
	}
	return out
}
