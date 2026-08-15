/**
 * Typed models for the Writ local agent wire contract.
 *
 * Field-level shapes come from the Rust daemon source
 * (`writ-agent/src/local/`): stable scalar fields are strongly
 * typed; dynamic/JSON-ish fields (workflow `steps`, run `result`, …) are
 * `unknown`. Every model keeps an open index signature so additive daemon
 * fields never break consumers.
 */

import { WritError } from "./errors.js";

// ---------------------------------------------------------------------------
// Page (DESIGN.md §6)
// ---------------------------------------------------------------------------

/**
 * Uniform list envelope. The daemon is inconsistent (`{data,count}`,
 * `{data,count,total}`, bare arrays); every SDK list method normalizes to this
 * shape. For bare arrays `count = data.length` and `total = null`.
 */
export interface Page<T> {
  data: T[];
  count: number;
  total: number | null;
}

/** Normalize any of the three daemon list envelopes into a {@link Page}. */
export function normalizePage<T>(payload: unknown): Page<T> {
  if (Array.isArray(payload)) {
    return { data: payload as T[], count: payload.length, total: null };
  }
  if (payload !== null && typeof payload === "object") {
    const p = payload as { data?: unknown; count?: unknown; total?: unknown };
    if (Array.isArray(p.data)) {
      return {
        data: p.data as T[],
        count: typeof p.count === "number" ? p.count : p.data.length,
        total: typeof p.total === "number" ? p.total : null,
      };
    }
  }
  throw new WritError(
    `unexpected list envelope from the daemon: ${JSON.stringify(payload)?.slice(0, 200)}`,
  );
}

/** Page size {@link autoPage} requests when the caller's params do not set one. */
export const DEFAULT_AUTO_PAGE_SIZE = 100;

/**
 * Walk every page of a `limit`/`offset` list endpoint, yielding rows one at a
 * time and fetching the next page only when the current one is exhausted.
 *
 * ```ts
 * for await (const run of autoPage((p) => client.runs.list(p))) {
 *   console.log(run.id);
 * }
 * ```
 *
 * Without this, "list everything" means hand-rolling an offset loop at every
 * call site — and the usual mistake is stopping at the first page, silently
 * processing 100 of 4,000 rows with no error to show for it.
 *
 * Iteration stops when a page comes back short, which is the honest
 * end-of-data signal for an offset walk. `break` stops the fetching too.
 */
export async function* autoPage<T, P extends { limit?: number; offset?: number }>(
  list: (params: P) => Promise<Page<T>>,
  params?: P,
): AsyncGenerator<T, void, undefined> {
  const base = { ...(params ?? ({} as P)) };
  const limit = base.limit && base.limit > 0 ? base.limit : DEFAULT_AUTO_PAGE_SIZE;
  let offset = base.offset && base.offset > 0 ? base.offset : 0;

  for (;;) {
    const page = await list({ ...base, limit, offset } as P);
    for (const row of page.data) yield row;
    if (page.data.length < limit) return;
    offset += page.data.length;
  }
}

/** Open string enum helper: known literals + any other string. */
export type OpenEnum<T extends string> = T | (string & {});

// ---------------------------------------------------------------------------
// agent — server.rs
// ---------------------------------------------------------------------------

/** `GET /v1/agent` — lightweight daemon status. */
export interface AgentStatus {
  status: OpenEnum<"ok">;
  version: string;
  active_runs: number;
  encrypted: boolean;
  due_monitors: number;
  last_tick_at: string | null;
  warm_browser: boolean;
  [key: string]: unknown;
}

/** `GET /v1/health` — deep health probe. */
export interface Health {
  status: OpenEnum<"ok" | "degraded">;
  version: string;
  cipher_present: boolean;
  db_ok: boolean;
  keyring_ok: boolean;
  active_runs: number;
  scheduler: {
    last_tick_at: string | null;
    due_monitors: number;
    [key: string]: unknown;
  };
  warm_browser: boolean;
  cloud_link: {
    linked: boolean;
    account_id: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// workflows — api/v1/workflows.rs + store/workflows.rs (redact()ed row)
// ---------------------------------------------------------------------------

/** One entry of a workflow's computed `placeholders` (Run-modal input fields). */
export interface WorkflowPlaceholder {
  key: string;
  label: string;
  field_type: unknown;
  [key: string]: unknown;
}

/**
 * A workflow row as returned by the API. The daemon `redact()`s every row:
 * `credentials_encrypted` never appears; `has_credentials`, `credential_keys`,
 * `placeholders` and `has_login` are added; JSON-TEXT columns (`steps`,
 * `form_data`, `functions`, …) are re-hydrated to real JSON values.
 */
export interface Workflow {
  id: number;
  name: string;
  description: string | null;
  workflow_type: OpenEnum<"recorded" | "pre_check" | "on_change" | "api_recorded" | "streaming">;
  /** Recorded step array (JSON re-hydrated by the daemon). */
  steps: unknown;
  raw_replay?: unknown;
  form_data?: unknown;
  exit_condition?: unknown;
  input_rules?: unknown;
  api_functions?: unknown;
  streaming_config?: unknown;
  functions?: unknown;
  entry_url: string | null;
  timeout_ms: number;
  retry_count: number;
  /** 0/1 integer flags (SQLite columns). */
  headless: number;
  fast_mode: number;
  is_active: number;
  is_verified: number;
  schedule_enabled: number;
  schedule_interval_ms: number | null;
  /** `interval` (default) | `daily` | `weekly`. */
  schedule_kind?: string | null;
  /** "HH:MM" local wall-clock fire time (daily/weekly). */
  schedule_time?: string | null;
  /** ISO weekday ints 1=Mon…7=Sun (weekly), JSON re-hydrated. */
  schedule_days?: unknown;
  schedule_tz?: string | null;
  last_scheduled_at: string | null;
  next_scheduled_at: string | null;
  session_persistence: number;
  session_ttl_seconds: number | null;
  login_url_patterns?: unknown;
  relogin_max_retries: number;
  /** -1 unknown | 0 browser-only | 1 HTTP-proven (browserless HTTP lane hint). */
  http_capable?: number;
  auth_config?: unknown;
  default_persona_id: number | null;
  estimated_duration_ms: number | null;
  usage_count: number;
  total_run_count: number;
  total_failure_count: number;
  consecutive_failures: number;
  last_run_at: string | null;
  /** Status of the most recent run (computed column; null = never ran). */
  last_run_status?: string | null;
  last_run_duration_ms?: number | null;
  last_run_has_extracted_data?: number | null;
  last_failure_at: string | null;
  last_failure_error: string | null;
  cloud_callable: number;
  /** Run-venue pin: "local" | "cloud" | null (Auto). */
  execution_target?: string | null;
  /** Set when this row is a marketplace-install proxy. */
  marketplace_slug?: string | null;
  created_at: string;
  updated_at: string | null;
  // redact() additions:
  has_credentials: boolean;
  /** Names (never values) of the sealed credential map's keys. */
  credential_keys: string[];
  placeholders: WorkflowPlaceholder[];
  has_login: boolean;
  [key: string]: unknown;
}

/** Query params for `GET /v1/workflows` (pass-through). */
export interface WorkflowListParams {
  /** Filter to `is_active = 1` (daemon default: true). */
  active_only?: boolean;
  /** Page size, clamped to 1..=1000 by the daemon (default 100). */
  limit?: number;
  [key: string]: string | number | boolean | undefined;
}

/**
 * Body for `POST /v1/workflows`. Only `name` is required; JSON-TEXT fields
 * accept rich JSON values. A plaintext `credentials` map (`{name: value}`) is
 * sealed daemon-side and never echoed back.
 */
export interface WorkflowCreate {
  name: string;
  description?: string;
  workflow_type?: string;
  steps?: unknown;
  raw_replay?: unknown;
  form_data?: unknown;
  exit_condition?: unknown;
  input_rules?: unknown;
  api_functions?: unknown;
  streaming_config?: unknown;
  functions?: unknown;
  entry_url?: string;
  default_persona_id?: number;
  timeout_ms?: number;
  retry_count?: number;
  headless?: boolean | number;
  fast_mode?: boolean | number;
  schedule_kind?: string;
  schedule_time?: string;
  schedule_days?: unknown;
  schedule_tz?: string;
  auth_config?: unknown;
  /** Plaintext credentials, sealed daemon-side. Never returned. */
  credentials?: Record<string, string>;
  [key: string]: unknown;
}

/** Sparse patch body for `PATCH /v1/workflows/:id` (absent fields untouched). */
export interface WorkflowUpdate {
  name?: string;
  description?: string;
  workflow_type?: string;
  steps?: unknown;
  raw_replay?: unknown;
  form_data?: unknown;
  exit_condition?: unknown;
  input_rules?: unknown;
  api_functions?: unknown;
  streaming_config?: unknown;
  functions?: unknown;
  entry_url?: string;
  timeout_ms?: number;
  retry_count?: number;
  headless?: boolean | number;
  fast_mode?: boolean | number;
  is_verified?: boolean | number;
  schedule_enabled?: boolean | number;
  schedule_interval_ms?: number;
  schedule_kind?: string;
  schedule_time?: string;
  schedule_days?: unknown;
  schedule_tz?: string;
  session_persistence?: boolean | number;
  session_ttl_seconds?: number;
  login_url_patterns?: unknown;
  relogin_max_retries?: number;
  default_persona_id?: number;
  estimated_duration_ms?: number;
  cloud_callable?: boolean | number;
  execution_target?: string;
  /** Plaintext credentials, sealed daemon-side. Never returned. */
  credentials?: Record<string, string>;
  [key: string]: unknown;
}

/** Options for `workflows.run(id, …)` (wire body: `inputs`/`persona_id`/`dry_run`/`files`). */
export interface RunOptions {
  /** Run-time inputs resolved over `{{NAME}}` / `{{input.NAME}}` placeholders. */
  inputs?: Record<string, unknown>;
  /** Persona override for this run (wins over the workflow's pinned default). */
  personaId?: number;
  /** Validate-only: parse the step plan without executing anything (200, not 202). */
  dryRun?: boolean;
  /** `{slot: file_id}` bindings of vault files to the workflow's upload slots. */
  files?: Record<string, string>;
  /**
   * Block on the daemon until the run is terminal (`?wait=true`) instead of
   * getting a `run_id` back to observe yourself.
   *
   * This is the SERVER-side wait — one request, no SSE — and returns a
   * {@link RunCompleted}. Prefer {@link WorkflowsApi.runAndWait} when you want
   * live events, the enriched run feed item, or a deadline longer than the
   * daemon's own ceiling.
   */
  wait?: boolean;
  /**
   * Reuse a recent answer instead of running: if this workflow's last successful
   * run with the SAME inputs finished within this many seconds, its data is
   * returned and nothing executes. The response carries `_cache.hit` /
   * `_cache.age_seconds` so you can always tell which you got.
   *
   * Omit it (or pass 0) for the unchanged behaviour — always run.
   */
  maxAge?: number;
  /**
   * Seconds the daemon may block for when `wait` is set. Clamped server-side to
   * [1, 3600]; default 120. On expiry the call throws a {@link WritTimeoutError}
   * carrying the still-valid `run_id` — the run is NOT cancelled.
   */
  timeout?: number;
}

/** `POST /v1/workflows/:id/run` → 202 `{run_id, status:"running"}`. */
export interface RunStarted {
  run_id: number;
  status: OpenEnum<"running">;
  [key: string]: unknown;
}

/**
 * `workflows.run(id, {wait:true})` → 200, the run's terminal document.
 *
 * A FAILED run arrives here as a normal result with `status: "failed"`, not as a
 * thrown error — the call succeeded in reporting the outcome. Check `status`.
 */
export interface RunCompleted {
  run_id: number;
  status: OpenEnum<"success" | "failed" | "timeout" | "cancelled">;
  done: true;
  /** The run's result payload, when it produced one. */
  data?: unknown;
  /** Why it failed. Present for non-success terminal states. */
  error?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

/** `workflows.run(id, {dryRun:true})` → 200 validate-only report. */
export interface DryRunReport {
  dry_run: true;
  workflow_id: number;
  step_count: number;
  steps: Array<{
    index: number;
    type: string;
    enabled: boolean;
    references_secret: boolean;
    [key: string]: unknown;
  }>;
  /** Secret KEY NAMES the plan would need — names only, never values. */
  required_secrets: string[];
  provided_inputs: string[];
  entry_url: string | null;
  [key: string]: unknown;
}

/**
 * Cancel outcome for `workflows.cancel` / `runs.cancel`. A 409 `not_running`
 * is a VALID answer (already-terminal run), returned as a result — never
 * thrown (DESIGN.md §7).
 */
export interface CancelResult {
  status: OpenEnum<"cancel_requested" | "not_running">;
  /** Present on run-level cancels and on workflow cancels that resolved a run. */
  run_id?: number;
  /** Present on workflow-level cancels (the workflow id). */
  id?: number;
  /** `runs.cancel` 409 only: the run row's actual status. */
  run_status?: string;
  [key: string]: unknown;
}

/** `GET /v1/workflows/:id/session` — browserless-HTTP-lane session status. */
export interface WorkflowSession {
  workflow_id: number;
  has_session: boolean;
  engine?: string | null;
  expires_at?: string | null;
  last_used_at?: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// runs — api/v1/runs.rs
// ---------------------------------------------------------------------------

/** Run lifecycle statuses (serde snake_case of `engine/mod.rs::RunStatus`). Open enum. */
export type RunStatus = OpenEnum<
  "running" | "success" | "failed" | "cancelled" | "timeout" | "captcha_required" | "twofa_required"
>;

/**
 * One enriched run-feed item (`GET /v1/runs`). `id` is a COMPOSITE string
 * `"<run_type>-<row_id>"` (e.g. `"workflow-3"`); the numeric row id for
 * `runs.get/cancel/events` is the part after the last dash — use
 * {@link runRowId}.
 */
export interface RunFeedItem {
  id: string;
  run_type: OpenEnum<"workflow" | "check" | "automation">;
  entity_id: number | null;
  entity_name: string | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  trigger_source: string | null;
  error: string | null;
  detail_url_hint: string | null;
  data_url_hint: string | null;
  /** Workflow runs only: extracted-record count. `null` for check/automation runs. */
  rows_extracted: number | null;
  /** Check runs only: whether a change was detected. `null` otherwise. */
  change_detected: boolean | null;
  /** Which lane ran this ("http" | "browser" | "hybrid"); absent on older rows. */
  engine?: string;
  [key: string]: unknown;
}

/** Extract the numeric run row id from a composite feed id (`"workflow-3"` → 3). */
export function runRowId(item: RunFeedItem | string): number {
  const id = typeof item === "string" ? item : item.id;
  const dash = id.lastIndexOf("-");
  const tail = dash >= 0 ? id.slice(dash + 1) : id;
  const n = Number(tail);
  if (!Number.isInteger(n) || tail === "") {
    throw new WritError(`cannot extract a numeric run row id from ${JSON.stringify(id)}`);
  }
  return n;
}

/** One bindable file input on a workflow — see {@link fileSlots}. */
export interface FileSlot {
  /** Key to use in {@link RunOptions.files}. */
  slot: string;
  label: string;
  is_multiple: boolean;
  /**
   * File pinned on the step. Present ⇒ the run works with NO binding at all,
   * and binding one overrides it for that run only.
   */
  default_file_id?: string;
  default_filename?: string;
  /**
   * `true` when the workflow's author named the slot; `false` when it is keyed
   * on the step id because the step only pins a file.
   */
  declared: boolean;
}

/**
 * The file inputs of a workflow — the valid keys for {@link RunOptions.files}.
 *
 * Every `upload` step is a file input. Two kinds:
 *
 * - the step names a `file_slot` — an abstract slot whose file the CALLER
 *   supplies. With no `default_file_id` it must be bound or the step fails;
 * - the step pins a concrete file. It is keyed `step:<step id>` and carries that
 *   file as `default_file_id`, so the workflow runs untouched — bind it only to
 *   run against a DIFFERENT file.
 *
 * Derived from `workflow.steps` on the client, so it costs no extra round trip
 * and works against any daemon version. A step's binding lives in `config` when
 * the editor wrote it and in `options` when the recorder did; both are read,
 * `config` winning as the explicit later edit. De-duped by slot,
 * order-preserving; `[]` when the workflow has no upload steps.
 *
 * ```ts
 * const wf = await client.workflows.get(7);
 * fileSlots(wf).map((s) => s.slot); // ["resume", "step:6f2a…"]
 * await client.workflows.run(7, { files: { resume: "file_abc" } });
 * ```
 */
export function fileSlots(workflow: Pick<Workflow, "steps"> | { steps?: unknown }): FileSlot[] {
  const steps = (workflow as { steps?: unknown } | undefined)?.steps;
  if (!Array.isArray(steps)) return [];
  const out: FileSlot[] = [];
  const seen = new Set<string>();
  steps.forEach((raw, i) => {
    const step = raw as Record<string, any> | null;
    if (!step || typeof step !== "object" || step.type !== "upload") return;
    const cfg: Record<string, any> = step.config && typeof step.config === "object" ? step.config : {};
    const opts: Record<string, any> = step.options && typeof step.options === "object" ? step.options : {};
    const named = cfg.file_slot || opts.file_slot;
    const declared = typeof named === "string" && named.length > 0;
    // Keyed on the step's own id, never an ordinal: a binding has to survive the
    // steps being reordered or one being disabled.
    const slot = declared ? (named as string) : step.id ? `step:${step.id}` : `upload:${i + 1}`;
    if (seen.has(slot)) return;
    seen.add(slot);
    const defaultFileId = cfg.file_id || opts.file_id;
    const defaultFilename = cfg.file_name || opts.filename || opts.file_name;
    out.push({
      slot,
      label:
        cfg.label ||
        opts.label ||
        defaultFilename ||
        (declared ? slot.replace(/_/g, " ") : `File ${i + 1}`),
      is_multiple: Boolean(cfg.is_multiple || opts.is_multiple),
      ...(defaultFileId ? { default_file_id: defaultFileId as string } : {}),
      ...(defaultFilename ? { default_filename: defaultFilename as string } : {}),
      declared,
    });
  });
  return out;
}

/** A file a run CAPTURED (a `wait_for_download` step) — see {@link outputFiles}. */
export interface OutputFile {
  /** Handle in the vault — read the bytes with `client.files.content(file_id)`. */
  file_id: string;
  filename: string;
  size: number;
  content_type: string;
  /** The step's `output_key`, when it named the capture for later reference. */
  output_key?: string;
  [key: string]: unknown;
}

/**
 * Files captured by a run's download steps.
 *
 * A `wait_for_download` step stores what the browser downloaded and reports it
 * as `result_data.output_files`. Accepts the completed-run document, its
 * `result_data`, or a results payload — whichever you hold — and returns `[]`
 * when the run captured nothing.
 *
 * ```ts
 * const outcome = await client.workflows.runAndWait(7);
 * for (const f of outputFiles(outcome)) {
 *   const bytes = await client.files.content(f.file_id);
 * }
 * ```
 */
export function outputFiles(run: unknown): OutputFile[] {
  if (!run || typeof run !== "object") return [];
  const r = run as Record<string, any>;
  const candidates = [
    r.output_files,
    r.result_data && typeof r.result_data === "object" ? r.result_data.output_files : undefined,
    r.results && typeof r.results === "object" ? r.results.output_files : undefined,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter((f) => f && typeof f === "object") as OutputFile[];
  }
  return [];
}

/** Query params for `GET /v1/runs` (pass-through). */
export interface RunListParams {
  entity_id?: number;
  workflow_id?: number;
  run_type?: OpenEnum<"workflow" | "check" | "automation">;
  status?: RunStatus;
  limit?: number;
  offset?: number;
  [key: string]: string | number | boolean | undefined;
}

/** `GET /v1/runs/:id/results` → the run's raw result payload. */
export interface RunResults {
  run_id: number;
  status: RunStatus;
  result: unknown;
  [key: string]: unknown;
}

/** `GET /v1/runs/:id/data` (JSON lane) → the run's extracted data. */
export interface RunData {
  run_id: number;
  status: RunStatus;
  data: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// run events (SSE) — engine/events.rs (serde tag = "event", snake_case)
// ---------------------------------------------------------------------------

/** Per-step lifecycle status inside a `step` event. */
export type StepStatus = OpenEnum<"running" | "succeeded" | "failed" | "skipped">;

export interface RunEventStarted {
  event: "started";
  run_id: number;
  total_steps: number;
}

export interface RunEventStep {
  event: "step";
  run_id: number;
  index: number;
  step_type: string;
  status: StepStatus;
}

export interface RunEventProgress {
  event: "progress";
  run_id: number;
  completed: number;
  total: number;
}

/** Terminal — the stream closes after this event. */
export interface RunEventFinished {
  event: "finished";
  run_id: number;
  status: RunStatus;
}

/** Terminal — the stream closes after this event. */
export interface RunEventError {
  event: "error";
  run_id: number;
  message: string;
}

/**
 * A run lifecycle event from `GET /v1/runs/:id/events` (SSE). Discriminated on
 * `event`; `finished` and `error` are stream-closing.
 */
export type RunEvent =
  | RunEventStarted
  | RunEventStep
  | RunEventProgress
  | RunEventFinished
  | RunEventError;

/** True for the two stream-closing variants (`finished` / `error`). */
export function isTerminalEvent(ev: RunEvent): ev is RunEventFinished | RunEventError {
  return ev.event === "finished" || ev.event === "error";
}

/** Options for `workflows.runAndWait` (DESIGN.md §8). */
export interface RunAndWaitOptions {
  inputs?: Record<string, unknown>;
  personaId?: number;
  files?: Record<string, string>;
  /**
   * Overall deadline in milliseconds (default 600 000 = 600 s). On expiry a
   * `WritError` is thrown; the run itself is NOT cancelled.
   */
  waitTimeout?: number;
  /** Polling cadence (ms) for the SSE-drop fallback. Default 1000. */
  pollInterval?: number;
  /** Also fetch `runs.results()` and attach it as `results` on the returned item. */
  includeResults?: boolean;
  /** Observe live events while waiting (only fires while the SSE lane is up). */
  onEvent?: (event: RunEvent) => void;
}

// ---------------------------------------------------------------------------
// monitors — api/v1/monitors.rs + store/targets.rs (enriched row)
// ---------------------------------------------------------------------------

/**
 * A monitor (`targets` row) enriched with its live check state. `setup_steps`
 * credentials are redacted daemon-side (sentinel `«redacted»`).
 */
export interface Monitor {
  id: number;
  url: string;
  check_type: OpenEnum<"content" | "uptime">;
  selector: string | null;
  ignore_regex: string | null;
  check_period_ms: number | null;
  expected_status_code: number | null;
  timeout_ms: number | null;
  max_response_time_ms: number | null;
  check_ssl: number | null;
  enabled: number;
  requires_playwright: number;
  baseline_hash: string | null;
  baseline_fetched_at: string | null;
  pre_check_workflow_id: number | null;
  setup_steps?: unknown;
  on_change_workflow_id: number | null;
  on_change_enabled: number;
  on_change_conditions?: unknown;
  on_change_in_session: number;
  persona_id: number | null;
  notification_providers?: unknown;
  notification_title: string | null;
  notification_message: string | null;
  next_run_at?: string | null;
  created_at?: string;
  updated_at?: string | null;
  // enrich() additions (live monitor_state + counts):
  state?: string | null;
  last_checked_at?: string | null;
  status_code?: number | null;
  is_up?: boolean | null;
  last_change_at?: string | null;
  state_updated_at?: string | null;
  changes_count?: number;
  selector_count?: number;
  [key: string]: unknown;
}

/** Body for `POST /v1/monitors` — requires a non-empty `url`. */
export interface MonitorCreate {
  url: string;
  check_type?: string;
  selector?: string;
  ignore_regex?: string;
  check_period_ms?: number;
  expected_status_code?: number;
  timeout_ms?: number;
  max_response_time_ms?: number;
  check_ssl?: boolean | number;
  enabled?: boolean | number;
  requires_playwright?: boolean | number;
  pre_check_workflow_id?: number;
  setup_steps?: unknown;
  on_change_workflow_id?: number;
  on_change_enabled?: boolean | number;
  on_change_conditions?: unknown;
  persona_id?: number;
  notification_providers?: unknown;
  notification_title?: string;
  notification_message?: string;
  [key: string]: unknown;
}

/** Sparse patch body for `PATCH /v1/monitors/:id`. */
export type MonitorUpdate = Partial<MonitorCreate>;

/** `GET /v1/monitors/:id/changes` — paginated change + uptime history. */
export interface MonitorHistory {
  monitor_id: number;
  limit: number;
  offset: number;
  has_more: boolean;
  changes: unknown[];
  uptime_checks: unknown[];
  [key: string]: unknown;
}

/** One entry of the global `GET /v1/changes/recent` feed. */
/**
 * One row of the GLOBAL recent-changes feed — the daemon's
 * `GET /v1/changes/recent` and the cloud's `GET /api/targets/changes/recent`,
 * which serialise the identical shape. snake_case with INTEGER ids.
 *
 * It carries a feed row's worth of data: the monitor URL, which selector fired,
 * a server-truncated diff snippet, and the two timestamps. Full before/after
 * content lives on the per-monitor change route (`CloudMonitorChange`), which is
 * a genuinely different shape — camelCase, string ids — and must not be confused
 * with this one.
 */
export interface RecentChange {
  id: number;
  target_id: number;
  target_url: string;
  /** Which selector fired — null for a whole-page monitor. */
  target_selector_id?: number | null;
  selector_name?: string | null;
  /** Truncated server-side to a feed-friendly length. */
  diff_snippet?: string | null;
  /**
   * `first_detected_at` is when this content first differed. `last_detected_at`
   * moves forward every time the SAME difference is seen again, which is why it
   * — not `first_detected_at` — is the feed's sort key and the value a cursor
   * advances to. A row you have already processed legitimately reappears with a
   * later `last_detected_at`: that is a fresh detection, not a duplicate.
   */
  first_detected_at: string;
  last_detected_at: string;
}

/**
 * Filters for either change feed.
 *
 * Leaving `since` unset gives the newest-first browsing view. Setting it
 * switches the server to an oldest-first keyset walk returning only what was
 * detected AFTER that point — which is what a poller wants: newest-first plus a
 * limit silently drops changes whenever more than `limit` of them land between
 * two polls.
 */
export interface ChangeListParams {
  /** Page size. Omit for the API default. */
  limit?: number;
  /** ISO-8601 cursor — the `last_detected_at` of the last row you processed. */
  since?: string;
  /**
   * That row's id, breaking ties between changes sharing one timestamp. Without
   * it two rows in the same millisecond can straddle the page boundary and the
   * trailing one is never returned again.
   */
  since_id?: number;
}

// ---------------------------------------------------------------------------
// selectors — api/v1/selectors.rs + store/target_selectors.rs
// ---------------------------------------------------------------------------

export interface Selector {
  id: number;
  target_id: number;
  name: string;
  selector: string;
  description: string | null;
  enabled: number;
  content_type: string | null;
  visual_region: string | null;
  ignore_regex: string | null;
  priority: number | null;
  baseline_hash: string | null;
  baseline_content: string | null;
  baseline_screenshot: string | null;
  baseline_fetched_at: string | null;
  last_content_hash: string | null;
  last_checked_at: string | null;
  change_count: number | null;
  created_at: string;
  updated_at: string | null;
  [key: string]: unknown;
}

/** Body for `POST /v1/monitors/:id/selectors` — requires non-empty `selector`. */
export interface SelectorCreate {
  selector: string;
  name?: string;
  description?: string;
  enabled?: boolean | number;
  content_type?: string;
  visual_region?: unknown;
  ignore_regex?: string;
  priority?: number;
  [key: string]: unknown;
}

export type SelectorUpdate = Partial<SelectorCreate>;

// ---------------------------------------------------------------------------
// extractors — api/v1/extractors.rs + store/selector_extractors.rs
// ---------------------------------------------------------------------------

export interface Extractor {
  id: number;
  target_selector_id: number;
  name: string;
  output_name: string;
  enabled: number;
  extract_type: string;
  config: string | null;
  is_array: number;
  default_value: string | null;
  [key: string]: unknown;
}

/** Body for `POST /v1/extractors` — requires `target_selector_id` + `output_name`. */
export interface ExtractorCreate {
  target_selector_id: number;
  output_name: string;
  name?: string;
  enabled?: boolean | number;
  extract_type?: string;
  config?: unknown;
  is_array?: boolean | number;
  default_value?: string;
  [key: string]: unknown;
}

export type ExtractorUpdate = Partial<Omit<ExtractorCreate, "target_selector_id">>;

// ---------------------------------------------------------------------------
// automations — api/v1/automations.rs (JSON-TEXT columns parsed on the wire)
// ---------------------------------------------------------------------------

export interface Automation {
  id: number;
  target_id: number | null;
  event_type: string;
  target_selector_id: number | null;
  workflow_id: number | null;
  webhook_trigger_id: number | null;
  name: string;
  description: string | null;
  enabled: number;
  priority: number | null;
  /** Parsed JSON object (daemon parses the stored TEXT). */
  conditions: unknown;
  /** Parsed JSON array. */
  actions: unknown;
  /** Parsed JSON array or null. */
  blocks: unknown;
  last_triggered_at: string | null;
  trigger_count: number | null;
  created_at: string;
  updated_at: string | null;
  [key: string]: unknown;
}

/** Body for `POST /v1/automations` — requires a non-empty `name`. */
export interface AutomationCreate {
  name: string;
  event_type?: string;
  target_id?: number;
  target_selector_id?: number;
  workflow_id?: number;
  description?: string;
  enabled?: boolean | number;
  priority?: number;
  conditions?: unknown;
  actions?: unknown;
  blocks?: unknown;
  [key: string]: unknown;
}

export type AutomationUpdate = Partial<AutomationCreate>;

/** `POST /v1/automations/:id/run` outcome. */
export interface AutomationRunResult {
  status: string;
  execution_id?: number;
  results?: unknown;
  error?: string | null;
  reason?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// personas — api/v1/personas.rs (cloud PersonaResponse wire parity)
// ---------------------------------------------------------------------------

/** Shaped persona: secrets collapse to `has_*` booleans + linked names only. */
export interface Persona {
  id: number;
  name: string;
  description: string | null;
  target_domain: string | null;
  login_username: string | null;
  has_password: boolean;
  twofa_method: OpenEnum<"none" | "totp" | "email_otp" | "sms">;
  has_totp_seed: boolean;
  email_otp_mode: string | null;
  mail_connection_id: unknown;
  connected_mailbox: unknown;
  relay_address: string | null;
  has_fingerprint: boolean;
  preferred_agent_id: unknown;
  has_proxy: boolean;
  is_active: boolean;
  validation_status: string | null;
  has_warm_session: boolean;
  session_expires_at: string | null;
  last_login_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string | null;
  linked_workflows: Array<{ id: number; name: string }>;
  /** `{credential_field -> vault secret base name}` — names only, never values. */
  linked_secrets: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Write payload for persona create/update (plaintext secrets are sealed
 * daemon-side and never echoed back).
 */
export interface PersonaWrite {
  name?: string;
  description?: string | null;
  target_domain?: string | null;
  login_username?: string | null;
  password?: string;
  extra_login_fields?: Record<string, string>;
  twofa_method?: "none" | "totp" | "email_otp" | "sms";
  totp_seed?: string;
  totp_digits?: number;
  totp_period_seconds?: number;
  totp_algorithm?: string;
  email_otp_mode?: "oauth_mailbox" | "relay";
  relay_address?: string;
  otp_extract_config?: Record<string, unknown> | null;
  fingerprint?: Record<string, unknown> | null;
  proxy_server?: string;
  proxy_username?: string;
  proxy_password?: string;
  proxy_lawful_use_ack?: boolean;
  is_active?: boolean;
  [key: string]: unknown;
}

/** One run entry from `GET /v1/personas/:id/runs`. */
export interface PersonaRun {
  task_id: number;
  workflow_id: number | null;
  workflow_name: string | null;
  status: RunStatus;
  success: boolean | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  [key: string]: unknown;
}

/** Body for `POST /v1/personas/validate-totp`. */
export interface ValidateTotpBody {
  totp_seed: string;
  code?: string;
  algorithm?: string;
  digits?: number;
  period?: number;
}

/** `POST /v1/personas/validate-totp` result. */
export interface ValidateTotpResult {
  valid_base32: boolean;
  /** `true`/`false` when a code was supplied, `null` otherwise. */
  matches_code: boolean | null;
  [key: string]: unknown;
}

/** `POST /v1/personas/:id/test-2fa` result (never contains the code). */
export interface Test2faResult {
  ok: boolean;
  method: string;
  message?: string;
  kind?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// secrets — api/v1/secrets.rs (metadata only; values never returned)
// ---------------------------------------------------------------------------

/** Secret metadata — the value/ciphertext is NEVER returned by the API. */
export interface SecretMeta {
  id: number;
  /** Unique TEXT key (the secret's name). */
  key: string;
  name: string;
  description: string | null;
  category: string | null;
  is_credential: boolean;
  is_card: boolean;
  /** Credential secrets only: the (non-secret) username. */
  username: string | null;
  /** Card secrets only: last 4 digits of the number. */
  card_last4: string | null;
  created_at: string;
  updated_at: string | null;
  last_used_at: string | null;
  use_count: number;
  [key: string]: unknown;
}

/** Query params for `GET /v1/secrets`. */
export interface SecretListParams {
  limit?: number;
  /** Case-insensitive substring match on the name. */
  search?: string;
  category?: string;
  [key: string]: string | number | boolean | undefined;
}

/** Extra fields for `secrets.set(...)` beyond a single plain value. */
export interface SecretSetOptions {
  description?: string;
  /** e.g. "credentials" or "card" — usually inferred from the fields below. */
  category?: string;
  /** With `password`: store a credential (username+password) secret. */
  username?: string;
  password?: string;
  /** Store a payment-card secret (`number` + `expiry` required by the daemon). */
  card?: { name?: string; number?: string; expiry?: string; cvc?: string; zip?: string };
}

// ---------------------------------------------------------------------------
// vault — api/v1/vault.rs
// ---------------------------------------------------------------------------

/** `GET /v1/vault/status` — non-secret app-lock snapshot. */
export interface VaultStatus {
  enabled: boolean;
  locked: boolean;
  idle_timeout_secs: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// files — api/v1/files.rs (OpenAI Files-API wire shape)
// ---------------------------------------------------------------------------

/** File handle metadata (`bytes` size, `created_at` = UNIX epoch seconds). */
export interface FileMeta {
  id: string;
  object: "file";
  filename: string;
  content_type: string;
  bytes: number;
  created_at: number;
  status: string;
  source: OpenEnum<"upload" | "api" | "workflow_output">;
  purpose: string;
  [key: string]: unknown;
}

/** Options for `files.upload(...)`. */
export interface FileUploadOptions {
  filename?: string;
  contentType?: string;
  source?: "upload" | "api" | "workflow_output";
}

/** Body for `POST /v1/files/from-data`. */
export interface FileFromDataBody {
  workflow_id: number;
  /** `csv` (default) or `json`. */
  format?: "csv" | "json";
  filters?: unknown;
}

// ---------------------------------------------------------------------------
// data — api/v1/data.rs
// ---------------------------------------------------------------------------

/** One entry of the `GET /v1/data` workflow picker. */
export interface DataWorkflowSummary {
  workflow_id: number;
  workflow_name: string;
  run_count: number;
  last_data_at: string | null;
  last_delta: { new: number; changed: number; removed: number } | null;
  [key: string]: unknown;
}

/** `GET /v1/data` response. */
export interface DataWorkflows {
  workflows: DataWorkflowSummary[];
  [key: string]: unknown;
}

/** Loose query params for the data-table endpoints (pass-through). */
export type DataQueryParams = Record<string, string | number | boolean | undefined>;

/**
 * Output shape for a dataset read (`?format=`).
 *
 * `json` (default) returns the documented envelope. The rest return TEXT and are
 * CONTENT-AWARE: a dataset whose records carry long-form content (a crawl's pages
 * have `markdown`) renders as documents; anything else renders as a table.
 * `html` is a standalone document — its scraped content is escaped, but it is
 * meant to be saved/viewed, not parsed.
 */
export type DatasetFormat = "json" | "csv" | "markdown" | "html";

/** The non-json formats — these return `string`, not a parsed envelope. */
export type DatasetTextFormat = Exclude<DatasetFormat, "json">;

/** One entry in the unified dataset catalog (`GET /v1/datasets`). */
export interface Dataset {
  id: number;
  name: string | null;
  source_type: string;
  run_count?: number;
  last_updated?: string | null;
  origin?: string;
  [key: string]: unknown;
}

/** `GET /v1/datasets` response — a non-Page envelope (mirrors `DataWorkflows`). */
export interface DatasetList {
  datasets: Dataset[];
  [key: string]: unknown;
}

/** One matched run from a dataset full-text search. */
export interface DatasetSearchHit {
  dataset: { id: number; name: string | null; source_type: string };
  run_id: number | null;
  run_at: string | null;
  fields: Record<string, unknown>;
  highlight: { field: string; snippet: string } | null;
  [key: string]: unknown;
}

/** `GET /v1/datasets/search` (and `/v1/datasets/:id/search`) response. */
export interface DatasetSearchResult {
  query: string;
  terms: string[];
  results: DatasetSearchHit[];
  total: number;
  truncated: boolean;
  scanned_runs: number;
  [key: string]: unknown;
}

/** Body for `DELETE /v1/workflows/:id/data`. */
export interface DataDeleteBody {
  records?: Array<{ run_id: number; record_index: number }>;
  record_uids?: string[];
  key?: string;
}

/** `DELETE /v1/workflows/:id/data` result. */
export interface DataDeleteResult {
  deleted: number;
  resolved: Record<string, number>;
  unmatched: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// crawl — api/v1/crawl.rs + store/crawl_jobs.rs (the "Dragnet" whole-site crawl)
// ---------------------------------------------------------------------------

/** Crawl lifecycle statuses (`store/crawl_jobs.rs`). Terminal: the last three. Open enum. */
export type CrawlStatus = OpenEnum<
  "queued" | "mapping" | "crawling" | "stopping" | "completed" | "failed" | "cancelled"
>;

/**
 * A crawl row as returned by the API (`to_view()`): the JSON-TEXT scope columns
 * are parsed into arrays/objects, and the daemon adds `brand` (`"Dragnet"`),
 * the `data_workflow_id` alias of `workflow_id`, and `is_terminal`. Booleans
 * arrive as `0/1` ints from SQLite — they are kept as numbers (mirrors the
 * monitor rows).
 */
/**
 * Display naming a crawl view carries, in the TWO shapes two different services
 * answer with:
 *
 *   • the LOCAL daemon sends a bare string — `"Dragnet"`
 *   • Writ Cloud sends an object — `{"crawl": "Dragnet", "agent": "Scribe"}`
 *
 * Narrow it with a `typeof` check before reading a name. Typing this as a string
 * alone made the typed SDKs fail to decode a real cloud crawl outright; here it
 * was only a lie, since TypeScript does not validate at runtime.
 */
export type CrawlBrand = OpenEnum<"Dragnet"> | { crawl: string; agent?: string };

/** The crawler display name, whichever shape {@link CrawlBrand} arrived in. */
export function crawlBrandName(brand: CrawlBrand): string {
  return typeof brand === "string" ? brand : brand.crawl;
}

export interface CrawlJob {
  id: number;
  name: string;
  seed_url: string;
  /** Path-regex allowlist (JSON-TEXT parsed to an array by the daemon). */
  include_paths: string[];
  /** Path-regex denylist (JSON-TEXT parsed to an array by the daemon). */
  exclude_paths: string[];
  max_depth: number;
  /** 0/1 integer flags (SQLite columns). */
  same_domain: number;
  allow_subdomains: number;
  extract_mode: OpenEnum<"markdown" | "schema">;
  /** JSON schema for `extract_mode: "schema"` (parsed to an object) or null. */
  extract_schema: unknown;
  persona_id: number | null;
  respect_robots: number;
  delay_ms: number;
  max_concurrent: number;
  page_budget: number;
  workflow_id: number | null;
  /** Alias of `workflow_id` — the synthetic dataset workflow results aggregate under. */
  data_workflow_id: number | null;
  concierge_session_id: number | null;
  status: CrawlStatus;
  pages_discovered: number;
  pages_done: number;
  pages_failed: number;
  pages_skipped: number;
  workers_active: number;
  current_depth: number;
  error: string | null;
  cancel_requested: number;
  /**
   * Display naming, in the TWO shapes two different services answer with: the
   * LOCAL daemon sends a bare string (`"Dragnet"`), while Writ Cloud sends an
   * object (`{crawl, agent}`). Typing this as a string alone was a lie about the
   * cloud response — and in the typed SDKs it was a hard decode failure.
   */
  brand: CrawlBrand;
  is_terminal: boolean;
  created_at: string;
  updated_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  [key: string]: unknown;
}

/**
 * Body for `POST /v1/crawl` — only `url` is required (empty → 400). The
 * `include_paths`/`exclude_paths` are path-regex allow/deny lists; everything
 * else falls back to the daemon default noted below.
 */
export interface CrawlStartBody {
  url: string;
  name?: string;
  /** `"markdown"` (default) or `"schema"`. */
  extract_mode?: "markdown" | "schema";
  /** JSON schema, required by the daemon when `extract_mode: "schema"`. */
  extract_schema?: Record<string, unknown>;
  persona_id?: number;
  include_paths?: string[];
  exclude_paths?: string[];
  /** Default 3. */
  max_depth?: number;
  /** Default 500. */
  page_budget?: number;
  /** In-process worker cap. Default 4. */
  max_concurrent?: number;
  /** Per-page politeness delay. Default 250. */
  delay_ms?: number;
  /** Default true. */
  respect_robots?: boolean;
  /** Default true. */
  same_domain?: boolean;
  /** Default true. */
  allow_subdomains?: boolean;
  /**
   * Content-selection spec applied to every crawled page:
   * `{ preset, include_comments, exclude_selectors, include_selectors, keep }`. Omit for default
   * extraction. Forwarded to the cloud when linked; honored locally in the self-host build.
   */
  content?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A SAVED crawl — a stored configuration with a stable slug.
 *
 * A {@link CrawlJob} is one RUN and its id dies with that run, so a crawl had no
 * stable handle to call. A definition owns the settings, so it can be re-run with
 * exactly those settings and — via `maxAge` — answered from the data it already
 * collected.
 */
export interface CrawlDefinition {
  id: number;
  slug: string;
  name: string;
  description?: string | null;
  seed_url: string;
  /** The saved start-crawl body. Send it back verbatim to edit. */
  config: Partial<CrawlStartBody> & { url?: string };
  /** Freshness used when a caller omits `maxAge` (null = always re-crawl). */
  default_max_age_seconds?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_run_at?: string | null;
  run_url?: string;
  data_url?: string;
  [key: string]: unknown;
}

/** `GET /v1/crawl/definitions` response — `{definitions: [...]}`, not a Page. */
export interface CrawlDefinitionList {
  definitions: CrawlDefinition[];
  [key: string]: unknown;
}

/** Body for {@link CrawlApi.save}. Supply exactly one of `config` / `fromCrawlId`. */
export interface SaveCrawlBody {
  name?: string;
  slug?: string;
  description?: string;
  /** Freshness applied when a caller omits `maxAge`; omit for "always re-crawl". */
  defaultMaxAgeSeconds?: number | null;
  /** The settings to save. */
  config?: CrawlStartBody;
  /**
   * Capture the settings an existing crawl ran with. Preferred over rebuilding
   * `config` client-side: a crawl's status view does not echo every knob, so a
   * rebuilt config silently substitutes defaults.
   */
  fromCrawlId?: number;
}

/**
 * Freshness provenance, present on every saved-crawl answer.
 *
 * Stamped into the BODY rather than only into headers, because an SDK caller (and
 * an MCP tool) receives a payload, not an HTTP response — a header-only signal
 * would be invisible exactly where it matters most.
 */
export interface CacheStamp {
  /** True when this answer reused already-collected data (nothing was crawled). */
  hit: boolean;
  age_seconds?: number;
  /** The crawl whose data was served. */
  source_crawl_id?: number;
}

/** A page of a crawl's collected rows, in the Workflow Data API's shape. */
export interface CrawlDataTable {
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  total?: number;
  truncated?: boolean;
}

/** Delivery controls for {@link CrawlApi.runSaved}. Never crawl settings. */
export interface RunSavedCrawlOptions {
  /** Reuse the last completed crawl if it finished within this many seconds. */
  maxAge?: number;
  /** Block until the crawl converges. Default false — a crawl is slow. */
  wait?: boolean;
  /** Seconds to block for when `wait` is set (server clamp 5–300). */
  timeout?: number;
  /** Rows of collected data to inline. */
  limit?: number;
}

/**
 * `POST /v1/crawl/definitions/:ref/run` — two shapes behind one call.
 *
 * On a freshness HIT (`cached: true`) the collected `data` is inline and nothing
 * was crawled. On a MISS a crawl was dispatched and `data` is absent — poll
 * `status_url`, or pass `wait: true`.
 */
export interface SavedCrawlRun {
  cached: boolean;
  _cache?: CacheStamp;
  definition: CrawlDefinition;
  crawl: CrawlJob;
  status_url?: string | null;
  data_url?: string | null;
  data?: CrawlDataTable | null;
  [key: string]: unknown;
}

/** `GET /v1/crawl/definitions/:ref/data` — a pure read; never crawls. */
export interface SavedCrawlData {
  definition: CrawlDefinition;
  crawl: CrawlJob | null;
  age_seconds?: number | null;
  data_url?: string | null;
  data?: CrawlDataTable | null;
  [key: string]: unknown;
}

/** `GET /v1/crawl` response — a non-Page envelope (mirrors `DataWorkflows`). */
export interface CrawlList {
  crawls: CrawlJob[];
  [key: string]: unknown;
}

/**
 * `POST /v1/crawl/:id/cancel` result — the refreshed view plus
 * `cancel_requested_now` (`true` iff this call flipped it to `stopping`;
 * `false` if it was already terminal). Not a 409 — always the view.
 */
export interface CrawlCancelResult extends CrawlJob {
  cancel_requested_now: boolean;
}

/**
 * One ORIGINAL document a crawl captured as a stored file (PDF / office doc /
 * image / CSV). `download_url` is a short-TTL signed GET — fetch it with no
 * further auth. `version` counts captures of `source_url` whose bytes changed
 * across re-crawls (1 = never changed); `crawl_ids` lists every crawl that
 * references this exact version (re-crawl dedupe links, one file → many crawls).
 */
export interface CrawlFileEntry {
  file_id: string;
  filename: string;
  content_type: string | null;
  size: number;
  version: number;
  source_url: string | null;
  crawl_ids: number[];
  created_at: string | null;
  download_url: string | null;
}

/** `GET /api/crawl/:id/files` — the documents one crawl run captured. */
export interface CrawlFilesResult {
  crawl_id: number;
  files: CrawlFileEntry[];
  total: number;
}

/** `GET /api/crawl/definitions/:ref/files` — documents from a saved crawl's recent run(s). */
export interface SavedCrawlFilesResult {
  definition: Record<string, unknown>;
  files: CrawlFileEntry[];
  total: number;
}

// ---------------------------------------------------------------------------
// keys — api/v1/keys.rs
// ---------------------------------------------------------------------------

/** A scoped `wlk_` API-key record (the hash is never serialized). */
export interface ApiKey {
  id: number;
  name: string;
  /** `wlk_` + first 6 chars — safe to display. */
  prefix: string;
  /** CSV scopes (read|run|admin). */
  scopes: string;
  enabled: number;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
  [key: string]: unknown;
}

/** `POST /v1/keys` response: the record plus the plaintext key — shown ONLY here. */
export interface ApiKeyCreated extends ApiKey {
  /** The raw `wlk_…` key. It cannot be recovered later — capture it now. */
  key: string;
}

// ---------------------------------------------------------------------------
// ws-ticket — api/v1/ws_ticket.rs
// ---------------------------------------------------------------------------

/** `POST /v1/ws-ticket` → single-use WebSocket connect ticket. */
export interface WsTicket {
  ticket: string;
  expires_in_secs: number;
  [key: string]: unknown;
}

/** WS ticket routes. `ai-preview` requires a `channel`. */
export type WsTicketRoute = "record" | "ai-preview";
