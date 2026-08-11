/**
 * Crawl-resource tests (the "Dragnet" whole-site crawl): the non-Page
 * `{crawls:[…]}` list envelope, the start body + brand/data_workflow_id view,
 * get-by-id, the `cancel_requested_now` cancel result, and 404 → WritApiError.
 *
 * Plus SAVED crawls — the callable crawl API and its `maxAge` freshness contract.
 * A crawl row is one RUN whose id dies with it; a saved crawl owns the settings
 * under a stable slug, which is what makes "re-run these exact settings" and
 * "give me the data unless it is older than N" expressible at all.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WritAgent, WritApiError, WritRunTimeoutError } from "../src/index.js";
import { MockAgentServer, startMockAgent } from "./mock.js";

let server: MockAgentServer;
let client: WritAgent;

/** A representative crawl view (`to_view()` shape). */
function crawlView(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5,
    name: "Dragnet: example.com",
    seed_url: "https://example.com",
    include_paths: ["^/docs"],
    exclude_paths: [],
    max_depth: 3,
    same_domain: 1,
    allow_subdomains: 1,
    extract_mode: "markdown",
    extract_schema: null,
    persona_id: null,
    respect_robots: 1,
    delay_ms: 250,
    max_concurrent: 4,
    page_budget: 500,
    workflow_id: 42,
    data_workflow_id: 42,
    concierge_session_id: null,
    status: "queued",
    pages_discovered: 0,
    pages_done: 0,
    pages_failed: 0,
    pages_skipped: 0,
    workers_active: 0,
    current_depth: 0,
    error: null,
    cancel_requested: 0,
    brand: "Dragnet",
    is_terminal: false,
    created_at: "2026-07-13T00:00:00Z",
    updated_at: null,
    started_at: null,
    completed_at: null,
    ...over,
  };
}

beforeEach(async () => {
  server = await startMockAgent();
  client = new WritAgent({ baseUrl: server.url, token: "wlt_test_token", env: {} });
});

afterEach(async () => {
  await server.close();
});

describe("crawl", () => {
  it("list unwraps the non-Page {crawls:[…]} envelope and passes limit through", async () => {
    server.json("GET", "/v1/crawl", { crawls: [crawlView(), crawlView({ id: 6 })] });
    const res = await client.crawl.list({ limit: 10 });
    expect(res.crawls).toHaveLength(2);
    expect(res.crawls[0]!.brand).toBe("Dragnet");
    expect(server.requests[0]!.url.searchParams.get("limit")).toBe("10");
  });

  it("start POSTs the body and returns the queued view", async () => {
    server.json("POST", "/v1/crawl", crawlView());
    const job = await client.crawl.start({
      url: "https://example.com",
      include_paths: ["^/docs"],
      max_depth: 3,
    });
    expect(job.brand).toBe("Dragnet");
    expect(job.data_workflow_id).toBe(42);
    expect(job.same_domain).toBe(1); // 0/1 int-bool, not coerced

    const body = JSON.parse(server.requests[0]!.body.toString("utf8")) as Record<string, unknown>;
    expect(body).toEqual({
      url: "https://example.com",
      include_paths: ["^/docs"],
      max_depth: 3,
    });
  });

  it("get fetches one crawl by id", async () => {
    server.json("GET", "/v1/crawl/5", crawlView({ status: "crawling", pages_done: 4 }));
    const job = await client.crawl.get(5);
    expect(job.id).toBe(5);
    expect(job.status).toBe("crawling");
    expect(job.pages_done).toBe(4);
  });

  it("cancel returns the refreshed view plus cancel_requested_now", async () => {
    server.json(
      "POST",
      "/v1/crawl/5/cancel",
      crawlView({ status: "stopping", cancel_requested: 1, cancel_requested_now: true }),
    );
    const res = await client.crawl.cancel(5);
    expect(res.status).toBe("stopping");
    expect(res.cancel_requested_now).toBe(true);
  });

  it("maps a 404 on a missing crawl to WritApiError", async () => {
    server.json("GET", "/v1/crawl/999999", { error: "not found: crawl 999999", code: "not_found" }, 404);
    const err = await client.crawl.get(999999).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WritApiError);
    expect((err as WritApiError).status).toBe(404);
    expect((err as WritApiError).code).toBe("not_found");
  });
});

/** A representative saved-crawl view. */
function definitionView(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4,
    slug: "docs",
    name: "Docs — example.com",
    description: null,
    seed_url: "https://example.com/docs",
    config: { url: "https://example.com/docs", page_budget: 200 },
    default_max_age_seconds: 86400,
    created_at: "2026-07-29T00:00:00Z",
    updated_at: null,
    last_run_at: null,
    run_url: "/api/crawl/definitions/docs/run",
    data_url: "/api/crawl/definitions/docs/data",
    ...over,
  };
}

describe("saved crawls", () => {
  it("saved() unwraps the {definitions:[…]} envelope and passes limit through", async () => {
    server.json("GET", "/v1/crawl/definitions", { definitions: [definitionView()] });
    const res = await client.crawl.saved({ limit: 10 });
    expect(res.definitions.map((d) => d.slug)).toEqual(["docs"]);
    expect(server.requests[0]!.url.searchParams.get("limit")).toBe("10");
  });

  it("save() sends from_crawl_id and does NOT invent a config", async () => {
    // A client-rebuilt config would silently lose the knobs a crawl's status view
    // never echoes (politeness, shard sizing, path filters), saving a crawl that
    // behaves differently from the one the user pointed at.
    server.json("POST", "/v1/crawl/definitions", definitionView(), 201);
    await client.crawl.save({ name: "Docs", fromCrawlId: 9, defaultMaxAgeSeconds: 86400 });
    const body = JSON.parse(server.requests[0]!.body!);
    expect(body.from_crawl_id).toBe(9);
    expect(body.default_max_age_seconds).toBe(86400);
    expect(body.config).toBeUndefined();
  });

  it("save() refuses a call with neither config nor fromCrawlId, before any HTTP", async () => {
    await expect(client.crawl.save({ name: "nothing" })).rejects.toThrow(TypeError);
    expect(server.requests).toHaveLength(0);
  });

  it("a freshness hit is distinguishable and carries the collected rows inline", async () => {
    server.json("POST", "/v1/crawl/definitions/docs/run", {
      cached: true,
      _cache: { hit: true, age_seconds: 1200, source_crawl_id: 9 },
      definition: definitionView(),
      crawl: crawlView({ id: 9, status: "completed", pages_done: 42 }),
      data: { columns: ["url"], rows: [{ url: "https://example.com/docs" }] },
    });
    const res = await client.crawl.runSaved("docs", { maxAge: 86400 });
    expect(res.cached).toBe(true);
    expect(res._cache?.hit).toBe(true);
    // The AGE is the point: staleness is unknowable without it.
    expect(res._cache?.age_seconds).toBe(1200);
    expect(res.data?.rows).toHaveLength(1);
    // max_age is a DELIVERY control — it must not restate the crawl config.
    const body = JSON.parse(server.requests[0]!.body!);
    expect(body).toEqual({ max_age: 86400 });
  });

  it("a cold 202 resolves with the crawl handle rather than rejecting", async () => {
    // A crawl outlives the request, so the id IS the answer. Rejecting would force
    // every caller into a catch block just to learn what was started.
    server.json(
      "POST",
      "/v1/crawl/definitions/docs/run",
      {
        cached: false,
        _cache: { hit: false },
        definition: definitionView(),
        crawl: crawlView({ id: 10, status: "queued" }),
        status_url: "/api/crawl/10",
      },
      202,
    );
    const res = await client.crawl.runSaved("docs", { maxAge: 0 });
    expect(res.cached).toBe(false);
    expect(res.crawl.id).toBe(10);
    expect(res.data ?? null).toBeNull();
  });

  it("wait:true overrun rejects with WritRunTimeoutError carrying the crawl id", async () => {
    server.json(
      "POST",
      "/v1/crawl/definitions/docs/run",
      { crawl_id: 11, status_url: "/api/crawl/11", retryable: true },
      504,
    );
    await expect(
      client.crawl.runSaved("docs", { wait: true, timeout: 30 }),
    ).rejects.toMatchObject({ runId: 11 });
    await expect(
      client.crawl.runSaved("docs", { wait: true, timeout: 30 }),
    ).rejects.toBeInstanceOf(WritRunTimeoutError);
  });

  it("savedData() is a GET — reading collected data never dispatches a crawl", async () => {
    server.json("GET", "/v1/crawl/definitions/docs/data", {
      definition: definitionView(),
      crawl: crawlView({ id: 9, status: "completed" }),
      age_seconds: 4000,
      data: { columns: ["url"], rows: [] },
    });
    const res = await client.crawl.savedData("docs", { limit: 25 });
    expect(server.requests[0]!.method).toBe("GET");
    expect(server.requests[0]!.url.searchParams.get("limit")).toBe("25");
    expect(res.age_seconds).toBe(4000);
  });

  it("workflows.run maxAge is a query control, never a run input", async () => {
    server.json("POST", "/v1/workflows/3/run", { run_id: 5, status: "running" });
    await client.workflows.run(3, { inputs: { city: "paris" }, maxAge: 600 });
    const req = server.requests[0]!;
    expect(req.url.searchParams.get("max_age")).toBe("600");
    const body = JSON.parse(req.body!);
    expect(body.inputs).toEqual({ city: "paris" });
    expect(body.max_age).toBeUndefined();
  });
});
