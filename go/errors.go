package writ

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"
)

// Error is implemented by every error type this SDK returns for wire-level
// failures (*APIError, *ConnectionError, *DiscoveryError). It plays the role
// of the shared WritError base class in the other SDKs.
type Error interface {
	error
	writError()
}

// APIError is a non-2xx HTTP response from the daemon.
//
// Domain errors arrive as JSON {"error": "<msg>", "code": "<code>"}; some
// axum rejections are plain text. Code is taken from the JSON body when
// present, else derived from the HTTP status. Message resolution from a JSON
// body: "error" → "detail" → "message" → HTTP status text. Body always holds
// the raw response bytes.
type APIError struct {
	Status  int
	Code    string
	Message string
	Body    []byte
}

func (e *APIError) Error() string {
	return fmt.Sprintf("writ: HTTP %d %s: %s", e.Status, e.Code, e.Message)
}

func (e *APIError) writError() {}

// ConnectionError is a network-level failure (daemon down mid-session,
// timeout, refused connection, dropped stream).
// RunTimeoutError is returned by Workflows.Run when RunOptions.Wait was set and
// the daemon's wait budget expired (HTTP 504).
//
// NOT a failure of the run: it is still executing and RunID still addresses it —
// poll Runs.Get, stream Runs.Events, or Runs.Cancel it. Retrying the call would
// start a SECOND run, which is exactly what carrying the id here prevents.
type RunTimeoutError struct {
	// RunID is the still-running run.
	RunID int64
	// StatusURL / EventsURL address it, as reported by the daemon.
	StatusURL string
	EventsURL string
}

func (e *RunTimeoutError) Error() string {
	return fmt.Sprintf(
		"writ: run %d did not finish within the requested budget and is STILL RUNNING — "+
			"observe it with Runs.Events(%d) or Runs.Get(%d); do not retry, that would start a second run",
		e.RunID, e.RunID, e.RunID,
	)
}

type ConnectionError struct {
	URL string
	Err error
}

func (e *ConnectionError) Error() string {
	return fmt.Sprintf("writ: connection error (%s): %v", e.URL, e.Err)
}

func (e *ConnectionError) Unwrap() error { return e.Err }

func (e *ConnectionError) writError() {}

// DiscoveryError means no live Writ agent could be found (see the package
// docs for the discovery algorithm). Its message says how to fix it.
type DiscoveryError struct {
	Message string
}

func (e *DiscoveryError) Error() string { return "writ: " + e.Message }

func (e *DiscoveryError) writError() {}

// APIKeyRequiredError means a whole-site crawl was requested on the keyless
// Writ Cloud tier (no API key). Crawl is metered and always needs a credential
// — set an API key (WithAPIKey or WRIT_API_KEY). Keyless access covers scrape +
// map only. Returned by CloudService.Crawl (before any network call) and by the
// cloud on HTTP 402 with code "api_key_required". Embeds APIError.
type APIKeyRequiredError struct {
	APIError
}

// InsufficientCreditsError means the tenant's crawl-page allotment is spent and
// the wallet cannot cover the call (HTTP 402). Embeds APIError.
type InsufficientCreditsError struct {
	APIError
}

// RateLimitedError means the keyless daily allowance (requests/day or pages/day,
// per device or IP) is exhausted (HTTP 429). ResetAt is when the allowance
// refills; add an API key for a full metered quota. Embeds APIError; the
// remaining-count fields are nil when the cloud did not report them.
type RateLimitedError struct {
	APIError
	// ResetAt is the ISO timestamp when the keyless daily allowance resets.
	ResetAt string
	// RequestsRemaining is keyless requests left today, when reported.
	RequestsRemaining *int
	// PagesRemaining is keyless pages left today, when reported.
	PagesRemaining *int
}

// maxPlainTextMessage caps the plain-text error message length (~500 chars).
const maxPlainTextMessage = 500

// codeForStatus derives the stable machine code from an HTTP status when the
// body carried none (plain-text axum rejections).
func codeForStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "bad_request"
	case http.StatusUnauthorized:
		return "unauthorized"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusNotFound:
		return "not_found"
	case http.StatusConflict:
		return "conflict"
	case http.StatusUnprocessableEntity:
		return "unprocessable"
	case http.StatusTooManyRequests:
		return "rate_limited"
	}
	if status >= 500 {
		return "internal"
	}
	return fmt.Sprintf("http_%d", status)
}

// newAPIError maps a non-2xx response body per the DESIGN §5 rules.
func newAPIError(status int, body []byte) *APIError {
	e := &APIError{Status: status, Body: body}

	var parsed map[string]json.RawMessage
	if json.Unmarshal(body, &parsed) == nil && parsed != nil {
		if raw, ok := parsed["code"]; ok {
			var s string
			if json.Unmarshal(raw, &s) == nil {
				e.Code = s
			}
		}
		for _, key := range []string{"error", "detail", "message"} {
			raw, ok := parsed[key]
			if !ok {
				continue
			}
			var s string
			if json.Unmarshal(raw, &s) == nil && s != "" {
				e.Message = s
				break
			}
		}
	} else {
		// Plain-text body: the raw text (truncated) is the message.
		txt := strings.TrimSpace(string(body))
		if len(txt) > maxPlainTextMessage {
			cut := maxPlainTextMessage
			for cut > 0 && !utf8.RuneStart(txt[cut]) {
				cut--
			}
			txt = txt[:cut]
		}
		e.Message = txt
	}

	if e.Message == "" {
		e.Message = http.StatusText(status)
	}
	if e.Code == "" {
		e.Code = codeForStatus(status)
	}
	return e
}
