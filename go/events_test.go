package writ

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// sseHandler streams the given pre-formatted SSE text with flushes between
// frames, then returns (closing the stream).
func sseHandler(t *testing.T, frames []string) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("no flusher")
		}
		for _, frame := range frames {
			_, _ = w.Write([]byte(frame))
			flusher.Flush()
		}
	}
}

// A live stream: named frames, keep-alive comments and id: lines ignored,
// multi-data accumulation handled, stop after the terminal frame.
func TestEventsStream(t *testing.T) {
	frames := []string{
		": keep-alive\n\n",
		"event: started\ndata: {\"event\":\"started\",\"run_id\":5,\"total_steps\":2}\n\n",
		"id: 1\nretry: 3000\n: another keep-alive\n\n",
		"event: step\ndata: {\"event\":\"step\",\"run_id\":5,\"index\":0,\"step_type\":\"click\",\"status\":\"succeeded\"}\n\n",
		// Multi-data frame: the JSON is split across two data: lines.
		"event: progress\ndata: {\"event\":\"progress\",\n" + "data: \"run_id\":5,\"completed\":1,\"total\":2}\n\n",
		"event: finished\ndata: {\"event\":\"finished\",\"run_id\":5,\"status\":\"success\"}\n\n",
		// Anything after the terminal frame must never be surfaced.
		"event: step\ndata: {\"event\":\"step\",\"run_id\":5,\"index\":9}\n\n",
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/runs/5/events", sseHandler(t, frames))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := testClient(srv.URL)
	var events []RunEvent
	for ev, err := range c.Runs.Events(ctxT(t), 5) {
		if err != nil {
			t.Fatalf("stream error: %v", err)
		}
		events = append(events, ev)
	}
	if len(events) != 4 {
		t.Fatalf("got %d events: %+v", len(events), events)
	}
	if events[0].Event != "started" || events[0].TotalSteps != 2 {
		t.Errorf("started = %+v", events[0])
	}
	if events[1].Event != "step" || events[1].StepType != "click" || events[1].Status != "succeeded" {
		t.Errorf("step = %+v", events[1])
	}
	if events[2].Event != "progress" || events[2].Completed != 1 || events[2].Total != 2 {
		t.Errorf("progress = %+v", events[2])
	}
	if events[3].Event != "finished" || events[3].Status != "success" || !events[3].Terminal() {
		t.Errorf("finished = %+v", events[3])
	}
}

// A run that already finished yields exactly one terminal frame.
func TestEventsAlreadyFinished(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/runs/8/events", sseHandler(t, []string{
		"event: finished\ndata: {\"event\":\"finished\",\"run_id\":8,\"status\":\"failed\"}\n\n",
	}))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := testClient(srv.URL)
	var events []RunEvent
	for ev, err := range c.Runs.Events(ctxT(t), 8) {
		if err != nil {
			t.Fatal(err)
		}
		events = append(events, ev)
	}
	if len(events) != 1 || events[0].Status != "failed" {
		t.Fatalf("events = %+v", events)
	}
}

// The "event:" field name backfills a payload without the serde tag.
func TestEventsNameFallback(t *testing.T) {
	seq := sseFrames(strings.NewReader("event: error\ndata: {\"run_id\":4,\"message\":\"navigation failed\"}\n\n"), "test")
	var events []RunEvent
	for ev, err := range seq {
		if err != nil {
			t.Fatal(err)
		}
		events = append(events, ev)
	}
	if len(events) != 1 || events[0].Event != "error" || events[0].Message != "navigation failed" {
		t.Fatalf("events = %+v", events)
	}
	if !events[0].Terminal() {
		t.Error("error must be terminal")
	}
}

// A missing run 404s cleanly instead of hanging on an empty stream.
func TestEventsMissingRunIs404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found: run 999999","code":"not_found"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	var streamErr error
	for _, err := range c.Runs.Events(ctxT(t), 999999) {
		streamErr = err
		break
	}
	var apiErr *APIError
	if !errors.As(streamErr, &apiErr) || apiErr.Status != 404 {
		t.Fatalf("want 404 *APIError, got %v", streamErr)
	}
}

// Breaking out of the range early releases the stream without error.
func TestEventsEarlyBreak(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/runs/5/events", sseHandler(t, []string{
		"event: started\ndata: {\"event\":\"started\",\"run_id\":5,\"total_steps\":9}\n\n",
		"event: step\ndata: {\"event\":\"step\",\"run_id\":5,\"index\":0,\"step_type\":\"click\",\"status\":\"running\"}\n\n",
	}))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := testClient(srv.URL)
	count := 0
	for _, err := range c.Runs.Events(ctxT(t), 5) {
		if err != nil {
			t.Fatal(err)
		}
		count++
		break
	}
	if count != 1 {
		t.Fatalf("count = %d", count)
	}
}
