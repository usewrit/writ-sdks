/**
 * Minimal fetch-based HTTP transport with lazy single-flight discovery,
 * per-request timeouts, and the DESIGN.md §5 error mapping.
 */

import { discoverAgent, normalizeBaseUrl } from "./discovery.js";
import type { DiscoveryOptions, ResolvedConnection } from "./discovery.js";
import { apiErrorFrom, WritConnectionError } from "./errors.js";
import { USER_AGENT } from "./version.js";

/** Query parameters — `undefined`/`null` entries are skipped. */
export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: QueryParams;
  /** JSON request body (sets `content-type: application/json`). */
  json?: unknown;
  /** Multipart body — fetch sets the boundary itself; do not set content-type. */
  form?: FormData;
  headers?: Record<string, string>;
  /** Non-2xx statuses to treat as a normal answer (e.g. cancel's 409). */
  allowStatuses?: readonly number[];
  /** Caller-supplied abort signal (combined with the timeout). */
  signal?: AbortSignal;
  /** Per-request timeout override in ms. */
  timeoutMs?: number;
}

export interface HttpClientOptions extends DiscoveryOptions {
  /** Per-request timeout in milliseconds. Default 30 000 (DESIGN.md §3). */
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpClient {
  readonly #opts: HttpClientOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  #conn: Promise<ResolvedConnection> | null = null;

  constructor(opts: HttpClientOptions = {}) {
    this.#opts = opts;
    const custom = opts.fetch;
    this.#fetch = custom
      ? (input, init) => custom(input, init)
      : (input, init) => globalThis.fetch(input, init);
    this.#timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;

    // Fully-explicit configuration short-circuits discovery entirely.
    if (opts.baseUrl && opts.token) {
      this.#conn = Promise.resolve({
        baseUrl: normalizeBaseUrl(opts.baseUrl),
        token: opts.token,
      });
    }
  }

  /**
   * Resolve the connection (single-flight). The first request triggers
   * discovery; concurrent requests share the same in-flight promise; a failed
   * discovery resets so a later request can retry.
   */
  connection(): Promise<ResolvedConnection> {
    if (this.#conn === null) {
      const attempt = discoverAgent(this.#opts);
      this.#conn = attempt;
      attempt.catch(() => {
        if (this.#conn === attempt) this.#conn = null;
      });
    }
    return this.#conn;
  }

  /** JSON request → parsed JSON response (empty body → `undefined`). */
  async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const { res, finish } = await this.#send(method, path, opts, false);
    const text = await this.#readText(res, finish, method, path);
    if (text === "") return undefined as T;
    return JSON.parse(text) as T;
  }

  /** Raw-text lane (CSV exports etc.). */
  async text(method: string, path: string, opts: RequestOptions = {}): Promise<string> {
    const { res, finish } = await this.#send(method, path, opts, false);
    return this.#readText(res, finish, method, path);
  }

  /** Raw-bytes lane (file content). */
  async bytes(method: string, path: string, opts: RequestOptions = {}): Promise<Uint8Array> {
    const { res, finish } = await this.#send(method, path, opts, false);
    try {
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      throw this.#bodyError(err, method, path);
    } finally {
      finish();
    }
  }

  /**
   * Streaming lane (SSE): returns the `Response` once headers arrive. The
   * request timeout covers only connection establishment — a long-lived event
   * stream is kept open indefinitely (keep-alive comments arrive every 15 s).
   */
  async stream(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const { res, finish } = await this.#send(method, path, opts, true);
    // Headers are in; stop the timeout clock but keep any caller signal wired.
    finish();
    return res;
  }

  async #send(
    method: string,
    path: string,
    opts: RequestOptions,
    streaming: boolean,
  ): Promise<{ res: Response; finish: () => void }> {
    const conn = await this.connection();

    const url = new URL(conn.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${conn.token}`,
      "user-agent": USER_AGENT,
      accept: streaming ? "text/event-stream" : "application/json",
      ...opts.headers,
    };

    let body: string | FormData | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form;
    }

    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            ctrl.abort();
          }, timeoutMs)
        : null;

    const outer = opts.signal;
    const onOuterAbort = () => ctrl.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) onOuterAbort();
      else outer.addEventListener("abort", onOuterAbort, { once: true });
    }

    /** Stop the timeout clock and detach the caller-signal listener. */
    const finish = () => {
      if (timer !== null) clearTimeout(timer);
      // For streams the caller signal must keep aborting the body, so only
      // detach when it can no longer matter.
      if (outer && !streaming) outer.removeEventListener("abort", onOuterAbort);
    };

    let res: Response;
    try {
      res = await this.#fetch(url, { method, headers, body, signal: ctrl.signal });
    } catch (err) {
      finish();
      if (timedOut) {
        throw new WritConnectionError(
          `request timed out after ${timeoutMs} ms: ${method} ${path}`,
          { cause: err },
        );
      }
      throw new WritConnectionError(
        `could not reach the Writ agent (${method} ${path}): ${errorMessage(err)}`,
        { cause: err },
      );
    }

    if (!res.ok && !(opts.allowStatuses ?? []).includes(res.status)) {
      let raw = "";
      try {
        raw = await res.text();
      } catch {
        // unreadable error body — map from status alone
      }
      finish();
      throw apiErrorFrom(res.status, res.statusText ?? "", raw);
    }

    return { res, finish };
  }

  async #readText(
    res: Response,
    finish: () => void,
    method: string,
    path: string,
  ): Promise<string> {
    try {
      return await res.text();
    } catch (err) {
      throw this.#bodyError(err, method, path);
    } finally {
      finish();
    }
  }

  #bodyError(err: unknown, method: string, path: string): WritConnectionError {
    return new WritConnectionError(
      `connection lost while reading the response body (${method} ${path}): ${errorMessage(err)}`,
      { cause: err },
    );
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // undici wraps the interesting part in `cause` ("fetch failed").
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${err.message} (${cause.message})`;
    return err.message;
  }
  return String(err);
}
