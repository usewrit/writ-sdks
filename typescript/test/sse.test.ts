/**
 * SSE + runAndWait tests (DESIGN.md §8, §9.5): typed event stream, keep-alive
 * comment tolerance, multi-`data:` accumulation, terminal-close semantics,
 * and the SSE-drop → polling fallback.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../src/index.js";
import { WritAgent } from "../src/index.js";
import { MockAgentServer, startMockAgent } from "./mock.js";

let server: MockAgentServer;
let client: WritAgent;

beforeEach(async () => {
  server = await startMockAgent();
  client = new WritAgent({ baseUrl: server.url, token: "wlt_test", env: {} });
});

afterEach(async () => {
  await server.close();
});

const sseHeaders = { "content-type": "text/event-stream", "cache-control": "no-cache" };

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("runs.events", () => {
  it("yields typed events and completes after the terminal frame", async () => {
    server.route("GET", "/v1/runs/42/events", (_req, res) => {
      res.writeHead(200, sseHeaders);
      res.write(frame("started", { event: "started", run_id: 42, total_steps: 2 }));
      res.write(": keep-alive\n\n"); // comment frame — must be ignored
      res.write("id: 7\nretry: 1000\n\n"); // id/retry-only frame — no dispatch
      res.write(
        frame("step", {
          event: "step",
          run_id: 42,
          index: 0,
          step_type: "navigate",
          status: "succeeded",
        }),
      );
      // Multi-`data:` frame split mid-JSON — lines join with \n.
      res.write('event: progress\ndata: {"event":"progress","run_id":42,\ndata: "completed":1,"total":2}\n\n');
      res.write(frame("finished", { event: "finished", run_id: 42, status: "success" }));
      // Anything after the terminal frame must never be surfaced.
      res.write(frame("step", { event: "step", run_id: 42, index: 9, step_type: "x", status: "running" }));
      res.end();
    });

    const events: RunEvent[] = [];
    for await (const ev of client.runs.events(42)) events.push(ev);

    expect(events.map((e) => e.event)).toEqual(["started", "step", "progress", "finished"]);
    expect(events[0]).toEqual({ event: "started", run_id: 42, total_steps: 2 });
    expect(events[2]).toEqual({ event: "progress", run_id: 42, completed: 1, total: 2 });
    expect(events[3]).toEqual({ event: "finished", run_id: 42, status: "success" });
  });

  it("an already-finished run yields exactly one terminal frame", async () => {
    server.route("GET", "/v1/runs/7/events", (_req, res) => {
      res.writeHead(200, sseHeaders);
      res.write(frame("finished", { event: "finished", run_id: 7, status: "failed" }));
      res.end();
    });
    const events: RunEvent[] = [];
    for await (const ev of client.runs.events(7)) events.push(ev);
    expect(events).toEqual([{ event: "finished", run_id: 7, status: "failed" }]);
  });

  it("the error event is terminal too", async () => {
    server.route("GET", "/v1/runs/8/events", (_req, res) => {
      res.writeHead(200, sseHeaders);
      res.write(frame("error", { event: "error", run_id: 8, message: "run is not live" }));
      res.end();
    });
    const events: RunEvent[] = [];
    for await (const ev of client.runs.events(8)) events.push(ev);
    expect(events).toEqual([{ event: "error", run_id: 8, message: "run is not live" }]);
  });
});

describe("workflows.runAndWait", () => {
  it("resolves over the SSE happy path (started → step → finished)", async () => {
    server.json("POST", "/v1/workflows/3/run", { run_id: 42, status: "running" }, 202);
    server.route("GET", "/v1/runs/42/events", (_req, res) => {
      res.writeHead(200, sseHeaders);
      res.write(frame("started", { event: "started", run_id: 42, total_steps: 1 }));
      res.write(": ping\n\n");
      res.write(
        frame("step", { event: "step", run_id: 42, index: 0, step_type: "extract", status: "succeeded" }),
      );
      res.write(frame("finished", { event: "finished", run_id: 42, status: "success" }));
      res.end();
    });
    server.json("GET", "/v1/runs/42", {
      id: "workflow-42",
      run_type: "workflow",
      status: "success",
      rows_extracted: 3,
    });

    const seen: string[] = [];
    const run = await client.workflows.runAndWait(3, {
      inputs: { q: "x" },
      onEvent: (ev) => seen.push(ev.event),
    });

    expect(run.status).toBe("success");
    expect(run.rows_extracted).toBe(3);
    expect(seen).toEqual(["started", "step", "finished"]);
    // No polling was needed: exactly one final GET /v1/runs/42.
    const gets = server.requests.filter((r) => r.method === "GET" && r.path === "/v1/runs/42");
    expect(gets).toHaveLength(1);
  });

  it("falls back to polling when the SSE stream drops pre-terminal", async () => {
    server.json("POST", "/v1/workflows/3/run", { run_id: 55, status: "running" }, 202);
    server.route("GET", "/v1/runs/55/events", (_req, res) => {
      res.writeHead(200, sseHeaders);
      res.write(frame("started", { event: "started", run_id: 55, total_steps: 3 }));
      // Drop the connection mid-stream, pre-terminal.
      setTimeout(() => res.destroy(), 20);
    });
    let polls = 0;
    server.route("GET", "/v1/runs/55", (_req, res) => {
      polls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "workflow-55",
          run_type: "workflow",
          status: polls < 3 ? "running" : "success",
        }),
      );
    });

    const run = await client.workflows.runAndWait(3, { pollInterval: 25 });
    expect(run.status).toBe("success");
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("falls back to polling when the SSE connection cannot be established", async () => {
    server.json("POST", "/v1/workflows/3/run", { run_id: 56, status: "running" }, 202);
    server.json("GET", "/v1/runs/56/events", { error: "boom", code: "internal" }, 500);
    server.json("GET", "/v1/runs/56", { id: "workflow-56", run_type: "workflow", status: "success" });

    const run = await client.workflows.runAndWait(3, { pollInterval: 10 });
    expect(run.status).toBe("success");
  });

  it("attaches results with includeResults", async () => {
    server.json("POST", "/v1/workflows/3/run", { run_id: 60, status: "running" }, 202);
    server.route("GET", "/v1/runs/60/events", (_req, res) => {
      res.writeHead(200, sseHeaders);
      res.write(frame("finished", { event: "finished", run_id: 60, status: "success" }));
      res.end();
    });
    server.json("GET", "/v1/runs/60", { id: "workflow-60", run_type: "workflow", status: "success" });
    server.json("GET", "/v1/runs/60/results", {
      run_id: 60,
      status: "success",
      result: { extracted_data: { price: "42" } },
    });

    const run = await client.workflows.runAndWait(3, { includeResults: true });
    expect(run.results?.result).toEqual({ extracted_data: { price: "42" } });
  });

  it("times out after waitTimeout without cancelling the run", async () => {
    server.json("POST", "/v1/workflows/3/run", { run_id: 61, status: "running" }, 202);
    server.route("GET", "/v1/runs/61/events", (_req, res) => {
      res.writeHead(200, sseHeaders);
      res.write(frame("started", { event: "started", run_id: 61, total_steps: 1 }));
      // …then silence: only keep-alives, never a terminal frame.
      const ka = setInterval(() => res.write(": keep-alive\n\n"), 30);
      res.on("close", () => clearInterval(ka));
    });

    await expect(
      client.workflows.runAndWait(3, { waitTimeout: 150, pollInterval: 20 }),
    ).rejects.toThrow(/NOT cancelled/);
    // No cancel request was ever issued.
    const cancels = server.requests.filter((r) => r.path.endsWith("/cancel"));
    expect(cancels).toHaveLength(0);
  });

  it("rejects dryRun", async () => {
    await expect(
      client.workflows.runAndWait(3, { dryRun: true } as never),
    ).rejects.toThrow(/dryRun/);
  });
});
