//! Wire models for the Writ agent API.
//!
//! Field-level shapes mirror the daemon source (`writ-agent/src/local/`),
//! never invented. Only stable scalar fields are strongly typed; everything else —
//! including any field a future daemon adds — lands in the `extra` map via
//! `#[serde(flatten)]`, so unknown fields never break deserialization. Boolean-ish
//! daemon columns arrive as SQLite `0/1` integers and are typed `Option<i64>` here
//! to match the wire exactly.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Catch-all for wire fields this SDK does not type. Keyed by field name.
pub type Extra = Map<String, Value>;

/// `GET /v1/agent` — lightweight daemon status (`server.rs::agent_status`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentStatus {
    pub status: String,
    pub version: Option<String>,
    pub active_runs: Option<i64>,
    pub encrypted: Option<bool>,
    pub due_monitors: Option<i64>,
    pub last_tick_at: Option<String>,
    pub warm_browser: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `GET /v1/health` — deep health probe (`server.rs::health`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Health {
    pub status: String,
    pub version: Option<String>,
    pub cipher_present: Option<bool>,
    pub db_ok: Option<bool>,
    pub keyring_ok: Option<bool>,
    pub active_runs: Option<i64>,
    pub warm_browser: Option<bool>,
    /// `{ last_tick_at, due_monitors }`.
    pub scheduler: Option<Value>,
    /// `{ linked, account_id }`.
    pub cloud_link: Option<Value>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A workflow row as returned by the API (`store/workflows.rs::Workflow`, shaped by
/// `api/v1/workflows.rs::redact`): `credentials_encrypted` never appears; the daemon
/// adds `has_credentials`, `credential_keys`, `placeholders`, `has_login` and
/// re-hydrates JSON-TEXT columns (`steps`, `functions`, …) into real JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Workflow {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub workflow_type: Option<String>,
    pub entry_url: Option<String>,
    /// Recorded steps, re-hydrated to a JSON array by the daemon.
    pub steps: Option<Value>,
    pub form_data: Option<Value>,
    pub functions: Option<Value>,
    pub is_active: Option<i64>,
    pub is_verified: Option<i64>,
    pub timeout_ms: Option<i64>,
    pub retry_count: Option<i64>,
    pub headless: Option<i64>,
    pub schedule_enabled: Option<i64>,
    pub schedule_interval_ms: Option<i64>,
    /// `interval` (default) | `daily` | `weekly`.
    pub schedule_kind: Option<String>,
    /// "HH:MM" local wall-clock fire time (daily/weekly).
    pub schedule_time: Option<String>,
    /// JSON array *string* of ISO weekday ints (weekly only) — not re-hydrated.
    pub schedule_days: Option<String>,
    pub schedule_tz: Option<String>,
    pub last_scheduled_at: Option<String>,
    pub next_scheduled_at: Option<String>,
    pub default_persona_id: Option<i64>,
    pub http_capable: Option<i64>,
    pub usage_count: Option<i64>,
    pub total_run_count: Option<i64>,
    pub total_failure_count: Option<i64>,
    pub consecutive_failures: Option<i64>,
    pub last_run_at: Option<String>,
    pub last_run_status: Option<String>,
    pub last_run_duration_ms: Option<i64>,
    pub last_failure_at: Option<String>,
    pub last_failure_error: Option<String>,
    pub cloud_callable: Option<i64>,
    pub execution_target: Option<String>,
    pub marketplace_slug: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    // redact()-computed additions:
    pub has_credentials: Option<bool>,
    /// Name-only view of the sealed credential map's keys — never values.
    pub credential_keys: Option<Vec<String>>,
    /// `{key, label, field_type}` run-input descriptors.
    pub placeholders: Option<Vec<Value>>,
    pub has_login: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `POST /v1/workflows/:id/run` → `202 {run_id, status:"running"}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RunStarted {
    pub run_id: i64,
    pub status: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Terminal run document returned by `workflows().run_wait(..)` (`?wait=true`).
///
/// A FAILED run arrives here as a normal value with `status == "failed"`, NOT as an
/// error: the call succeeded in REPORTING the outcome. Check `status`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RunCompleted {
    pub run_id: i64,
    /// One of `success` | `failed` | `timeout` | `cancelled`.
    pub status: String,
    #[serde(default)]
    pub done: bool,
    /// The run's result payload, when it produced one.
    #[serde(default)]
    pub data: Option<Value>,
    /// Why it failed. Present for non-success terminal states.
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    /// Populated only on the 504 (still-running) body.
    #[serde(default)]
    pub status_url: Option<String>,
    #[serde(default)]
    pub events_url: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Enriched run-feed item (`api/v1/runs.rs::RunFeedItem`).
///
/// `id` is a composite string `"<run_type>-<row_id>"` (e.g. `"workflow-3"`); the
/// numeric id for `runs().get/cancel/events` is [`RunFeedItem::row_id`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RunFeedItem {
    /// Composite id, unique across the feed: `"<run_type>-<row_id>"`.
    pub id: String,
    /// `workflow` | `check` | `automation` (open set).
    pub run_type: Option<String>,
    pub entity_id: Option<i64>,
    pub entity_name: Option<String>,
    /// `running | success | failed | cancelled | timeout | captcha_required |
    /// twofa_required` — treat as an open string enum.
    pub status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub trigger_source: Option<String>,
    pub error: Option<String>,
    pub detail_url_hint: Option<String>,
    pub data_url_hint: Option<String>,
    /// Workflow runs only: extracted record count.
    pub rows_extracted: Option<i64>,
    /// Check runs only: whether the check detected a change.
    pub change_detected: Option<bool>,
    /// Execution lane: `http` | `browser` | `hybrid` (workflow runs).
    pub engine: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl RunFeedItem {
    /// The numeric run row id parsed out of the composite `id`
    /// (`"workflow-3"` → `3`). A purely numeric `id` also parses.
    pub fn row_id(&self) -> Option<i64> {
        self.id
            .rsplit_once('-')
            .and_then(|(_, tail)| tail.parse().ok())
            .or_else(|| self.id.parse().ok())
    }

    /// True while the run is still in flight.
    pub fn is_running(&self) -> bool {
        self.status == "running"
    }
}

/// `GET /v1/runs/:id/results` → `{run_id, status, result}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RunResults {
    pub run_id: i64,
    pub status: String,
    /// The run's raw `result_data` JSON (`null` when the run produced none).
    pub result: Value,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `GET /v1/runs/:id/data` → `{run_id, status, data}` (default JSON lane).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RunData {
    pub run_id: i64,
    pub status: String,
    /// The run's extracted data (`result_data.extracted_data`, falling back to the
    /// whole result payload).
    pub data: Value,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Outcome of a cancel call. A `202` answers `{run_id, status:"cancel_requested"}`;
/// a `409` answers `{status:"not_running", ...}` — per DESIGN.md §7 the 409 is a
/// valid result, not an error, so both land here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CancelOutcome {
    /// The run row id (present on run-scoped cancels and signalled workflow cancels).
    pub run_id: Option<i64>,
    /// The workflow id (workflow-scoped cancels only).
    pub id: Option<i64>,
    /// `cancel_requested` | `not_running`.
    pub status: String,
    /// Run-scoped 409s include the run's actual terminal status here.
    pub run_status: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl CancelOutcome {
    /// True when a live run was actually signalled.
    pub fn cancel_requested(&self) -> bool {
        self.status == "cancel_requested"
    }
}

/// One frame of the `GET /v1/runs/:id/events` SSE stream
/// (`engine/events.rs::RunEvent`, tagged on `"event"`, snake_case).
///
/// `Finished` and `Error` are stream-closing. Unrecognized frames (a future daemon
/// vocabulary) decode as [`RunEvent::Unknown`] instead of failing.
#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    /// The run is registered and about to drive its steps.
    Started { run_id: i64, total_steps: u64 },
    /// A step transitioned; `status` ∈ `running|succeeded|failed|skipped` (open set).
    Step {
        run_id: i64,
        index: u64,
        step_type: String,
        status: String,
    },
    /// Coarse progress hint.
    Progress {
        run_id: i64,
        completed: u64,
        total: u64,
    },
    /// Terminal: final status (`success | failed | cancelled | timeout |
    /// captcha_required | twofa_required`, open set). Stream-closing.
    Finished { run_id: i64, status: String },
    /// Terminal: the run failed around the step loop. Stream-closing.
    Error { run_id: i64, message: String },
    /// A frame this SDK version does not recognize (raw payload preserved).
    Unknown(Value),
}

/// Private tagged mirror of the daemon's known event vocabulary.
#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum TaggedRunEvent {
    Started {
        run_id: i64,
        total_steps: u64,
    },
    Step {
        run_id: i64,
        index: u64,
        step_type: String,
        status: String,
    },
    Progress {
        run_id: i64,
        completed: u64,
        total: u64,
    },
    Finished {
        run_id: i64,
        status: String,
    },
    Error {
        run_id: i64,
        message: String,
    },
}

impl From<TaggedRunEvent> for RunEvent {
    fn from(ev: TaggedRunEvent) -> Self {
        match ev {
            TaggedRunEvent::Started {
                run_id,
                total_steps,
            } => RunEvent::Started {
                run_id,
                total_steps,
            },
            TaggedRunEvent::Step {
                run_id,
                index,
                step_type,
                status,
            } => RunEvent::Step {
                run_id,
                index,
                step_type,
                status,
            },
            TaggedRunEvent::Progress {
                run_id,
                completed,
                total,
            } => RunEvent::Progress {
                run_id,
                completed,
                total,
            },
            TaggedRunEvent::Finished { run_id, status } => RunEvent::Finished { run_id, status },
            TaggedRunEvent::Error { run_id, message } => RunEvent::Error { run_id, message },
        }
    }
}

impl<'de> Deserialize<'de> for RunEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        Ok(
            match serde_json::from_value::<TaggedRunEvent>(value.clone()) {
                Ok(known) => known.into(),
                Err(_) => RunEvent::Unknown(value),
            },
        )
    }
}

impl RunEvent {
    /// Parse one SSE `data:` payload. Never fails: unparseable/unknown frames become
    /// [`RunEvent::Unknown`] (with the raw text wrapped as a JSON string when the
    /// payload is not even JSON).
    pub fn parse(data: &str) -> RunEvent {
        match serde_json::from_str::<RunEvent>(data) {
            Ok(ev) => ev,
            Err(_) => RunEvent::Unknown(Value::String(data.to_string())),
        }
    }

    /// The run id this event belongs to, when carried.
    pub fn run_id(&self) -> Option<i64> {
        match self {
            RunEvent::Started { run_id, .. }
            | RunEvent::Step { run_id, .. }
            | RunEvent::Progress { run_id, .. }
            | RunEvent::Finished { run_id, .. }
            | RunEvent::Error { run_id, .. } => Some(*run_id),
            RunEvent::Unknown(v) => v.get("run_id").and_then(Value::as_i64),
        }
    }

    /// True for the two stream-closing variants (`Finished` / `Error`).
    pub fn is_terminal(&self) -> bool {
        matches!(self, RunEvent::Finished { .. } | RunEvent::Error { .. })
    }
}

/// Final answer of [`crate::resources::Workflows::run_and_wait`].
#[derive(Debug, Clone)]
pub struct RunOutcome {
    /// The final run row (fetched once after the terminal event).
    pub run: RunFeedItem,
    /// `runs().results()` payload when `RunOptions::include_results` was set.
    pub results: Option<RunResults>,
}

/// A monitor (target) row, enriched with live check state
/// (`api/v1/monitors.rs::enrich` over `store/targets.rs`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Monitor {
    pub id: i64,
    pub url: Option<String>,
    pub name: Option<String>,
    /// `content` | `uptime`.
    pub check_type: Option<String>,
    pub enabled: Option<i64>,
    pub check_period_ms: Option<i64>,
    pub requires_playwright: Option<i64>,
    // Live-state enrichment:
    pub state: Option<String>,
    pub last_checked_at: Option<String>,
    pub status_code: Option<i64>,
    pub is_up: Option<bool>,
    pub last_change_at: Option<String>,
    pub state_updated_at: Option<String>,
    pub changes_count: Option<i64>,
    pub selector_count: Option<i64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `GET /v1/monitors/:id/changes` — paginated change + uptime history.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MonitorHistory {
    pub monitor_id: i64,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub has_more: Option<bool>,
    /// Content-diff history rows, newest first.
    pub changes: Vec<Value>,
    /// Up/down + SSL samples, newest first.
    pub uptime_checks: Vec<Value>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A content selector under a monitor (`store/target_selectors.rs`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Selector {
    pub id: i64,
    pub target_id: Option<i64>,
    pub name: Option<String>,
    pub selector: Option<String>,
    pub description: Option<String>,
    pub enabled: Option<i64>,
    /// `text` | `html` | `visual`.
    pub content_type: Option<String>,
    pub ignore_regex: Option<String>,
    pub priority: Option<i64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A field extractor under a selector (`store/selector_extractors.rs`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Extractor {
    pub id: i64,
    pub target_selector_id: Option<i64>,
    pub name: Option<String>,
    pub output_name: Option<String>,
    pub enabled: Option<i64>,
    pub extract_type: Option<String>,
    /// JSON-TEXT on the wire (string) — kept loose.
    pub config: Option<Value>,
    pub is_array: Option<i64>,
    pub default_value: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// An automation (event→action rule) row, JSON-TEXT columns parsed by the daemon
/// (`api/v1/automations.rs::automation_response`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Automation {
    pub id: i64,
    pub name: String,
    pub enabled: Option<i64>,
    pub event_type: Option<String>,
    pub conditions: Option<Value>,
    pub actions: Option<Value>,
    pub blocks: Option<Value>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A persona in its redacted wire form (`api/v1/personas.rs::shape`): secrets
/// collapse to `has_*` booleans + `linked_secrets` names; no `*_encrypted` column
/// ever appears.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Persona {
    pub id: i64,
    pub name: Option<String>,
    pub description: Option<String>,
    pub target_domain: Option<String>,
    pub login_username: Option<String>,
    pub has_password: Option<bool>,
    pub twofa_method: Option<String>,
    pub has_totp_seed: Option<bool>,
    pub email_otp_mode: Option<String>,
    pub has_fingerprint: Option<bool>,
    pub has_proxy: Option<bool>,
    pub is_active: Option<bool>,
    pub validation_status: Option<String>,
    pub has_warm_session: Option<bool>,
    pub session_expires_at: Option<String>,
    pub last_login_at: Option<String>,
    pub last_used_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// `[{id, name}]` workflows pinned to this persona.
    pub linked_workflows: Option<Vec<Value>>,
    pub linked_secrets: Option<Value>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Secret **metadata** (`api/v1/secrets.rs::meta`) — the value is never returned.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SecretMeta {
    pub id: Option<i64>,
    /// The unique TEXT key the secret is addressed by.
    pub key: String,
    /// Cloud-contract alias of `key`.
    pub name: Option<String>,
    pub description: Option<String>,
    /// e.g. `credentials` | `card` | free-form.
    pub category: Option<String>,
    pub is_credential: Option<bool>,
    pub is_card: Option<bool>,
    /// Credential secrets only: the (non-secret) username half.
    pub username: Option<String>,
    /// Card secrets only: last 4 digits.
    pub card_last4: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_used_at: Option<String>,
    pub use_count: Option<i64>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `GET /v1/vault/status` → `{enabled, locked, idle_timeout_secs}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct VaultStatus {
    pub enabled: bool,
    pub locked: bool,
    pub idle_timeout_secs: Option<i64>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A stored-file handle in its OpenAI-style wire form
/// (`api/v1/files.rs::WireStoredFile`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct StoredFile {
    /// TEXT id, `file_<hex>`.
    pub id: String,
    pub object: Option<String>,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    /// Size in bytes.
    pub bytes: Option<i64>,
    /// UNIX epoch seconds.
    pub created_at: Option<i64>,
    pub status: Option<String>,
    /// `upload` | `api` | `workflow_output`.
    pub source: Option<String>,
    pub purpose: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A scoped `wlk_` API-key record (`store/local_api_keys.rs`; `key_hash` is never
/// serialized by the daemon). The plaintext `key` appears **only** in the create
/// response — capture it immediately.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ApiKey {
    pub id: i64,
    pub name: Option<String>,
    /// `wlk_` + first 6 chars — safe to display.
    pub prefix: Option<String>,
    /// CSV of scopes: `read|run|admin`.
    pub scopes: Option<String>,
    pub enabled: Option<i64>,
    pub last_used_at: Option<String>,
    pub created_at: Option<String>,
    pub revoked_at: Option<String>,
    /// The one-time plaintext key (create response only; never recoverable later).
    pub key: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `POST /v1/ws-ticket` → `{ticket, expires_in_secs}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WsTicket {
    /// Single-use `wtk_…` connect ticket.
    pub ticket: String,
    pub expires_in_secs: u64,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A Dragnet crawl-job status view (`api/v1/crawl.rs::to_view` over
/// `store/crawl_jobs.rs::CrawlJob`). One crawl fans a seed URL across a bounded
/// in-process worker pool; extracted pages aggregate under the synthetic
/// [`CrawlJob::data_workflow_id`] workflow, read back through the Data API. As with
/// monitor rows, the boolean columns arrive as SQLite `0/1` ints and stay typed as
/// `i64` (not coerced).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CrawlJob {
    pub id: i64,
    pub name: String,
    pub seed_url: String,
    /// Path-regex allowlist (parsed from JSON-TEXT into an array by the daemon view).
    pub include_paths: Vec<String>,
    /// Path-regex denylist.
    pub exclude_paths: Vec<String>,
    pub max_depth: i64,
    /// boolean as `0/1`.
    pub same_domain: i64,
    /// boolean as `0/1`.
    pub allow_subdomains: i64,
    /// `markdown` | `schema`.
    pub extract_mode: String,
    /// The JSON schema object driving `schema` extraction (`null` for markdown).
    pub extract_schema: Option<Value>,
    pub persona_id: Option<i64>,
    /// boolean as `0/1`.
    pub respect_robots: i64,
    pub delay_ms: i64,
    pub max_concurrent: i64,
    pub page_budget: i64,
    /// The synthetic per-crawl workflow the extracted pages aggregate under.
    pub workflow_id: Option<i64>,
    /// Alias of `workflow_id` the view adds for the Data API
    /// (`/v1/workflows/{data_workflow_id}/data`).
    pub data_workflow_id: Option<i64>,
    pub concierge_session_id: Option<i64>,
    /// `queued | mapping | crawling | stopping | completed | failed | cancelled`
    /// (terminal: the last three) — treat as an open string enum.
    pub status: String,
    pub pages_discovered: i64,
    pub pages_done: i64,
    pub pages_failed: i64,
    pub pages_skipped: i64,
    pub workers_active: i64,
    pub current_depth: i64,
    pub error: Option<String>,
    /// boolean as `0/1`.
    pub cancel_requested: i64,
    /// Always `"Dragnet"`.
    pub brand: String,
    /// Daemon-computed convenience: true for the terminal states.
    pub is_terminal: bool,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Body for `POST /v1/crawl` — start a Dragnet whole-site crawl. Only `url` is
/// required (empty → the daemon `400`s); every unset optional field is **omitted**
/// from the wire body so the daemon fills its documented default.
#[derive(Debug, Clone, Default, Serialize)]
pub struct CrawlStartParams {
    /// Seed URL to crawl from (required).
    pub url: String,
    /// Human label for the crawl (defaults daemon-side).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `"markdown"` (default) | `"schema"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extract_mode: Option<String>,
    /// JSON schema object driving `schema` extraction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extract_schema: Option<Value>,
    /// Persona to crawl as.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona_id: Option<i64>,
    /// Path-regex allowlist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_paths: Option<Vec<String>>,
    /// Path-regex denylist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_paths: Option<Vec<String>>,
    /// Max link depth from the seed (default 3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<i64>,
    /// Hard cap on pages fetched (default 500).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_budget: Option<i64>,
    /// In-process worker cap (default 4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_concurrent: Option<i64>,
    /// Politeness delay between fetches, ms (default 250).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<i64>,
    /// Honor `robots.txt` (default true).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub respect_robots: Option<bool>,
    /// Stay on the seed's domain (default true).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_domain: Option<bool>,
    /// Allow subdomains of the seed domain (default true).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_subdomains: Option<bool>,
}

/// `GET /v1/crawl` → `{crawls: [CrawlJob…]}`. **Not** a [`crate::Page`]: this
/// endpoint answers a named object, mirroring the daemon's other non-envelope list
/// (`/v1/data`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CrawlList {
    pub crawls: Vec<CrawlJob>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `POST /v1/crawl/:id/cancel` → the refreshed [`CrawlJob`] view plus
/// `cancel_requested_now` (true iff this call flipped a live crawl to `stopping`;
/// false when it was already terminal). Never a 409 — always the view.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CrawlCancel {
    /// The refreshed crawl view.
    #[serde(flatten)]
    pub job: CrawlJob,
    /// True iff this call is the one that requested cancellation.
    pub cancel_requested_now: bool,
}

/// One row of `GET /v1/datasets` — a dataset that has accumulated extracted data,
/// sourced from either a crawl or a workflow.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Dataset {
    pub id: i64,
    pub name: String,
    /// `"crawl"` | `"workflow"` — the dataset's origin lane.
    pub source_type: String,
    pub run_count: i64,
    pub last_updated: Option<String>,
    pub origin: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `GET /v1/datasets` → `{datasets: [Dataset…]}`. **Not** a [`crate::Page`]: like
/// [`CrawlList`], this endpoint answers a named object rather than the list
/// envelope (unwrap its `datasets` field).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DatasetList {
    pub datasets: Vec<Dataset>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `GET /v1/datasets/:id` → one dataset's metadata + schema. `columns`/`facets`
/// are query-engine-driven, so they stay loosely-typed [`Value`]s.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DatasetMeta {
    pub id: i64,
    pub name: String,
    /// `"crawl"` | `"workflow"`.
    pub source_type: String,
    /// Column descriptors (shape driven by the query engine).
    pub columns: Value,
    /// Per-column facet values.
    pub facets: Value,
    pub row_count: i64,
    pub run_count: i64,
    pub truncated: bool,
    #[serde(flatten)]
    pub extra: Extra,
}

/// The dataset a search hit belongs to — the identifying subset the search
/// endpoints echo back per result.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DatasetRef {
    pub id: i64,
    pub name: Option<String>,
    /// `"crawl"` | `"workflow"`.
    pub source_type: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// One hit from `GET /v1/datasets/search` or `GET /v1/datasets/:id/search`.
/// `fields`/`highlight` are query-engine-driven (dynamic columns), so they stay
/// loosely-typed [`Value`]s.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DatasetSearchHit {
    pub dataset: DatasetRef,
    pub run_id: Option<i64>,
    pub run_at: Option<String>,
    /// The matched row's fields (shape driven by the query engine).
    pub fields: Value,
    /// Per-field highlight fragments (shape driven by the query engine).
    pub highlight: Value,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Output shape for a dataset read (the `?format=` query param).
///
/// `Json` is the documented envelope. The rest render TEXT and are CONTENT-AWARE:
/// a dataset whose records carry long-form content (a crawl's pages have
/// `markdown`) renders as documents, anything else as a table. Because they are
/// not JSON they are served by the `*_text` methods on [`crate::resources::Datasets`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatasetFormat {
    /// The documented JSON envelope (the API default).
    Json,
    /// Comma-separated table.
    Csv,
    /// Readable prose — documents for a crawl, a table otherwise.
    Markdown,
    /// A standalone HTML document (meant to be saved/viewed, not parsed).
    Html,
}

impl DatasetFormat {
    /// The wire value for the `format` query param.
    pub fn as_str(self) -> &'static str {
        match self {
            DatasetFormat::Json => "json",
            DatasetFormat::Csv => "csv",
            DatasetFormat::Markdown => "markdown",
            DatasetFormat::Html => "html",
        }
    }
}

/// `GET /v1/datasets/search` and `GET /v1/datasets/:id/search` → full-text search
/// results across the unified dataset index.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DatasetSearchResult {
    pub query: String,
    pub terms: Vec<String>,
    pub results: Vec<DatasetSearchHit>,
    pub total: i64,
    pub truncated: bool,
    pub scanned_runs: i64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn run_feed_item_row_id_parses_composite() {
        let item: RunFeedItem =
            serde_json::from_value(json!({"id": "workflow-3", "status": "success"})).unwrap();
        assert_eq!(item.row_id(), Some(3));
        let item: RunFeedItem =
            serde_json::from_value(json!({"id": "check-142", "status": "running"})).unwrap();
        assert_eq!(item.row_id(), Some(142));
        assert!(item.is_running());
        let bare: RunFeedItem =
            serde_json::from_value(json!({"id": "7", "status": "success"})).unwrap();
        assert_eq!(bare.row_id(), Some(7));
    }

    #[test]
    fn run_event_parses_known_and_unknown() {
        let ev = RunEvent::parse(r#"{"event":"started","run_id":9,"total_steps":4}"#);
        assert_eq!(
            ev,
            RunEvent::Started {
                run_id: 9,
                total_steps: 4
            }
        );
        assert!(!ev.is_terminal());

        let ev = RunEvent::parse(
            r#"{"event":"step","run_id":9,"index":1,"step_type":"click","status":"succeeded"}"#,
        );
        assert_eq!(ev.run_id(), Some(9));

        let ev = RunEvent::parse(r#"{"event":"finished","run_id":9,"status":"success"}"#);
        assert!(ev.is_terminal());

        let ev = RunEvent::parse(r#"{"event":"error","run_id":9,"message":"navigation failed"}"#);
        assert!(ev.is_terminal());

        // Future vocabulary degrades to Unknown, keeping run_id readable.
        let ev = RunEvent::parse(r#"{"event":"warp","run_id":9,"factor":5}"#);
        assert!(matches!(ev, RunEvent::Unknown(_)));
        assert_eq!(ev.run_id(), Some(9));
        assert!(!ev.is_terminal());

        // Non-JSON payload wraps the raw text.
        let ev = RunEvent::parse("not json");
        assert_eq!(ev, RunEvent::Unknown(Value::String("not json".into())));
    }

    #[test]
    fn crawl_cancel_flattens_job_and_splits_cancel_flag() {
        // The cancel view is the CrawlJob fields plus a sibling `cancel_requested_now`;
        // the flag must land on the outer struct, not get swallowed by CrawlJob.extra.
        let c: CrawlCancel = serde_json::from_value(json!({
            "id": 5, "name": "Dragnet: example.com", "seed_url": "https://example.com",
            "include_paths": ["^/docs"], "exclude_paths": [], "status": "stopping",
            "brand": "Dragnet", "is_terminal": false, "workflow_id": 77,
            "data_workflow_id": 77, "cancel_requested_now": true, "some_future": 1
        }))
        .unwrap();
        assert!(c.cancel_requested_now);
        assert_eq!(c.job.id, 5);
        assert_eq!(c.job.status, "stopping");
        assert_eq!(c.job.brand, "Dragnet");
        assert_eq!(c.job.data_workflow_id, Some(77));
        assert_eq!(c.job.include_paths, vec!["^/docs".to_string()]);
        // Unknown fields still land in CrawlJob.extra, and the flag is NOT among them.
        assert_eq!(c.job.extra["some_future"], 1);
        assert!(!c.job.extra.contains_key("cancel_requested_now"));
    }

    #[test]
    fn crawl_start_params_omit_unset_fields() {
        let body = serde_json::to_value(CrawlStartParams {
            url: "https://example.com".into(),
            max_depth: Some(2),
            respect_robots: Some(true),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(body["url"], "https://example.com");
        assert_eq!(body["max_depth"], 2);
        assert_eq!(body["respect_robots"], true);
        // Unset optionals are omitted, not sent as null.
        assert!(body.get("name").is_none());
        assert!(body.get("persona_id").is_none());
        assert!(body.get("page_budget").is_none());
        assert!(body.get("include_paths").is_none());
    }

    #[test]
    fn workflow_unknown_fields_land_in_extra() {
        let wf: Workflow = serde_json::from_value(json!({
            "id": 5, "name": "scrape", "steps": [], "some_future_field": {"x": 1}
        }))
        .unwrap();
        assert_eq!(wf.id, 5);
        assert_eq!(wf.extra["some_future_field"]["x"], 1);
    }
}
