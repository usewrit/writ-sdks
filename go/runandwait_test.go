package writ

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// Happy path: run 202 → SSE started/step/finished (with keep-alives) → one
// final Runs.Get fetch.
func TestRunAndWaitOverSSE(t *testing.T) {
	var getCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/workflows/9/run", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"run_id":5,"status":"running"}`))
	})
	mux.HandleFunc("GET /v1/runs/5/events", sseHandler(t, []string{
		": keep-alive\n\n",
		"event: started\ndata: {\"event\":\"started\",\"run_id\":5,\"total_steps\":1}\n\n",
		"event: step\ndata: {\"event\":\"step\",\"run_id\":5,\"index\":0,\"step_type\":\"navigate\",\"status\":\"succeeded\"}\n\n",
		"event: finished\ndata: {\"event\":\"finished\",\"run_id\":5,\"status\":\"success\"}\n\n",
	}))
	mux.HandleFunc("GET /v1/runs/5", func(w http.ResponseWriter, r *http.Request) {
		getCalls.Add(1)
		_, _ = w.Write([]byte(`{"id":"workflow-5","run_type":"workflow","status":"success"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := testClient(srv.URL)
	item, err := c.Workflows.RunAndWait(ctxT(t), 9, nil)
	if err != nil {
		t.Fatal(err)
	}
	if item.Status != "success" || item.ID != "workflow-5" {
		t.Errorf("item = %+v", item)
	}
	if got := getCalls.Load(); got != 1 {
		t.Errorf("Runs.Get called %d times, want exactly 1 (single post-terminal fetch)", got)
	}
}

// SSE stream killed mid-flight (pre-terminal) → the helper falls back to
// polling Runs.Get until the run leaves "running".
func TestRunAndWaitPollingFallback(t *testing.T) {
	var polls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/workflows/9/run", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"run_id":6,"status":"running"}`))
	})
	// The stream dies after one non-terminal frame.
	mux.HandleFunc("GET /v1/runs/6/events", sseHandler(t, []string{
		"event: started\ndata: {\"event\":\"started\",\"run_id\":6,\"total_steps\":3}\n\n",
	}))
	mux.HandleFunc("GET /v1/runs/6", func(w http.ResponseWriter, r *http.Request) {
		n := polls.Add(1)
		if n < 3 {
			_, _ = w.Write([]byte(`{"id":"workflow-6","run_type":"workflow","status":"running"}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"workflow-6","run_type":"workflow","status":"success"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := testClient(srv.URL)
	c.pollInterval = 10 * time.Millisecond // keep the test fast
	item, err := c.Workflows.RunAndWait(ctxT(t), 9, nil)
	if err != nil {
		t.Fatal(err)
	}
	if item.Status != "success" {
		t.Errorf("item = %+v", item)
	}
	if polls.Load() < 3 {
		t.Errorf("expected at least 3 polls, got %d", polls.Load())
	}
}

// The overall deadline (WaitTimeout) bounds the wait; the error says the run
// was not cancelled, and the run keeps its "running" status server-side.
func TestRunAndWaitTimeout(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/workflows/9/run", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"run_id":7,"status":"running"}`))
	})
	mux.HandleFunc("GET /v1/runs/7/events", sseHandler(t, []string{
		"event: started\ndata: {\"event\":\"started\",\"run_id\":7,\"total_steps\":1}\n\n",
	}))
	mux.HandleFunc("GET /v1/runs/7", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"workflow-7","run_type":"workflow","status":"running"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := testClient(srv.URL)
	c.pollInterval = 5 * time.Millisecond
	_, err := c.Workflows.RunAndWait(ctxT(t), 9, &RunOptions{WaitTimeout: 60 * time.Millisecond})
	if err == nil {
		t.Fatal("expected a timeout error")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("want context.DeadlineExceeded in chain, got %v", err)
	}
}

// An API error during the polling fallback surfaces immediately.
func TestRunAndWaitPollingSurfacesAPIError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/workflows/9/run", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"run_id":8,"status":"running"}`))
	})
	mux.HandleFunc("GET /v1/runs/8/events", sseHandler(t, nil)) // instant drop
	mux.HandleFunc("GET /v1/runs/8", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized","code":"unauthorized"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := testClient(srv.URL)
	c.pollInterval = 5 * time.Millisecond
	_, err := c.Workflows.RunAndWait(ctxT(t), 9, nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 401 {
		t.Fatalf("want 401 *APIError, got %v", err)
	}
}
