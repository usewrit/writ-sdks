/**
 * `WritAgent` — the official TypeScript client for the Writ local agent
 * (`writ-agentd`) loopback API. Resource groups are namespaces
 * (`client.workflows.list()`, `client.runs.get(id)`, …) per DESIGN.md §7.
 */

import { HttpClient } from "./http.js";
import type { HttpClientOptions, QueryParams } from "./http.js";
import { CloudApi } from "./cloud.js";
import { WritConnectionError, WritError, WritRunTimeoutError } from "./errors.js";
import { iterateSseFrames } from "./sse.js";
import { isTerminalEvent, normalizePage } from "./types.js";
import type {
  AgentStatus,
  ApiKey,
  ApiKeyCreated,
  Automation,
  AutomationCreate,
  AutomationRunResult,
  AutomationUpdate,
  CancelResult,
  CrawlCancelResult,
  CrawlJob,
  CrawlList,
  CrawlStartBody,
  DataDeleteBody,
  DataDeleteResult,
  DataQueryParams,
  DataWorkflows,
  DatasetFormat,
  DatasetList,
  DatasetSearchResult,
  DatasetTextFormat,
  DryRunReport,
  Extractor,
  ExtractorCreate,
  ExtractorUpdate,
  FileFromDataBody,
  FileMeta,
  FileUploadOptions,
  Health,
  Monitor,
  MonitorCreate,
  MonitorHistory,
  MonitorUpdate,
  Page,
  Persona,
  PersonaRun,
  PersonaWrite,
  RecentChange,
  RunAndWaitOptions,
  RunCompleted,
  RunData,
  RunEvent,
  RunFeedItem,
  RunListParams,
  RunOptions,
  RunResults,
  RunStarted,
  SecretListParams,
  SecretMeta,
  SecretSetOptions,
  Selector,
  SelectorCreate,
  SelectorUpdate,
  Test2faResult,
  ValidateTotpBody,
  ValidateTotpResult,
  VaultStatus,
  Workflow,
  WorkflowCreate,
  WorkflowListParams,
  WorkflowSession,
  WorkflowUpdate,
  WsTicket,
  WsTicketRoute,
} from "./types.js";

/** Constructor options for {@link WritAgent} (DESIGN.md §3/§4). */
export interface WritAgentOptions extends HttpClientOptions {
  /**
   * Metered Writ Cloud API key (`wt_`/`wlk_`) for the tiered {@link CloudApi} surface
   * (`client.cloud.scrape/map/crawl`). Falls back to `WRIT_API_KEY`; absent → the keyless tier.
   * Unrelated to the local-daemon `token` used by every other resource.
   */
  readonly apiKey?: string;
  /** Cloud base URL for {@link CloudApi}. Falls back to `WRIT_CLOUD_URL`, then `https://api.usewrit.app`. */
  readonly cloudUrl?: string;
  /** Override the keyless device/client id (else read/mint `~/.writ/client_id`). */
  readonly clientId?: string;
}

const DEFAULT_WAIT_TIMEOUT_MS = 600_000; // 600 s (DESIGN.md §8)
const DEFAULT_POLL_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

export class AgentApi {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v1/agent` — lightweight daemon status. */
  status(): Promise<AgentStatus> {
    return this.http.json("GET", "/v1/agent");
  }

  /** `GET /v1/health` — deep health probe. */
  health(): Promise<Health> {
    return this.http.json("GET", "/v1/health");
  }
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

export class RunsApi {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v1/runs` — enriched run feed, newest first. */
  async list(params?: RunListParams): Promise<Page<RunFeedItem>> {
    const payload = await this.http.json<unknown>("GET", "/v1/runs", {
      query: params as QueryParams,
    });
    return normalizePage<RunFeedItem>(payload);
  }

  /** `GET /v1/runs/:id` — one run (numeric ROW id, see {@link runRowId}). */
  get(runId: number): Promise<RunFeedItem> {
    return this.http.json("GET", `/v1/runs/${runId}`);
  }

  /** `GET /v1/runs/:id/results` — the run's raw result payload. */
  results(runId: number): Promise<RunResults> {
    return this.http.json("GET", `/v1/runs/${runId}/results`);
  }

  /** `GET /v1/runs/:id/data` — the run's extracted data (JSON lane). */
  data(runId: number): Promise<RunData> {
    return this.http.json("GET", `/v1/runs/${runId}/data`);
  }

  /** `GET /v1/runs/:id/data?format=csv` — the run's extracted data as raw CSV text. */
  dataCsv(runId: number): Promise<string> {
    return this.http.text("GET", `/v1/runs/${runId}/data`, { query: { format: "csv" } });
  }

  /**
   * `POST /v1/runs/:id/cancel` — cancel a live run by row id. Returns a
   * result for BOTH answers: 202 `{run_id, status:"cancel_requested"}` and
   * 409 `{run_id, status:"not_running", run_status?}` — the 409 is a valid
   * answer (the run already finished), never an exception.
   */
  cancel(runId: number): Promise<CancelResult> {
    return this.http.json("POST", `/v1/runs/${runId}/cancel`, { allowStatuses: [409] });
  }

  /**
   * `GET /v1/runs/:id/events` — live SSE stream of the run's lifecycle,
   * yielded as typed {@link RunEvent}s. The iterator completes after the
   * terminal `finished`/`error` event (a run that already finished yields
   * exactly one terminal event). Keep-alive comment frames are ignored.
   * No reconnect logic — a dropped stream surfaces as a
   * {@link WritConnectionError} (the `runAndWait` fallback handles it).
   */
  async *events(
    runId: number,
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterableIterator<RunEvent> {
    const res = await this.http.stream("GET", `/v1/runs/${runId}/events`, {
      signal: opts.signal,
    });
    if (!res.body) {
      throw new WritConnectionError(`SSE response for run ${runId} has no body`);
    }
    for await (const frame of iterateSseFrames(res.body)) {
      let event: RunEvent;
      try {
        event = JSON.parse(frame.data) as RunEvent;
      } catch {
        continue; // not a JSON payload — skip defensively
      }
      if (typeof event !== "object" || event === null || typeof event.event !== "string") {
        continue;
      }
      yield event;
      if (isTerminalEvent(event)) return;
    }
  }
}

// ---------------------------------------------------------------------------
// workflows
// ---------------------------------------------------------------------------

export class WorkflowsApi {
  constructor(
    private readonly http: HttpClient,
    private readonly runs: RunsApi,
  ) {}

  /** `GET /v1/workflows` — newest first. */
  async list(params?: WorkflowListParams): Promise<Page<Workflow>> {
    const payload = await this.http.json<unknown>("GET", "/v1/workflows", {
      query: params as QueryParams,
    });
    return normalizePage<Workflow>(payload);
  }

  /** `POST /v1/workflows` — create a workflow (`name` required). */
  create(body: WorkflowCreate): Promise<Workflow> {
    return this.http.json("POST", "/v1/workflows", { json: body });
  }

  /** `GET /v1/workflows/:id`. */
  get(id: number): Promise<Workflow> {
    return this.http.json("GET", `/v1/workflows/${id}`);
  }

  /** `PATCH /v1/workflows/:id` — sparse update; absent fields untouched. */
  update(id: number, patch: WorkflowUpdate): Promise<Workflow> {
    return this.http.json("PATCH", `/v1/workflows/${id}`, { json: patch });
  }

  /** `DELETE /v1/workflows/:id` — HARD delete (runs cascade away). */
  delete(id: number): Promise<{ id: number; deleted: boolean }> {
    return this.http.json("DELETE", `/v1/workflows/${id}`);
  }

  /**
   * `POST /v1/workflows/:id/run` — run the workflow.
   *
   * Default: starts it and returns 202 `{run_id, status:"running"}` for you to
   * observe via `runs.events(runId)` / `runs.get(runId)`.
   *
   * With `wait: true` the daemon blocks until the run is terminal and you get a
   * {@link RunCompleted} back in the same request — no SSE, no poll loop. A run
   * that FAILS still resolves (check `status`); only an expired budget rejects,
   * as a {@link WritRunTimeoutError} carrying the still-valid `run_id`.
   *
   * With `dryRun: true` the daemon answers 200 with a validate-only
   * {@link DryRunReport} instead (nothing is executed).
   */
  run(id: number, opts: RunOptions & { wait: true; dryRun?: false }): Promise<RunCompleted>;
  run(id: number, opts?: RunOptions & { dryRun?: false; wait?: false }): Promise<RunStarted>;
  run(id: number, opts: RunOptions & { dryRun: true }): Promise<DryRunReport>;
  async run(
    id: number,
    opts: RunOptions = {},
  ): Promise<RunStarted | RunCompleted | DryRunReport> {
    const body: Record<string, unknown> = {};
    if (opts.inputs !== undefined) body["inputs"] = opts.inputs;
    if (opts.personaId !== undefined) body["persona_id"] = opts.personaId;
    if (opts.dryRun !== undefined) body["dry_run"] = opts.dryRun;
    if (opts.files !== undefined) body["files"] = opts.files;

    const query: QueryParams = {};
    if (opts.wait) query["wait"] = true;
    if (opts.timeout !== undefined) query["timeout"] = opts.timeout;

    if (!opts.wait) {
      return this.http.json("POST", `/v1/workflows/${id}/run`, { json: body, query });
    }

    // 504 is a documented, RECOVERABLE outcome of waiting — allow it through the
    // HTTP layer so we can re-throw it with the run id attached instead of a bare
    // "gateway timeout" the caller cannot act on.
    const res = await this.http.json<RunCompleted & { status_url?: string }>(
      "POST",
      `/v1/workflows/${id}/run`,
      { json: body, query, allowStatuses: [504] },
    );
    if ((res as { done?: boolean }).done === false) {
      throw new WritRunTimeoutError({
        status: 504,
        code: "run_timeout",
        message:
          `run ${res.run_id} did not finish within the requested budget and is STILL RUNNING — ` +
          `observe it with runs.events(${res.run_id}) or runs.get(${res.run_id}); ` +
          `do not retry, that would start a second run`,
        body: res,
        runId: res.run_id,
      });
    }
    return res;
  }

  /**
   * `POST /v1/workflows/:id/cancel` — cancel the workflow's newest live run.
   * Both answers are returned as a result (202 `cancel_requested`, 409
   * `not_running`) — the 409 is not an exception.
   */
  cancel(id: number): Promise<CancelResult> {
    return this.http.json("POST", `/v1/workflows/${id}/cancel`, { allowStatuses: [409] });
  }

  /** `GET /v1/workflows/:id/session` — browserless-HTTP-lane session status. */
  session(id: number): Promise<WorkflowSession> {
    return this.http.json("GET", `/v1/workflows/${id}/session`);
  }

  /** `DELETE /v1/workflows/:id/session` — drop the persisted session (next run logs in fresh). */
  clearSession(id: number): Promise<{ cleared: boolean }> {
    return this.http.json("DELETE", `/v1/workflows/${id}/session`);
  }

  /**
   * Run a workflow and wait for it to finish (DESIGN.md §8):
   *
   * 1. `run(id, …)` → `run_id` (`dryRun` is rejected here).
   * 2. Subscribe to `runs.events(run_id)` and resolve on `finished`/`error`.
   * 3. If the SSE stream fails or drops pre-terminal, fall back to polling
   *    `runs.get(run_id)` every second until `status != "running"`.
   * 4. Overall deadline `waitTimeout` (default 600 s). On expiry a
   *    {@link WritError} is thrown — **the run itself is NOT cancelled**; use
   *    `runs.cancel(runId)` if you want it stopped.
   *
   * Returns the final {@link RunFeedItem}; with `includeResults: true` the
   * run's `runs.results()` payload is attached as `results`.
   */
  async runAndWait(
    id: number,
    opts: RunAndWaitOptions = {},
  ): Promise<RunFeedItem & { results?: RunResults }> {
    if ((opts as { dryRun?: boolean }).dryRun) {
      throw new WritError(
        "runAndWait does not accept dryRun — call workflows.run(id, { dryRun: true }) instead",
      );
    }

    const runOpts: RunOptions = {};
    if (opts.inputs !== undefined) runOpts.inputs = opts.inputs;
    if (opts.personaId !== undefined) runOpts.personaId = opts.personaId;
    if (opts.files !== undefined) runOpts.files = opts.files;
    // Explicitly NOT the server-side wait: runAndWait owns the waiting itself (SSE +
    // poll fallback, its own longer deadline, live onEvent callbacks).
    const started = await this.run(
      id,
      runOpts as RunOptions & { dryRun?: false; wait?: false },
    );
    const runId = started.run_id;

    const waitTimeout = opts.waitTimeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollInterval = opts.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + waitTimeout;
    const timeoutError = () =>
      new WritError(
        `run ${runId} did not finish within ${waitTimeout} ms — the run was NOT cancelled ` +
          `(use runs.cancel(${runId}) to stop it)`,
      );

    // Phase 1: SSE. The deadline aborts the stream; any other stream failure
    // falls through to the polling lane.
    let sawTerminal = false;
    const ctrl = new AbortController();
    let deadlineHit = false;
    const timer = setTimeout(() => {
      deadlineHit = true;
      ctrl.abort();
    }, waitTimeout);
    try {
      for await (const event of this.runs.events(runId, { signal: ctrl.signal })) {
        opts.onEvent?.(event);
        if (isTerminalEvent(event)) {
          sawTerminal = true;
          break;
        }
      }
    } catch (err) {
      if (deadlineHit) throw timeoutError();
      // SSE connect failure / mid-stream drop → polling fallback below.
    } finally {
      clearTimeout(timer);
    }
    if (deadlineHit && !sawTerminal) throw timeoutError();

    // Phase 2: polling fallback (only when SSE did not deliver a terminal event).
    if (!sawTerminal) {
      for (;;) {
        const run = await this.runs.get(runId);
        if (run.status !== "running") break;
        if (Date.now() >= deadline) throw timeoutError();
        await sleep(Math.min(pollInterval, Math.max(1, deadline - Date.now())));
      }
    }

    // Fetch the final feed item once after the terminal event.
    const finalRun = await this.runs.get(runId);
    if (opts.includeResults) {
      const results = await this.runs.results(runId);
      return { ...finalRun, results };
    }
    return finalRun;
  }
}

// ---------------------------------------------------------------------------
// monitors
// ---------------------------------------------------------------------------

export class MonitorsApi {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v1/monitors` — bare-array envelope, normalized to a Page. */
  async list(params?: {
    limit?: number;
    check_type?: string;
    [key: string]: string | number | boolean | undefined;
  }): Promise<Page<Monitor>> {
    const payload = await this.http.json<unknown>("GET", "/v1/monitors", {
      query: params as QueryParams,
    });
    return normalizePage<Monitor>(payload);
  }

  /** `POST /v1/monitors` — requires a non-empty `url`. A 409 `device_capacity` is a normal WritApiError. */
  create(body: MonitorCreate): Promise<Monitor> {
    return this.http.json("POST", "/v1/monitors", { json: body });
  }

  /** `GET /v1/monitors/:id` — enriched with live check state. */
  get(id: number): Promise<Monitor> {
    return this.http.json("GET", `/v1/monitors/${id}`);
  }

  /** `PATCH /v1/monitors/:id`. */
  update(id: number, patch: MonitorUpdate): Promise<Monitor> {
    return this.http.json("PATCH", `/v1/monitors/${id}`, { json: patch });
  }

  /** `DELETE /v1/monitors/:id` — cascades to selectors/state/changes. */
  delete(id: number): Promise<{ deleted: boolean; id: number }> {
    return this.http.json("DELETE", `/v1/monitors/${id}`);
  }

  /** `POST /v1/monitors/:id/run` — run the check NOW; returns the check outcome. */
  run(id: number): Promise<unknown> {
    return this.http.json("POST", `/v1/monitors/${id}/run`, { json: {} });
  }

  /** `GET /v1/monitors/:id/changes` — paginated change + uptime history. */
  changes(id: number, params?: { limit?: number; offset?: number }): Promise<MonitorHistory> {
    return this.http.json("GET", `/v1/monitors/${id}/changes`, {
      query: params as QueryParams,
    });
  }

  /** `GET /v1/monitors/capacity` — device check-capacity meter. */
  capacity(): Promise<unknown> {
    return this.http.json("GET", "/v1/monitors/capacity");
  }

  /** `GET /v1/changes/recent` — global recent-changes feed across all monitors. */
  async recentChanges(params?: { limit?: number }): Promise<Page<RecentChange>> {
    const payload = await this.http.json<unknown>("GET", "/v1/changes/recent", {
      query: params as QueryParams,
    });
    return normalizePage<RecentChange>(payload);
  }
}

// ---------------------------------------------------------------------------
// selectors (nested under monitors)
// ---------------------------------------------------------------------------

export class SelectorsApi {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v1/monitors/:id/selectors`. */
  async list(monitorId: number, params?: { enabled_only?: boolean }): Promise<Page<Selector>> {
    const payload = await this.http.json<unknown>("GET", `/v1/monitors/${monitorId}/selectors`, {
      query: params as QueryParams,
    });
    return normalizePage<Selector>(payload);
  }

  /** `POST /v1/monitors/:id/selectors` — requires a non-empty `selector`. */
  create(monitorId: number, body: SelectorCreate): Promise<Selector> {
    return this.http.json("POST", `/v1/monitors/${monitorId}/selectors`, { json: body });
  }

  /** `GET /v1/monitors/:id/selectors/:sid`. */
  get(monitorId: number, selectorId: number): Promise<Selector> {
    return this.http.json("GET", `/v1/monitors/${monitorId}/selectors/${selectorId}`);
  }

  /** `PATCH /v1/monitors/:id/selectors/:sid`. */
  update(monitorId: number, selectorId: number, patch: SelectorUpdate): Promise<Selector> {
    return this.http.json("PATCH", `/v1/monitors/${monitorId}/selectors/${selectorId}`, {
      json: patch,
    });
  }

  /** `DELETE /v1/monitors/:id/selectors/:sid` (cascades to its extractors). */
  delete(
    monitorId: number,
    selectorId: number,
  ): Promise<{ deleted: boolean; selector_id: number }> {
    return this.http.json("DELETE", `/v1/monitors/${monitorId}/selectors/${selectorId}`);
  }

  /** `POST …/toggle` — flip `enabled`. */
  toggle(monitorId: number, selectorId: number): Promise<{ selector_id: number; enabled: boolean }> {
    return this.http.json("POST", `/v1/monitors/${monitorId}/selectors/${selectorId}/toggle`);
  }

  /** `POST …/test` — live one-off fetch reporting what the selector resolves to. */
  test(monitorId: number, selectorId: number): Promise<unknown> {
    return this.http.json("POST", `/v1/monitors/${monitorId}/selectors/${selectorId}/test`);
  }

  /** `POST …/set-baseline` — capture this selector's baseline from a fresh fetch. */
  setBaseline(monitorId: number, selectorId: number): Promise<unknown> {
    return this.http.json("POST", `/v1/monitors/${monitorId}/selectors/${selectorId}/set-baseline`);
  }

  /** `POST …/clear-baseline` — drop the stored baseline (next check re-seeds). */
  clearBaseline(
    monitorId: number,
    selectorId: number,
  ): Promise<{ selector_id: number; cleared: boolean }> {
    return this.http.json(
      "POST",
      `/v1/monitors/${monitorId}/selectors/${selectorId}/clear-baseline`,
    );
  }
}

// ---------------------------------------------------------------------------
// extractors
// ---------------------------------------------------------------------------

export class ExtractorsApi {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v1/selectors/:sid/extractors`. */
  async list(selectorId: number, params?: { enabled_only?: boolean }): Promise<Page<Extractor>> {
    const payload = await this.http.json<unknown>("GET", `/v1/selectors/${selectorId}/extractors`, {
      query: params as QueryParams,
    });
    return normalizePage<Extractor>(payload);
  }

  /** `POST /v1/extractors` — requires `target_selector_id` + `output_name`. */
  create(body: ExtractorCreate): Promise<Extractor> {
    return this.http.json("POST", "/v1/extractors", { json: body });
  }

  /** `GET /v1/extractors/:id`. */
  get(extractorId: number): Promise<Extractor> {
    return this.http.json("GET", `/v1/extractors/${extractorId}`);
  }

  /** `PATCH /v1/extractors/:id`. */
  update(extractorId: number, patch: ExtractorUpdate): Promise<Extractor> {
    return this.http.json("PATCH", `/v1/extractors/${extractorId}`, { json: patch });
  }

  /** `DELETE /v1/extractors/:id`. */
  delete(extractorId: number): Promise<unknown> {
    return this.http.json("DELETE", `/v1/extractors/${extractorId}`);
  }

  /** `PATCH /v1/extractors/:id/toggle` — flip `enabled`. */
  toggle(extractorId: number): Promise<unknown> {
    return this.http.json("PATCH", `/v1/extractors/${extractorId}/toggle`);
  }

  /** `POST /v1/extractors/:id/test` — run the saved extractor over caller-supplied content. */
  test(extractorId: number, body: { content: string; content_type?: string }): Promise<unknown> {
    return this.http.json("POST", `/v1/extractors/${extractorId}/test`, { json: body });
  }
}

// ---------------------------------------------------------------------------
// automations
// ---------------------------------------------------------------------------

export class AutomationsApi {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v1/automations` — bare-array envelope, normalized to a Page. */
  async list(params?: { limit?: number }): Promise<Page<Automation>> {
    const payload = await this.http.json<unknown>("GET", "/v1/automations", {
      query: params as QueryParams,
    });
    return normalizePage<Automation>(payload);
  }

  /** `POST /v1/automations` — requires a non-empty `name`. */
  create(body: AutomationCreate): Promise<Automation> {
    return this.http.json("POST", "/v1/automations", { json: body });
  }

  /** `GET /v1/automations/:id`. */
  get(id: number): Promise<Automation> {
    return this.http.json("GET", `/v1/automations/${id}`);
  }

  /** `PATCH /v1/automations/:id`. */
  update(id: number, patch: AutomationUpdate): Promise<Automation> {
    return this.http.json("PATCH", `/v1/automations/${id}`, { json: patch });
  }

  /** `DELETE /v1/automations/:id`. */
  delete(id: number): Promise<{ deleted: boolean; id: number }> {
    return this.http.json("DELETE", `/v1/automations/${id}`);
  }

  /** `POST /v1/automations/:id/enable` — set `enabled` (default true). */
  enable(id: number, enabled = true): Promise<Automation> {
    return this.http.json("POST", `/v1/automations/${id}/enable`, { json: { enabled } });
  }

  /** `POST /v1/automations/:id/run` — fire the automation now (manual trigger). */
  run(id: number, inputs?: Record<string, unknown>): Promise<AutomationRunResult> {
    return this.http.json("POST", `/v1/automations/${id}/run`, {
      json: inputs !== undefined ? { inputs } : {},
    });
  }
}

// ---------------------------------------------------------------------------
// personas
// ---------------------------------------------------------------------------

export class PersonasApi {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v1/personas` — optionally filtered by `?domain=` (suffix semantics). */
  async list(params?: {
    limit?: number;
    domain?: string;
    [key: string]: string | number | boolean | undefined;
  }): Promise<Page<Persona>> {
    const payload = await this.http.json<unknown>("GET", "/v1/personas", {
      query: params as QueryParams,
    });
    return normalizePage<Persona>(payload);
  }

  /** `POST /v1/personas` — plaintext secrets are sealed daemon-side, never echoed. */
  create(body: PersonaWrite & { name: string }): Promise<Persona> {
    return this.http.json("POST", "/v1/personas", { json: body });
  }

  /** `GET /v1/personas/:id`. */
  get(id: number): Promise<Persona> {
    return this.http.json("GET", `/v1/personas/${id}`);
  }

  /** `PATCH /v1/personas/:id` — secrets replaced only when explicitly provided. */
  update(id: number, patch: PersonaWrite): Promise<Persona> {
    return this.http.json("PATCH", `/v1/personas/${id}`, { json: patch });
  }

  /** `DELETE /v1/personas/:id`. */
  delete(id: number): Promise<{ id: number; deleted: boolean }> {
    return this.http.json("DELETE", `/v1/personas/${id}`);
  }

  /** `GET /v1/personas/:id/runs` — recent runs that acted as this persona. */
  async runs(id: number, params?: { limit?: number }): Promise<Page<PersonaRun>> {
    const payload = await this.http.json<unknown>("GET", `/v1/personas/${id}/runs`, {
      query: params as QueryParams,
    });
    return normalizePage<PersonaRun>(payload);
  }

  /** `POST /v1/personas/validate-totp` — seed/code check; nothing is stored. */
  validateTotp(body: ValidateTotpBody): Promise<ValidateTotpResult> {
    return this.http.json("POST", "/v1/personas/validate-totp", { json: body });
  }

  /** `POST /v1/personas/:id/test-2fa` — mint-smoke-test (never returns the code). */
  test2fa(id: number): Promise<Test2faResult> {
    return this.http.json("POST", `/v1/personas/${id}/test-2fa`);
  }
}

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

export class SecretsApi {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v1/secrets` — metadata only; ciphertext/values are never returned. */
  async list(params?: SecretListParams): Promise<Page<SecretMeta>> {
    const payload = await this.http.json<unknown>("GET", "/v1/secrets", {
      query: params as QueryParams,
    });
    return normalizePage<SecretMeta>(payload);
  }

  /**
   * `POST /v1/secrets` — create a secret. A plain value:
   * `secrets.set("api_key", "sk-…")`. A credential pair:
   * `secrets.set("gh_login", null, { username, password })`. A card:
   * `secrets.set("visa", null, { card: { number, expiry } })`.
   * The plaintext is sealed daemon-side; responses carry metadata only.
   */
  set(name: string, value: string | null, opts: SecretSetOptions = {}): Promise<SecretMeta> {
    const body: Record<string, unknown> = { name, ...opts };
    if (value !== null && value !== undefined) body["value"] = value;
    return this.http.json("POST", "/v1/secrets", { json: body });
  }

  /** `GET /v1/secrets/:key` — METADATA only, never the value. */
  get(key: string): Promise<SecretMeta> {
    return this.http.json("GET", `/v1/secrets/${encodeURIComponent(key)}`);
  }

  /** `DELETE /v1/secrets/:key`. */
  delete(key: string): Promise<{ key: string; deleted: boolean }> {
    return this.http.json("DELETE", `/v1/secrets/${encodeURIComponent(key)}`);
  }
}

// ---------------------------------------------------------------------------
// vault
// ---------------------------------------------------------------------------

export class VaultApi {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v1/vault/status` — `{enabled, locked, idle_timeout_secs}`. */
  status(): Promise<VaultStatus> {
    return this.http.json("GET", "/v1/vault/status");
  }

  /** `POST /v1/vault/lock` — relock now. Idempotent. */
  lock(): Promise<{ ok: boolean }> {
    return this.http.json("POST", "/v1/vault/lock");
  }

  /** `POST /v1/vault/unlock` — unlock with the passphrase (401 on mismatch). */
  unlock(body: { passphrase: string }): Promise<{ ok: boolean }> {
    return this.http.json("POST", "/v1/vault/unlock", { json: body });
  }
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

export class FilesApi {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v1/files` — live (not soft-deleted) file handles. */
  async list(params?: { limit?: number; source?: string }): Promise<Page<FileMeta>> {
    const payload = await this.http.json<unknown>("GET", "/v1/files", {
      query: params as QueryParams,
    });
    return normalizePage<FileMeta>(payload);
  }

  /**
   * `POST /v1/files` — multipart upload. Accepts a `Blob`, `Uint8Array`,
   * `ArrayBuffer` or `string`; bytes are encrypted at rest by the daemon.
   */
  upload(
    content: Blob | Uint8Array | ArrayBuffer | string,
    opts: FileUploadOptions = {},
  ): Promise<FileMeta> {
    const form = new FormData();
    const blob =
      content instanceof Blob
        ? content
        : new Blob([content], { type: opts.contentType ?? "application/octet-stream" });
    form.append("file", blob, opts.filename ?? "upload.bin");
    if (opts.source) form.append("source", opts.source);
    return this.http.json("POST", "/v1/files", { form });
  }

  /** `POST /v1/files/from-data` — export a workflow's extracted data into a file handle. */
  fromData(body: FileFromDataBody): Promise<FileMeta> {
    return this.http.json("POST", "/v1/files/from-data", { json: body });
  }

  /** `GET /v1/files/:id` — one file's metadata. */
  get(id: string): Promise<FileMeta> {
    return this.http.json("GET", `/v1/files/${encodeURIComponent(id)}`);
  }

  /** `DELETE /v1/files/:id` — soft-delete the handle. */
  delete(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.http.json("DELETE", `/v1/files/${encodeURIComponent(id)}`);
  }

  /** `GET /v1/files/:id/content` — decrypted raw bytes. */
  content(id: string): Promise<Uint8Array> {
    return this.http.bytes("GET", `/v1/files/${encodeURIComponent(id)}/content`);
  }
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

export class DataApi {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v1/data` — the Data-explorer workflow picker (`{workflows: [...]}`). */
  query(params?: DataQueryParams): Promise<DataWorkflows> {
    return this.http.json("GET", "/v1/data", { query: params as QueryParams });
  }

  /**
   * `GET /v1/workflows/:id/data` — the aggregated extracted-data table
   * (columns + a paginated page of rows). Params (`view`, `search`, `sort`,
   * `limit`, `offset`, …) pass through as given.
   */
  workflowData(id: number, params?: DataQueryParams): Promise<unknown> {
    return this.http.json("GET", `/v1/workflows/${id}/data`, { query: params as QueryParams });
  }

  /** `DELETE /v1/workflows/:id/data` — delete specific extracted records. */
  deleteWorkflowData(id: number, body: DataDeleteBody = {}): Promise<DataDeleteResult> {
    return this.http.json("DELETE", `/v1/workflows/${id}/data`, { json: body });
  }

  /** `GET /v1/workflows/:id/data/facets` — per-column facets for smart filters. */
  facets(id: number, params?: DataQueryParams): Promise<unknown> {
    return this.http.json("GET", `/v1/workflows/${id}/data/facets`, {
      query: params as QueryParams,
    });
  }

  /**
   * `GET /v1/workflows/:id/data/export` — the full (filtered, un-paginated)
   * table as raw text: CSV by default, JSON with `{format: "json"}`.
   */
  export(id: number, params?: DataQueryParams): Promise<string> {
    return this.http.text("GET", `/v1/workflows/${id}/data/export`, {
      query: params as QueryParams,
    });
  }

  /** `GET /v1/workflows/:id/data/runs` — the data-bearing run index (lineage). */
  dataRuns(id: number, params?: DataQueryParams): Promise<unknown> {
    return this.http.json("GET", `/v1/workflows/${id}/data/runs`, {
      query: params as QueryParams,
    });
  }
}

// ---------------------------------------------------------------------------
// crawl (the "Dragnet" whole-site crawl)
// ---------------------------------------------------------------------------

export class CrawlApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * `GET /v1/crawl` — newest-first crawls. NOT a Page: the daemon returns
   * `{crawls: [...]}` (mirrors `data.query`), exposed as-is.
   */
  list(params?: { limit?: number }): Promise<CrawlList> {
    return this.http.json("GET", "/v1/crawl", { query: params as QueryParams });
  }

  /**
   * `POST /v1/crawl` — start a whole-site crawl (`url` required; empty → 400).
   * Returns the queued crawl view (with `workflow_id`/`data_workflow_id` set);
   * extracted pages aggregate under that synthetic workflow, read back via the
   * Data API (`data.workflowData(data_workflow_id)`).
   */
  start(body: CrawlStartBody): Promise<CrawlJob> {
    return this.http.json("POST", "/v1/crawl", { json: body });
  }

  /** `GET /v1/crawl/:id` — one crawl's live status view (404 if missing). */
  get(id: number): Promise<CrawlJob> {
    return this.http.json("GET", `/v1/crawl/${id}`);
  }

  /**
   * `POST /v1/crawl/:id/cancel` — request cancellation (404 if missing). Always
   * returns the refreshed view plus `cancel_requested_now` (`true` iff this call
   * flipped it to `stopping`) — never a 409.
   */
  cancel(id: number): Promise<CrawlCancelResult> {
    return this.http.json("POST", `/v1/crawl/${id}/cancel`);
  }
}

// ---------------------------------------------------------------------------
// datasets (unified crawl + workflow data catalog)
// ---------------------------------------------------------------------------

export class DatasetsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * `GET /v1/datasets` — the unified dataset catalog. NOT a Page: the daemon
   * returns `{datasets: [...]}` (mirrors `data.query`), exposed as-is. Each
   * entry spans both crawl and workflow origins (`source_type`).
   */
  list(): Promise<DatasetList> {
    return this.http.json("GET", "/v1/datasets");
  }

  /** `GET /v1/datasets/:id` — one dataset's metadata + schema (columns/facets). */
  get(id: number): Promise<unknown> {
    return this.http.json("GET", `/v1/datasets/${id}`);
  }

  /**
   * `GET /v1/datasets/:id/records` — the aggregated records table (columns + a
   * paginated page of records). Params (`q`, `filter`, `filters`, `sort_by`,
   * `sort_dir`, `limit`, `offset`, `include_inputs`, `collection`) pass through.
   *
   * `format` picks the output: the default `json` resolves to the envelope; any
   * other format resolves to the rendered TEXT (see {@link DatasetFormat}). The
   * overloads below make the return type follow the format you ask for.
   */
  records(id: number, params?: DataQueryParams & { format?: "json" }): Promise<unknown>;
  records(
    id: number,
    params: DataQueryParams & { format: DatasetTextFormat },
  ): Promise<string>;
  records(id: number, params?: DataQueryParams): Promise<unknown> {
    return this.readDataset(`/v1/datasets/${id}/records`, params);
  }

  /**
   * `GET /v1/datasets/:id/export` — the full (filtered, un-paginated) records as
   * raw text. `format`: `csv` (default), `json`, `markdown`, or `html`.
   * markdown/html are content-aware — a crawl's pages export as readable
   * documents, structured data as a table.
   */
  export(id: number, params?: DataQueryParams & { format?: DatasetFormat }): Promise<string> {
    return this.http.text("GET", `/v1/datasets/${id}/export`, {
      query: params as QueryParams,
    });
  }

  /**
   * Shared read: a non-json `format` returns rendered TEXT, so it must NOT go
   * through the JSON parser. One place to make that call, since records/search/
   * searchOne all share the rule.
   */
  private readDataset(path: string, params?: DataQueryParams): Promise<unknown> {
    const fmt = params?.format;
    const query = params as QueryParams;
    return fmt && fmt !== "json"
      ? this.http.text("GET", path, { query })
      : this.http.json("GET", path, { query });
  }

  /**
   * `GET /v1/datasets/search` — GLOBAL full-text search across every dataset.
   * Returns matched runs (with an optional `highlight` snippet) ordered by
   * relevance. `limit`/`offset` paginate the ranked hits.
   */
  search(
    q: string,
    params?: { limit?: number; offset?: number; format?: "json" },
  ): Promise<DatasetSearchResult>;
  search(
    q: string,
    params: { limit?: number; offset?: number; format: DatasetTextFormat },
  ): Promise<string>;
  search(
    q: string,
    params?: { limit?: number; offset?: number; format?: DatasetFormat },
  ): Promise<unknown> {
    return this.readDataset("/v1/datasets/search", { q, ...params } as DataQueryParams);
  }

  /**
   * `GET /v1/datasets/:id/search` — full-text search scoped to a single
   * dataset. Same response shape as `search`, restricted to one dataset's runs.
   */
  searchOne(
    id: number,
    q: string,
    params?: { limit?: number; offset?: number; format?: "json" },
  ): Promise<DatasetSearchResult>;
  searchOne(
    id: number,
    q: string,
    params: { limit?: number; offset?: number; format: DatasetTextFormat },
  ): Promise<string>;
  searchOne(
    id: number,
    q: string,
    params?: { limit?: number; offset?: number; format?: DatasetFormat },
  ): Promise<unknown> {
    return this.readDataset(`/v1/datasets/${id}/search`, { q, ...params } as DataQueryParams);
  }
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

export class KeysApi {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v1/keys` — key records (hashes are never serialized). Requires `wlt_`. */
  async list(params?: { limit?: number }): Promise<Page<ApiKey>> {
    const payload = await this.http.json<unknown>("GET", "/v1/keys", {
      query: params as QueryParams,
    });
    return normalizePage<ApiKey>(payload);
  }

  /**
   * `POST /v1/keys` — mint a scoped `wlk_` key. The plaintext `key` appears
   * ONLY in this response and cannot be recovered later.
   */
  create(body: { name: string; scopes?: string }): Promise<ApiKeyCreated> {
    return this.http.json("POST", "/v1/keys", { json: body });
  }

  /** `GET /v1/keys/:id`. */
  get(id: number): Promise<ApiKey> {
    return this.http.json("GET", `/v1/keys/${id}`);
  }

  /** `DELETE /v1/keys/:id`. */
  delete(id: number): Promise<{ id: number; deleted: boolean }> {
    return this.http.json("DELETE", `/v1/keys/${id}`);
  }
}

// ---------------------------------------------------------------------------
// WritAgent
// ---------------------------------------------------------------------------

/**
 * Client for the Writ local agent (`writ-agentd`).
 *
 * ```ts
 * const client = new WritAgent();               // discovers ~/.writ/runtime.json
 * const { data } = await client.workflows.list();
 * const run = await client.workflows.runAndWait(data[0].id);
 * ```
 *
 * Construction never performs I/O: discovery runs lazily (single-flight) on
 * the first request. Call {@link WritAgent.connect} — or use
 * {@link WritAgent.discover} — to resolve and probe the daemon eagerly and get
 * a clear {@link WritDiscoveryError} up front instead of on the first call.
 */
export class WritAgent {
  readonly agent: AgentApi;
  readonly workflows: WorkflowsApi;
  readonly runs: RunsApi;
  readonly monitors: MonitorsApi;
  readonly selectors: SelectorsApi;
  readonly extractors: ExtractorsApi;
  readonly automations: AutomationsApi;
  readonly personas: PersonasApi;
  readonly secrets: SecretsApi;
  readonly vault: VaultApi;
  readonly files: FilesApi;
  readonly data: DataApi;
  readonly crawl: CrawlApi;
  readonly datasets: DatasetsApi;
  readonly keys: KeysApi;
  /**
   * The tiered Writ Cloud surface (`scrape`, `map`, whole-site `crawl`) — runs on the cloud, never
   * locally. Metered with an API key, free/keyless (daily-capped) without one. See {@link CloudApi}.
   */
  readonly cloud: CloudApi;

  readonly #http: HttpClient;

  constructor(options: WritAgentOptions = {}) {
    this.#http = new HttpClient(options);
    this.cloud = new CloudApi({
      apiKey: options.apiKey,
      cloudUrl: options.cloudUrl,
      clientId: options.clientId,
    });
    this.agent = new AgentApi(this.#http);
    this.runs = new RunsApi(this.#http);
    this.workflows = new WorkflowsApi(this.#http, this.runs);
    this.monitors = new MonitorsApi(this.#http);
    this.selectors = new SelectorsApi(this.#http);
    this.extractors = new ExtractorsApi(this.#http);
    this.automations = new AutomationsApi(this.#http);
    this.personas = new PersonasApi(this.#http);
    this.secrets = new SecretsApi(this.#http);
    this.vault = new VaultApi(this.#http);
    this.files = new FilesApi(this.#http);
    this.data = new DataApi(this.#http);
    this.crawl = new CrawlApi(this.#http);
    this.datasets = new DatasetsApi(this.#http);
    this.keys = new KeysApi(this.#http);
  }

  /** Force discovery/liveness resolution now (otherwise it is lazy). */
  async connect(): Promise<this> {
    await this.#http.connection();
    return this;
  }

  /** Construct a client and eagerly discover + probe the daemon. */
  static async discover(options: WritAgentOptions = {}): Promise<WritAgent> {
    const client = new WritAgent(options);
    await client.connect();
    return client;
  }

  /** The resolved `{baseUrl, token}` (triggers discovery if needed). */
  connection(): Promise<{ baseUrl: string; token: string }> {
    return this.#http.connection();
  }

  /**
   * `POST /v1/ws-ticket` — mint a single-use, route-scoped WebSocket connect
   * ticket (`wtk_…`). `route: "ai-preview"` requires a `channel`; `"record"`
   * takes none. Opening the WebSocket itself is out of scope for SDK v1.
   */
  wsTicket(route: WsTicketRoute, channel?: string): Promise<WsTicket> {
    const body: Record<string, unknown> = { route };
    if (channel !== undefined) body["channel"] = channel;
    return this.#http.json("POST", "/v1/ws-ticket", { json: body });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
