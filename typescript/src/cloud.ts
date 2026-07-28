/**
 * `CloudApi` — the tiered Writ Cloud surface: `scrape`, `map`, and whole-site `crawl`.
 *
 * Unlike the rest of this SDK (which talks to the LOCAL daemon), these three verbs run on Writ Cloud
 * — never on the calling machine — with a Firecrawl-style tier model resolved from your credential:
 *
 *   • **Metered** — an API key (constructor `apiKey` → `WRIT_API_KEY` env) → the authed `/api/crawl/*`
 *     surface, billed per page against your plan. `scrape`, `map`, AND `crawl` all work.
 *   • **Keyless** — no key → the free `/v1/keyless/*` tier, daily-capped per install (a stable
 *     client-id header) AND per IP. `scrape` + `map` only; `crawl` throws {@link WritApiKeyRequiredError}.
 *
 * The credential fallback chain (`apiKey` arg → `WRIT_API_KEY` → keyless) mirrors Firecrawl's, so the
 * same code scales from an anonymous test to a metered production key with no branching at the call site.
 */
import {
  WritApiError,
  WritApiKeyRequiredError,
  WritConnectionError,
  WritInsufficientCreditsError,
  WritRateLimitedError,
  codeForStatus,
} from "./errors.js";
import type { CrawlJob, CrawlStartBody } from "./types.js";

const DEFAULT_CLOUD_URL = "https://api.usewrit.app";
const CLIENT_ID_HEADER = "X-Writ-Client-Id";

/** Which access tier a call resolved to. */
export type CloudTier = "keyless" | "metered";

/** Remaining keyless allowance echoed back on every keyless call. */
export interface KeylessQuota {
  tier: "keyless";
  requestsRemaining: number;
  pagesRemaining: number;
  requestsPerDay: number;
  pagesPerDay: number;
  resetAt: string;
  upgradeUrl?: string;
}

export interface ScrapeResult {
  url: string;
  title: string | null;
  format: string;
  markdown: string;
  counts: Record<string, number>;
  /** The tier this call resolved to. */
  tier: CloudTier;
  /** Present on the keyless tier only — remaining daily allowance. */
  quota?: KeylessQuota;
}

export interface MapResult {
  url: string;
  host?: string;
  urls: Array<{ url: string; score: number; title: string | null }>;
  counts: { returned: number; total: number };
  tier: CloudTier;
  quota?: KeylessQuota;
}

export interface CloudOptions {
  /** Metered API key (`wt_`/`wlk_`). Falls back to `WRIT_API_KEY`; absent → keyless. */
  apiKey?: string;
  /** Cloud base URL. Falls back to `WRIT_CLOUD_URL`, then `https://api.usewrit.app`. */
  cloudUrl?: string;
  /** Override the keyless device/client id (else read/mint `~/.writ/client_id`). */
  clientId?: string;
  /** Environment source (mainly for tests). Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable fetch (mainly for tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export class CloudApi {
  readonly #apiKey?: string;
  readonly #base: string;
  readonly #clientIdOverride?: string;
  #clientId?: string;
  readonly #fetch: typeof fetch;

  constructor(opts: CloudOptions = {}) {
    const env: Record<string, string | undefined> =
      opts.env ?? (typeof process !== "undefined" ? process.env : {}) ?? {};
    this.#apiKey = opts.apiKey ?? env["WRIT_API_KEY"] ?? undefined;
    this.#base = (opts.cloudUrl ?? env["WRIT_CLOUD_URL"] ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
    this.#clientIdOverride = opts.clientId ?? env["WRIT_CLIENT_ID"] ?? undefined;
    this.#fetch = opts.fetch ?? fetch;
  }

  /** The tier this client will use: `metered` when an API key is present, else `keyless`. */
  get tier(): CloudTier {
    return this.#apiKey ? "metered" : "keyless";
  }

  /** Scrape ONE page to clean markdown. Works on both tiers. */
  async scrape(url: string): Promise<ScrapeResult> {
    const path = this.#apiKey ? "/api/crawl/scrape" : "/v1/keyless/scrape";
    const raw = await this.#send("POST", path, { url });
    return normalizeScrape(raw, this.tier);
  }

  /** Map a site's URLs, ranked by an optional `search`. Works on both tiers. */
  async map(url: string, opts: { search?: string; limit?: number } = {}): Promise<MapResult> {
    const path = this.#apiKey ? "/api/crawl/map" : "/v1/keyless/map";
    const raw = await this.#send("POST", path, {
      url,
      search: opts.search ?? "",
      ...(opts.limit != null ? { limit: opts.limit } : {}),
    });
    return normalizeMap(raw, this.tier);
  }

  /**
   * Start a whole-site crawl. METERED ONLY — requires an API key; on the keyless tier this throws
   * {@link WritApiKeyRequiredError} before any network call (use {@link scrape}/{@link map} instead).
   */
  async crawl(body: CrawlStartBody): Promise<CrawlJob> {
    if (!this.#apiKey) {
      throw new WritApiKeyRequiredError({
        status: 402,
        code: "api_key_required",
        message:
          "Whole-site crawl needs an API key — set `apiKey` or WRIT_API_KEY. Keyless access covers scrape and map only.",
        body: null,
      });
    }
    return this.#send("POST", "/api/crawl", body) as Promise<CrawlJob>;
  }

  /** Poll a metered crawl's status (requires an API key). */
  async crawlStatus(id: number): Promise<CrawlJob> {
    if (!this.#apiKey) {
      throw new WritApiKeyRequiredError({
        status: 402,
        code: "api_key_required",
        message: "Crawl status needs an API key — set `apiKey` or WRIT_API_KEY.",
        body: null,
      });
    }
    return this.#send("GET", `/api/crawl/${id}`) as Promise<CrawlJob>;
  }

  /** Remaining keyless allowance for this install (keyless tier only; `null` when metered). */
  async quota(): Promise<KeylessQuota | null> {
    if (this.#apiKey) return null;
    const raw = await this.#send("GET", "/v1/keyless/quota");
    return normalizeQuota(raw);
  }

  // --- transport -----------------------------------------------------------

  async #send(method: "GET" | "POST", path: string, json?: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {};
    if (this.#apiKey) headers["authorization"] = `Bearer ${this.#apiKey}`;
    else headers[CLIENT_ID_HEADER] = await this.#resolveClientId();
    if (json !== undefined) headers["content-type"] = "application/json";

    let resp: Response;
    try {
      resp = await this.#fetch(this.#base + path, {
        method,
        headers,
        body: json !== undefined ? JSON.stringify(json) : undefined,
      });
    } catch (cause) {
      throw new WritConnectionError(`cloud request to ${path} failed`, { cause });
    }
    const text = await resp.text();
    if (!resp.ok) throw cloudErrorFrom(resp.status, text);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  async #resolveClientId(): Promise<string> {
    if (this.#clientIdOverride) return this.#clientIdOverride;
    if (this.#clientId) return this.#clientId;
    this.#clientId = await loadOrMintClientId();
    return this.#clientId;
  }
}

// --- error mapping ----------------------------------------------------------

function cloudErrorFrom(status: number, rawBody: string): WritApiError {
  let body: unknown = rawBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    /* plain-text */
  }
  const detail =
    body && typeof body === "object" && "detail" in body ? (body as Record<string, unknown>)["detail"] : body;
  const d: Record<string, unknown> = detail && typeof detail === "object" ? (detail as Record<string, unknown>) : {};
  const code = (typeof d["code"] === "string" && d["code"]) || codeForStatus(status);
  const message =
    (typeof d["message"] === "string" && d["message"]) ||
    (typeof detail === "string" && detail) ||
    `HTTP ${status}`;
  const base = { status, code, message, body };

  if (status === 429) {
    return new WritRateLimitedError({
      ...base,
      resetAt: typeof d["reset_at"] === "string" ? d["reset_at"] : undefined,
      requestsRemaining: typeof d["requests_remaining"] === "number" ? d["requests_remaining"] : undefined,
      pagesRemaining: typeof d["pages_remaining"] === "number" ? d["pages_remaining"] : undefined,
    });
  }
  if (status === 402 && code === "api_key_required") return new WritApiKeyRequiredError(base);
  if (status === 402) return new WritInsufficientCreditsError(base);
  return new WritApiError(base);
}

// --- normalization ----------------------------------------------------------

function normalizeQuota(raw: Record<string, unknown>): KeylessQuota {
  const q = (raw["quota"] as Record<string, unknown> | undefined) ?? raw;
  return {
    tier: "keyless",
    requestsRemaining: num(q["requests_remaining"]),
    pagesRemaining: num(q["pages_remaining"]),
    requestsPerDay: num(q["requests_per_day"]),
    pagesPerDay: num(q["pages_per_day"]),
    resetAt: str(q["reset_at"]),
    upgradeUrl: typeof q["upgrade_url"] === "string" ? q["upgrade_url"] : undefined,
  };
}

function normalizeScrape(raw: Record<string, unknown>, tier: CloudTier): ScrapeResult {
  return {
    url: str(raw["url"]),
    title: (raw["title"] as string | null) ?? null,
    format: str(raw["format"]) || "markdown",
    markdown: str(raw["markdown"]),
    counts: (raw["counts"] as Record<string, number>) ?? {},
    tier,
    quota: raw["quota"] ? normalizeQuota(raw) : undefined,
  };
}

function normalizeMap(raw: Record<string, unknown>, tier: CloudTier): MapResult {
  return {
    url: str(raw["url"]),
    host: typeof raw["host"] === "string" ? raw["host"] : undefined,
    urls: (raw["urls"] as MapResult["urls"]) ?? [],
    counts: (raw["counts"] as MapResult["counts"]) ?? { returned: 0, total: 0 },
    tier,
    quota: raw["quota"] ? normalizeQuota(raw) : undefined,
  };
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// --- client id --------------------------------------------------------------

/** Read (or mint + persist) the stable keyless device id at `~/.writ/client_id`. */
async function loadOrMintClientId(): Promise<string> {
  try {
    const [os, fs, path] = await Promise.all([import("node:os"), import("node:fs"), import("node:path")]);
    const dir = path.join(os.homedir(), ".writ");
    const file = path.join(dir, "client_id");
    try {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (existing) return existing;
    } catch {
      /* not yet minted */
    }
    const id = randomId();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, id, { mode: 0o600 });
    } catch {
      /* read-only fs — fall back to the ephemeral id */
    }
    return id;
  } catch {
    return randomId();
  }
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) & 0xff;
  // URL-safe base64, no padding.
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
