"""Resource namespaces (DESIGN §7) — shared by ``WritAgent`` and ``AsyncWritAgent``.

Every method builds a request descriptor (:mod:`writ_agent._ops`) and hands it
to the owning client's ``_call``. On :class:`~writ_agent.WritAgent` methods
return values directly; on :class:`~writ_agent.AsyncWritAgent` the *same*
methods return awaitables of the same shapes (``await client.workflows.get(3)``).
Return annotations below describe the resolved (sync) shapes.

``runs.events`` and ``workflows.run_and_wait`` are the two flow-control
helpers; they delegate to client-specific implementations (sync generator /
async generator, blocking / awaitable).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import IO, Any

from . import _ops as ops
from .pagination import Page
from .types import (
    AgentHealth,
    AgentStatus,
    ApiKey,
    Automation,
    CancelResult,
    CrawlJob,
    CrawlList,
    Dataset,
    DatasetList,
    Extractor,
    Monitor,
    MonitorHistory,
    Persona,
    RecentChange,
    RunData,
    RunFeedItem,
    RunResults,
    RunCompleted,
    RunStarted,
    SecretMeta,
    Selector,
    StoredFile,
    VaultStatus,
    Workflow,
)

__all__ = [
    "Agent",
    "Workflows",
    "Runs",
    "Monitors",
    "Selectors",
    "Extractors",
    "Automations",
    "Personas",
    "Secrets",
    "Vault",
    "Files",
    "Data",
    "Crawl",
    "Datasets",
    "Keys",
]



class _Resource:
    def __init__(self, client: Any) -> None:
        self._c = client


class Agent(_Resource):
    """``GET /v1/agent`` + ``GET /v1/health``."""

    def status(self) -> AgentStatus:
        """Lightweight daemon status (version, active runs, scheduler liveness)."""
        return self._c._call(ops.agent_status())

    def health(self) -> AgentHealth:
        """Deep health probe (encrypted store, keyring, scheduler, cloud link)."""
        return self._c._call(ops.agent_health())


class Workflows(_Resource):
    """CRUD + run/cancel/session over ``/v1/workflows``."""

    def list(self, **params: Any) -> Page[Workflow]:
        """List workflows, newest first. Params: ``active_only`` (default true), ``limit``."""
        return self._c._call(ops.workflows_list(params))

    def create(self, body: dict[str, Any]) -> Workflow:
        """Create a workflow (requires a non-empty ``name``)."""
        return self._c._call(ops.workflows_create(body))

    def get(self, workflow_id: int) -> Workflow:
        return self._c._call(ops.workflows_get(workflow_id))

    def update(self, workflow_id: int, patch: dict[str, Any]) -> Workflow:
        """Sparse PATCH — omitted fields stay untouched."""
        return self._c._call(ops.workflows_update(workflow_id, patch))

    def delete(self, workflow_id: int) -> dict[str, Any]:
        """HARD delete (the daemon has no soft-delete); runs cascade away."""
        return self._c._call(ops.workflows_delete(workflow_id))

    def run(
        self,
        workflow_id: int,
        inputs: dict[str, Any] | None = None,
        persona_id: int | None = None,
        dry_run: bool = False,
        files: dict[str, str] | None = None,
        wait: bool = False,
        timeout: int | None = None,
    ) -> RunStarted | RunCompleted | dict[str, Any]:
        """Run the workflow.

        Default: starts it and returns 202 ``{run_id, status:"running"}`` for you to
        observe with ``runs.events(run_id)`` / ``runs.get(run_id)``.

        ``wait=True`` asks the DAEMON to block until the run is terminal and hands back
        a :class:`~writ_agent.types.RunCompleted` in the same request — one call, no SSE
        and no poll loop. ``timeout`` is the seconds it may block (clamped server-side to
        [1, 3600], default 120). A run that FAILS still returns normally (check
        ``status``); only an expired budget raises
        :class:`~writ_agent.errors.WritRunTimeoutError`, which carries the still-valid
        ``run_id`` so you can collect the run instead of starting a second one.

        Prefer :meth:`run_and_wait` when you want live events, the enriched run feed item,
        or a deadline longer than the daemon's own ceiling.

        ``dry_run=True`` is a validate-only path: the daemon answers 200 with a
        step-plan report and nothing executes. ``files`` maps declared upload
        slots to vault file ids (``{slot: file_id}``).
        """
        return self._c._call(
            ops.workflows_run(
                workflow_id, inputs, persona_id, dry_run, files, wait=wait, timeout=timeout
            )
        )

    def cancel(self, workflow_id: int) -> CancelResult:
        """Cancel the newest live run of this workflow.

        Returns the body for BOTH the 202 (``status:"cancel_requested"``) and
        the 409 (``status:"not_running"``) answers — a 409 is a result here,
        never an exception.
        """
        return self._c._call(ops.workflows_cancel(workflow_id))

    def session(self, workflow_id: int) -> dict[str, Any]:
        """Browserless-HTTP-lane session status for this workflow."""
        return self._c._call(ops.workflows_session(workflow_id))

    def clear_session(self, workflow_id: int) -> dict[str, Any]:
        """Drop the persisted HTTP-lane session so the next run logs in fresh."""
        return self._c._call(ops.workflows_clear_session(workflow_id))

    def run_and_wait(
        self,
        workflow_id: int,
        inputs: dict[str, Any] | None = None,
        persona_id: int | None = None,
        files: dict[str, str] | None = None,
        *,
        wait_timeout: float = 600.0,
        poll_interval: float = 1.0,
        include_results: bool = False,
    ) -> RunFeedItem:
        """Run the workflow and block until it reaches a terminal status (§8).

        Subscribes to the run's SSE stream and resolves on ``finished``/``error``;
        if the SSE connection fails or drops pre-terminal, falls back to polling
        ``runs.get`` every ``poll_interval`` seconds. After ``wait_timeout``
        seconds (default 600) a :class:`~writ_agent.WritTimeoutError` is raised —
        **the run itself is NOT cancelled**. ``dry_run`` is deliberately not
        accepted here (there is nothing to wait for on a dry run).

        Returns the final :class:`RunFeedItem` (fetched once after the terminal
        event); with ``include_results=True`` the ``runs.results`` payload is
        attached under its ``"results"`` key.
        """
        return self._c._run_and_wait(
            workflow_id,
            inputs=inputs,
            persona_id=persona_id,
            files=files,
            wait_timeout=wait_timeout,
            poll_interval=poll_interval,
            include_results=include_results,
        )


class Runs(_Resource):
    """Read + control over ``/v1/runs`` (rows are created by the engine, not this API)."""

    def list(self, **params: Any) -> Page[RunFeedItem]:
        """List runs newest-first. Filters: ``entity_id``, ``workflow_id``,
        ``run_type``, ``status``, ``limit``, ``offset``. ``Page.total`` is set."""
        return self._c._call(ops.runs_list(params))

    def get(self, run_id: int) -> RunFeedItem:
        """One run by **numeric row id** (see :func:`writ_agent.run_row_id`)."""
        return self._c._call(ops.runs_get(run_id))

    def results(self, run_id: int) -> RunResults:
        """``{run_id, status, result}`` — ``result`` is null while running/empty."""
        return self._c._call(ops.runs_results(run_id))

    def data(self, run_id: int, **params: Any) -> RunData:
        """The run's extracted data (JSON envelope)."""
        return self._c._call(ops.runs_data(run_id, params))

    def data_csv(self, run_id: int) -> str:
        """The run's extracted data flattened to CSV (``?format=csv``) as text."""
        return self._c._call(ops.runs_data_csv(run_id))

    def cancel(self, run_id: int) -> CancelResult:
        """Cancel a live run by row id.

        Returns the body for BOTH the 202 (``status:"cancel_requested"``) and
        the 409 (``status:"not_running"``) answers — a 409 is a result, never
        an exception. An unknown run id still raises (404).
        """
        return self._c._call(ops.runs_cancel(run_id))

    def events(self, run_id: int) -> Any:
        """Stream the run's SSE lifecycle events as typed dicts (§8).

        Yields ``started`` / ``step`` / ``progress`` frames and ends after the
        stream-closing ``finished`` or ``error`` event. Keep-alive comment
        frames are ignored. On ``WritAgent`` this is a plain generator; on
        ``AsyncWritAgent`` an async generator (``async for``). A run that is
        already finished yields exactly one terminal frame.
        """
        return self._c._run_events(run_id)


class Monitors(_Resource):
    """CRUD + run/changes/capacity over ``/v1/monitors`` (content/uptime checks)."""

    def list(self, **params: Any) -> Page[Monitor]:
        """Params: ``limit``, ``check_type`` (``content``/``uptime``). Bare-array envelope."""
        return self._c._call(ops.monitors_list(params))

    def create(self, body: dict[str, Any]) -> Monitor:
        """Requires a non-empty ``url``. A 409 ``device_capacity`` is a normal
        :class:`WritApiError` (this machine's check budget is full)."""
        return self._c._call(ops.monitors_create(body))

    def get(self, monitor_id: int) -> Monitor:
        return self._c._call(ops.monitors_get(monitor_id))

    def update(self, monitor_id: int, patch: dict[str, Any]) -> Monitor:
        return self._c._call(ops.monitors_update(monitor_id, patch))

    def delete(self, monitor_id: int) -> dict[str, Any]:
        return self._c._call(ops.monitors_delete(monitor_id))

    def run(self, monitor_id: int) -> dict[str, Any]:
        """Run this monitor's check NOW; returns the check outcome."""
        return self._c._call(ops.monitors_run(monitor_id))

    def changes(self, monitor_id: int, **params: Any) -> MonitorHistory:
        """Paginated change + uptime history (``limit``/``offset``)."""
        return self._c._call(ops.monitors_changes(monitor_id, params))

    def capacity(self) -> dict[str, Any]:
        """The device check-capacity meter snapshot."""
        return self._c._call(ops.monitors_capacity())

    def recent_changes(self, limit: int | None = None) -> Page[RecentChange]:
        """Newest detected content changes across ALL monitors (``/v1/changes/recent``)."""
        return self._c._call(ops.monitors_recent_changes({"limit": limit}))


class Selectors(_Resource):
    """Per-monitor content selectors (``/v1/monitors/:id/selectors``)."""

    def list(self, monitor_id: int, **params: Any) -> Page[Selector]:
        """Params: ``enabled_only``. Bare-array envelope."""
        return self._c._call(ops.selectors_list(monitor_id, params))

    def create(self, monitor_id: int, body: dict[str, Any]) -> Selector:
        """Requires a non-empty ``selector``; ``name`` defaults to it."""
        return self._c._call(ops.selectors_create(monitor_id, body))

    def get(self, monitor_id: int, selector_id: int) -> Selector:
        return self._c._call(ops.selectors_get(monitor_id, selector_id))

    def update(
        self, monitor_id: int, selector_id: int, patch: dict[str, Any]
    ) -> Selector:
        return self._c._call(ops.selectors_update(monitor_id, selector_id, patch))

    def delete(self, monitor_id: int, selector_id: int) -> dict[str, Any]:
        return self._c._call(ops.selectors_delete(monitor_id, selector_id))

    def toggle(self, monitor_id: int, selector_id: int) -> dict[str, Any]:
        """Flip ``enabled`` → ``{selector_id, enabled}``."""
        return self._c._call(ops.selectors_toggle(monitor_id, selector_id))

    def test(self, monitor_id: int, selector_id: int) -> dict[str, Any]:
        """Live one-off fetch: what does this selector resolve to right now."""
        return self._c._call(ops.selectors_test(monitor_id, selector_id))

    def set_baseline(self, monitor_id: int, selector_id: int) -> dict[str, Any]:
        """Capture this selector's baseline from a fresh fetch."""
        return self._c._call(ops.selectors_set_baseline(monitor_id, selector_id))

    def clear_baseline(self, monitor_id: int, selector_id: int) -> dict[str, Any]:
        """Drop the stored baseline so the next check re-seeds it."""
        return self._c._call(ops.selectors_clear_baseline(monitor_id, selector_id))


class Extractors(_Resource):
    """Field extractors over selector content (``/v1/extractors``)."""

    def list(self, selector_id: int, **params: Any) -> Page[Extractor]:
        """A selector's extractors (``/v1/selectors/:sid/extractors``). Params:
        ``enabled_only``. Bare-array envelope."""
        return self._c._call(ops.extractors_list(selector_id, params))

    def create(self, body: dict[str, Any]) -> Extractor:
        """Requires ``target_selector_id`` and a non-empty ``output_name``."""
        return self._c._call(ops.extractors_create(body))

    def get(self, extractor_id: int) -> Extractor:
        return self._c._call(ops.extractors_get(extractor_id))

    def update(self, extractor_id: int, patch: dict[str, Any]) -> Extractor:
        return self._c._call(ops.extractors_update(extractor_id, patch))

    def delete(self, extractor_id: int) -> dict[str, Any]:
        return self._c._call(ops.extractors_delete(extractor_id))

    def toggle(self, extractor_id: int) -> Extractor:
        """Flip ``enabled`` (PATCH); returns the refreshed row."""
        return self._c._call(ops.extractors_toggle(extractor_id))

    def test(
        self, extractor_id: int, content: str, content_type: str | None = None
    ) -> dict[str, Any]:
        """Run the saved extractor over caller-supplied content → ``{value, …}``."""
        return self._c._call(ops.extractors_test(extractor_id, content, content_type))


class Automations(_Resource):
    """Event→action rules (``/v1/automations``)."""

    def list(self, **params: Any) -> Page[Automation]:
        """Params: ``limit``. Bare-array envelope."""
        return self._c._call(ops.automations_list(params))

    def create(self, body: dict[str, Any]) -> Automation:
        """Requires a non-empty ``name``."""
        return self._c._call(ops.automations_create(body))

    def get(self, automation_id: int) -> Automation:
        return self._c._call(ops.automations_get(automation_id))

    def update(self, automation_id: int, patch: dict[str, Any]) -> Automation:
        return self._c._call(ops.automations_update(automation_id, patch))

    def delete(self, automation_id: int) -> dict[str, Any]:
        return self._c._call(ops.automations_delete(automation_id))

    def enable(self, automation_id: int, enabled: bool = True) -> Automation:
        """Toggle the ``enabled`` flag; returns the refreshed row."""
        return self._c._call(ops.automations_enable(automation_id, enabled))

    def run(
        self, automation_id: int, inputs: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Fire the automation now (manual trigger); returns the execution outcome."""
        return self._c._call(ops.automations_run(automation_id, inputs))


class Personas(_Resource):
    """Login identities (``/v1/personas``). Secrets are sealed daemon-side and
    only ever come back as ``has_*`` booleans."""

    def list(self, **params: Any) -> Page[Persona]:
        """Params: ``limit``, ``domain`` (suggest-by-domain)."""
        return self._c._call(ops.personas_list(params))

    def create(self, body: dict[str, Any]) -> Persona:
        """Create from the wizard-shaped plaintext payload (``name`` required;
        ``password``/``totp_seed``/``proxy_*`` are sealed by the daemon)."""
        return self._c._call(ops.personas_create(body))

    def get(self, persona_id: int) -> Persona:
        return self._c._call(ops.personas_get(persona_id))

    def update(self, persona_id: int, patch: dict[str, Any]) -> Persona:
        """Partial update; secrets are replaced only when explicitly provided."""
        return self._c._call(ops.personas_update(persona_id, patch))

    def delete(self, persona_id: int) -> dict[str, Any]:
        return self._c._call(ops.personas_delete(persona_id))

    def runs(self, persona_id: int, limit: int | None = None) -> Page[dict[str, Any]]:
        """Recent runs that acted as this persona."""
        return self._c._call(ops.personas_runs(persona_id, {"limit": limit}))

    def validate_totp(
        self,
        totp_seed: str,
        code: str | None = None,
        *,
        algorithm: str | None = None,
        digits: int | None = None,
        period: int | None = None,
    ) -> dict[str, Any]:
        """Check a pasted seed is well-formed base32 (and optionally reproduces
        a code) → ``{valid_base32, matches_code}``. Never stored or logged."""
        body = {
            "totp_seed": totp_seed,
            "code": code,
            "algorithm": algorithm,
            "digits": digits,
            "period": period,
        }
        return self._c._call(
            ops.personas_validate_totp({k: v for k, v in body.items() if v is not None})
        )

    def test_2fa(self, persona_id: int) -> dict[str, Any]:
        """Confirm the persona can mint a 2FA value (the code is never returned)."""
        return self._c._call(ops.personas_test_2fa(persona_id))


class Secrets(_Resource):
    """Vault secrets, addressed by unique TEXT ``key``. Values NEVER come back
    over the API — every read is metadata only."""

    def list(self, **params: Any) -> Page[SecretMeta]:
        """Params: ``limit``, ``search``, ``category``."""
        return self._c._call(ops.secrets_list(params))

    def set(
        self,
        key: str,
        value: str | None = None,
        *,
        username: str | None = None,
        password: str | None = None,
        card: dict[str, Any] | None = None,
        description: str | None = None,
        category: str | None = None,
    ) -> SecretMeta:
        """Create a secret: single ``value``, credential (``username`` +
        ``password``), or ``card`` (needs ``number`` + ``expiry``). The daemon
        seals the plaintext; the response is metadata only. Duplicate names 400."""
        return self._c._call(
            ops.secrets_set(key, value, username, password, card, description, category)
        )

    def get(self, key: str) -> SecretMeta:
        """One secret's **metadata** (never the value) or 404."""
        return self._c._call(ops.secrets_get(key))

    def delete(self, key: str) -> dict[str, Any]:
        return self._c._call(ops.secrets_delete(key))


class Vault(_Resource):
    """The desktop app-lock (``/v1/vault``). While locked, secret-touching
    routes answer 423 ``vault_locked``."""

    def status(self) -> VaultStatus:
        """``{enabled, locked, idle_timeout_secs}``."""
        return self._c._call(ops.vault_status())

    def lock(self) -> dict[str, Any]:
        """Relock now. Idempotent."""
        return self._c._call(ops.vault_lock())

    def unlock(self, passphrase: str) -> dict[str, Any]:
        """Unlock with the passphrase (wrong passphrase → 401)."""
        return self._c._call(ops.vault_unlock(passphrase))


class Files(_Resource):
    """Encrypted-at-rest file handles (OpenAI Files-API shape, ``/v1/files``)."""

    def list(self, **params: Any) -> Page[StoredFile]:
        """Params: ``limit``, ``source`` (``upload``/``api``/``workflow_output``)."""
        return self._c._call(ops.files_list(params))

    def upload(
        self,
        file: bytes | str | os.PathLike[str] | IO[bytes],
        *,
        filename: str | None = None,
        content_type: str | None = None,
        source: str | None = None,
    ) -> StoredFile:
        """Multipart upload (max 50 MiB). ``file`` may be raw bytes, a filesystem
        path, or a binary file object; ``filename`` defaults to the path's
        basename (else ``upload.bin``)."""
        content: bytes
        if isinstance(file, bytes):
            content = file
        elif isinstance(file, (str, os.PathLike)):
            path = Path(file)
            content = path.read_bytes()
            filename = filename or path.name
        else:
            content = file.read()
            if filename is None:
                name = getattr(file, "name", None)
                if isinstance(name, str) and name:
                    filename = Path(name).name
        return self._c._call(
            ops.files_upload(content, filename or "upload.bin", content_type, source)
        )

    def from_data(
        self,
        workflow_id: int,
        *,
        format: str | None = None,
        filters: Any | None = None,
    ) -> StoredFile:
        """Export a workflow's extracted data into a new stored file
        (``format``: ``csv`` default, or ``json``)."""
        return self._c._call(ops.files_from_data(workflow_id, format, filters))

    def get(self, file_id: str) -> StoredFile:
        return self._c._call(ops.files_get(file_id))

    def delete(self, file_id: str) -> dict[str, Any]:
        """Soft-delete the handle (bytes reclaimed by storage GC)."""
        return self._c._call(ops.files_delete(file_id))

    def content(self, file_id: str) -> bytes:
        """Decrypt and download the file's raw bytes."""
        return self._c._call(ops.files_content(file_id))


class Data(_Resource):
    """The extracted-data explorer (``/v1/data`` + ``/v1/workflows/:id/data``)."""

    def query(self, **params: Any) -> dict[str, Any]:
        """Workflows that produced extracted data → ``{"workflows": [...]}``."""
        return self._c._call(ops.data_query(params))

    def workflow_data(self, workflow_id: int, **params: Any) -> dict[str, Any]:
        """The aggregated extracted-data table (``q``, ``filters``, ``sort_by``,
        ``limit``, ``offset``, ``view`` = ``all``/``latest``/``run`` …)."""
        return self._c._call(ops.data_workflow_data(workflow_id, params))

    def delete_workflow_data(
        self,
        workflow_id: int,
        *,
        records: list[dict[str, Any]] | None = None,
        record_uids: list[str] | None = None,
        key: str | None = None,
    ) -> dict[str, Any]:
        """Remove extracted rows → ``{deleted, resolved, unmatched}``."""
        return self._c._call(
            ops.data_delete_workflow_data(workflow_id, records, record_uids, key)
        )

    def facets(self, workflow_id: int, **params: Any) -> dict[str, Any]:
        """Per-column facets over the workflow's extracted data."""
        return self._c._call(ops.data_facets(workflow_id, params))

    def export(self, workflow_id: int, **params: Any) -> str:
        """Download the full filtered table as text — CSV (default) or
        ``format="json"``."""
        return self._c._call(ops.data_export(workflow_id, params))

    def data_runs(self, workflow_id: int, **params: Any) -> dict[str, Any]:
        """The snapshot index: every successful data-bearing run with deltas."""
        return self._c._call(ops.data_runs(workflow_id, params))


class Crawl(_Resource):
    """The **Dragnet** whole-site crawl (``/v1/crawl``). One crawl fans a seed URL
    across a bounded worker pool; extracted pages aggregate under a synthetic
    per-crawl workflow, read back through the Data API on ``data_workflow_id``."""

    def list(self, limit: int | None = None) -> CrawlList:
        """Newest-first crawls → ``{"crawls": [...]}`` (NOT a :class:`Page`;
        ``limit`` default 50, max 500)."""
        return self._c._call(ops.crawl_list({"limit": limit}))

    def start(
        self,
        url: str,
        *,
        name: str | None = None,
        extract_mode: str | None = None,
        extract_schema: dict[str, Any] | None = None,
        persona_id: int | None = None,
        include_paths: list[str] | None = None,
        exclude_paths: list[str] | None = None,
        max_depth: int | None = None,
        page_budget: int | None = None,
        max_concurrent: int | None = None,
        delay_ms: int | None = None,
        respect_robots: bool | None = None,
        same_domain: bool | None = None,
        allow_subdomains: bool | None = None,
    ) -> CrawlJob:
        """Queue a crawl of ``url`` → the queued crawl view (an empty ``url`` 400s).

        Only ``url`` is required; every omitted option keeps the daemon default
        (``extract_mode="markdown"``, ``max_depth=3``, ``page_budget=500``,
        ``max_concurrent=4``, ``delay_ms=250``, ``respect_robots``/``same_domain``/
        ``allow_subdomains`` true). ``include_paths``/``exclude_paths`` are
        path-regex allow/deny lists; ``extract_schema`` pairs with
        ``extract_mode="schema"``."""
        return self._c._call(
            ops.crawl_start(
                url,
                name,
                extract_mode,
                extract_schema,
                persona_id,
                include_paths,
                exclude_paths,
                max_depth,
                page_budget,
                max_concurrent,
                delay_ms,
                respect_robots,
                same_domain,
                allow_subdomains,
            )
        )

    def get(self, crawl_id: int) -> CrawlJob:
        """One crawl's view by id (404 if missing)."""
        return self._c._call(ops.crawl_get(crawl_id))

    def cancel(self, crawl_id: int) -> CrawlJob:
        """Request cancellation (404 if missing). Always returns the refreshed
        view plus ``cancel_requested_now`` — true iff this call flipped the crawl
        to ``stopping``, false if it was already terminal. Never a 409."""
        return self._c._call(ops.crawl_cancel(crawl_id))


class Datasets(_Resource):
    """The cross-source dataset explorer (``/v1/datasets``). Each dataset is a
    crawl- or workflow-sourced extracted-data table addressed by dataset id;
    records/export share the Data API's filter grammar."""

    def list(self) -> DatasetList:
        """All datasets, one row per source → ``{"datasets": [...]}`` (NOT a
        :class:`Page`). Rows carry ``id``, ``name``, ``source_type``
        (``"crawl"``/``"workflow"``), ``run_count``, ``last_updated``, ``origin``."""
        return self._c._call(ops.datasets_list())

    def get(self, dataset_id: int | str) -> Dataset:
        """One dataset's metadata + schema (``columns``, ``facets``,
        ``row_count``, ``run_count``, ``truncated``) or 404."""
        return self._c._call(ops.datasets_get(dataset_id))

    def records(self, dataset_id: int | str, **params: Any) -> dict[str, Any] | str:
        """The dataset's records table → ``{dataset, columns, records, total, …}``.

        Params: ``q``, ``filter`` (repeatable — pass a list), ``filters`` (a JSON
        string), ``sort_by``, ``sort_dir``, ``limit``, ``offset``,
        ``include_inputs``, ``collection``, ``format``.

        ``format`` picks the output shape (see :data:`ops.DATASET_FORMATS`):
        ``"json"`` (default) returns the envelope above; ``"csv"``/``"markdown"``/
        ``"html"`` return rendered **text** instead. markdown/html are
        content-aware — a crawl's pages render as documents, structured data as a
        table — so reach for ``format="markdown"`` when you want to READ the
        content rather than parse fields."""
        return self._c._call(ops.datasets_records(dataset_id, params))

    def export(
        self, dataset_id: int | str, format: str = "json", **params: Any
    ) -> str:
        """Download the full (un-paginated) filtered table as text.

        ``format``: ``"json"`` (default), ``"csv"``, ``"markdown"`` or ``"html"``.
        markdown/html are content-aware — a crawl's pages export as readable
        documents, structured data as a table. Accepts the same filter params as
        :meth:`records`."""
        return self._c._call(ops.datasets_export(dataset_id, format, params))

    def search(self, q: str, **params: Any) -> dict[str, Any] | str:
        """Global full-text search across every dataset → ``{query, terms,
        results: [{dataset, run_id, run_at, fields, highlight}], total,
        truncated, scanned_runs}``.

        Params: ``limit``, ``offset``, ``format``. A non-``json`` ``format``
        returns the matches as rendered **text** instead of this envelope (the
        per-result dataset tag + highlight exist only in the json shape)."""
        return self._c._call(ops.datasets_search(q, params))

    def search_one(
        self, dataset_id: int | str, q: str, **params: Any
    ) -> dict[str, Any] | str:
        """Full-text search scoped to one dataset — same envelope as
        :meth:`search`. Params: ``limit``, ``offset``, ``format`` (a non-``json``
        format returns rendered text)."""
        return self._c._call(ops.datasets_search_one(dataset_id, q, params))


class Keys(_Resource):
    """Scoped ``wlk_`` API keys (``/v1/keys``; requires the full ``wlt_`` token)."""

    def list(self, **params: Any) -> Page[ApiKey]:
        return self._c._call(ops.keys_list(params))

    def create(self, name: str, scopes: str | None = None) -> ApiKey:
        """Mint a key. The plaintext ``key`` appears ONLY in this response —
        capture it now; it cannot be recovered later."""
        return self._c._call(ops.keys_create(name, scopes))

    def get(self, key_id: int) -> ApiKey:
        return self._c._call(ops.keys_get(key_id))

    def delete(self, key_id: int) -> dict[str, Any]:
        return self._c._call(ops.keys_delete(key_id))
