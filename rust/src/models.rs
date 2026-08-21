//! Wire models for the Writ agent API.
//!
//! Field-level shapes mirror the daemon source (`writ-agent/src/local/`),
//! never invented. Only stable scalar fields are strongly typed; everything else —
//! including any field a future daemon adds — lands in the `extra` map via
//! `#[serde(flatten)]`, so unknown fields never break deserialization. Boolean-ish
//! daemon columns arrive as SQLite `0/1` integers and are typed `Option<i64>` here
//! to match the wire exactly.

use std::time::Duration;

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
/// Display naming a crawl view carries, in the TWO shapes two different services
/// answer with:
///
/// - the LOCAL daemon sends a bare string — `"Dragnet"`
/// - Writ Cloud sends an object — `{"crawl": "Dragnet", "agent": "Scribe"}`
///
/// Typing this as a plain `String` made [`CloudClient::crawl`] fail to decode
/// against the real cloud; a stub server with a hand-written body never showed
/// it. Accepting both keeps ONE [`CrawlJob`] usable from either venue, which is
/// the point of the local/cloud symmetry.
///
/// [`CloudClient::crawl`]: crate::CloudClient::crawl
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Brand {
    /// The daemon form: just the crawler's display name.
    Name(String),
    /// The cloud form: the crawler's name plus the AI executor's.
    Pair {
        /// Crawler display name.
        crawl: String,
        /// AI-executor display name.
        #[serde(default)]
        agent: Option<String>,
    },
}

impl Default for Brand {
    fn default() -> Self {
        Brand::Name(String::new())
    }
}

impl Brand {
    /// The crawler's display name, whichever shape arrived.
    pub fn crawl(&self) -> &str {
        match self {
            Brand::Name(name) => name,
            Brand::Pair { crawl, .. } => crawl,
        }
    }

    /// The AI-executor display name — cloud only, `None` from the daemon.
    pub fn agent(&self) -> Option<&str> {
        match self {
            Brand::Name(_) => None,
            Brand::Pair { agent, .. } => agent.as_deref(),
        }
    }
}

/// An explicit `"brand": null` must decode to the empty default, not fail the
/// whole crawl view: it is a display label. `#[serde(default)]` alone does not
/// cover this — it handles an ABSENT key, while a present null is still fed to
/// the untagged enum, which has no null variant.
fn de_brand<'de, D>(deserializer: D) -> std::result::Result<Brand, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<Brand>::deserialize(deserializer)?.unwrap_or_default())
}

impl std::fmt::Display for Brand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.crawl())
    }
}

/// One ORIGINAL document a crawl captured as a stored file — a PDF, office
/// document, image or CSV the crawler reached. The crawl's dataset holds the
/// EXTRACTED TEXT; this is the source file it came from.
///
/// `download_url` is a short-TTL signed GET: fetch it with no further auth and
/// stream it straight to disk. `version` counts captures of `source_url` whose
/// bytes changed across re-crawls (1 = never changed), and `crawl_ids` lists
/// every crawl referencing this exact version — re-crawl dedupe links one file
/// to many crawls rather than storing it again.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CrawlFileEntry {
    pub file_id: String,
    pub filename: String,
    /// `None` when the server recorded no content type — distinct from `""`.
    pub content_type: Option<String>,
    pub size: i64,
    pub version: i64,
    pub source_url: Option<String>,
    pub crawl_ids: Vec<i64>,
    pub created_at: Option<String>,
    pub download_url: Option<String>,
}

/// The documents one crawl run captured (`GET /api/crawl/{id}/files`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CrawlFilesResult {
    pub crawl_id: i64,
    pub files: Vec<CrawlFileEntry>,
    pub total: i64,
}

/// Documents from a saved crawl's recent run(s)
/// (`GET /api/crawl/definitions/{ref}/files`).
///
/// `definition` stays an untyped value: this crate does not otherwise model
/// saved-crawl definitions, and inventing a partial struct would silently drop
/// fields the API adds later.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SavedCrawlFilesResult {
    pub definition: serde_json::Value,
    pub files: Vec<CrawlFileEntry>,
    pub total: i64,
}

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
    /// Display naming for this crawl. Arrives in TWO shapes — see [`Brand`].
    #[serde(deserialize_with = "de_brand")]
    pub brand: Brand,
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
    /// `"regular"` (default, deterministic) | `"ai"` (an agent fleet reads each page
    /// against `extract_prompt`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor: Option<String>,
    /// Required with `executor: "ai"`: what each agent extracts per page, in plain language.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extract_prompt: Option<String>,
    /// How each page is fetched: `"auto"` (default) | `"http"` | `"browser"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render_mode: Option<String>,
    /// OCR policy for non-HTML docs / DOM-empty renders: `"auto"` (default) | `"off"` | `"force"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_mode: Option<String>,
    /// Plain-English goal; scopes the crawl to matching pages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
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
    /// URLs fetched per shard batch (default 20).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shard_size: Option<i64>,
    /// Route every shard through the platform residential network (premium) — for
    /// sites that block datacenter IPs. A persona crawl forces it on. Money-safe:
    /// degrades to direct when unfunded. Default false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_residential: Option<bool>,
    /// Throughput tier: `"slow"` | `"normal"` (default) | `"fast"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
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

// ---------------------------------------------------------------------------
// saved crawls (the callable crawl API)
//
// A [`CrawlJob`] is one RUN and its id dies with that run, so a crawl had no
// stable handle to call. A definition owns the settings, so it can be re-run with
// exactly those settings and — via `max_age` — answered from the data it already
// collected.
// ---------------------------------------------------------------------------

/// A SAVED crawl — a stored configuration with a stable slug.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CrawlDefinition {
    pub id: i64,
    pub slug: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub seed_url: String,
    /// The saved start-crawl body. Send it back verbatim to edit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
    /// Freshness used when a caller omits `max_age`; `None` = always re-crawl.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_max_age_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `GET /v1/crawl/definitions` — `{definitions: [...]}`, not a page envelope.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CrawlDefinitionList {
    pub definitions: Vec<CrawlDefinition>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Body for saving a crawl. Set exactly one of `config` / `from_crawl_id`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SaveCrawlParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Freshness applied when a caller omits `max_age`; omit for "always re-crawl".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_max_age_seconds: Option<i64>,
    /// The settings to save.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<CrawlStartParams>,
    /// Capture the settings an existing crawl ran with. Preferred over rebuilding
    /// `config`: a crawl's status view does not echo every knob, so a rebuilt config
    /// silently substitutes defaults.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_crawl_id: Option<i64>,
}

/// DELIVERY controls for a saved-crawl run. Never crawl settings — those are saved.
#[derive(Debug, Clone, Default)]
pub struct RunSavedCrawlParams {
    /// Reuse the last completed crawl when it finished within this window. `None` or
    /// zero always re-crawls.
    pub max_age: Option<Duration>,
    /// Block until the crawl converges. Default false: a whole-site crawl routinely
    /// outlives an HTTP request.
    pub wait: bool,
    /// How long to block when `wait` is set (server clamp 5–300 s).
    pub timeout: Option<Duration>,
    /// Cap on the rows of collected data inlined in the response.
    pub limit: Option<i64>,
}

/// Freshness provenance carried by every saved-crawl answer.
///
/// Stamped into the BODY rather than only into headers, because an SDK caller
/// receives a decoded payload, not a `Response` — a header-only signal would be
/// invisible exactly where it matters.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CacheStamp {
    /// True when the answer reused already-collected data (nothing was crawled).
    pub hit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub age_seconds: Option<i64>,
    /// The crawl whose data was served.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_crawl_id: Option<i64>,
}

/// A page of a crawl's collected rows, in the Workflow Data API's shape.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CrawlDataTable {
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub rows: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
    #[serde(default)]
    pub truncated: bool,
}

/// `POST /v1/crawl/definitions/:ref/run` — two shapes behind one call.
///
/// On a freshness HIT (`cached` true) `data` is inline and nothing was crawled. On
/// a MISS a crawl was dispatched and `data` is `None`: poll `status_url`, or set
/// `wait`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SavedCrawlRun {
    #[serde(default)]
    pub cached: bool,
    #[serde(rename = "_cache", default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<CacheStamp>,
    #[serde(default)]
    pub definition: CrawlDefinition,
    #[serde(default)]
    pub crawl: CrawlJob,
    #[serde(default)]
    pub status_url: Option<String>,
    #[serde(default)]
    pub data_url: Option<String>,
    #[serde(default)]
    pub data: Option<CrawlDataTable>,
    /// Present only on the `504` overrun answer, which the SDK converts into
    /// [`crate::WritError::RunTimeout`] so the crawl stays collectable.
    #[serde(default)]
    pub crawl_id: Option<i64>,
    #[serde(default)]
    pub retryable: bool,
    #[serde(flatten)]
    pub extra: Extra,
}

/// `GET /v1/crawl/definitions/:ref/data` — a pure read that never crawls.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SavedCrawlData {
    #[serde(default)]
    pub definition: CrawlDefinition,
    #[serde(default)]
    pub crawl: Option<CrawlJob>,
    #[serde(default)]
    pub age_seconds: Option<f64>,
    #[serde(default)]
    pub data_url: Option<String>,
    #[serde(default)]
    pub data: Option<CrawlDataTable>,
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

// ---------------------------------------------------------------------------
// file assets — a run's bindable INPUTS and its captured OUTPUTS
// ---------------------------------------------------------------------------

/// One bindable file input on a workflow — see [`file_slots`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileSlot {
    /// Key to use in the run's `files` map (`RunOptions::files`).
    pub slot: String,
    pub label: String,
    pub is_multiple: bool,
    /// File pinned on the step. `Some` ⇒ the run works with NO binding at all,
    /// and binding one overrides it for that run only.
    pub default_file_id: Option<String>,
    pub default_filename: Option<String>,
    /// `true` when the workflow's author named the slot; `false` when it is
    /// keyed on the step id because the step only pins a file.
    pub declared: bool,
}

/// A file a run CAPTURED (a `wait_for_download` step) — see [`output_files`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutputFile {
    /// Handle in the vault — read the bytes with `client.files().content(..)`.
    pub file_id: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub content_type: String,
    /// The step's `output_key`, when it named the capture for later reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_key: Option<String>,
}

fn first_non_empty(vals: [Option<&str>; 3]) -> Option<String> {
    vals.into_iter()
        .flatten()
        .find(|s| !s.is_empty())
        .map(str::to_string)
}

/// The file inputs of a workflow — the valid keys for the run's `files` map.
///
/// Every `upload` step is a file input, of one of two kinds:
///
/// * the step names a `file_slot` — an abstract slot whose file the CALLER
///   supplies. With no [`FileSlot::default_file_id`] it must be bound or the
///   step fails;
/// * the step pins a concrete file. It is keyed `step:<step id>` and carries
///   that file as the default, so the workflow runs untouched — bind it only to
///   run against a DIFFERENT file.
///
/// Derived from `workflow.steps` on the client, so it costs no extra round trip
/// and works against any daemon version. A step's binding lives in `config` when
/// the editor wrote it and in `options` when the recorder did; both are read,
/// `config` winning as the explicit later edit. De-duped by slot,
/// order-preserving; empty when the workflow has no upload steps.
pub fn file_slots(workflow: &Workflow) -> Vec<FileSlot> {
    let Some(Value::Array(steps)) = workflow.steps.as_ref() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (i, step) in steps.iter().enumerate() {
        let Some(obj) = step.as_object() else {
            continue;
        };
        if obj.get("type").and_then(Value::as_str) != Some("upload") {
            continue;
        }
        let sub = |key: &str, field: &str| -> Option<String> {
            obj.get(key)
                .and_then(Value::as_object)
                .and_then(|o| o.get(field))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let named = sub("config", "file_slot").or_else(|| sub("options", "file_slot"));
        let declared = named.is_some();
        let slot = match named {
            Some(s) => s,
            // Keyed on the step's own id, never an ordinal: a binding has to
            // survive the steps being reordered or one being disabled.
            None => match obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                Some(id) => format!("step:{id}"),
                None => format!("upload:{}", i + 1),
            },
        };
        if !seen.insert(slot.clone()) {
            continue;
        }
        let default_file_id = sub("config", "file_id").or_else(|| sub("options", "file_id"));
        let cfg_name = sub("config", "file_name");
        let opt_filename = sub("options", "filename");
        let opt_file_name = sub("options", "file_name");
        let default_filename = first_non_empty([
            cfg_name.as_deref(),
            opt_filename.as_deref(),
            opt_file_name.as_deref(),
        ]);
        let cfg_label = sub("config", "label");
        let opt_label = sub("options", "label");
        let label = first_non_empty([
            cfg_label.as_deref(),
            opt_label.as_deref(),
            default_filename.as_deref(),
        ])
        .unwrap_or_else(|| {
            if declared {
                slot.replace('_', " ")
            } else {
                format!("File {}", i + 1)
            }
        });
        let is_multiple = ["config", "options"].iter().any(|k| {
            obj.get(*k)
                .and_then(Value::as_object)
                .and_then(|o| o.get("is_multiple"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });
        out.push(FileSlot {
            slot,
            label,
            is_multiple,
            default_file_id,
            default_filename,
            declared,
        });
    }
    out
}

/// Files captured by a run's download steps.
///
/// A `wait_for_download` step stores what the browser downloaded and reports it
/// as `result_data.output_files`. Accepts the terminal run document, its
/// `result_data`, or a results payload — whichever you hold — and returns an
/// empty vec when the run captured nothing.
pub fn output_files(payload: &Value) -> Vec<OutputFile> {
    let pick = |v: Option<&Value>| -> Vec<OutputFile> {
        v.and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|f| serde_json::from_value(f.clone()).ok())
                    .collect()
            })
            .unwrap_or_default()
    };
    for candidate in [
        payload.get("output_files"),
        payload
            .get("result_data")
            .and_then(|r| r.get("output_files")),
        payload.get("results").and_then(|r| r.get("output_files")),
    ] {
        let files = pick(candidate);
        if !files.is_empty() {
            return files;
        }
    }
    Vec::new()
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
        assert_eq!(c.job.brand.crawl(), "Dragnet");
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

    /// The slot rule is shared with the coordinator, the run form and the replay
    /// engine, so these cases mirror the ones asserted there.
    fn upload_workflow() -> Workflow {
        serde_json::from_value(json!({
            "id": 1, "name": "wf",
            "steps": [
                {"id":"s1","type":"upload","config":{"file_slot":"resume","label":"Your CV"}},
                {"id":"s2","type":"upload","config":{"file_id":"file_pinned","file_name":"invoice.pdf"}},
                {"id":"s3","type":"upload","options":{"file_id":"file_rec","filename":"scan.png"}},
                {"id":"s4","type":"click","config":{"selector":".go"}}
            ]
        }))
        .unwrap()
    }

    #[test]
    fn file_slots_covers_every_upload_step() {
        let slots = file_slots(&upload_workflow());
        assert_eq!(
            slots.iter().map(|s| s.slot.as_str()).collect::<Vec<_>>(),
            ["resume", "step:s2", "step:s3"]
        );
        // A declared slot with no pinned file MUST be bound by the caller.
        assert!(slots[0].declared);
        assert_eq!(slots[0].default_file_id, None);
        assert_eq!(slots[0].label, "Your CV");
        // A pinned step carries its file as the default → runs unbound.
        assert!(!slots[1].declared);
        assert_eq!(slots[1].default_file_id.as_deref(), Some("file_pinned"));
        assert_eq!(slots[1].default_filename.as_deref(), Some("invoice.pdf"));
        // The recorder writes options.file_id/filename; the editor writes config.*.
        assert_eq!(slots[2].default_file_id.as_deref(), Some("file_rec"));
        assert_eq!(slots[2].default_filename.as_deref(), Some("scan.png"));
    }

    #[test]
    fn file_slots_config_wins_over_options_and_dedupes() {
        let wf: Workflow = serde_json::from_value(json!({
            "id": 1, "name": "wf",
            "steps": [
                {"id":"a","type":"upload","config":{"file_id":"edited"},"options":{"file_id":"recorded"}},
                {"id":"b","type":"upload","config":{"file_slot":"cv"}},
                {"id":"c","type":"upload","config":{"file_slot":"cv"}}
            ]
        }))
        .unwrap();
        let slots = file_slots(&wf);
        assert_eq!(slots.len(), 2, "the duplicate `cv` slot collapses");
        assert_eq!(slots[0].default_file_id.as_deref(), Some("edited"));
        assert_eq!(slots[1].slot, "cv");
    }

    #[test]
    fn file_slots_is_empty_without_uploads_and_never_panics() {
        for steps in [
            json!([]),
            json!([{"id":"x","type":"click"}]),
            json!("junk"),
            json!(null),
        ] {
            let wf: Workflow =
                serde_json::from_value(json!({"id":1,"name":"wf","steps": steps})).unwrap();
            assert!(file_slots(&wf).is_empty());
        }
    }

    #[test]
    fn output_files_reads_every_envelope() {
        let captured = json!({
            "file_id":"file_dl","filename":"report.csv","size":12,
            "content_type":"text/csv","output_key":"report"
        });
        for payload in [
            json!({"result_data": {"output_files": [captured.clone()]}}),
            json!({"output_files": [captured.clone()]}),
            json!({"results": {"output_files": [captured.clone()]}}),
        ] {
            let files = output_files(&payload);
            assert_eq!(files.len(), 1);
            assert_eq!(files[0].file_id, "file_dl");
            assert_eq!(files[0].size, 12);
            assert_eq!(files[0].output_key.as_deref(), Some("report"));
        }
    }

    #[test]
    fn output_files_is_empty_when_nothing_captured() {
        for payload in [json!({"result_data": {}}), json!({}), json!("junk")] {
            assert!(output_files(&payload).is_empty());
        }
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
