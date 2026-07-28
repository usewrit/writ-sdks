package writ

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The DEFAULT stays async — Run must not start sending ?wait= on its own, or every
// existing caller silently changes behavior.
func TestRunDefaultSendsNoWaitQuery(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("wait"); got != "" {
			t.Errorf("wait query = %q, want empty", got)
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"run_id":42,"status":"running"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	started, err := c.Workflows.Run(ctxT(t), 9, nil)
	if err != nil {
		t.Fatal(err)
	}
	if started.RunID != 42 {
		t.Errorf("started = %+v", started)
	}
}

// RunWait sends the delivery options as QUERY parameters (the body stays the run's
// inputs) and returns the terminal document.
func TestRunWaitSendsQueryAndReturnsTerminalDocument(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("wait"); got != "true" {
			t.Errorf("wait = %q, want true", got)
		}
		if got := r.URL.Query().Get("timeout"); got != "60" {
			t.Errorf("timeout = %q, want 60", got)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if _, ok := body["wait"]; ok {
			t.Error("wait leaked into the request body; it belongs in the query")
		}
		inputs, _ := body["inputs"].(map[string]any)
		if inputs["sku"] != "B0C123" {
			t.Errorf("inputs = %v", body["inputs"])
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"run_id":42,"status":"success","done":true,"data":{"price":"19.99"},"duration_ms":8123}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	done, err := c.Workflows.RunWait(ctxT(t), 9, &RunOptions{
		Inputs:  map[string]any{"sku": "B0C123"},
		Timeout: 60 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if done.Status != "success" || !done.Done {
		t.Errorf("done = %+v", done)
	}
	if string(done.Data) != `{"price":"19.99"}` {
		t.Errorf("data = %s", done.Data)
	}
	if done.DurationMS != 8123 {
		t.Errorf("duration = %d", done.DurationMS)
	}
}

// A FAILED run is a RESULT, not an error — otherwise a caller cannot tell a failed
// workflow from a rejected request.
func TestRunWaitFailedRunIsAResult(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"run_id":43,"status":"failed","done":true,"error":"login step timed out"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	done, err := c.Workflows.RunWait(ctxT(t), 9, nil)
	if err != nil {
		t.Fatalf("a failed run must not be an error: %v", err)
	}
	if done.Status != "failed" || done.Error != "login step timed out" {
		t.Errorf("done = %+v", done)
	}
}

// An expired budget yields *RunTimeoutError carrying the still-valid run id, so the
// caller can collect the run instead of retrying and starting a second one.
func TestRunWaitTimeoutCarriesTheRunID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGatewayTimeout)
		_, _ = w.Write([]byte(`{"run_id":44,"status":"running","done":false,` +
			`"status_url":"/v1/runs/44","events_url":"/v1/runs/44/events"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	_, err := c.Workflows.RunWait(ctxT(t), 9, &RunOptions{Timeout: 5 * time.Second})
	if err == nil {
		t.Fatal("expected a timeout error")
	}

	var timeout *RunTimeoutError
	if !errors.As(err, &timeout) {
		t.Fatalf("err = %T (%v), want *RunTimeoutError", err, err)
	}
	if timeout.RunID != 44 {
		t.Errorf("RunID = %d, want 44", timeout.RunID)
	}
	if timeout.StatusURL != "/v1/runs/44" || timeout.EventsURL != "/v1/runs/44/events" {
		t.Errorf("urls = %q / %q", timeout.StatusURL, timeout.EventsURL)
	}
	// The message must steer toward collecting, not retrying.
	if msg := timeout.Error(); msg == "" ||
		!contains(msg, "STILL RUNNING") || !contains(msg, "do not retry") {
		t.Errorf("message = %q", msg)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
