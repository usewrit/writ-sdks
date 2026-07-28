"""Lightweight wire types for the Writ agent SDK.

Model approach (one, consistent): every API method returns **plain dicts**
annotated with ``TypedDict`` types (all ``total=False``). Nothing is validated
or stripped — when the daemon adds fields they simply pass through. Field-level
shapes mirror the Rust daemon source (``writ-agent/src/local/``),
which is the wire truth; JSON-ish dynamic fields (workflow ``steps``, run
``result`` …) are typed ``Any``.

Run events are a tagged union keyed on the ``"event"`` field (serde tag of
``engine/events.rs::RunEvent``).
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict, Union

__all__ = [
    "AgentStatus",
    "AgentHealth",
    "Workflow",
    "RunStarted",
    "CancelResult",
    "RunFeedItem",
    "RunResults",
    "RunData",
    "Monitor",
    "MonitorHistory",
    "RecentChange",
    "Selector",
    "Extractor",
    "Automation",
    "Persona",
    "SecretMeta",
    "VaultStatus",
    "StoredFile",
    "ApiKey",
    "CrawlStatus",
    "CrawlStartBody",
    "CrawlJob",
    "CrawlList",
    "Dataset",
    "DatasetList",
    "WsTicket",
    "StartedEvent",
    "StepEvent",
    "ProgressEvent",
    "FinishedEvent",
    "ErrorEvent",
    "RunEvent",
    "TERMINAL_EVENTS",
    "run_row_id",
]


# ---------------------------------------------------------------------------
# agent — server.rs::agent_status / health
# ---------------------------------------------------------------------------

class AgentStatus(TypedDict, total=False):
    status: str
    version: str
    active_runs: int
    encrypted: bool
    due_monitors: int
    last_tick_at: str | None
    warm_browser: bool


class AgentHealth(TypedDict, total=False):
    status: str
    version: str
    cipher_present: bool
    db_ok: bool
    keyring_ok: bool
    active_runs: int
    scheduler: dict[str, Any]
    warm_browser: bool
    cloud_link: dict[str, Any]


# ---------------------------------------------------------------------------
# workflows — api/v1/workflows.rs (rows are redact()ed: no credentials_encrypted;
# adds has_credentials / credential_keys / placeholders / has_login)
# ---------------------------------------------------------------------------

class Workflow(TypedDict, total=False):
    id: int
    name: str
    description: str | None
    entry_url: str | None
    is_active: int
    workflow_type: str
    steps: Any
    raw_replay: Any
    form_data: Any
    exit_condition: Any
    input_rules: Any
    api_functions: Any
    streaming_config: Any
    functions: Any
    login_url_patterns: Any
    has_credentials: bool
    credential_keys: list[str]
    placeholders: list[dict[str, Any]]
    has_login: bool
    default_persona_id: int | None
    cloud_callable: int
    marketplace_slug: str | None
    schedule_interval_ms: int | None
    last_run_at: str | None
    last_run_status: str | None
    created_at: str
    updated_at: str


class RunStarted(TypedDict, total=False):
    """202 body of ``POST /v1/workflows/:id/run``: ``{run_id, status: "running"}``."""

    run_id: int
    status: str


class RunCompleted(TypedDict, total=False):
    """200 body of ``POST /v1/workflows/:id/run?wait=true`` — the run's terminal document.

    A FAILED run arrives here as a normal result with ``status="failed"``, not as a raised
    error: the call succeeded in REPORTING the outcome. Check ``status``.
    """

    run_id: int
    #: ``success`` | ``failed`` | ``timeout`` | ``cancelled``.
    status: str
    done: bool
    #: The run's result payload, when it produced one.
    data: Any
    #: Why it failed. Present for non-success terminal states.
    error: str
    duration_ms: int


class CancelResult(TypedDict, total=False):
    """202 ``{…, status: "cancel_requested"}`` or 409 ``{…, status: "not_running"}``.

    A 409 here is a valid answer, not an exception (DESIGN §7).
    ``run_status`` is only present on the run-scoped cancel's 409.
    """

    id: int
    run_id: int
    status: str
    run_status: str


# ---------------------------------------------------------------------------
# runs — api/v1/runs.rs::RunFeedItem
# ---------------------------------------------------------------------------

class RunFeedItem(TypedDict, total=False):
    id: str  # composite "<run_type>-<row id>", e.g. "workflow-3"
    run_type: str  # workflow | check | automation
    entity_id: int | None
    entity_name: str | None
    status: str  # running|success|failed|cancelled|timeout|captcha_required|twofa_required (open)
    started_at: str | None
    finished_at: str | None
    duration_ms: int | None
    trigger_source: str | None
    error: str | None
    detail_url_hint: str | None
    data_url_hint: str | None
    rows_extracted: int | None
    change_detected: bool | None
    engine: str
    results: Any  # attached by run_and_wait(include_results=True) only


class RunResults(TypedDict, total=False):
    run_id: int
    status: str
    result: Any


class RunData(TypedDict, total=False):
    run_id: int
    status: str
    data: Any


# ---------------------------------------------------------------------------
# monitors — api/v1/monitors.rs (targets rows enriched with live state)
# ---------------------------------------------------------------------------

class Monitor(TypedDict, total=False):
    id: int
    url: str
    name: str | None
    check_type: str
    check_period_ms: int | None
    requires_playwright: int
    enabled: int
    setup_steps: Any
    state: str | None
    last_checked_at: str | None
    status_code: int | None
    is_up: bool | None
    last_change_at: str | None
    state_updated_at: str | None
    changes_count: int
    selector_count: int
    created_at: str
    updated_at: str


class MonitorHistory(TypedDict, total=False):
    monitor_id: int
    limit: int
    offset: int
    has_more: bool
    changes: list[dict[str, Any]]
    uptime_checks: list[dict[str, Any]]


class RecentChange(TypedDict, total=False):
    id: int
    target_id: int
    url: str
    selector_name: str | None
    diff_snippet: str | None
    created_at: str


class Selector(TypedDict, total=False):
    id: int
    target_id: int
    name: str
    selector: str
    description: str | None
    enabled: int
    content_type: str | None
    visual_region: str | None
    ignore_regex: str | None
    priority: int | None
    created_at: str
    updated_at: str


class Extractor(TypedDict, total=False):
    id: int
    target_selector_id: int
    name: str
    output_name: str
    enabled: int
    extract_type: str
    config: str | None
    is_array: int
    default_value: str | None
    created_at: str
    updated_at: str


class Automation(TypedDict, total=False):
    id: int
    name: str
    event_type: str
    enabled: int
    conditions: Any
    actions: Any
    blocks: Any
    created_at: str
    updated_at: str


# ---------------------------------------------------------------------------
# personas — api/v1/personas.rs::shape (cloud PersonaResponse wire form)
# ---------------------------------------------------------------------------

class Persona(TypedDict, total=False):
    id: int
    name: str
    description: str | None
    target_domain: str | None
    login_username: str | None
    has_password: bool
    twofa_method: str
    has_totp_seed: bool
    email_otp_mode: str | None
    relay_address: str | None
    has_fingerprint: bool
    has_proxy: bool
    is_active: bool
    validation_status: str | None
    has_warm_session: bool
    session_expires_at: str | None
    last_login_at: str | None
    last_used_at: str | None
    created_at: str
    updated_at: str
    linked_workflows: list[dict[str, Any]]
    linked_secrets: list[dict[str, Any]]


class SecretMeta(TypedDict, total=False):
    """Metadata ONLY — the daemon never returns a secret's value (secrets.rs::meta)."""

    id: int
    key: str
    name: str
    description: str | None
    category: str | None
    is_credential: bool
    is_card: bool
    username: str | None
    card_last4: str | None
    created_at: str
    updated_at: str
    last_used_at: str | None
    use_count: int


class VaultStatus(TypedDict, total=False):
    enabled: bool
    locked: bool
    idle_timeout_secs: int | None


class StoredFile(TypedDict, total=False):
    """OpenAI Files-API wire shape (files.rs::WireStoredFile)."""

    id: str
    object: str
    filename: str
    content_type: str
    bytes: int
    created_at: int  # UNIX epoch seconds
    status: str
    source: str
    purpose: str


class ApiKey(TypedDict, total=False):
    id: int
    name: str
    prefix: str
    scopes: str
    key: str  # plaintext wlk_ key — ONLY present in the create() response
    created_at: str
    last_used_at: str | None


# ---------------------------------------------------------------------------
# crawl — api/v1/crawl.rs (the Dragnet whole-site crawl), model store/crawl_jobs.rs
# ---------------------------------------------------------------------------

#: Crawl lifecycle status (open string enum; terminal: completed|failed|cancelled).
CrawlStatus = Literal[
    "queued", "mapping", "crawling", "stopping", "completed", "failed", "cancelled"
]


class CrawlStartBody(TypedDict, total=False):
    """``POST /v1/crawl`` body. Only ``url`` is required (empty → 400); the daemon
    applies the documented defaults for every omitted field."""

    url: str
    name: str
    extract_mode: str  # "markdown" (default) | "schema"
    extract_schema: dict[str, Any]
    persona_id: int
    include_paths: list[str]  # path-regex allow list
    exclude_paths: list[str]  # path-regex deny list
    max_depth: int
    page_budget: int
    max_concurrent: int
    delay_ms: int
    respect_robots: bool
    same_domain: bool
    allow_subdomains: bool


class CrawlJob(TypedDict, total=False):
    """A Dragnet crawl view (crawl.rs::to_view). SQLite booleans arrive as ``0/1``
    ints and are kept as ints (like the monitor rows), not coerced."""

    id: int
    name: str | None
    seed_url: str
    include_paths: list[str]
    exclude_paths: list[str]
    max_depth: int
    same_domain: int
    allow_subdomains: int
    extract_mode: str
    extract_schema: dict[str, Any] | None
    persona_id: int | None
    respect_robots: int
    delay_ms: int
    max_concurrent: int
    page_budget: int
    workflow_id: int | None
    data_workflow_id: int | None  # alias of workflow_id
    concierge_session_id: int | None
    status: str  # CrawlStatus (open string enum)
    pages_discovered: int
    pages_done: int
    pages_failed: int
    pages_skipped: int
    workers_active: int
    current_depth: int
    error: str | None
    cancel_requested: int
    cancel_requested_now: bool  # ONLY present in the cancel() response
    brand: str  # "Dragnet"
    is_terminal: bool
    created_at: str
    updated_at: str | None
    started_at: str | None
    completed_at: str | None


class CrawlList(TypedDict, total=False):
    """``GET /v1/crawl`` envelope — ``{"crawls": [...]}`` (NOT a Page)."""

    crawls: list[CrawlJob]


# ---------------------------------------------------------------------------
# datasets — api/v1/datasets.rs (cross-source extracted-data explorer)
# ---------------------------------------------------------------------------

class Dataset(TypedDict, total=False):
    """A dataset view — both the ``GET /v1/datasets`` list items and the richer
    ``GET /v1/datasets/:id`` metadata. ``source_type`` is ``"crawl"`` or
    ``"workflow"``; the schema fields (``columns``/``facets``/``row_count``/
    ``truncated``) are present only on the single-dataset get."""

    id: int | str
    name: str
    source_type: str  # "crawl" | "workflow"
    run_count: int
    last_updated: str | None
    origin: Any
    columns: list[dict[str, Any]]
    facets: Any
    row_count: int
    truncated: bool


class DatasetList(TypedDict, total=False):
    """``GET /v1/datasets`` envelope — ``{"datasets": [...]}`` (NOT a Page)."""

    datasets: list[Dataset]


class WsTicket(TypedDict, total=False):
    ticket: str
    expires_in_secs: int


# ---------------------------------------------------------------------------
# run events (SSE) — engine/events.rs::RunEvent, tagged on "event"
# ---------------------------------------------------------------------------

class StartedEvent(TypedDict):
    event: Literal["started"]
    run_id: int
    total_steps: int


class StepEvent(TypedDict):
    event: Literal["step"]
    run_id: int
    index: int
    step_type: str
    status: str  # running | succeeded | failed | skipped


class ProgressEvent(TypedDict):
    event: Literal["progress"]
    run_id: int
    completed: int
    total: int


class FinishedEvent(TypedDict):
    event: Literal["finished"]
    run_id: int
    status: str


class ErrorEvent(TypedDict):
    event: Literal["error"]
    run_id: int
    message: str


RunEvent = Union[StartedEvent, StepEvent, ProgressEvent, FinishedEvent, ErrorEvent]

#: The two stream-closing event names.
TERMINAL_EVENTS = frozenset({"finished", "error"})


def run_row_id(run: RunFeedItem | str | int) -> int:
    """Numeric run row id from a feed item or its composite id string.

    ``RunFeedItem.id`` is ``"<run_type>-<row_id>"`` (e.g. ``"workflow-3"``); the
    numeric row id (the part after the last dash) is what ``runs.get`` /
    ``runs.cancel`` / ``runs.events`` take. An ``int`` passes through unchanged.
    """
    if isinstance(run, int):
        return run
    raw: Any = run
    if isinstance(run, dict):
        raw = run.get("id")
        if isinstance(raw, int):
            return raw
    if not isinstance(raw, str) or not raw:
        raise ValueError(f"cannot derive a run row id from {run!r}")
    tail = raw.rsplit("-", 1)[-1]
    try:
        return int(tail)
    except ValueError as exc:
        raise ValueError(f"cannot derive a run row id from {raw!r}") from exc
