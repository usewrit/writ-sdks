package writ

import (
	"encoding/json"
	"testing"
)

// The slot rule is shared with the coordinator, the run form and the replay
// engine, so these cases mirror the ones asserted there.
const uploadWorkflowSteps = `[
  {"id":"s1","type":"upload","config":{"file_slot":"resume","label":"Your CV"}},
  {"id":"s2","type":"upload","config":{"file_id":"file_pinned","file_name":"invoice.pdf"}},
  {"id":"s3","type":"upload","options":{"file_id":"file_rec","filename":"scan.png"}},
  {"id":"s4","type":"click","config":{"selector":".go"}}
]`

func TestFileSlotsCoversEveryUploadStep(t *testing.T) {
	wf := &Workflow{Steps: json.RawMessage(uploadWorkflowSteps)}
	got := FileSlots(wf)
	if len(got) != 3 {
		t.Fatalf("want 3 file inputs, got %d (%+v)", len(got), got)
	}
	want := []string{"resume", "step:s2", "step:s3"}
	for i, w := range want {
		if got[i].Slot != w {
			t.Errorf("slot %d = %q, want %q", i, got[i].Slot, w)
		}
	}

	// A declared slot with no pinned file is the one the caller MUST bind.
	if !got[0].Declared || got[0].DefaultFileID != "" {
		t.Errorf("resume: want declared with no default, got %+v", got[0])
	}
	if got[0].Label != "Your CV" {
		t.Errorf("resume label = %q, want %q", got[0].Label, "Your CV")
	}

	// A pinned step carries its file as the default, so the run works unbound.
	if got[1].Declared || got[1].DefaultFileID != "file_pinned" || got[1].DefaultFilename != "invoice.pdf" {
		t.Errorf("pinned step: %+v", got[1])
	}

	// The recorder writes options.file_id/filename; the editor writes config.*.
	if got[2].DefaultFileID != "file_rec" || got[2].DefaultFilename != "scan.png" {
		t.Errorf("recorded step: %+v", got[2])
	}
}

func TestFileSlotsConfigWinsOverOptions(t *testing.T) {
	wf := &Workflow{Steps: json.RawMessage(
		`[{"id":"s1","type":"upload","config":{"file_id":"edited"},"options":{"file_id":"recorded"}}]`)}
	got := FileSlots(wf)
	if len(got) != 1 || got[0].DefaultFileID != "edited" {
		t.Fatalf("config must win as the explicit later edit, got %+v", got)
	}
}

func TestFileSlotsDedupesOrderPreserving(t *testing.T) {
	wf := &Workflow{Steps: json.RawMessage(
		`[{"id":"a","type":"upload","config":{"file_slot":"cv"}},
		  {"id":"b","type":"upload","config":{"file_slot":"cv"}}]`)}
	if got := FileSlots(wf); len(got) != 1 || got[0].Slot != "cv" {
		t.Fatalf("want one de-duped slot, got %+v", got)
	}
}

func TestFileSlotsIsNilAndNeverPanicsOnJunk(t *testing.T) {
	cases := map[string]*Workflow{
		"nil workflow": nil,
		"no steps":     {},
		"no uploads":   {Steps: json.RawMessage(`[{"id":"x","type":"click"}]`)},
		"unparseable":  {Steps: json.RawMessage(`{"not":"an array"}`)},
		"garbage":      {Steps: json.RawMessage(`nonsense`)},
	}
	for name, wf := range cases {
		if got := FileSlots(wf); got != nil {
			t.Errorf("%s: want nil, got %+v", name, got)
		}
	}
}

func TestOutputFilesReadsEveryEnvelope(t *testing.T) {
	captured := `{"file_id":"file_dl","filename":"report.csv","size":12,"content_type":"text/csv","output_key":"report"}`
	for name, payload := range map[string]string{
		"run document": `{"result_data":{"output_files":[` + captured + `]}}`,
		"bare":         `{"output_files":[` + captured + `]}`,
		"results":      `{"results":{"output_files":[` + captured + `]}}`,
	} {
		got := OutputFiles(json.RawMessage(payload))
		if len(got) != 1 {
			t.Fatalf("%s: want 1 captured file, got %d", name, len(got))
		}
		if got[0].FileID != "file_dl" || got[0].Filename != "report.csv" ||
			got[0].Size != 12 || got[0].ContentType != "text/csv" || got[0].OutputKey != "report" {
			t.Errorf("%s: %+v", name, got[0])
		}
	}
}

func TestOutputFilesIsNilWhenNothingCaptured(t *testing.T) {
	for name, payload := range map[string]string{
		"empty result_data": `{"result_data":{}}`,
		"empty object":      `{}`,
		"empty raw":         ``,
		"garbage":           `nonsense`,
	} {
		if got := OutputFiles(json.RawMessage(payload)); got != nil {
			t.Errorf("%s: want nil, got %+v", name, got)
		}
	}
}
