package writ

import (
	"encoding/json"
	"fmt"
)

// File assets have two sides at run time: the files a run CONSUMES (bound to a
// workflow's upload steps via RunOptions.Files) and the files a run PRODUCES (a
// wait_for_download step's capture). FileSlots answers "what may I bind?" and
// OutputFiles answers "what did it capture?".
//
// Both are pure derivations over data you already hold, so neither costs a round
// trip and both work against any daemon version.

// FileSlot is one bindable file input on a workflow — see FileSlots.
type FileSlot struct {
	// Slot is the key to use in RunOptions.Files.
	Slot       string `json:"slot"`
	Label      string `json:"label"`
	IsMultiple bool   `json:"is_multiple"`
	// DefaultFileID is the file pinned on the step. Non-empty ⇒ the run works
	// with NO binding at all, and binding one overrides it for that run only.
	DefaultFileID   string `json:"default_file_id,omitempty"`
	DefaultFilename string `json:"default_filename,omitempty"`
	// Declared is true when the workflow's author named the slot, false when it
	// is keyed on the step id because the step only pins a file.
	Declared bool `json:"declared"`
}

// uploadStep is the subset of a recorded step the slot rule reads. A step's
// binding lives in "config" when the editor wrote it and in "options" when the
// recorder did, so both are decoded and config wins as the explicit later edit.
type uploadStep struct {
	ID     string `json:"id"`
	Type   string `json:"type"`
	Config struct {
		FileSlot   string `json:"file_slot"`
		FileID     string `json:"file_id"`
		FileName   string `json:"file_name"`
		Label      string `json:"label"`
		IsMultiple bool   `json:"is_multiple"`
	} `json:"config"`
	Options struct {
		FileSlot   string `json:"file_slot"`
		FileID     string `json:"file_id"`
		Filename   string `json:"filename"`
		FileName   string `json:"file_name"`
		Label      string `json:"label"`
		IsMultiple bool   `json:"is_multiple"`
	} `json:"options"`
}

// FileSlots reports a workflow's file inputs — the valid keys for
// RunOptions.Files.
//
// Every upload step is a file input, of one of two kinds:
//
//   - the step names a file_slot: an abstract slot whose file the CALLER
//     supplies. With no DefaultFileID it must be bound or the step fails;
//   - the step pins a concrete file: it is keyed "step:<step id>" and carries
//     that file as DefaultFileID, so the workflow runs untouched. Bind it only
//     to run against a DIFFERENT file.
//
// Slots are de-duped, order-preserving. A workflow with no upload steps (or
// with steps that will not parse) yields nil, never an error: this is a
// best-effort read of a free-form recipe, and a caller that binds nothing still
// gets the pinned files.
//
//	wf, _ := c.Workflows.Get(ctx, 7)
//	for _, s := range writ.FileSlots(wf) {
//	    fmt.Println(s.Slot, s.DefaultFilename)
//	}
//	c.Workflows.Run(ctx, 7, &writ.RunOptions{Files: map[string]string{"resume": "file_abc"}})
func FileSlots(wf *Workflow) []FileSlot {
	if wf == nil || len(wf.Steps) == 0 {
		return nil
	}
	var steps []uploadStep
	if err := json.Unmarshal(wf.Steps, &steps); err != nil {
		return nil
	}
	var out []FileSlot
	seen := map[string]bool{}
	for i, s := range steps {
		if s.Type != "upload" {
			continue
		}
		slot := s.Config.FileSlot
		if slot == "" {
			slot = s.Options.FileSlot
		}
		declared := slot != ""
		if !declared {
			// Keyed on the step's own id, never an ordinal: a binding has to
			// survive the steps being reordered or one being disabled.
			if s.ID != "" {
				slot = "step:" + s.ID
			} else {
				slot = fmt.Sprintf("upload:%d", i+1)
			}
		}
		if seen[slot] {
			continue
		}
		seen[slot] = true

		defaultID := firstNonEmpty(s.Config.FileID, s.Options.FileID)
		defaultName := firstNonEmpty(s.Config.FileName, s.Options.Filename, s.Options.FileName)
		label := firstNonEmpty(s.Config.Label, s.Options.Label, defaultName)
		if label == "" {
			if declared {
				label = slot
			} else {
				label = fmt.Sprintf("File %d", i+1)
			}
		}
		out = append(out, FileSlot{
			Slot:            slot,
			Label:           label,
			IsMultiple:      s.Config.IsMultiple || s.Options.IsMultiple,
			DefaultFileID:   defaultID,
			DefaultFilename: defaultName,
			Declared:        declared,
		})
	}
	return out
}

// (firstNonEmpty lives in cloud.go — same package.)

// OutputFile is a file a run CAPTURED (a wait_for_download step) — see
// OutputFiles.
type OutputFile struct {
	// FileID is the handle in the vault: read the bytes with Files.Content.
	FileID      string `json:"file_id"`
	Filename    string `json:"filename"`
	Size        int64  `json:"size"`
	ContentType string `json:"content_type"`
	// OutputKey is the step's output_key, when it named the capture for later
	// reference. Empty when unnamed.
	OutputKey string `json:"output_key,omitempty"`
}

// OutputFiles reports the files a run's download steps captured.
//
// A wait_for_download step stores what the browser downloaded and reports it as
// result_data.output_files. Pass the terminal run document, its result_data, or
// a results payload — whichever you hold. Returns nil when the run captured
// nothing or the payload cannot be read.
//
//	out, _ := c.Workflows.RunAndWait(ctx, 7, nil)
//	for _, f := range writ.OutputFiles(out.ResultData) {
//	    rc, _ := c.Files.Content(ctx, f.FileID)
//	}
func OutputFiles(payload json.RawMessage) []OutputFile {
	if len(payload) == 0 {
		return nil
	}
	var envelope struct {
		OutputFiles []OutputFile `json:"output_files"`
		ResultData  struct {
			OutputFiles []OutputFile `json:"output_files"`
		} `json:"result_data"`
		Results struct {
			OutputFiles []OutputFile `json:"output_files"`
		} `json:"results"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil
	}
	switch {
	case len(envelope.OutputFiles) > 0:
		return envelope.OutputFiles
	case len(envelope.ResultData.OutputFiles) > 0:
		return envelope.ResultData.OutputFiles
	case len(envelope.Results.OutputFiles) > 0:
		return envelope.Results.OutputFiles
	}
	return nil
}
