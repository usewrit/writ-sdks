/**
 * Error model (DESIGN.md §5): three error kinds, one shared base.
 *
 * - {@link WritApiError} — the daemon answered with a non-2xx HTTP response.
 * - {@link WritConnectionError} — network failure / timeout (daemon down mid-session).
 * - {@link WritDiscoveryError} — no live daemon could be found at construction time.
 */

/** Base class for every error thrown by the Writ agent SDK. */
export class WritError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * A non-2xx HTTP response from the daemon.
 *
 * Domain errors are JSON `{"error": "<msg>", "code": "<code>"}`; some axum
 * rejections are plain text. `message` resolves `error` → `detail` → `message`
 * → status text; `code` is the body's `code` when present, else derived from
 * the HTTP status. `body` is the parsed JSON value (or the raw text when the
 * body was not JSON).
 */
export class WritApiError extends WritError {
  /** HTTP status code (e.g. 404). */
  readonly status: number;
  /** Stable machine code (`not_found`, `unauthorized`, `bad_request`, …). */
  readonly code: string;
  /** Parsed JSON body, or the raw response text when the body was not JSON. */
  readonly body: unknown;

  constructor(opts: { status: number; code: string; message: string; body: unknown }) {
    super(opts.message);
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}

/** Network failure or timeout while talking to the daemon. */
export class WritConnectionError extends WritError {}

/**
 * A `run(id, {wait:true})` call whose server-side budget expired (HTTP 504).
 *
 * NOT a failure of the run: it is still executing and `runId` still addresses it —
 * poll {@link RunsApi.get} / {@link RunsApi.results}, stream {@link RunsApi.events},
 * or {@link RunsApi.cancel} it. Retrying the call would start a SECOND run, which is
 * exactly what having the id here is meant to prevent.
 */
export class WritRunTimeoutError extends WritApiError {
  /** The still-running run. */
  readonly runId: number;

  constructor(opts: { status: number; code: string; message: string; body: unknown; runId: number }) {
    super(opts);
    this.runId = opts.runId;
  }
}

/**
 * A whole-site crawl was requested on the keyless cloud tier (no API key). Crawl is metered and
 * always needs a credential — set `apiKey` (or `WRIT_API_KEY`). Keyless access covers scrape + map.
 * Thrown by {@link CloudApi.crawl}. HTTP 402 `api_key_required`.
 */
export class WritApiKeyRequiredError extends WritApiError {}

/** The tenant's crawl-page allotment is spent and the wallet can't cover the call. HTTP 402. */
export class WritInsufficientCreditsError extends WritApiError {}

/**
 * The keyless daily allowance (requests/day or pages/day, per device or IP) is exhausted. HTTP 429.
 * `resetAt` is when the allowance refills; add an API key for a full metered quota.
 */
export class WritRateLimitedError extends WritApiError {
  /** ISO timestamp when the keyless daily allowance resets. */
  readonly resetAt?: string;
  /** Keyless requests left today (if reported). */
  readonly requestsRemaining?: number;
  /** Keyless pages left today (if reported). */
  readonly pagesRemaining?: number;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    body: unknown;
    resetAt?: string;
    requestsRemaining?: number;
    pagesRemaining?: number;
  }) {
    super(opts);
    this.resetAt = opts.resetAt;
    this.requestsRemaining = opts.requestsRemaining;
    this.pagesRemaining = opts.pagesRemaining;
  }
}

/**
 * No live daemon was found (DESIGN.md §4). The message says how to fix it —
 * start the Writ agent, or pass `baseUrl`/`token` (or set `WRIT_API_URL`/`WRIT_TOKEN`).
 */
export class WritDiscoveryError extends WritError {}

/**
 * Derive a stable machine code from an HTTP status for responses whose body
 * carries no `code` field (plain-text axum rejections). DESIGN.md §5.
 */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 422:
      return "unprocessable";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "internal" : `http_${status}`;
  }
}

const MAX_TEXT_MESSAGE = 500;

/**
 * Build a {@link WritApiError} from a non-2xx response's status + raw body text,
 * applying the DESIGN.md §5 message/code resolution rules.
 */
export function apiErrorFrom(status: number, statusText: string, rawBody: string): WritApiError {
  let body: unknown = rawBody;
  let parsed: Record<string, unknown> | null = null;
  try {
    const j: unknown = JSON.parse(rawBody);
    body = j;
    if (j !== null && typeof j === "object" && !Array.isArray(j)) {
      parsed = j as Record<string, unknown>;
    }
  } catch {
    // plain-text body — fall through
  }

  const fallbackMessage = statusText.trim() !== "" ? statusText : `HTTP ${status}`;
  let message: string;
  let code: string;
  if (parsed) {
    message =
      asString(parsed["error"]) ??
      asString(parsed["detail"]) ??
      asString(parsed["message"]) ??
      fallbackMessage;
    code = asString(parsed["code"]) ?? codeForStatus(status);
  } else {
    const text = rawBody.trim();
    message = text !== "" ? truncate(text, MAX_TEXT_MESSAGE) : fallbackMessage;
    code = codeForStatus(status);
  }
  return new WritApiError({ status, code, message, body });
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
