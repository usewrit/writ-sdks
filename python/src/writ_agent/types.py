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
    "MonitorChange",
    "ChangeListParams",
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
    "FileSlot",
    "file_slots",
    "OutputFile",
    "output_files",
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
    """One row of the GLOBAL recent-changes feed — the daemon's
    ``GET /v1/changes/recent`` and the cloud's ``GET /api/targets/changes/recent``,
    which serialise the identical shape. snake_case with INTEGER ids.

    Carries a feed row's worth of data: the monitor URL, which selector fired, a
    server-truncated diff snippet, and the two timestamps. Full before/after
    content lives on the per-monitor change route (:class:`MonitorChange`), which
    is a genuinely different shape — camelCase, string ids — and must not be
    confused with this one.

    (The previous field names here — ``url`` and ``created_at`` — do not exist on
    the wire. Reading them returned nothing, silently.)
    """

    id: int
    target_id: int
    target_url: str
    target_selector_id: int | None
    selector_name: str | None
    #: Truncated server-side to a feed-friendly length.
    diff_snippet: str | None
    #: ``first_detected_at`` is when this content first differed.
    #: ``last_detected_at`` moves forward every time the SAME difference is seen
    #: again, which is why it — not ``first_detected_at`` — is the feed's sort key
    #: and the value a cursor advances to. A row already processed legitimately
    #: reappears with a later ``last_detected_at``: a fresh detection, not a
    #: duplicate.
    first_detected_at: str
    last_detected_at: str


class MonitorChange(TypedDict, total=False):
    """One detected change in ONE monitor's history, as the cloud's
    ``GET /api/targets/{id}/changes`` serialises it: camelCase, STRING ids.

    Deliberately NOT :class:`RecentChange` — the two routes answer different
    casing, different id types and different fields.
    """

    id: str
    targetId: str
    #: When the change was FIRST seen — the same value as ``firstDetectedAt``.
    timestamp: str
    #: The feed is ORDERED by ``lastDetectedAt``, so that — not ``timestamp`` —
    #: is what a client sorts or advances a cursor on.
    firstDetectedAt: str
    lastDetectedAt: str
    oldContent: str
    newContent: str
    diff: str
    detectedBy: str
    selectorId: int | None
    selectorName: str | None
    screenshotBefore: str | None
    screenshotAfter: str | None
    screenshotDiff: str | None


class ChangeListParams(TypedDict, total=False):
    """Filters for either change feed.

    Omitting ``since`` gives the newest-first browsing view. Setting it switches
    the server to an oldest-first keyset walk returning only what was detected
    AFTER that point — which is what a poller wants: newest-first plus a limit
    silently drops changes whenever more than ``limit`` of them land between two
    polls.
    """

    limit: int
    #: ISO-8601 cursor — the ``last_detected_at`` of the last row processed.
    since: str
    #: That row's id, breaking ties between changes sharing one timestamp.
    #: Without it two rows in the same millisecond can straddle the page
    #: boundary and the trailing one is never returned again.
    since_id: int


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


class CrawlDefinition(TypedDict, total=False):
    """A SAVED crawl — a stored configuration with a stable slug.

    A :class:`CrawlJob` is one RUN and its id dies with that run, so a crawl had
    no stable handle to call. A definition owns the settings, so it can be re-run
    with exactly those settings and — via ``max_age`` — answered from the data it
    already collected.
    """

    id: int
    slug: str
    name: str
    description: str | None
    seed_url: str
    #: The saved start-crawl body. Send it back verbatim to edit.
    config: dict[str, Any]
    #: Freshness used when a caller omits ``max_age`` (None = always re-crawl).
    default_max_age_seconds: int | None
    created_at: str | None
    updated_at: str | None
    last_run_at: str | None
    run_url: str
    data_url: str


class CrawlDefinitionList(TypedDict, total=False):
    """``GET /v1/crawl/definitions`` envelope — ``{"definitions": [...]}``."""

    definitions: list[CrawlDefinition]


class CacheStamp(TypedDict, total=False):
    """Freshness provenance, present on every saved-crawl answer.

    Stamped into the BODY rather than only into headers, because an SDK caller
    (and an MCP tool) receives a payload, not an HTTP response — a header-only
    signal would be invisible exactly where it matters.
    """

    #: True when this answer reused already-collected data (nothing was crawled).
    hit: bool
    age_seconds: int
    #: The crawl whose data was served.
    source_crawl_id: int


class CrawlDataTable(TypedDict, total=False):
    """A page of a crawl's collected rows, in the Workflow Data API's shape."""

    columns: list[str]
    rows: list[dict[str, Any]]
    total: int
    truncated: bool


class SavedCrawlRun(TypedDict, total=False):
    """``POST /v1/crawl/definitions/{ref}/run``.

    Two shapes behind one call. On a freshness HIT (``cached`` true) the collected
    ``data`` is inline and nothing was crawled. On a MISS a crawl was dispatched
    and ``data`` is absent — poll ``status_url``, or pass ``wait=True``.
    """

    cached: bool
    _cache: CacheStamp
    definition: CrawlDefinition
    crawl: CrawlJob
    status_url: str | None
    data_url: str | None
    data: CrawlDataTable | None


class SavedCrawlData(TypedDict, total=False):
    """``GET /v1/crawl/definitions/{ref}/data`` — a pure read; never crawls."""

    definition: CrawlDefinition
    crawl: CrawlJob | None
    age_seconds: float | None
    data_url: str | None
    data: CrawlDataTable | None


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


# ---------------------------------------------------------------------------
# file assets — run inputs (upload) and run outputs (captured downloads)
# ---------------------------------------------------------------------------


class FileSlot(TypedDict, total=False):
    """One bindable file input on a workflow — see :func:`file_slots`."""

    #: Key to use in ``RunOptions.files`` / the run body's ``files`` map.
    slot: str
    label: str
    is_multiple: bool
    #: File pinned on the step. Present ⇒ the run works with NO binding at all,
    #: and passing one overrides it for that run only.
    default_file_id: str | None
    default_filename: str | None
    #: ``True`` when the workflow's author named the slot; ``False`` when it is
    #: keyed on the step id because the step only pins a file.
    declared: bool


def file_slots(workflow: Workflow | Any) -> list[FileSlot]:
    """The file inputs of ``workflow``, i.e. the valid keys for ``files``.

    Every ``upload`` step is a file input. Two kinds:

    * the step names a ``file_slot`` — an abstract slot whose file the CALLER
      supplies. With no ``default_file_id`` it must be bound or the step fails;
    * the step pins a concrete file. It is keyed ``step:<step id>`` and carries
      that file as ``default_file_id``, so the workflow runs untouched — bind it
      only to run against a DIFFERENT file.

    Derived from ``workflow["steps"]`` on the client, so it needs no extra round
    trip and works against any daemon version. A step's binding lives in
    ``config`` when the editor wrote it and in ``options`` when the recorder did;
    both are read, ``config`` winning as the explicit later edit. De-duped by
    slot, order-preserving. Returns ``[]`` for a workflow with no upload steps.

    >>> wf = client.workflows.get(7)
    >>> [s["slot"] for s in file_slots(wf)]
    ['resume', 'step:6f2a…']
    >>> client.workflows.run(7, files={"resume": "file_abc"})
    """
    steps = workflow.get("steps") if isinstance(workflow, dict) else None
    if not isinstance(steps, list):
        return []
    out: list[FileSlot] = []
    seen: set[str] = set()
    for index, step in enumerate(steps, start=1):
        if not isinstance(step, dict) or step.get("type") != "upload":
            continue
        cfg = step.get("config") if isinstance(step.get("config"), dict) else {}
        opts = step.get("options") if isinstance(step.get("options"), dict) else {}
        slot = cfg.get("file_slot") or opts.get("file_slot")
        declared = isinstance(slot, str) and bool(slot)
        if not declared:
            sid = step.get("id")
            # Keyed on the step's own id, never an ordinal: a binding has to
            # survive the steps being reordered or one being disabled.
            slot = f"step:{sid}" if sid else f"upload:{index}"
        if slot in seen:
            continue
        seen.add(slot)
        default_id = cfg.get("file_id") or opts.get("file_id")
        default_name = cfg.get("file_name") or opts.get("filename") or opts.get("file_name")
        out.append(
            FileSlot(
                slot=slot,
                label=(
                    cfg.get("label")
                    or opts.get("label")
                    or default_name
                    or (slot.replace("_", " ") if declared else f"File {index}")
                ),
                is_multiple=bool(cfg.get("is_multiple") or opts.get("is_multiple")),
                default_file_id=default_id,
                default_filename=default_name,
                declared=declared,
            )
        )
    return out


class OutputFile(TypedDict, total=False):
    """A file a run CAPTURED (a ``wait_for_download`` step) — see :func:`output_files`."""

    #: Handle in the vault — read the bytes with ``client.files.content(file_id)``.
    file_id: str
    filename: str
    size: int
    content_type: str
    #: The step's ``output_key``, when it named the capture for later reference.
    output_key: str | None


def output_files(run: Any) -> list[OutputFile]:
    """Files captured by a run's download steps, newest run document in.

    A ``wait_for_download`` step stores what the browser downloaded and reports
    it as ``result_data.output_files``. Accepts the completed-run document, its
    ``result_data``, or a results payload — whichever you happen to hold — and
    returns ``[]`` when the run captured nothing.

    >>> outcome = client.workflows.run_and_wait(7)
    >>> for f in output_files(outcome):
    ...     data = client.files.content(f["file_id"])
    """
    if not isinstance(run, dict):
        return []
    for candidate in (
        run.get("output_files"),
        (run.get("result_data") or {}).get("output_files")
        if isinstance(run.get("result_data"), dict)
        else None,
        (run.get("results") or {}).get("output_files")
        if isinstance(run.get("results"), dict)
        else None,
    ):
        if isinstance(candidate, list):
            return [f for f in candidate if isinstance(f, dict)]
    return []
