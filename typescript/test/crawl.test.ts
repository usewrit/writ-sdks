/**
 * Crawl-resource tests (the "Dragnet" whole-site crawl): the non-Page
 * `{crawls:[…]}` list envelope, the start body + brand/data_workflow_id view,
 * get-by-id, the `cancel_requested_now` cancel result, and 404 → WritApiError.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WritAgent, WritApiError } from "../src/index.js";
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
