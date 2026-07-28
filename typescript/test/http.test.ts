/**
 * Wire-behavior tests (DESIGN.md §9.2–§9.4, §9.6–§9.7): auth/User-Agent
 * headers, envelope normalization, error mapping, CSV/bytes lanes, multipart
 * upload, cancel-409-as-result.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runRowId,
  USER_AGENT,
  WritAgent,
  WritApiError,
  WritConnectionError,
  WritError,
} from "../src/index.js";
import { MockAgentServer, refusedPort, startMockAgent } from "./mock.js";

let server: MockAgentServer;
let client: WritAgent;

beforeEach(async () => {
  server = await startMockAgent();
  client = new WritAgent({ baseUrl: server.url, token: "wlt_test_token", env: {} });
});

afterEach(async () => {
  await server.close();
});

describe("auth + headers", () => {
  it("sends the bearer token and the SDK User-Agent on every request", async () => {
    server.json("GET", "/v1/agent", { status: "ok" });
    await client.agent.status();

    const req = server.requests[0]!;
    expect(req.headers.authorization).toBe("Bearer wlt_test_token");
    expect(req.headers["user-agent"]).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^writ-sdk-typescript\/0\.1\.0$/);
  });

  it("strips a trailing slash from an explicit baseUrl", async () => {
    const slashClient = new WritAgent({ baseUrl: `${server.url}/`, token: "wlt_x", env: {} });
    server.json("GET", "/v1/agent", { status: "ok" });
    await slashClient.agent.status();
    expect(server.requests[0]!.path).toBe("/v1/agent");
  });
});

describe("envelope normalization (Page)", () => {
  it("normalizes {data,count} (workflows)", async () => {
    server.json("GET", "/v1/workflows", {
      data: [{ id: 1, name: "wf" }, { id: 2, name: "wf2" }],
      count: 2,
    });
    const page = await client.workflows.list({ active_only: false, limit: 10 });
    expect(page.data).toHaveLength(2);
    expect(page.count).toBe(2);
    expect(page.total).toBeNull();

    // Query params pass through as given.
    const url = server.requests[0]!.url;
    expect(url.searchParams.get("active_only")).toBe("false");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("normalizes {data,count,total} (runs)", async () => {
    server.json("GET", "/v1/runs", {
      data: [{ id: "workflow-7", run_type: "workflow", status: "success" }],
      count: 1,
      total: 42,
    });
    const page = await client.runs.list({ limit: 1 });
    expect(page.count).toBe(1);
    expect(page.total).toBe(42);
    expect(runRowId(page.data[0]!)).toBe(7);
  });

  it("normalizes a bare array (monitors) with count=len, total=null", async () => {
    server.json("GET", "/v1/monitors", [{ id: 1, url: "https://a.test" }]);
    const page = await client.monitors.list();
    expect(page.data).toHaveLength(1);
    expect(page.count).toBe(1);
    expect(page.total).toBeNull();
  });
});

describe("error mapping", () => {
  it("maps a JSON {error,code} domain error", async () => {
    server.json(
      "GET",
      "/v1/workflows/999999",
      { error: "not found: workflow 999999", code: "not_found" },
      404,
    );
    const err = await client.workflows.get(999999).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WritApiError);
    const api = err as WritApiError;
    expect(api.status).toBe(404);
    expect(api.code).toBe("not_found");
    expect(api.message).toBe("not found: workflow 999999");
    expect(api.body).toEqual({ error: "not found: workflow 999999", code: "not_found" });
    expect(api).toBeInstanceOf(WritError);
  });

  it("maps a plain-text 4xx (axum body-deserialize rejection)", async () => {
    server.route("POST", "/v1/workflows", (_req, res) => {
      res.writeHead(422, { "content-type": "text/plain" });
      res.end("Failed to deserialize the JSON body into the target type: missing field `url`");
    });
    const err = await client.workflows.create({ name: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WritApiError);
    const api = err as WritApiError;
    expect(api.status).toBe(422);
    expect(api.code).toBe("unprocessable"); // derived from status
    expect(api.message).toContain("missing field `url`");
    expect(typeof api.body).toBe("string");
  });

  it("resolves message via detail when error is absent", async () => {
    server.json("GET", "/v1/agent", { detail: "record x not found" }, 404);
    const err = await client.agent.status().catch((e: unknown) => e);
    expect((err as WritApiError).message).toBe("record x not found");
  });

  it("truncates a huge plain-text message to ~500 chars", async () => {
    server.route("GET", "/v1/agent", (_req, res) => {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("x".repeat(2000));
    });
    const err = (await client.agent.status().catch((e: unknown) => e)) as WritApiError;
    expect(err.code).toBe("bad_request");
    expect(err.message.length).toBeLessThanOrEqual(501);
    expect(err.body).toHaveLength(2000); // raw body preserved
  });

  it("wraps connection-refused in WritConnectionError", async () => {
    const deadPort = await refusedPort();
    const dead = new WritAgent({ baseUrl: `http://127.0.0.1:${deadPort}`, token: "wlt_x", env: {} });
    const err = await dead.agent.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WritConnectionError);
  });
});

describe("run + cancel results", () => {
  it("workflows.run returns the 202 {run_id, status:running} shape", async () => {
    server.json("POST", "/v1/workflows/3/run", { run_id: 17, status: "running" }, 202);
    const started = await client.workflows.run(3, { inputs: { city: "Paris" }, personaId: 9 });
    expect(started).toEqual({ run_id: 17, status: "running" });

    const body = JSON.parse(server.requests[0]!.body.toString("utf8")) as Record<string, unknown>;
    expect(body).toEqual({ inputs: { city: "Paris" }, persona_id: 9 });
  });

  it("runs.cancel returns the 409 not_running answer as a result, not an exception", async () => {
    server.json(
      "POST",
      "/v1/runs/17/cancel",
      { run_id: 17, status: "not_running", run_status: "success" },
      409,
    );
    const result = await client.runs.cancel(17);
    expect(result.status).toBe("not_running");
    expect(result.run_status).toBe("success");
  });

  it("runs.cancel returns the 202 cancel_requested answer", async () => {
    server.json("POST", "/v1/runs/17/cancel", { run_id: 17, status: "cancel_requested" }, 202);
    const result = await client.runs.cancel(17);
    expect(result).toEqual({ run_id: 17, status: "cancel_requested" });
  });

  it("workflows.cancel also treats 409 as a result", async () => {
    server.json("POST", "/v1/workflows/3/cancel", { id: 3, status: "not_running" }, 409);
    const result = await client.workflows.cancel(3);
    expect(result.status).toBe("not_running");
    expect(result.id).toBe(3);
  });
});

describe("raw lanes", () => {
  it("runs.dataCsv returns the raw CSV text", async () => {
    const csv = "run_id,title\n17,A\n17,B\n";
    server.route("GET", "/v1/runs/17/data", (req, res) => {
      expect(req.url.searchParams.get("format")).toBe("csv");
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
      res.end(csv);
    });
    await expect(client.runs.dataCsv(17)).resolves.toBe(csv);
  });

  it("data.export returns raw text", async () => {
    server.route("GET", "/v1/workflows/3/data/export", (_req, res) => {
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
      res.end("a,b\n1,2\n");
    });
    await expect(client.data.export(3)).resolves.toBe("a,b\n1,2\n");
  });

  it("files.content returns the exact bytes", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x42]);
    server.route("GET", "/v1/files/file_abc/content", (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(bytes);
    });
    const got = await client.files.content("file_abc");
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(got).equals(bytes)).toBe(true);
  });
});

describe("multipart upload", () => {
  it("sends a well-formed multipart body with the file part and source field", async () => {
    server.json("POST", "/v1/files", {
      id: "file_123",
      object: "file",
      filename: "report.csv",
      content_type: "text/csv",
      bytes: 10,
      created_at: 1752000000,
      status: "ready",
      source: "api",
      purpose: "user_data",
    });

    const meta = await client.files.upload("a,b\n1,2\n", {
      filename: "report.csv",
      contentType: "text/csv",
      source: "api",
    });
    expect(meta.id).toBe("file_123");

    const req = server.requests[0]!;
    const contentType = req.headers["content-type"] ?? "";
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const boundary = contentType.split("boundary=")[1]!;
    const raw = req.body.toString("utf8");
    // The file part: correct field name, filename, content type, and payload.
    expect(raw).toContain(`--${boundary}`);
    expect(raw).toMatch(/name="file"/);
    expect(raw).toMatch(/filename="report\.csv"/);
    expect(raw).toContain("Content-Type: text/csv");
    expect(raw).toContain("a,b\n1,2\n");
    // The optional source text part.
    expect(raw).toMatch(/name="source"/);
    expect(raw).toContain("api");
    // Well-formed closing boundary.
    expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });
});

describe("misc surface", () => {
  it("wsTicket posts route + channel and returns the ticket", async () => {
    server.json("POST", "/v1/ws-ticket", { ticket: "wtk_abc", expires_in_secs: 30 });
    const ticket = await client.wsTicket("ai-preview", "ai-7");
    expect(ticket.ticket).toBe("wtk_abc");
    const body = JSON.parse(server.requests[0]!.body.toString("utf8")) as Record<string, unknown>;
    expect(body).toEqual({ route: "ai-preview", channel: "ai-7" });
  });

  it("secrets.get hits the key-addressed path and returns metadata", async () => {
    server.json("GET", "/v1/secrets/gh_login", {
      id: 1,
      key: "gh_login",
      name: "gh_login",
      description: null,
      category: "credentials",
      is_credential: true,
      is_card: false,
      username: "octocat",
      card_last4: null,
      created_at: "2026-07-13T00:00:00Z",
      updated_at: null,
      last_used_at: null,
      use_count: 0,
    });
    const meta = await client.secrets.get("gh_login");
    expect(meta.is_credential).toBe(true);
    expect(meta.username).toBe("octocat");
  });

  it("runRowId parses composite feed ids", () => {
    expect(runRowId("workflow-3")).toBe(3);
    expect(runRowId("check-121")).toBe(121);
    expect(() => runRowId("garbage")).toThrow(WritError);
  });
});
