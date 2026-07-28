/**
 * `workflows.run(id, {wait})` — the server-side wait contract
 * (`?wait=true` on `POST /v1/workflows/:id/run`).
 *
 * The daemon's run endpoint is async by DEFAULT; `wait` opts into blocking and
 * returns the run's terminal document in the same request. These tests pin the
 * three behaviors a caller has to be able to rely on:
 *   - the default is unchanged (202, no query params sent),
 *   - a failed run RESOLVES (it is a result, not an exception),
 *   - an expired budget REJECTS with the still-valid run id, so a caller can
 *     collect the run instead of blindly retrying and starting a second one.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WritAgent, WritRunTimeoutError } from "../src/index.js";
import { MockAgentServer, startMockAgent } from "./mock.js";

let server: MockAgentServer;
let client: WritAgent;

beforeEach(async () => {
  server = await startMockAgent();
  client = new WritAgent({ baseUrl: server.url, token: "wlt_test_token", env: {} });
});

afterEach(async () => {
  await server.close();
});

describe("workflows.run — delivery mode", () => {
  it("defaults to async and sends no wait query", async () => {
    server.json("POST", "/v1/workflows/7/run", { run_id: 42, status: "running" }, 202);

    const started = await client.workflows.run(7, { inputs: { a: 1 } });

    expect(started.run_id).toBe(42);
    expect(started.status).toBe("running");
    const req = server.requests.at(-1)!;
    expect(req.url.searchParams.get("wait")).toBeNull();
    expect(req.url.searchParams.get("timeout")).toBeNull();
  });

  it("wait:true asks the daemon to block and returns the terminal document", async () => {
    server.json(
      "POST",
      "/v1/workflows/7/run",
      { run_id: 42, status: "success", done: true, data: { price: "19.99" }, duration_ms: 8123 },
      200,
    );

    const done = await client.workflows.run(7, { wait: true, timeout: 60 });

    expect(done.status).toBe("success");
    expect(done.done).toBe(true);
    expect(done.data).toEqual({ price: "19.99" });
    const req = server.requests.at(-1)!;
    expect(req.url.searchParams.get("wait")).toBe("true");
    expect(req.url.searchParams.get("timeout")).toBe("60");
  });

  it("resolves (not throws) when the run itself failed", async () => {
    // The REPORT succeeded; the run did not. Throwing here would leave a caller
    // unable to distinguish a failed workflow from a rejected request.
    server.json(
      "POST",
      "/v1/workflows/7/run",
      { run_id: 43, status: "failed", done: true, error: "login step timed out" },
      200,
    );

    const done = await client.workflows.run(7, { wait: true });

    expect(done.status).toBe("failed");
    expect(done.error).toBe("login step timed out");
  });

  it("throws WritRunTimeoutError carrying the still-running run id on 504", async () => {
    server.json(
      "POST",
      "/v1/workflows/7/run",
      {
        run_id: 44,
        status: "running",
        done: false,
        error: "Run did not finish within 5s and is still in progress",
        status_url: "/v1/runs/44",
        events_url: "/v1/runs/44/events",
      },
      504,
    );

    await expect(client.workflows.run(7, { wait: true, timeout: 5 })).rejects.toThrow(
      WritRunTimeoutError,
    );

    try {
      await client.workflows.run(7, { wait: true, timeout: 5 });
      expect.unreachable("should have thrown");
    } catch (err) {
      const timeout = err as WritRunTimeoutError;
      expect(timeout.runId).toBe(44);
      expect(timeout.status).toBe(504);
      // The message must steer toward collecting, not retrying — a retry starts a
      // SECOND run of a workflow that is already executing.
      expect(timeout.message).toContain("STILL RUNNING");
      expect(timeout.message).toContain("do not retry");
    }
  });

  it("still supports dryRun alongside the new options", async () => {
    server.json(
      "POST",
      "/v1/workflows/7/run",
      { dry_run: true, workflow_id: 7, step_count: 0, steps: [] },
      200,
    );

    const report = await client.workflows.run(7, { dryRun: true });

    expect(report.dry_run).toBe(true);
    expect(server.requests.at(-1)!.url.searchParams.get("wait")).toBeNull();
  });
});
