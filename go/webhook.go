package writ

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Webhook delivery headers. Writ signs every outbound delivery twice:
//
//	X-Writ-Signature-V1  HMAC-SHA256 over "{timestamp}." + raw body  ← verify this
//	X-Writ-Signature     HMAC-SHA256 over the raw body alone         ← legacy
//
// V1 binds the timestamp into the MAC, so a captured delivery stops being
// replayable the moment its timestamp goes stale. The body-only signature is
// still sent for handlers written before V1 and is accepted here as a fallback,
// but it CANNOT support a freshness check — nothing ties it to a point in time.
const (
	WebhookSignatureV1Header = "X-Writ-Signature-V1"
	WebhookSignatureHeader   = "X-Writ-Signature"
	WebhookTimestampHeader   = "X-Writ-Timestamp"
)

// DefaultWebhookTolerance is the freshness window for a V1 signature, matching
// the server's own ±5 minutes.
const DefaultWebhookTolerance = 5 * time.Minute

// Errors returned by VerifyWebhook. Compare with errors.Is.
var (
	// ErrWebhookNoSignature means the request carried no Writ signature header.
	ErrWebhookNoSignature = errors.New("writ: request carries no Writ webhook signature")
	// ErrWebhookSignatureMismatch means the computed MAC did not match. Treat the
	// request as hostile: do not act on the payload.
	ErrWebhookSignatureMismatch = errors.New("writ: webhook signature does not match")
	// ErrWebhookStale means the delivery's timestamp is outside the tolerance —
	// a replay, or clocks far enough apart to be worth fixing.
	ErrWebhookStale = errors.New("writ: webhook timestamp is outside the tolerance window")
	// ErrWebhookBadTimestamp means the timestamp header was missing or unparsable
	// while a V1 signature was being verified.
	ErrWebhookBadTimestamp = errors.New("writ: webhook timestamp header is missing or malformed")
)

// WebhookVerifyOptions tunes VerifyWebhook. The zero value is the recommended
// posture: V1 required, ±5 minutes, legacy body-only signatures refused.
type WebhookVerifyOptions struct {
	// Tolerance overrides the freshness window. Zero uses
	// DefaultWebhookTolerance. Negative disables the freshness check entirely —
	// only sensible when something upstream already enforces replay protection.
	Tolerance time.Duration

	// AllowLegacyBodyOnly accepts a delivery carrying ONLY the body-only
	// X-Writ-Signature. Off by default: that signature cannot be checked for
	// freshness, so accepting it silently reintroduces unlimited replay. Turn it
	// on only while migrating a handler that predates V1.
	AllowLegacyBodyOnly bool

	// Now overrides the clock (tests).
	Now func() time.Time
}

// VerifyWebhook authenticates an outbound Writ delivery.
//
//	func handler(w http.ResponseWriter, r *http.Request) {
//	    body, _ := io.ReadAll(r.Body)
//	    if err := writ.VerifyWebhook(r.Header, body, os.Getenv("WRIT_WEBHOOK_SECRET"), nil); err != nil {
//	        http.Error(w, "bad signature", http.StatusUnauthorized)
//	        return
//	    }
//	    // ... body is authentic and fresh
//	}
//
// body MUST be the exact bytes received. Unmarshalling and re-marshalling first
// changes them (key order, spacing, number formatting) and the MAC will not
// match — this is the single most common cause of a "wrong secret" report.
//
// Comparison is constant-time, so a caller cannot learn the expected MAC by
// timing repeated attempts.
func VerifyWebhook(headers http.Header, body []byte, secret string, opts *WebhookVerifyOptions) error {
	cfg := WebhookVerifyOptions{}
	if opts != nil {
		cfg = *opts
	}
	if secret == "" {
		return fmt.Errorf("writ: webhook secret is empty")
	}

	if v1 := strings.TrimSpace(headers.Get(WebhookSignatureV1Header)); v1 != "" {
		ts := strings.TrimSpace(headers.Get(WebhookTimestampHeader))
		if ts == "" {
			return ErrWebhookBadTimestamp
		}
		if err := checkFreshness(ts, cfg); err != nil {
			return err
		}
		if !macMatches(v1, secret, append(append([]byte(ts), '.'), body...)) {
			return ErrWebhookSignatureMismatch
		}
		return nil
	}

	legacy := strings.TrimSpace(headers.Get(WebhookSignatureHeader))
	if legacy == "" {
		return ErrWebhookNoSignature
	}
	if !cfg.AllowLegacyBodyOnly {
		return fmt.Errorf(
			"%w: only the body-only %s was present. It cannot be checked for freshness, so it is "+
				"refused by default — set WebhookVerifyOptions.AllowLegacyBodyOnly while migrating",
			ErrWebhookNoSignature, WebhookSignatureHeader,
		)
	}
	if !macMatches(legacy, secret, body) {
		return ErrWebhookSignatureMismatch
	}
	return nil
}

// checkFreshness enforces the replay window against the signed timestamp.
func checkFreshness(ts string, cfg WebhookVerifyOptions) error {
	tolerance := cfg.Tolerance
	if tolerance == 0 {
		tolerance = DefaultWebhookTolerance
	}
	if tolerance < 0 {
		return nil
	}
	secs, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return ErrWebhookBadTimestamp
	}
	now := time.Now
	if cfg.Now != nil {
		now = cfg.Now
	}
	// Absolute skew: a delivery timestamped in the FUTURE is as suspect as a
	// stale one — it means forged headers or a badly wrong clock.
	drift := now().Sub(time.Unix(secs, 0))
	if drift < 0 {
		drift = -drift
	}
	if drift > tolerance {
		return fmt.Errorf("%w: %s is %s away from now", ErrWebhookStale, ts, drift.Round(time.Second))
	}
	return nil
}

// macMatches compares a `sha256=<hex>` (or bare hex) header against the MAC of
// signed, in constant time.
func macMatches(header, secret string, signed []byte) bool {
	got := strings.TrimPrefix(header, "sha256=")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(signed)
	want := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(strings.ToLower(got)), []byte(want))
}

// SignWebhookRequest produces the headers for an INBOUND call to a Writ hook
// (POST /api/webhooks/hook/{token}), which requires a fresh signed timestamp:
// the MAC covers "{timestamp}." + body, and an unsigned or stale call is
// rejected 401.
//
//	headers := writ.SignWebhookRequest(body, secret)
//	for k, v := range headers { req.Header.Set(k, v) }
func SignWebhookRequest(body []byte, secret string) map[string]string {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(append(append([]byte(ts), '.'), body...))
	return map[string]string{
		WebhookTimestampHeader: ts,
		WebhookSignatureHeader: "sha256=" + hex.EncodeToString(mac.Sum(nil)),
	}
}
