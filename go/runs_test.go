package writ

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// POST /v1/workflows/:id/run answers 202 {run_id, status:"running"}.
func TestRunAccepted202(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/workflows/9/run" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		inputs, _ := body["inputs"].(map[string]any)
		if inputs["city"] != "Paris" {
			t.Errorf("inputs = %v", body["inputs"])
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"run_id":42,"status":"running"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	started, err := c.Workflows.Run(ctxT(t), 9, &RunOptions{Inputs: map[string]any{"city": "Paris"}})
	if err != nil {
		t.Fatal(err)
	}
	if started.RunID != 42 || started.Status != "running" {
		t.Errorf("started = %+v", started)
	}
}

// Runs.Cancel treats the 409 not_running answer as a result, not an error.
func TestRunsCancelConflictIsResult(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"run_id":3,"status":"not_running","run_status":"success"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	res, err := c.Runs.Cancel(ctxT(t), 3)
	if err != nil {
		t.Fatalf("409 must not be an error: %v", err)
	}
	if res.RunID != 3 || res.Status != "not_running" || res.RunStatus != "success" {
		t.Errorf("res = %+v", res)
	}
}

// The 202 cancel_requested answer decodes into the same result type.
func TestRunsCancelAccepted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"run_id":3,"status":"cancel_requested"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	res, err := c.Runs.Cancel(ctxT(t), 3)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "cancel_requested" {
		t.Errorf("res = %+v", res)
	}
}

// An unknown run id on cancel is still a 404 *APIError.
func TestRunsCancelNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found: run 999","code":"not_found"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	_, err := c.Runs.Cancel(ctxT(t), 999)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 404 {
		t.Fatalf("want 404 *APIError, got %v", err)
	}
}

// Workflows.Cancel mirrors the same 409-is-a-result contract.
func TestWorkflowsCancelConflictIsResult(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"id":5,"status":"not_running"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	res, err := c.Workflows.Cancel(ctxT(t), 5)
	if err != nil {
		t.Fatal(err)
	}
	if res.ID != 5 || res.Status != "not_running" {
		t.Errorf("res = %+v", res)
	}
}

// The CSV lane returns the raw document verbatim.
func TestRunsDataCSV(t *testing.T) {
	const csv = "run_id,run_at,title\n7,2026-07-13T00:00:00Z,A\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/runs/7/data" || r.URL.Query().Get("format") != "csv" {
			t.Errorf("%s?%s", r.URL.Path, r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		_, _ = w.Write([]byte(csv))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	got, err := c.Runs.DataCSV(ctxT(t), 7)
	if err != nil {
		t.Fatal(err)
	}
	if got != csv {
		t.Errorf("csv = %q", got)
	}
}

// Runs.Results carries the raw result payload.
func TestRunsResults(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"run_id":7,"status":"success","result":{"success":true,"extracted_data":{"k":"v"}}}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	res, err := c.Runs.Results(ctxT(t), 7)
	if err != nil {
		t.Fatal(err)
	}
	if res.RunID != 7 || res.Status != "success" {
		t.Errorf("res = %+v", res)
	}
	var payload struct {
		ExtractedData map[string]string `json:"extracted_data"`
	}
	if err := json.Unmarshal(res.Result, &payload); err != nil || payload.ExtractedData["k"] != "v" {
		t.Errorf("result payload = %s (%v)", res.Result, err)
	}
}

// RowID extracts the numeric row id from the composite feed id.
func TestRunFeedItemRowID(t *testing.T) {
	cases := []struct {
		id   string
		want int64
		ok   bool
	}{
		{"workflow-3", 3, true},
		{"check-41", 41, true},
		{"automation-7", 7, true},
		{"twofa_required-run-12", 12, true}, // last dash wins
		{"workflow-", 0, false},
		{"noid", 0, false},
		{"workflow-x", 0, false},
	}
	for _, tc := range cases {
		item := RunFeedItem{ID: tc.id}
		got, ok := item.RowID()
		if got != tc.want || ok != tc.ok {
			t.Errorf("RowID(%q) = (%d, %v), want (%d, %v)", tc.id, got, ok, tc.want, tc.ok)
		}
	}
}

// The enriched feed projection decodes with its typed fields.
func TestRunsGetFeedItem(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/runs/3" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"id":"workflow-3","run_type":"workflow","entity_id":9,"entity_name":"Daily scrape","status":"success","started_at":"2026-07-13T00:00:00Z","finished_at":"2026-07-13T00:00:05Z","duration_ms":5000,"trigger_source":"manual","error":null,"detail_url_hint":"/workflows/9","data_url_hint":"/workflows/9?tab=data","rows_extracted":12,"change_detected":null,"engine":"http"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	item, err := c.Runs.Get(ctxT(t), 3)
	if err != nil {
		t.Fatal(err)
	}
	rowID, ok := item.RowID()
	if !ok || rowID != 3 {
		t.Errorf("RowID = %d, %v", rowID, ok)
	}
	if item.RunType != "workflow" || *item.EntityID != 9 || *item.EntityName != "Daily scrape" {
		t.Errorf("item = %+v", item)
	}
	if *item.RowsExtracted != 12 || item.ChangeDetected != nil || *item.Engine != "http" {
		t.Errorf("annotations = %+v", item)
	}
	if fmt.Sprintf("%d", *item.DurationMS) != "5000" {
		t.Errorf("duration = %v", item.DurationMS)
	}
}
