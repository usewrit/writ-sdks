/**
 * File assets: the run's bindable INPUTS (`fileSlots`) and its captured
 * OUTPUTS (`outputFiles`). Both are pure derivations — no daemon needed.
 *
 * The slot rule is shared with the coordinator, the run form and the replay
 * engine, so these cases mirror the ones asserted there.
 */

import { describe, expect, it } from "vitest";
import { fileSlots, outputFiles } from "../src/index.js";

const WORKFLOW = {
  steps: [
    { id: "s1", type: "upload", config: { file_slot: "resume", label: "Your CV" } },
    { id: "s2", type: "upload", config: { file_id: "file_pinned", file_name: "invoice.pdf" } },
    { id: "s3", type: "upload", options: { file_id: "file_rec", filename: "scan.png" } },
    { id: "s4", type: "click", config: { selector: ".go" } },
  ],
};

describe("fileSlots", () => {
  it("returns every upload step: declared slots by name, pinned ones by step id", () => {
    expect(fileSlots(WORKFLOW).map((s) => s.slot)).toEqual([
      "resume",
      "step:s2",
      "step:s3",
    ]);
  });

  it("marks a declared slot with no pinned file as the one that MUST be bound", () => {
    const [resume] = fileSlots(WORKFLOW);
    expect(resume.declared).toBe(true);
    expect(resume.default_file_id).toBeUndefined();
    expect(resume.label).toBe("Your CV");
  });

  it("carries the pinned file as the default, so the run works unbound", () => {
    const pinned = fileSlots(WORKFLOW)[1];
    expect(pinned.declared).toBe(false);
    expect(pinned.default_file_id).toBe("file_pinned");
    expect(pinned.default_filename).toBe("invoice.pdf");
  });

  it("reads the recorder's `options` shape as well as the editor's `config`", () => {
    // The recorder writes options.file_id/filename; the editor writes config.*.
    const recorded = fileSlots(WORKFLOW)[2];
    expect(recorded.default_file_id).toBe("file_rec");
    expect(recorded.default_filename).toBe("scan.png");
  });

  it("prefers config over options when a step carries both", () => {
    const slots = fileSlots({
      steps: [{ id: "s1", type: "upload", config: { file_id: "edited" }, options: { file_id: "recorded" } }],
    });
    expect(slots[0].default_file_id).toBe("edited");
  });

  it("de-dupes by slot, order-preserving", () => {
    const slots = fileSlots({
      steps: [
        { id: "a", type: "upload", config: { file_slot: "cv" } },
        { id: "b", type: "upload", config: { file_slot: "cv" } },
      ],
    });
    expect(slots.map((s) => s.slot)).toEqual(["cv"]);
  });

  it("is empty for a workflow with no upload steps, and tolerates junk", () => {
    expect(fileSlots({ steps: [{ id: "x", type: "click" }] })).toEqual([]);
    expect(fileSlots({})).toEqual([]);
    expect(fileSlots({ steps: "not-an-array" })).toEqual([]);
    expect(fileSlots({ steps: [null, 7, "x"] as unknown[] })).toEqual([]);
  });
});

describe("outputFiles", () => {
  const captured = {
    file_id: "file_dl",
    filename: "report.csv",
    size: 12,
    content_type: "text/csv",
    output_key: "report",
  };

  it("reads a completed run document (result_data.output_files)", () => {
    expect(outputFiles({ result_data: { output_files: [captured] } })).toEqual([captured]);
  });

  it("also accepts the bare result_data or a results payload", () => {
    expect(outputFiles({ output_files: [captured] })).toEqual([captured]);
    expect(outputFiles({ results: { output_files: [captured] } })).toEqual([captured]);
  });

  it("is empty when the run captured nothing, and never throws on junk", () => {
    expect(outputFiles({ result_data: {} })).toEqual([]);
    expect(outputFiles({})).toEqual([]);
    expect(outputFiles(null)).toEqual([]);
    expect(outputFiles("nope")).toEqual([]);
  });
});
