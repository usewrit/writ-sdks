package writ

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// Every request carries the bearer, the SDK User-Agent, and Accept.
func TestHeadersOnTheWire(t *testing.T) {
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		_, _ = w.Write([]byte(`{"data":[],"count":0}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	if _, err := c.Workflows.List(ctxT(t), nil); err != nil {
		t.Fatal(err)
	}
	if auth := got.Get("Authorization"); auth != "Bearer test-token" {
		t.Errorf("Authorization = %q", auth)
	}
	if ua := got.Get("User-Agent"); ua != "writ-sdk-go/0.1.0" {
		t.Errorf("User-Agent = %q", ua)
	}
	if accept := got.Get("Accept"); accept != "application/json" {
		t.Errorf("Accept = %q", accept)
	}
}

// A trailing slash on the base URL is stripped (no double-slash paths).
func TestTrailingSlashStripped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL+"/"), WithToken("test-token"))
	if _, err := c.Agent.Status(ctxT(t)); err != nil {
		t.Fatal(err)
	}
}

// The three daemon list envelopes all normalize into the same Page shape.
func TestEnvelopeNormalization(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/workflows", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":1,"name":"a"},{"id":2,"name":"b"}],"count":2}`))
	})
	mux.HandleFunc("GET /v1/runs", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"workflow-3","run_type":"workflow","status":"success"}],"count":1,"total":41}`))
	})
	mux.HandleFunc("GET /v1/monitors", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"id":7,"url":"https://a.test","check_type":"content","enabled":1,"requires_playwright":0,"on_change_enabled":0,"on_change_in_session":0,"created_at":"2026-01-01T00:00:00Z"}]`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := testClient(srv.URL)

	// {data, count}
	wf, err := c.Workflows.List(ctxT(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	if wf.Count != 2 || len(wf.Data) != 2 || wf.Total != nil {
		t.Errorf("workflows page = %+v", wf)
	}
	if wf.Data[0].ID != 1 || wf.Data[1].Name != "b" {
		t.Errorf("workflows data = %+v", wf.Data)
	}

	// {data, count, total}
	runs, err := c.Runs.List(ctxT(t), url.Values{"limit": {"1"}})
	if err != nil {
		t.Fatal(err)
	}
	if runs.Count != 1 || runs.Total == nil || *runs.Total != 41 {
		t.Errorf("runs page = %+v", runs)
	}

	// bare array → synthesized count, nil total
	mons, err := c.Monitors.List(ctxT(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	if mons.Count != 1 || mons.Total != nil || mons.Data[0].URL != "https://a.test" {
		t.Errorf("monitors page = %+v", mons)
	}
}

// Query params pass through as given.
func TestQueryParamsPassThrough(t *testing.T) {
	var got url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Query()
		_, _ = w.Write([]byte(`{"data":[],"count":0,"total":0}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	params := url.Values{"entity_id": {"5"}, "run_type": {"workflow"}, "limit": {"10"}}
	if _, err := c.Runs.List(ctxT(t), params); err != nil {
		t.Fatal(err)
	}
	if got.Get("entity_id") != "5" || got.Get("run_type") != "workflow" || got.Get("limit") != "10" {
		t.Errorf("query = %v", got)
	}
}

// A JSON domain error maps {error, code} onto *APIError.
func TestAPIErrorJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found: workflow 999999","code":"not_found"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	_, err := c.Workflows.Get(ctxT(t), 999999)
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("want *APIError, got %T: %v", err, err)
	}
	if apiErr.Status != 404 || apiErr.Code != "not_found" || apiErr.Message != "not found: workflow 999999" {
		t.Errorf("apiErr = %+v", apiErr)
	}
	if !strings.Contains(string(apiErr.Body), "not_found") {
		t.Errorf("Body not preserved: %s", apiErr.Body)
	}
	var we Error
	if !errors.As(err, &we) {
		t.Fatal("*APIError must satisfy writ.Error")
	}
}

// A plain-text axum rejection keeps the raw text as the message and derives
// the code from the status.
func TestAPIErrorPlainText(t *testing.T) {
	const body = "Failed to deserialize the JSON body into the target type: missing field `url`"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	_, err := c.Monitors.Create(ctxT(t), map[string]any{})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("want *APIError, got %T: %v", err, err)
	}
	if apiErr.Status != 400 || apiErr.Code != "bad_request" || apiErr.Message != body {
		t.Errorf("apiErr = %+v", apiErr)
	}
}

// Message resolution order: "error" → "detail" → "message" → status text.
func TestAPIErrorMessageResolution(t *testing.T) {
	cases := []struct {
		body    string
		status  int
		message string
		code    string
	}{
		{`{"detail":"lens requires run_id"}`, 400, "lens requires run_id", "bad_request"},
		{`{"message":"try later"}`, 429, "try later", "rate_limited"},
		{`{}`, 422, "Unprocessable Entity", "unprocessable"},
		{``, 503, "Service Unavailable", "internal"},
		{`{"error":"vault locked","code":"vault_locked"}`, 423, "vault locked", "vault_locked"},
	}
	for _, tc := range cases {
		e := newAPIError(tc.status, []byte(tc.body))
		if e.Message != tc.message || e.Code != tc.code {
			t.Errorf("status %d body %q → %+v (want message %q code %q)", tc.status, tc.body, e, tc.message, tc.code)
		}
	}
}

// A very long plain-text message is truncated to ~500 chars.
func TestAPIErrorPlainTextTruncated(t *testing.T) {
	long := strings.Repeat("x", 2000)
	e := newAPIError(500, []byte(long))
	if len(e.Message) != 500 {
		t.Errorf("message length = %d", len(e.Message))
	}
	if len(e.Body) != 2000 {
		t.Errorf("raw body must be preserved, got %d bytes", len(e.Body))
	}
}

// Connection refused surfaces as *ConnectionError.
func TestConnectionRefused(t *testing.T) {
	port := deadPort(t)
	c := New(WithBaseURL(fmt.Sprintf("http://127.0.0.1:%d", port)), WithToken("test-token"))
	_, err := c.Agent.Status(ctxT(t))
	var connErr *ConnectionError
	if !errors.As(err, &connErr) {
		t.Fatalf("want *ConnectionError, got %T: %v", err, err)
	}
	var we Error
	if !errors.As(err, &we) {
		t.Fatal("*ConnectionError must satisfy writ.Error")
	}
}

// WSTicket posts {route, channel?} and decodes the minted ticket.
func TestWSTicket(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/ws-ticket" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["route"] != "ai-preview" || body["channel"] != "ai-42" {
			t.Errorf("body = %v", body)
		}
		_, _ = w.Write([]byte(`{"ticket":"wtk_abc","expires_in_secs":30}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	ticket, err := c.WSTicket(ctxT(t), "ai-preview", "ai-42")
	if err != nil {
		t.Fatal(err)
	}
	if ticket.Ticket != "wtk_abc" || ticket.ExpiresInSecs != 30 {
		t.Errorf("ticket = %+v", ticket)
	}
}
