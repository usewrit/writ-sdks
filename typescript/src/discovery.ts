/**
 * Daemon discovery (DESIGN.md §4) — the canonical algorithm, mirroring the
 * daemon's own CLI/MCP discovery (`cli/mcp_stdio.rs::daemon_candidate_homes`,
 * `app/runtime_file.rs`):
 *
 * 1. Env overrides `WRIT_API_URL` / `WRIT_TOKEN` (both set → done; one set →
 *    fills that field, the rest is discovered).
 * 2. `runtime.json` candidates, in order (first LIVE one wins):
 *    1. `$WRIT_HOME/runtime.json`
 *    2. `~/.writ/active_profile` → `~/.writ/profiles/<p>/runtime.json`
 *    3. `~/.writ/runtime.json`
 *    4. every `~/.writ/profiles/<id>/runtime.json` (cap 32, deduped)
 * 3. A candidate counts only if `GET /v1/agent` with its token answers 2xx
 *    within 2 s — stale descriptors fall through to the next candidate.
 *
 * Discovery is filesystem-based and desktop-only: `node:fs`/`node:os` are
 * imported lazily inside the function so bundling for browsers does not crash
 * at import time; in non-Node environments a {@link WritDiscoveryError} tells
 * the caller to pass `baseUrl` + `token` explicitly.
 */

import { WritDiscoveryError } from "./errors.js";
import { USER_AGENT } from "./version.js";

/** `~/.writ/runtime.json` descriptor written by the daemon (mode 0600). */
export interface RuntimeInfo {
  pid: number;
  port: number;
  token: string;
  version: string;
  started_at: string;
}

/** A resolved connection: where the daemon listens and the bearer to present. */
export interface ResolvedConnection {
  baseUrl: string;
  token: string;
}

/** Options accepted by {@link discoverAgent} (and forwarded by `WritAgent`). */
export interface DiscoveryOptions {
  /** Explicit base URL (e.g. `http://127.0.0.1:8131`) — wins over discovery. */
  baseUrl?: string;
  /** Explicit bearer token — wins over discovery. */
  token?: string;
  /** Environment override (mainly for tests). Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Override the `~/.writ` base directory (mainly for tests). */
  writDir?: string;
  /** Custom fetch implementation (e.g. for the HTTPS twin port). */
  fetch?: typeof globalThis.fetch;
  /** Liveness-probe budget per candidate, in ms. Default 2000. */
  probeTimeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const PROFILE_ID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_PROFILE_DIRS = 32;

/** Strip trailing slashes from a base URL (DESIGN.md §3). */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function readProcessEnv(): Record<string, string | undefined> {
  if (typeof process !== "undefined" && typeof process.env === "object" && process.env !== null) {
    return process.env;
  }
  return {};
}

/**
 * Discover a live Writ agent and return `{baseUrl, token}`.
 *
 * @throws {WritDiscoveryError} when no live daemon can be found, or when the
 *   runtime has no filesystem access (browser builds must pass both
 *   `baseUrl` and `token` explicitly).
 */
export async function discoverAgent(opts: DiscoveryOptions = {}): Promise<ResolvedConnection> {
  const env = opts.env ?? readProcessEnv();
  const explicitBaseUrl = opts.baseUrl ?? env["WRIT_API_URL"];
  const explicitToken = opts.token ?? env["WRIT_TOKEN"];

  // Both fields resolved → discovery is done (no filesystem, no probe).
  if (explicitBaseUrl && explicitToken) {
    return { baseUrl: normalizeBaseUrl(explicitBaseUrl), token: explicitToken };
  }

  // Filesystem discovery (Node-only; imported lazily so browser bundles don't
  // crash at module-import time).
  let fs: typeof import("node:fs");
  let os: typeof import("node:os");
  let path: typeof import("node:path");
  try {
    [fs, os, path] = await Promise.all([
      import("node:fs"),
      import("node:os"),
      import("node:path"),
    ]);
  } catch (err) {
    throw new WritDiscoveryError(
      "Writ agent discovery needs filesystem access (Node.js). In this environment pass both " +
        "baseUrl and token explicitly: new WritAgent({ baseUrl, token }).",
      { cause: err },
    );
  }

  const candidates: string[] = [];
  const writHome = env["WRIT_HOME"];
  if (writHome) {
    candidates.push(path.join(writHome, "runtime.json"));
  }
  const writDir = opts.writDir ?? path.join(os.homedir(), ".writ");

  // active_profile → profiles/<p>/runtime.json (validated profile id only).
  try {
    const profile = fs.readFileSync(path.join(writDir, "active_profile"), "utf8").trim();
    if (
      profile !== "" &&
      profile !== "local" &&
      profile.length <= 128 &&
      PROFILE_ID_RE.test(profile)
    ) {
      candidates.push(path.join(writDir, "profiles", profile, "runtime.json"));
    }
  } catch {
    // no active_profile — fine
  }

  candidates.push(path.join(writDir, "runtime.json"));

  // Every profile directory (cap 32), deduped against the above.
  try {
    const entries = fs.readdirSync(path.join(writDir, "profiles"), { withFileTypes: true });
    let taken = 0;
    for (const entry of entries) {
      if (taken >= MAX_PROFILE_DIRS) break;
      if (!entry.isDirectory()) continue;
      taken += 1;
      candidates.push(path.join(writDir, "profiles", entry.name, "runtime.json"));
    }
  } catch {
    // no profiles dir — fine
  }

  const seen = new Set<string>();
  const fetchFn = opts.fetch ?? defaultFetch;
  const probeTimeout = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const info = readRuntimeInfo(fs, candidate);
    if (!info) continue;

    // A partially-set env override fills its field; the rest comes from the
    // descriptor (DESIGN.md §4.1).
    const baseUrl = explicitBaseUrl
      ? normalizeBaseUrl(explicitBaseUrl)
      : `http://127.0.0.1:${info.port}`;
    const token = explicitToken ?? info.token;
    if (!token) continue;

    // Liveness probe — even a sole candidate is probed: better a clear
    // discovery error at construction than a confusing 401 later.
    if (await probeAgent(fetchFn, baseUrl, token, probeTimeout)) {
      return { baseUrl, token };
    }
  }

  throw new WritDiscoveryError(
    "no live Writ agent found — is the Writ agent running? Pass token (and baseUrl) to the " +
      "constructor, or set WRIT_TOKEN / WRIT_API_URL, or start the agent so ~/.writ/runtime.json exists.",
  );
}

function readRuntimeInfo(fs: typeof import("node:fs"), file: string): RuntimeInfo | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const info = parsed as Partial<RuntimeInfo>;
    if (typeof info.port !== "number" || !Number.isInteger(info.port)) return null;
    if (typeof info.token !== "string") return null;
    return info as RuntimeInfo;
  } catch {
    return null;
  }
}

/** `GET /v1/agent` with the candidate token; 2xx within the budget = live. */
async function probeAgent(
  fetchFn: typeof globalThis.fetch,
  baseUrl: string,
  token: string,
  timeoutMs: number,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${baseUrl}/v1/agent`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": USER_AGENT,
        accept: "application/json",
      },
      signal: ctrl.signal,
    });
    // Drain the body so the connection can be reused/released.
    await res.arrayBuffer().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function defaultFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  return globalThis.fetch(input, init);
}
