/**
 * `CloudApi` — the tiered Writ Cloud surface: `scrape`, `map`, whole-site `crawl` and `monitors`.
 *
 * Unlike the rest of this SDK (which talks to the LOCAL daemon), these verbs run on Writ Cloud
 * — never on the calling machine — with a Firecrawl-style tier model resolved from your credential:
 *
 *   • **Metered** — an API key (constructor `apiKey` → `WRIT_API_KEY` env) → the authed
 *     `/api/crawl/*` and `/api/targets/*` surfaces, billed against your plan. `scrape`, `map`,
 *     `crawl` AND `monitors` all work.
 *   • **Keyless** — no key → the free `/v1/keyless/*` tier, daily-capped per install (a stable
 *     client-id header) AND per IP. `scrape` + `map` only; `crawl` and `monitors` throw
 *     {@link WritApiKeyRequiredError}.
 *
 * The credential fallback chain (`apiKey` arg → `WRIT_API_KEY` → keyless) mirrors Firecrawl's, so the
 * same code scales from an anonymous test to a metered production key with no branching at the call site.
 *
 * `client.cloud.monitors` mirrors the local daemon's `client.monitors` verb for verb, so the same
 * program runs against either venue by changing which object it talks to. The wire paths differ (the
 * cloud calls the resource `targets`) and so does the JSON casing — the cloud answers `checkPeriodMs`
 * where the daemon answers `check_period_ms` — because these are two independently versioned
 * services, not one service behind two hostnames. The SDK returns each service's own body rather than
 * inventing a third shape, and the types below say which is which.
 */
import {
  WritApiError,
  WritError,
  WritApiKeyRequiredError,
  WritConnectionError,
  WritInsufficientCreditsError,
  WritPlanLimitError,
  WritRateLimitedError,
  codeForStatus,
} from "./errors.js";
import { DEFAULT_RETRY_POLICY, isSafeMethod, newIdempotencyKey, sleep, withRetry } from "./retry.js";
import type { RetryPolicy } from "./retry.js";
import type { ChangeListParams, CrawlJob, CrawlStartBody, RecentChange } from "./types.js";
import { warmWebCrypto } from "./webcrypto.js";

const DEFAULT_CLOUD_URL = "https://api.usewrit.app";
const CLIENT_ID_HEADER = "X-Writ-Client-Id";
// Server-minted, HMAC-signed keyless subject. The server issues one on any
// keyless response where we did not present a valid token; persisting it and
// sending it back is what earns this install its OWN daily bucket. Without it a
// caller is metered on its IP prefix, shared with every install behind the same
// NAT. The client cannot forge or edit this value — it is signed server-side
// (backend/services/keyless_identity.py).
const DEVICE_TOKEN_HEADER = "X-Writ-Device-Token";

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

/**
 * A cloud monitor, as the cloud serialises it — camelCase, because `/api/targets`
 * answers with its own aliases. The daemon's {@link Monitor} is the same concept in
 * snake_case; they are deliberately separate types so neither service's wire format
 * is silently claimed for the other.
 */
export interface CloudMonitor {
  id: number;
  url: string;
  checkType: string;
  selector: string | null;
  ignoreRegex: string | null;
  checkPeriodMs: number | null;
  scheduleKind: string | null;
  scheduleTime: string | null;
  scheduleDays: number[] | null;
  scheduleTz: string | null;
  enabled: boolean;
  expectedStatusCode: number | null;
  timeoutMs: number | null;
  maxResponseTimeMs: number | null;
  checkSsl: boolean | null;
  requiresPlaywright: boolean;
  preferredRegion: string | null;
  useResidential: boolean | null;
  residentialCountry: string | null;
  createdAt: string;
  updatedAt: string | null;
  lastCheckedAt: string | null;
  changesCount: number;
  /** Live health from the monitoring state: `up`/`down`/`ok`/`stale`/`never`. */
  state: string | null;
  statusCode: number | null;
  lastChangeAt: string | null;
}

/**
 * Create body for {@link CloudMonitors.create}. snake_case on purpose: the cloud
 * ACCEPTS snake_case and ANSWERS camelCase ({@link CloudMonitor}). That asymmetry is
 * the server's, and hiding it would mean guessing wrong the first time a field is added.
 */
export interface CloudMonitorCreate {
  /** Required. The page to watch. */
  url: string;
  /** `content` (default) watches the page or a selector; `uptime` watches availability. */
  check_type?: "content" | "uptime";
  /** CSS selector to extract and compare. Omit to watch the whole page. */
  selector?: string;
  ignore_regex?: string;
  /**
   * How often to check, in milliseconds. Below your plan's minimum check interval
   * the API answers 402 `interval_too_short` naming the floor — it is never
   * silently clamped. JS-rendered checks (`requires_playwright`) have their own,
   * longer floor.
   */
  check_period_ms?: number;
  schedule_kind?: "interval" | "daily" | "weekly";
  schedule_time?: string;
  schedule_days?: number[];
  schedule_tz?: string;
  enabled?: boolean;
  /** Render with a real browser (JS/SPA pages) instead of plain HTTP. */
  requires_playwright?: boolean;
  preferred_region?: string;
  expected_status_code?: number;
  timeout_ms?: number;
  max_response_time_ms?: number;
  check_ssl?: boolean;
  use_residential?: boolean;
  residential_country?: string;
}

/** Partial update for {@link CloudMonitors.update} — send only what changes. */
export type CloudMonitorPatch = Partial<CloudMonitorCreate>;

/** Query for {@link CloudMonitors.list}. Omit `limit` to get every monitor. */
export interface CloudMonitorListParams {
  enabled_only?: boolean;
  check_type?: "content" | "uptime";
  /** 1–1000, newest first. */
  limit?: number;
  offset?: number;
}

/**
 * One detected change in ONE monitor's history, as `GET /api/targets/{id}/changes`
 * serialises it: camelCase, with STRING ids.
 *
 * It is deliberately NOT the type the GLOBAL feed returns — see
 * {@link RecentChange}. The two routes answer genuinely different shapes
 * (different casing, different id types, different fields), and this SDK used to
 * model both with this one interface: `recentChanges()` was typed as returning
 * these while the server sent snake_case rows with numeric ids, so every field
 * read back `undefined` at runtime with no type error to show for it.
 */
export interface CloudMonitorChange {
  id: string;
  targetId: string;
  /** When this change was FIRST seen — the same value as {@link firstDetectedAt}. */
  timestamp: string;
  /**
   * The two real timestamps behind `timestamp`. The feed is ORDERED by
   * `lastDetectedAt`, so that — not `timestamp` — is what a client sorts or
   * advances a cursor on. Sorting on `timestamp` silently disagrees with the
   * server's own order.
   */
  firstDetectedAt: string;
  lastDetectedAt: string;
  oldContent: string;
  newContent: string;
  diff: string;
  detectedBy: string;
  selectorId: number | null;
  selectorName: string | null;
  /** Same-origin proxy path, present only when that snapshot has stored bytes. */
  screenshotBefore: string | null;
  screenshotAfter: string | null;
  screenshotDiff: string | null;
}

/**
 * The GLOBAL feed's row shape lives in `types.ts` because the cloud and the
 * local daemon serialise it identically — one type lets the same watcher drive
 * either venue. (The per-monitor routes genuinely do differ, which is why
 * {@link CloudMonitorChange} stays separate.)
 */
export type { RecentChange, ChangeListParams } from "./types.js";

/** Outcome of an out-of-schedule {@link CloudMonitors.run}. */
export interface CloudMonitorRunResult {
  ok: boolean;
  dispatched: number;
  /** Present when `ok` is false — e.g. no recorder is assigned to this monitor yet. */
  detail?: string;
}

/** A cloud automation (trigger rule) — event → conditions → actions. */
export interface CloudAutomation {
  id: number;
  name: string;
  description: string | null;
  /** `change_detected` | `webhook_received` | `workflow_completed` | … */
  event_type: string;
  enabled: boolean;
  priority: number;
  target_id: number | null;
  target_selector_id: number | null;
  workflow_id: number | null;
  webhook_trigger_id: number | null;
  webhook_trigger_token: string | null;
  custom_path: string | null;
  conditions: Record<string, unknown> | null;
  actions: Array<{ type: string; config: Record<string, unknown> }>;
  blocks: Array<Record<string, unknown>> | null;
  last_triggered_at: string | null;
  next_scheduled_at: string | null;
  trigger_count: number;
  created_at: string | null;
  updated_at: string | null;
}

/** Create body for {@link CloudAutomations.create}. `name` is required. */
export interface CloudAutomationCreate {
  name: string;
  description?: string;
  /** Defaults to `change_detected`. */
  event_type?: string;
  enabled?: boolean;
  priority?: number;
  /** Only fire for this monitor (`change_detected`). */
  target_id?: number;
  target_selector_id?: number;
  workflow_id?: number;
  webhook_trigger_id?: number;
  ai_session_id?: number;
  conditions?: Record<string, unknown>;
  /**
   * What to do when it fires. An action of type `workflow` arranges a workflow
   * run, so the key needs `workflows:execute` on top of `triggers:write`;
   * notification-only automations need no workflow scope.
   */
  actions?: Array<{ type: "notification" | "workflow" | "ai_session"; config: Record<string, unknown> }>;
  blocks?: Array<Record<string, unknown>>;
}

/** Query for {@link CloudAutomations.list}. */
export interface CloudAutomationListParams {
  enabled_only?: boolean;
  event_type?: string;
  workflow_id?: number;
}

/**
 * A cloud persona — the login identity a run acts as.
 *
 * SECRET MATERIAL IS WRITE-ONLY. A password, TOTP seed and proxy credentials go
 * in on create/update and are stored encrypted; they never come back. What you
 * read is `has_*` booleans.
 *
 * ⚠️ `relay_token` IS returned, because the owner needs it to point OTP
 * forwarding at the right address. It is deposit-only (it can add messages to
 * this persona's relay mailbox, never read them) — still treat it as a secret.
 */
export interface CloudPersona {
  id: number;
  name: string;
  description: string | null;
  target_domain: string | null;
  login_username: string | null;
  has_password: boolean;
  twofa_method: string;
  has_totp_seed: boolean;
  email_otp_mode: string | null;
  mail_connection_id: number | null;
  connected_mailbox: string | null;
  relay_address: string | null;
  relay_token: string | null;
  relay_inbound_address: string | null;
  relay_inbound_url: string | null;
  has_fingerprint: boolean;
  preferred_agent_id: string | null;
  has_proxy: boolean;
  proxy_provider: string | null;
  proxy_lawful_use_ack_at: string | null;
  is_active: boolean;
  validation_status: string;
  has_warm_session: boolean;
  session_expires_at: string | null;
  last_login_at: string | null;
  last_used_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  linked_workflows: Array<Record<string, unknown>>;
  linked_secrets: Record<string, unknown>;
}

/** Create body for {@link CloudPersonas.create}. Only `name` is required. */
export interface CloudPersonaCreate {
  name: string;
  description?: string;
  target_domain?: string;
  login_username?: string;
  /** WRITE-ONLY — stored encrypted, never returned. */
  password?: string;
  extra_login_fields?: Record<string, unknown>;
  /** `none` | `totp` | `email_otp` | `sms` … */
  twofa_method?: string;
  /** WRITE-ONLY base32 secret. Check it with {@link CloudPersonas.validateTotp} first. */
  totp_seed?: string;
  totp_digits?: number;
  totp_period_seconds?: number;
  totp_algorithm?: string;
  email_otp_mode?: string;
  mail_connection_id?: number;
  relay_address?: string;
  otp_extract_config?: Record<string, unknown>;
  fingerprint?: Record<string, unknown>;
  preferred_agent_id?: string;
  proxy_server?: string;
  proxy_username?: string;
  /** WRITE-ONLY. */
  proxy_password?: string;
  proxy_lawful_use_ack?: boolean;
  proxy_provider?: string;
  is_active?: boolean;
}

/** Result of {@link CloudPersonas.validateTotp}. */
export interface TotpValidation {
  valid_base32: boolean;
  matches_code?: boolean | null;
  [key: string]: unknown;
}

/** A website → API build, or the ladder answer that made one unnecessary. */
export interface CloudBuild {
  /** Present only when a build was actually queued. */
  build_id?: number;
  /** `queued` | `building` | `succeeded` | `failed` | `cancelled`, or a ladder
   *  answer: `existing_workflows` | `marketplace_candidates`. */
  status: string;
  url?: string;
  goal?: string;
  /** Present once the agent saves — this is what the build was for. */
  workflow_id?: number | null;
  error?: string | null;
  next?: string;
  /** Ladder answers carry these instead of a build. */
  workflows?: Array<Record<string, unknown>>;
  candidates?: Array<Record<string, unknown>>;
  message?: string;
  created_at?: string | null;
  completed_at?: string | null;
}

/** Options for {@link CloudBuilds.start}. */
export interface CloudBuildOptions {
  /** Saved identity to sign in with, for sites behind a login. */
  persona_id?: number;
  /** Upper bound on the agent loop. */
  max_steps?: number;
  /** Name for the workflow the build saves. */
  save_as?: string;
  /** Skip the proposal of your own matching workflows (replaying one is free). */
  skip_existing?: boolean;
  /** Skip the proposal of ready-made marketplace listings. */
  skip_marketplace?: boolean;
}

/** Build states that will never change again. */
export const TERMINAL_BUILD_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * A bounded, no-account crawl: a few same-domain pages fetched in process and
 * returned inline. Deliberately NOT a {@link CrawlJob} — that one is a fleet job
 * you poll, and one type must never pretend to be both shapes.
 */
export interface KeylessCrawlResult {
  verb: "crawl";
  url: string;
  pages: Array<{ url: string; title: string | null; markdown: string }>;
  counts: { pages: number; requested: number };
  tier: CloudTier;
  /** The ceilings that applied, stated so you need not discover them by hitting them. */
  limits: { page_cap: number; max_depth: number; same_domain: boolean; note: string };
  quota?: KeylessQuota;
  upgrade_url?: string;
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
  /**
   * Override the transient-failure retry policy. Unsafe methods ARE retried
   * here (unlike the daemon transport): every POST/PATCH/DELETE below carries an
   * `Idempotency-Key`, and the cloud replays its recorded response rather than
   * executing a second time.
   */
  retry?: Partial<RetryPolicy>;
}

type CloudMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * What a cloud sub-namespace is handed so it never re-implements credentials,
 * device-token absorption or error mapping. Internal — not exported.
 */
interface CloudTransport {
  send(method: CloudMethod, path: string, json?: unknown, query?: object): Promise<unknown>;
  requireKey(what: string): void;
}

/**
 * Cloud monitors — `client.cloud.monitors`, verb for verb the same as the local
 * daemon's `client.monitors`.
 *
 * On the wire the cloud calls this resource `targets`; the product, the daemon and
 * every SDK call it a MONITOR. The rename happens here, once.
 *
 * Every verb is metered-only: the keyless tier has no account to own a monitor, so
 * these throw {@link WritApiKeyRequiredError} BEFORE any network call rather than
 * sending a request that could only come back 401.
 */
export class CloudMonitors {
  readonly #t: CloudTransport;

  constructor(transport: CloudTransport) {
    this.#t = transport;
  }

  /** Every monitor on the account, newest first. Omit `limit` for all of them. */
  async list(params: CloudMonitorListParams = {}): Promise<CloudMonitor[]> {
    this.#t.requireKey("Listing cloud monitors");
    return (await this.#t.send("GET", MONITORS_PATH, undefined, params)) as CloudMonitor[];
  }

  /**
   * Create a monitor. A `check_period_ms` below your plan's minimum check interval
   * is REJECTED with a 402 `interval_too_short` naming the floor — never silently
   * clamped, so a monitor never runs slower than you asked without saying so.
   */
  async create(body: CloudMonitorCreate): Promise<CloudMonitor> {
    this.#t.requireKey("Creating a cloud monitor");
    return (await this.#t.send("POST", MONITORS_PATH, body)) as CloudMonitor;
  }

  async get(id: number): Promise<CloudMonitor> {
    this.#t.requireKey("Reading a cloud monitor");
    return (await this.#t.send("GET", `${MONITORS_PATH}/${id}`)) as CloudMonitor;
  }

  /** Partial update — send only the fields you are changing. */
  async update(id: number, patch: CloudMonitorPatch): Promise<CloudMonitor> {
    this.#t.requireKey("Updating a cloud monitor");
    return (await this.#t.send("PATCH", `${MONITORS_PATH}/${id}`, patch)) as CloudMonitor;
  }

  /** Delete a monitor with its selectors, triggers and notification history. Answers 204. */
  async delete(id: number): Promise<void> {
    this.#t.requireKey("Deleting a cloud monitor");
    await this.#t.send("DELETE", `${MONITORS_PATH}/${id}`);
  }

  /** Pause or resume a monitor without deleting it. */
  async toggle(id: number, enabled: boolean): Promise<CloudMonitor> {
    this.#t.requireKey("Toggling a cloud monitor");
    return (await this.#t.send("PATCH", `${MONITORS_PATH}/${id}/toggle`, undefined, {
      enabled,
    })) as CloudMonitor;
  }

  /**
   * Check this monitor NOW, out of schedule. `ok` is false with a `detail` when no
   * recorder is assigned yet — the check still happens on the next scheduled cycle.
   */
  async run(id: number): Promise<CloudMonitorRunResult> {
    this.#t.requireKey("Running a cloud monitor");
    return (await this.#t.send("POST", `${MONITORS_PATH}/${id}/run`)) as CloudMonitorRunResult;
  }

  /**
   * This monitor's detected-change history, newest first — or, when `since` is
   * set, the changes detected after that cursor, oldest first.
   */
  async changes(id: number, opts: ChangeListParams = {}): Promise<CloudMonitorChange[]> {
    this.#t.requireKey("Reading cloud monitor changes");
    return (await this.#t.send("GET", `${MONITORS_PATH}/${id}/changes`, undefined, opts)) as CloudMonitorChange[];
  }

  /**
   * Detected changes across ALL monitors on the account (`limit` 1–200), newest
   * first — or, when `since` is set, everything detected after that cursor,
   * oldest first.
   *
   * For a continuous feed prefer {@link watch}, which drives this call with a
   * correctly advanced cursor.
   */
  async recentChanges(opts: ChangeListParams = {}): Promise<RecentChange[]> {
    this.#t.requireKey("Reading recent cloud changes");
    return (await this.#t.send(
      "GET",
      `${MONITORS_PATH}/changes/recent`,
      undefined,
      opts,
    )) as RecentChange[];
  }

  /**
   * Stream detected changes across ALL monitors, in detection order, without
   * gaps or repeats.
   *
   * ```ts
   * for await (const change of client.cloud.monitors.watch()) {
   *   console.log(change.target_url, change.diff_snippet);
   * }
   * ```
   *
   * This exists because polling the feed correctly by hand is harder than it
   * looks: the newest-first view drops changes when more than a page of them
   * lands between polls, and a change row is UPDATED (not re-inserted) when the
   * same difference recurs, so an id you already processed can resurface.
   * `watch` drives the server's keyset cursor instead, which makes "everything
   * after this point" exact — and a resurfaced id arrives as what it actually
   * is, a fresh detection.
   *
   * To resume across process restarts, persist the last delivered change's
   * `last_detected_at` + `id` and pass them as `since` / `sinceId`.
   *
   * Stop by `break`ing out of the loop or aborting `opts.signal`.
   */
  watch(opts: WatchOptions = {}): AsyncGenerator<RecentChange, void, undefined> {
    this.#t.requireKey("Watching cloud monitor changes");
    return watchChanges(opts, (params) => this.recentChanges(params));
  }
}

/** Tuning for a change watcher. */
export interface WatchOptions {
  /**
   * Poll cadence in ms. Default 30 000. A watcher never polls faster than this
   * even when a page comes back full — it drains the backlog first, then
   * resumes the cadence.
   */
  intervalMs?: number;
  /** Rows per request. Default 100. */
  pageSize?: number;
  /**
   * Resume a previous watcher exactly where it stopped. Persist the last
   * delivered change's `last_detected_at` and `id`, hand them back here, and no
   * change detected during the downtime is missed.
   */
  since?: string;
  sinceId?: number;
  /**
   * Start from the beginning of the feed instead of its head. Ignored when
   * `since` is set. Off by default: a fresh watcher on an account with months of
   * history should not open by re-delivering all of it.
   */
  replayHistory?: boolean;
  /** Stop the watcher. */
  signal?: AbortSignal;
  /**
   * Decide what to do with a polling error. Return `true` to keep polling (with
   * backoff), `false` to rethrow. Default keeps polling: one bad response
   * should not silently kill a change feed a production system depends on.
   */
  onError?: (error: unknown) => boolean;
}

/**
 * Cursor floor used to replay a feed from the beginning.
 *
 * It is NOT the same as omitting `since`: omitting it selects the server's
 * newest-first BROWSING view, whose order runs backwards against a forward
 * walk. A floor cursor keeps the request in keyset mode — oldest-first,
 * strictly advancing — which is the only ordering a watcher can consume.
 */
const CURSOR_FLOOR = "1970-01-01T00:00:00+00:00";

/** The shared cursor loop behind every `watch()`. */
export async function* watchChanges(
  opts: WatchOptions,
  fetchPage: (params: ChangeListParams) => Promise<RecentChange[]>,
): AsyncGenerator<RecentChange, void, undefined> {
  const intervalMs = opts.intervalMs ?? 30_000;
  const pageSize = opts.pageSize ?? 100;
  const { signal } = opts;

  let since = opts.since;
  let sinceId = opts.sinceId ?? 0;

  const aborted = () => signal?.aborted === true;
  const survive = (err: unknown) => (opts.onError ? opts.onError(err) : true);

  // Establish the starting cursor.
  if (since === undefined) {
    if (opts.replayHistory) {
      // Replay from the floor, NOT from "no cursor" — see CURSOR_FLOOR.
      since = CURSOR_FLOOR;
      sinceId = 0;
    } else {
      // Read the single newest row (the no-cursor view IS newest-first) and
      // start AFTER it, so the watcher opens on "what happens from now on"
      // rather than the whole archive.
      try {
        const head = await fetchPage({ limit: 1 });
        if (head.length > 0) {
          since = head[0]!.last_detected_at;
          sinceId = head[0]!.id;
        } else {
          since = CURSOR_FLOOR;
          sinceId = 0;
        }
      } catch (err) {
        if (!survive(err)) throw err;
      }
    }
  }

  let failures = 0;
  while (!aborted()) {
    let batch: RecentChange[];
    try {
      batch = await fetchPage({ limit: pageSize, since, since_id: sinceId });
      failures = 0;
    } catch (err) {
      if (aborted()) return;
      if (!survive(err)) throw err;
      failures++;
      // Back off on repeated failure so a persistently broken feed does not
      // hammer the API at the full poll rate.
      await sleep(Math.min(intervalMs * 2 ** (failures - 1), intervalMs * 10), signal).catch(() => {});
      continue;
    }

    for (const change of batch) {
      // Guard against a server that echoes the cursor row back: strictly
      // advancing means a malformed page can never loop forever.
      if (since !== undefined) {
        if (change.last_detected_at < since) continue;
        if (change.last_detected_at === since && change.id <= sinceId) continue;
      }
      yield change;
      since = change.last_detected_at;
      sinceId = change.id;
      if (aborted()) return;
    }

    // A full page means there is very likely more waiting: drain the backlog
    // immediately instead of sleeping a whole interval per page.
    if (batch.length === pageSize) continue;
    try {
      await sleep(intervalMs, signal);
    } catch {
      return; // aborted mid-wait
    }
  }
}

const AUTOMATIONS_PATH = "/api/triggers";
const PERSONAS_PATH = "/api/personas";

/**
 * Cloud automations — `client.cloud.automations`, the same verbs as the local
 * daemon's `client.automations`.
 *
 * On the wire the cloud calls this resource `triggers`; the product and every
 * SDK call it an AUTOMATION. Two shape differences from the daemon, both the
 * server's: the list route is `/all`, and `toggle` FLIPS the flag rather than
 * setting it — read `enabled` off the returned row.
 *
 * Scopes: `triggers:*`. An action of type `workflow` additionally needs
 * `workflows:execute`, because it arranges a workflow run.
 */
export class CloudAutomations {
  readonly #t: CloudTransport;
  constructor(transport: CloudTransport) {
    this.#t = transport;
  }

  /** Every automation on the account. */
  async list(params: CloudAutomationListParams = {}): Promise<CloudAutomation[]> {
    this.#t.requireKey("Listing cloud automations");
    return (await this.#t.send("GET", `${AUTOMATIONS_PATH}/all`, undefined, params)) as CloudAutomation[];
  }

  async create(body: CloudAutomationCreate): Promise<CloudAutomation> {
    this.#t.requireKey("Creating a cloud automation");
    return (await this.#t.send("POST", AUTOMATIONS_PATH, body)) as CloudAutomation;
  }

  async get(id: number): Promise<CloudAutomation> {
    this.#t.requireKey("Reading a cloud automation");
    return (await this.#t.send("GET", `${AUTOMATIONS_PATH}/${id}`)) as CloudAutomation;
  }

  /** Partial update — send only the fields you are changing. */
  async update(id: number, patch: Partial<CloudAutomationCreate>): Promise<CloudAutomation> {
    this.#t.requireKey("Updating a cloud automation");
    return (await this.#t.send("PATCH", `${AUTOMATIONS_PATH}/${id}`, patch)) as CloudAutomation;
  }

  async delete(id: number): Promise<void> {
    this.#t.requireKey("Deleting a cloud automation");
    await this.#t.send("DELETE", `${AUTOMATIONS_PATH}/${id}`);
  }

  /** FLIP the enabled flag and return the refreshed row. */
  async toggle(id: number): Promise<CloudAutomation> {
    this.#t.requireKey("Toggling a cloud automation");
    return (await this.#t.send("PATCH", `${AUTOMATIONS_PATH}/${id}/toggle`)) as CloudAutomation;
  }

  /** Fire it NOW (manual trigger), skipping its event. */
  async run(id: number, inputs?: Record<string, unknown>): Promise<unknown> {
    this.#t.requireKey("Running a cloud automation");
    return this.#t.send("POST", `${AUTOMATIONS_PATH}/${id}/run`, inputs);
  }

  /** Evaluate the rule against a sample event WITHOUT running its actions. */
  async test(id: number, body: Record<string, unknown>): Promise<unknown> {
    this.#t.requireKey("Testing a cloud automation");
    return this.#t.send("POST", `${AUTOMATIONS_PATH}/${id}/test`, body);
  }

  /** This automation's execution history. */
  async executions(id: number, opts: { limit?: number } = {}): Promise<unknown[]> {
    this.#t.requireKey("Reading cloud automation executions");
    return (await this.#t.send("GET", `${AUTOMATIONS_PATH}/${id}/executions`, undefined, opts)) as unknown[];
  }

  /** The automations wired to one monitor — the other half of `cloud.monitors`. */
  async forMonitor(monitorId: number, opts: { enabled_only?: boolean } = {}): Promise<CloudAutomation[]> {
    this.#t.requireKey("Reading a monitor's cloud automations");
    return (await this.#t.send(
      "GET",
      `${AUTOMATIONS_PATH}/target/${monitorId}`,
      undefined,
      opts,
    )) as CloudAutomation[];
  }
}

/**
 * Cloud personas — `client.cloud.personas`, the same verbs as the local daemon's
 * `client.personas`. Scopes: `personas:*`.
 *
 * Secret material is write-only end to end: it goes in on create/update and
 * reads back only as `has_password` / `has_totp_seed` / `has_proxy`. Use personas
 * only with sites and accounts you are authorized to access.
 */
export class CloudPersonas {
  readonly #t: CloudTransport;
  constructor(transport: CloudTransport) {
    this.#t = transport;
  }

  /** Every persona on the account. `domain` suggests by site. */
  async list(params: { domain?: string } = {}): Promise<CloudPersona[]> {
    this.#t.requireKey("Listing cloud personas");
    return (await this.#t.send("GET", PERSONAS_PATH, undefined, params)) as CloudPersona[];
  }

  async create(body: CloudPersonaCreate): Promise<CloudPersona> {
    this.#t.requireKey("Creating a cloud persona");
    return (await this.#t.send("POST", PERSONAS_PATH, body)) as CloudPersona;
  }

  async get(id: number): Promise<CloudPersona> {
    this.#t.requireKey("Reading a cloud persona");
    return (await this.#t.send("GET", `${PERSONAS_PATH}/${id}`)) as CloudPersona;
  }

  /** Partial update. A secret is replaced only when sent; omit it to keep the stored one. */
  async update(id: number, patch: Partial<CloudPersonaCreate>): Promise<CloudPersona> {
    this.#t.requireKey("Updating a cloud persona");
    return (await this.#t.send("PATCH", `${PERSONAS_PATH}/${id}`, patch)) as CloudPersona;
  }

  async delete(id: number): Promise<void> {
    this.#t.requireKey("Deleting a cloud persona");
    await this.#t.send("DELETE", `${PERSONAS_PATH}/${id}`);
  }

  /** Recent runs that acted as this persona. */
  async runs(id: number, opts: { limit?: number } = {}): Promise<unknown> {
    this.#t.requireKey("Reading cloud persona runs");
    return this.#t.send("GET", `${PERSONAS_PATH}/${id}/runs`, undefined, opts);
  }

  /** Exercise the configured 2FA path and report whether it produced a code. */
  async test2fa(id: number): Promise<unknown> {
    this.#t.requireKey("Testing a cloud persona's 2FA");
    return this.#t.send("POST", `${PERSONAS_PATH}/${id}/test-2fa`);
  }

  /**
   * Check a pasted seed is well-formed base32 — and, with `code`, that it
   * reproduces that code. The seed is never stored or logged by this call, so it
   * is the safe way to check one BEFORE committing it to a persona.
   */
  async validateTotp(
    totpSeed: string,
    opts: { code?: string; algorithm?: string; digits?: number; period?: number } = {},
  ): Promise<TotpValidation> {
    this.#t.requireKey("Validating a TOTP seed");
    const body: Record<string, unknown> = { totp_seed: totpSeed };
    if (opts.code !== undefined) body["code"] = opts.code;
    if (opts.algorithm !== undefined) body["algorithm"] = opts.algorithm;
    if (opts.digits !== undefined) body["digits"] = opts.digits;
    if (opts.period !== undefined) body["period"] = opts.period;
    return (await this.#t.send("POST", `${PERSONAS_PATH}/validate-totp`, body)) as TotpValidation;
  }
}

const BUILDS_PATH = "/api/v1/website-to-api";

/**
 * Website → API builds — `client.cloud.builds`, the REST twin of the MCP tool
 * `writ_website_to_api`.
 *
 * ASYNCHRONOUS for a reason: the tool works because the caller is a MODEL that
 * drives the browser turn by turn. A program cannot, so Writ's own agent loop
 * drives and this surface hands back a build id to poll.
 *
 * The server checks two cheap rungs before spending any AI — your own matching
 * workflows, then ready-made marketplace listings — so `status` may come back as
 * `existing_workflows` or `marketplace_candidates` with no build at all.
 *
 * Scopes: `workflows:write` to start, `workflows:read` to poll. A build spends
 * AI credits, so the key must have AI enabled.
 */
export class CloudBuilds {
  readonly #t: CloudTransport;
  constructor(transport: CloudTransport) {
    this.#t = transport;
  }

  /** Turn a website into a callable API — one call. */
  async start(url: string, goal: string, opts: CloudBuildOptions = {}): Promise<CloudBuild> {
    this.#t.requireKey("Building an API from a website");
    const body: Record<string, unknown> = { url, goal };
    for (const key of ["persona_id", "max_steps", "save_as"] as const) {
      if (opts[key] !== undefined) body[key] = opts[key];
    }
    if (opts.skip_existing) body["skip_existing"] = true;
    if (opts.skip_marketplace) body["skip_marketplace"] = true;
    return (await this.#t.send("POST", BUILDS_PATH, body)) as CloudBuild;
  }

  /** Poll a build. Terminal: `succeeded` / `failed` / `cancelled`. */
  async get(buildId: number): Promise<CloudBuild> {
    this.#t.requireKey("Reading a website-to-API build");
    return (await this.#t.send("GET", `${BUILDS_PATH}/${buildId}`)) as CloudBuild;
  }

  /**
   * {@link start}, then poll until the build reaches a terminal state.
   *
   * Returns the ladder answer unchanged when the server resolved it without
   * building — there is nothing to wait for. Rejects on timeout; the build keeps
   * going and `build_id` still addresses it.
   */
  async startAndWait(
    url: string,
    goal: string,
    opts: CloudBuildOptions & { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<CloudBuild> {
    const { timeoutMs = 900_000, pollIntervalMs = 5_000, ...startOpts } = opts;
    const started = await this.start(url, goal, startOpts);
    if (started.build_id === undefined) return started;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await this.get(started.build_id);
      if (TERMINAL_BUILD_STATUSES.has(current.status)) return current;
      if (Date.now() >= deadline) {
        throw new WritError(
          `website-to-API build ${started.build_id} did not finish within ${timeoutMs}ms. ` +
            "It is still running — poll cloud.builds.get(buildId).",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

const MONITORS_PATH = "/api/targets";

export class CloudApi {
  readonly #apiKey?: string;
  readonly #base: string;
  readonly #clientIdOverride?: string;
  #clientId?: string;
  // undefined = not yet loaded; "" = loaded, none issued to us yet.
  #deviceToken?: string;
  readonly #fetch: typeof fetch;
  readonly #retry: RetryPolicy;

  /** Cloud monitors — the same verbs as `client.monitors` on the local daemon. */
  readonly monitors: CloudMonitors;
  /** Cloud automations — the same verbs as `client.automations`. */
  readonly automations: CloudAutomations;
  /** Cloud personas — the same verbs as `client.personas`. */
  readonly personas: CloudPersonas;
  /** Website → API builds — the REST twin of writ_website_to_api. */
  readonly builds: CloudBuilds;

  constructor(opts: CloudOptions = {}) {
    const env: Record<string, string | undefined> =
      opts.env ?? (typeof process !== "undefined" ? process.env : {}) ?? {};
    this.#apiKey = opts.apiKey ?? env["WRIT_API_KEY"] ?? undefined;
    this.#base = (opts.cloudUrl ?? env["WRIT_CLOUD_URL"] ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
    this.#clientIdOverride = opts.clientId ?? env["WRIT_CLIENT_ID"] ?? undefined;
    this.#fetch = opts.fetch ?? fetch;
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...opts.retry, retryUnsafeMethods: true };
    const transport: CloudTransport = {
      send: (method, path, json, query) => this.#send(method, path, json, query),
      requireKey: (what) => this.#requireKey(what),
    };
    this.monitors = new CloudMonitors(transport);
    this.automations = new CloudAutomations(transport);
    this.personas = new CloudPersonas(transport);
    this.builds = new CloudBuilds(transport);
  }

  /** Throw before the network call when this verb needs a key we do not have. */
  #requireKey(what: string): void {
    if (this.#apiKey) return;
    throw new WritApiKeyRequiredError({
      status: 402,
      code: "api_key_required",
      message: `${what} needs an API key — set \`apiKey\` or WRIT_API_KEY. Without one, scrape, map and the bounded crawlKeyless() still work.`,
      body: null,
    });
  }

  /** The tier this client will use: `metered` when an API key is present, else `keyless`. */
  get tier(): CloudTier {
    return this.#apiKey ? "metered" : "keyless";
  }

  /** Scrape ONE page to clean markdown. Works on both tiers. */
  async scrape(url: string): Promise<ScrapeResult> {
    const path = this.#apiKey ? "/api/crawl/scrape" : "/v1/keyless/scrape";
    const raw = await this.#send("POST", path, { url });
    return normalizeScrape(raw as Record<string, unknown>, this.tier);
  }

  /** Map a site's URLs, ranked by an optional `search`. Works on both tiers. */
  async map(url: string, opts: { search?: string; limit?: number } = {}): Promise<MapResult> {
    const path = this.#apiKey ? "/api/crawl/map" : "/v1/keyless/map";
    const raw = await this.#send("POST", path, {
      url,
      search: opts.search ?? "",
      ...(opts.limit != null ? { limit: opts.limit } : {}),
    });
    return normalizeMap(raw as Record<string, unknown>, this.tier);
  }

  /**
   * Start a whole-site crawl. METERED ONLY — requires an API key; on the keyless tier this throws
   * {@link WritApiKeyRequiredError} before any network call (use {@link scrape}/{@link map} instead).
   */
  async crawl(body: CrawlStartBody): Promise<CrawlJob> {
    this.#requireKey("Whole-site crawl");
    return (await this.#send("POST", "/api/crawl", body)) as CrawlJob;
  }

  /** Poll a metered crawl's status (requires an API key). */
  async crawlStatus(id: number): Promise<CrawlJob> {
    this.#requireKey("Crawl status");
    return (await this.#send("GET", `/api/crawl/${id}`)) as CrawlJob;
  }

  /**
   * A bounded crawl with NO account — the free tier's version.
   *
   * Separate from {@link crawl} because the two return genuinely different
   * things: `crawl` queues a fleet job you poll, this fetches a few same-domain
   * pages in process and returns their markdown inline. Capped per request (see
   * `limits.page_cap`), one level deep, and every page spends the same daily
   * allowance as {@link scrape} — so the daily cap is the real ceiling.
   */
  async crawlKeyless(
    url: string,
    opts: { search?: string; limit?: number } = {},
  ): Promise<KeylessCrawlResult> {
    const body: Record<string, unknown> = { url };
    if (opts.search !== undefined) body["search"] = opts.search;
    if (opts.limit !== undefined) body["limit"] = opts.limit;
    return (await this.#send("POST", "/v1/keyless/crawl", body)) as KeylessCrawlResult;
  }

  /** Remaining keyless allowance for this install (keyless tier only; `null` when metered). */
  async quota(): Promise<KeylessQuota | null> {
    if (this.#apiKey) return null;
    const raw = await this.#send("GET", "/v1/keyless/quota");
    return normalizeQuota(raw as Record<string, unknown>);
  }

  // --- transport -----------------------------------------------------------

  async #send(
    method: CloudMethod,
    path: string,
    json?: unknown,
    query?: object,
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (this.#apiKey) headers["authorization"] = `Bearer ${this.#apiKey}`;
    else {
      headers[CLIENT_ID_HEADER] = await this.#resolveClientId();
      const token = await this.#resolveDeviceToken();
      if (token) headers[DEVICE_TOKEN_HEADER] = token;
    }
    if (json !== undefined) headers["content-type"] = "application/json";

    // One key per logical call, reused by every retry of it — that is what makes
    // repeating an unsafe method safe rather than duplicative.
    const policy: RetryPolicy = { ...this.#retry };
    if (!isSafeMethod(method)) {
      // Warm Web Crypto first: on Node 18 it is not a global, and without this
      // the key would come from the non-CSPRNG last resort in `retry.ts`.
      await warmWebCrypto();
      const key = newIdempotencyKey();
      if (key) headers["idempotency-key"] = key;
      else policy.retryUnsafeMethods = false;
    }

    const url = this.#base + path + queryString(query);
    const body = json !== undefined ? JSON.stringify(json) : undefined;

    let resp: Response;
    try {
      resp = await withRetry(policy, method, () => this.#fetch(url, { method, headers, body }));
    } catch (cause) {
      throw new WritConnectionError(`cloud request to ${path} failed`, { cause });
    }
    // Absorb BEFORE the error check: a 429 carries a minted token too, and
    // dropping it would leave a rate-limited caller anonymous forever.
    await this.#absorbDeviceToken(resp);
    const text = await resp.text();
    if (!resp.ok) throw cloudErrorFrom(resp.status, text);
    // 204 (delete) and any empty body decode to {} rather than throwing.
    return text ? (JSON.parse(text) as unknown) : {};
  }

  async #resolveClientId(): Promise<string> {
    if (this.#clientIdOverride) return this.#clientIdOverride;
    if (this.#clientId) return this.#clientId;
    this.#clientId = await loadOrMintClientId();
    return this.#clientId;
  }

  async #resolveDeviceToken(): Promise<string | undefined> {
    if (this.#deviceToken !== undefined) return this.#deviceToken || undefined;
    this.#deviceToken = (await loadDeviceToken()) ?? "";
    return this.#deviceToken || undefined;
  }

  async #absorbDeviceToken(resp: Response): Promise<void> {
    if (this.#apiKey) return;
    const issued = resp.headers.get(DEVICE_TOKEN_HEADER);
    if (issued && issued !== this.#deviceToken) {
      this.#deviceToken = issued;
      await storeDeviceToken(issued);
    }
  }
}

// --- query -------------------------------------------------------------------

/**
 * `?a=1&b=true` from a params object, skipping anything unset: `{ limit: undefined }`
 * must produce no query at all, not `?limit=` — FastAPI rejects the empty string
 * for a typed int.
 */
function queryString(query?: object): string {
  if (!query) return "";
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
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
  // Prefer the nested `detail` object, but fall back to the TOP level when
  // `detail` is a bare string. A plan denial sends the flat shape
  // {"detail": "<reason>", "code": …, "current": …, "limit": …}; reading only the
  // (string) detail black-holed every machine-readable field, so the code
  // degraded to `http_402` and the ceiling was lost entirely.
  const d: Record<string, unknown> =
    detail && typeof detail === "object"
      ? (detail as Record<string, unknown>)
      : body && typeof body === "object"
        ? (body as Record<string, unknown>)
        : {};
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
  if (status === 402) {
    // Two different 402s share this status. Tell them apart STRUCTURALLY rather
    // than by a code allowlist that would drift as the backend adds limits: a
    // plan denial always reports the ceiling it hit as a numeric `limit`, a
    // credits/wallet 402 never does.
    if (typeof d["limit"] === "number") {
      return new WritPlanLimitError({
        ...base,
        current: typeof d["current"] === "number" ? d["current"] : undefined,
        limit: d["limit"],
        upgradeHint: typeof d["upgrade_hint"] === "string" ? d["upgrade_hint"] : undefined,
      });
    }
    return new WritInsufficientCreditsError(base);
  }
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

/** Read the server-minted keyless subject from `~/.writ/device_token`, if issued. */
async function loadDeviceToken(): Promise<string | undefined> {
  const env = globalThis.process?.env?.["WRIT_DEVICE_TOKEN"];
  if (env) return env;
  try {
    const [os, fs, path] = await Promise.all([import("node:os"), import("node:fs"), import("node:path")]);
    const token = fs.readFileSync(path.join(os.homedir(), ".writ", "device_token"), "utf8").trim();
    return token || undefined;
  } catch {
    return undefined; // not yet issued, or no filesystem (browser/worker)
  }
}

/** Persist a freshly-issued token. Best-effort: a read-only home just means the
 *  next process starts over as an anonymous caller, which still works. */
async function storeDeviceToken(token: string): Promise<void> {
  try {
    const [os, fs, path] = await Promise.all([import("node:os"), import("node:fs"), import("node:path")]);
    const dir = path.join(os.homedir(), ".writ");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "device_token"), token, { mode: 0o600 });
  } catch {
    /* read-only fs or no filesystem — stay in-memory for this process */
  }
}

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
