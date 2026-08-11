package writ

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	mrand "math/rand/v2"
	"net/http"
	"strconv"
	"time"
)

// RetryPolicy governs automatic retries of transient failures.
//
// A production caller cannot treat one 503 or one dropped connection as fatal —
// but it also must not blindly repeat a request that may already have executed.
// The split below is the whole safety story:
//
//   - GET / HEAD / OPTIONS are idempotent by definition and always eligible.
//   - POST / PUT / PATCH are eligible ONLY when RetryUnsafeMethods is set, which
//     the SDK enables solely on the cloud surface, where every unsafe request
//     carries an Idempotency-Key the server replays instead of re-executing.
//     Against the local daemon (no such lane) unsafe methods are never retried,
//     because a second POST there is a second monitor.
//
// The zero value disables retries. Use DefaultRetryPolicy as a starting point.
type RetryPolicy struct {
	// MaxAttempts is the TOTAL number of attempts including the first.
	// 0 or 1 disables retrying.
	MaxAttempts int
	// BaseDelay is the first backoff step; each further attempt doubles it.
	BaseDelay time.Duration
	// MaxDelay caps a single backoff wait (before jitter).
	MaxDelay time.Duration
	// MaxRetryAfter is the longest server-requested wait worth honouring. When
	// Retry-After asks for longer, the response is returned immediately instead.
	// This is what keeps a genuinely exhausted quota — "retry in 9 hours", which
	// a keyless daily allowance really does say — from being slept on and retried
	// three times for nothing. Zero uses DefaultRetryPolicy's value.
	MaxRetryAfter time.Duration
	// RetryUnsafeMethods allows POST/PUT/PATCH to be retried. Only safe when the
	// target honours Idempotency-Key. See the type doc.
	RetryUnsafeMethods bool
}

// DefaultRetryPolicy is what both the local and cloud transports use unless the
// caller overrides it: four attempts over roughly 0.25s + 0.5s + 1s of backoff,
// which rides out a rolling deploy without turning a hung dependency into a
// minutes-long hang.
var DefaultRetryPolicy = RetryPolicy{
	MaxAttempts:   4,
	BaseDelay:     250 * time.Millisecond,
	MaxDelay:      8 * time.Second,
	MaxRetryAfter: 30 * time.Second,
}

// retryableStatuses are the responses worth trying again. 408/425 are the
// server asking for exactly that; 429 is a rate limit that WILL clear; 5xx here
// are the transient members of the family. 501/505 and the 4xx client errors are
// deliberately absent — repeating them just burns quota.
var retryableStatuses = map[int]bool{
	http.StatusRequestTimeout:      true, // 408
	http.StatusTooEarly:            true, // 425
	http.StatusTooManyRequests:     true, // 429
	http.StatusInternalServerError: true, // 500
	http.StatusBadGateway:          true, // 502
	http.StatusServiceUnavailable:  true, // 503
	http.StatusGatewayTimeout:      true, // 504
}

// WithRetry overrides the retry policy for both the local and cloud transports.
// Pass RetryPolicy{} to disable retrying entirely.
func WithRetry(p RetryPolicy) Option {
	return func(c *Client) { c.retry = &p }
}

// methodIsSafe reports whether a method may be repeated with no further
// precautions.
func methodIsSafe(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return false
}

// canRetryMethod applies the safe/unsafe split described on RetryPolicy.
func (p RetryPolicy) canRetryMethod(method string) bool {
	return methodIsSafe(method) || p.RetryUnsafeMethods
}

// backoff returns how long to wait before attempt n (1-based: n=1 is the wait
// after the FIRST failure). Exponential with full jitter — the randomisation is
// not a nicety, it is what stops a fleet of clients that all saw the same 503
// from re-converging into a synchronised thundering herd on every retry.
func (p RetryPolicy) backoff(n int) time.Duration {
	base := p.BaseDelay
	if base <= 0 {
		base = DefaultRetryPolicy.BaseDelay
	}
	maxDelay := p.MaxDelay
	if maxDelay <= 0 {
		maxDelay = DefaultRetryPolicy.MaxDelay
	}
	d := base << min(n-1, 20)
	if d > maxDelay || d <= 0 {
		d = maxDelay
	}
	return time.Duration(mrand.Int64N(int64(d)) + int64(d)/2)
}

// retryAfter parses a Retry-After header (delta-seconds or HTTP-date). The
// server's own number always beats our computed backoff — it knows when the
// limit resets and we are guessing.
func retryAfter(resp *http.Response) (time.Duration, bool) {
	if resp == nil {
		return 0, false
	}
	v := resp.Header.Get("Retry-After")
	if v == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs < 0 {
			return 0, false
		}
		return time.Duration(secs) * time.Second, true
	}
	if when, err := http.ParseTime(v); err == nil {
		d := time.Until(when)
		if d < 0 {
			d = 0
		}
		return d, true
	}
	return 0, false
}

// sleepCtx waits for d unless ctx ends first.
func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// doWithRetry executes build()+Do under the policy, returning the final
// response (or the final error). build is called once per attempt so each retry
// gets a fresh, unconsumed request body.
//
// A retried response body is drained and closed before the next attempt:
// dropping it un-drained leaks the connection out of the keep-alive pool, which
// turns a brief 503 burst into permanent connection churn.
func doWithRetry(
	ctx context.Context,
	hc *http.Client,
	p RetryPolicy,
	method string,
	build func() (*http.Request, error),
) (*http.Response, error) {
	attempts := p.MaxAttempts
	if attempts < 1 {
		attempts = 1
	}
	if !p.canRetryMethod(method) {
		attempts = 1
	}

	var lastResp *http.Response
	var lastErr error
	for attempt := 1; ; attempt++ {
		req, err := build()
		if err != nil {
			return nil, err
		}
		resp, err := hc.Do(req)

		switch {
		case err != nil:
			// A context cancellation is the caller's decision, not a transient
			// fault — surface it immediately instead of sleeping on it.
			if ctx.Err() != nil {
				return nil, err
			}
			lastResp, lastErr = nil, err
		case retryableStatuses[resp.StatusCode]:
			lastResp, lastErr = resp, nil
		default:
			return resp, nil
		}

		if attempt >= attempts {
			if lastResp != nil {
				return lastResp, nil
			}
			return nil, lastErr
		}

		wait := p.backoff(attempt)
		if d, ok := retryAfter(lastResp); ok {
			maxAfter := p.MaxRetryAfter
			if maxAfter <= 0 {
				maxAfter = DefaultRetryPolicy.MaxRetryAfter
			}
			if d > maxAfter {
				// The server is telling us this will not clear any time soon (an
				// exhausted daily allowance says hours). Hand the caller the real
				// answer now — it carries the reset time — instead of sleeping.
				return lastResp, nil
			}
			wait = d
		}
		if lastResp != nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(lastResp.Body, 1<<16))
			lastResp.Body.Close()
			lastResp = nil
		}
		if err := sleepCtx(ctx, wait); err != nil {
			if lastErr != nil {
				return nil, lastErr
			}
			return nil, err
		}
	}
}

// newIdempotencyKey mints an opaque key for one logical unsafe request. It is
// generated ONCE per call and reused across that call's retries — that is the
// entire point: the server recognises the repeat and replays its first answer
// instead of executing twice.
func newIdempotencyKey() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failing is not recoverable here, and a predictable key is
		// worse than none: fall back to no key, which disables unsafe retries
		// for this call rather than risking a cross-request collision.
		return ""
	}
	return "writ-" + hex.EncodeToString(b[:])
}
