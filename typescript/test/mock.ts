/**
 * Test helpers: a REAL listening node:http server on an ephemeral 127.0.0.1
 * port (validates actual fetch usage), plus a fake `~/.writ` home builder for
 * discovery tests.
 */

import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CapturedRequest {
  method: string;
  path: string;
  url: URL;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type RouteHandler = (
  req: CapturedRequest,
  res: http.ServerResponse,
) => void | Promise<void>;

/** In-process mock daemon over node:http. */
export class MockAgentServer {
  readonly requests: CapturedRequest[] = [];
  url = "";
  port = 0;

  #routes = new Map<string, RouteHandler>();
  #server: http.Server;
  #sockets = new Set<Socket>();

  constructor() {
    this.#server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
        const captured: CapturedRequest = {
          method: req.method ?? "GET",
          path: url.pathname,
          url,
          headers: req.headers,
          body: Buffer.concat(chunks),
        };
        this.requests.push(captured);
        const handler = this.#routes.get(`${captured.method} ${captured.path}`);
        if (!handler) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `not found: ${captured.path}`, code: "not_found" }));
          return;
        }
        Promise.resolve(handler(captured, res)).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
    });
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
  }

  /** Register a handler for `METHOD /path` (query string ignored for matching). */
  route(method: string, routePath: string, handler: RouteHandler): this {
    this.#routes.set(`${method} ${routePath}`, handler);
    return this;
  }

  /** Register a fixed JSON response. */
  json(method: string, routePath: string, payload: unknown, status = 200): this {
    return this.route(method, routePath, (_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  }

  /** A standard live `/v1/agent` route (for discovery probes). */
  withAgentStatus(): this {
    return this.json("GET", "/v1/agent", {
      status: "ok",
      version: "0.0.0-test",
      active_runs: 0,
      encrypted: true,
      due_monitors: 0,
      last_tick_at: null,
      warm_browser: false,
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    const addr = this.#server.address() as AddressInfo;
    this.port = addr.port;
    this.url = `http://127.0.0.1:${this.port}`;
    return this;
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

export async function startMockAgent(): Promise<MockAgentServer> {
  return new MockAgentServer().start();
}

/** The daemon's `runtime.json` descriptor shape. */
export function runtimeDescriptor(port: number, token: string): string {
  return JSON.stringify(
    {
      pid: 4242,
      port,
      token,
      version: "0.0.0-test",
      started_at: "2026-07-13T00:00:00Z",
    },
    null,
    2,
  );
}

/**
 * Build a fake `~/.writ` directory in a temp dir.
 * `spec.activeProfile` writes `active_profile`; `spec.profiles` maps profile
 * id → runtime.json contents; `spec.root` is the root `runtime.json`.
 */
export function makeWritDir(spec: {
  activeProfile?: string;
  profiles?: Record<string, string>;
  root?: string;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writ-sdk-test-"));
  if (spec.activeProfile !== undefined) {
    fs.writeFileSync(path.join(dir, "active_profile"), spec.activeProfile);
  }
  if (spec.profiles) {
    for (const [id, runtime] of Object.entries(spec.profiles)) {
      const profileDir = path.join(dir, "profiles", id);
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, "runtime.json"), runtime);
    }
  }
  if (spec.root !== undefined) {
    fs.writeFileSync(path.join(dir, "runtime.json"), spec.root);
  }
  return dir;
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A 127.0.0.1 port that refuses connections (bound, then released). */
export async function refusedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
