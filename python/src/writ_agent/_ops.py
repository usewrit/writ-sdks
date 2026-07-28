"""Shared request descriptors — the single wire-level implementation both the
sync and async clients execute.

Each function builds an :class:`Op` describing one daemon endpoint (method,
path, params/body, extra acceptable statuses, and how to decode the response).
Paths, bodies and envelopes mirror the Rust handlers under
``writ-agent/src/local/api/v1/`` exactly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

__all__ = ["Op"]


def _seg(value: str) -> str:
    """Percent-encode a caller-supplied string path segment (secret keys, file ids)."""
    return quote(str(value), safe="")


def _clean(params: dict[str, Any] | None) -> dict[str, Any] | None:
    """Drop ``None`` values; serialize bools the way serde expects (``true``/``false``)."""
    if not params:
        return None
    out: dict[str, Any] = {}
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, bool):
            value = "true" if value else "false"
        out[key] = value
    return out or None


def _body(fields: dict[str, Any]) -> dict[str, Any]:
    """Drop ``None`` values from a JSON body."""
    return {k: v for k, v in fields.items() if v is not None}


@dataclass
class Op:
    """One HTTP operation against the daemon."""

    method: str
    path: str
    params: dict[str, Any] | None = None
    json_body: Any = None
    files: Any = None
    data: Any = None
    #: Extra acceptable (non-2xx) statuses returned as results, not raised (e.g. cancel's 409).
    ok: frozenset[int] = field(default_factory=frozenset)
    #: How to decode: "json" | "page" | "text" | "bytes".
    kind: str = "json"
    #: A 504 on this op means "still running", not a transport failure — decode it into a
    #: WritRunTimeoutError carrying the run id (see `_base._raise_run_timeout`).
    run_timeout_on_504: bool = False


# ---------------------------------------------------------------------------
# agent
# ---------------------------------------------------------------------------

def agent_status() -> Op:
    return Op("GET", "/v1/agent")


def agent_health() -> Op:
    return Op("GET", "/v1/health")


# ---------------------------------------------------------------------------
# workflows
# ---------------------------------------------------------------------------

def workflows_list(params: dict[str, Any]) -> Op:
    return Op("GET", "/v1/workflows", params=_clean(params), kind="page")


def workflows_create(body: dict[str, Any]) -> Op:
    return Op("POST", "/v1/workflows", json_body=body)


def workflows_get(workflow_id: int) -> Op:
    return Op("GET", f"/v1/workflows/{workflow_id}")


def workflows_update(workflow_id: int, patch: dict[str, Any]) -> Op:
    return Op("PATCH", f"/v1/workflows/{workflow_id}", json_body=patch)


def workflows_delete(workflow_id: int) -> Op:
    return Op("DELETE", f"/v1/workflows/{workflow_id}")


def workflows_run(
    workflow_id: int,
    inputs: dict[str, Any] | None,
    persona_id: int | None,
    dry_run: bool,
    files: dict[str, str] | None,
    wait: bool = False,
    timeout: int | None = None,
) -> Op:
    body = _body(
        {
            "inputs": inputs,
            "persona_id": persona_id,
            "dry_run": True if dry_run else None,
            "files": files,
        }
    )
    params = _body({"wait": True if wait else None, "timeout": timeout}) or None
    # 504 is a documented, RECOVERABLE outcome of waiting (the run is still going and the
    # run_id is still valid), so it comes back as a RESULT for the caller to convert into a
    # WritRunTimeoutError — not as a generic HTTP error that loses the id.
    return Op(
        "POST",
        f"/v1/workflows/{workflow_id}/run",
        params=params,
        json_body=body,
        ok=frozenset({504}) if wait else frozenset(),
        run_timeout_on_504=wait,
    )


def workflows_cancel(workflow_id: int) -> Op:
    # 409 {status:"not_running"} is a valid answer — returned, not raised.
    return Op("POST", f"/v1/workflows/{workflow_id}/cancel", ok=frozenset({409}))


def workflows_session(workflow_id: int) -> Op:
    return Op("GET", f"/v1/workflows/{workflow_id}/session")


def workflows_clear_session(workflow_id: int) -> Op:
    return Op("DELETE", f"/v1/workflows/{workflow_id}/session")


# ---------------------------------------------------------------------------
# runs
# ---------------------------------------------------------------------------

def runs_list(params: dict[str, Any]) -> Op:
    return Op("GET", "/v1/runs", params=_clean(params), kind="page")


def runs_get(run_id: int) -> Op:
    return Op("GET", f"/v1/runs/{run_id}")


def runs_results(run_id: int) -> Op:
    return Op("GET", f"/v1/runs/{run_id}/results")


def runs_data(run_id: int, params: dict[str, Any]) -> Op:
    return Op("GET", f"/v1/runs/{run_id}/data", params=_clean(params))


def runs_data_csv(run_id: int) -> Op:
    return Op("GET", f"/v1/runs/{run_id}/data", params={"format": "csv"}, kind="text")


def runs_cancel(run_id: int) -> Op:
    # 409 {status:"not_running"} is a valid answer — returned, not raised.
    return Op("POST", f"/v1/runs/{run_id}/cancel", ok=frozenset({409}))


def runs_events_path(run_id: int) -> str:
    return f"/v1/runs/{run_id}/events"


# ---------------------------------------------------------------------------
# monitors (targets)
# ---------------------------------------------------------------------------

def monitors_list(params: dict[str, Any]) -> Op:
    # Bare-array envelope — normalized to Page.
    return Op("GET", "/v1/monitors", params=_clean(params), kind="page")


def monitors_create(body: dict[str, Any]) -> Op:
    return Op("POST", "/v1/monitors", json_body=body)


def monitors_get(monitor_id: int) -> Op:
    return Op("GET", f"/v1/monitors/{monitor_id}")


def monitors_update(monitor_id: int, patch: dict[str, Any]) -> Op:
    return Op("PATCH", f"/v1/monitors/{monitor_id}", json_body=patch)


def monitors_delete(monitor_id: int) -> Op:
    return Op("DELETE", f"/v1/monitors/{monitor_id}")


def monitors_run(monitor_id: int) -> Op:
    return Op("POST", f"/v1/monitors/{monitor_id}/run")


def monitors_changes(monitor_id: int, params: dict[str, Any]) -> Op:
    return Op("GET", f"/v1/monitors/{monitor_id}/changes", params=_clean(params))


def monitors_capacity() -> Op:
    return Op("GET", "/v1/monitors/capacity")


def monitors_recent_changes(params: dict[str, Any]) -> Op:
    # Bare-array envelope — normalized to Page.
    return Op("GET", "/v1/changes/recent", params=_clean(params), kind="page")


# ---------------------------------------------------------------------------
# selectors (nested under monitors)
# ---------------------------------------------------------------------------

def selectors_list(monitor_id: int, params: dict[str, Any]) -> Op:
    return Op(
        "GET", f"/v1/monitors/{monitor_id}/selectors", params=_clean(params), kind="page"
    )


def selectors_create(monitor_id: int, body: dict[str, Any]) -> Op:
    return Op("POST", f"/v1/monitors/{monitor_id}/selectors", json_body=body)


def selectors_get(monitor_id: int, selector_id: int) -> Op:
    return Op("GET", f"/v1/monitors/{monitor_id}/selectors/{selector_id}")


def selectors_update(monitor_id: int, selector_id: int, patch: dict[str, Any]) -> Op:
    return Op(
        "PATCH", f"/v1/monitors/{monitor_id}/selectors/{selector_id}", json_body=patch
    )


def selectors_delete(monitor_id: int, selector_id: int) -> Op:
    return Op("DELETE", f"/v1/monitors/{monitor_id}/selectors/{selector_id}")


def selectors_toggle(monitor_id: int, selector_id: int) -> Op:
    return Op("POST", f"/v1/monitors/{monitor_id}/selectors/{selector_id}/toggle")


def selectors_test(monitor_id: int, selector_id: int) -> Op:
    return Op("POST", f"/v1/monitors/{monitor_id}/selectors/{selector_id}/test")


def selectors_set_baseline(monitor_id: int, selector_id: int) -> Op:
    return Op(
        "POST", f"/v1/monitors/{monitor_id}/selectors/{selector_id}/set-baseline"
    )


def selectors_clear_baseline(monitor_id: int, selector_id: int) -> Op:
    return Op(
        "POST", f"/v1/monitors/{monitor_id}/selectors/{selector_id}/clear-baseline"
    )


# ---------------------------------------------------------------------------
# extractors
# ---------------------------------------------------------------------------

def extractors_list(selector_id: int, params: dict[str, Any]) -> Op:
    return Op(
        "GET", f"/v1/selectors/{selector_id}/extractors", params=_clean(params), kind="page"
    )


def extractors_create(body: dict[str, Any]) -> Op:
    return Op("POST", "/v1/extractors", json_body=body)


def extractors_get(extractor_id: int) -> Op:
    return Op("GET", f"/v1/extractors/{extractor_id}")


def extractors_update(extractor_id: int, patch: dict[str, Any]) -> Op:
    return Op("PATCH", f"/v1/extractors/{extractor_id}", json_body=patch)


def extractors_delete(extractor_id: int) -> Op:
    return Op("DELETE", f"/v1/extractors/{extractor_id}")


def extractors_toggle(extractor_id: int) -> Op:
    # NB: toggle is a PATCH on this resource (extractors.rs router).
    return Op("PATCH", f"/v1/extractors/{extractor_id}/toggle")


def extractors_test(extractor_id: int, content: str, content_type: str | None) -> Op:
    return Op(
        "POST",
        f"/v1/extractors/{extractor_id}/test",
        json_body=_body({"content": content, "content_type": content_type}),
    )


# ---------------------------------------------------------------------------
# automations
# ---------------------------------------------------------------------------

def automations_list(params: dict[str, Any]) -> Op:
    # Bare-array envelope — normalized to Page.
    return Op("GET", "/v1/automations", params=_clean(params), kind="page")


def automations_create(body: dict[str, Any]) -> Op:
    return Op("POST", "/v1/automations", json_body=body)


def automations_get(automation_id: int) -> Op:
    return Op("GET", f"/v1/automations/{automation_id}")


def automations_update(automation_id: int, patch: dict[str, Any]) -> Op:
    return Op("PATCH", f"/v1/automations/{automation_id}", json_body=patch)


def automations_delete(automation_id: int) -> Op:
    return Op("DELETE", f"/v1/automations/{automation_id}")


def automations_enable(automation_id: int, enabled: bool) -> Op:
    return Op(
        "POST",
        f"/v1/automations/{automation_id}/enable",
        json_body={"enabled": enabled},
    )


def automations_run(automation_id: int, inputs: dict[str, Any] | None) -> Op:
    return Op(
        "POST",
        f"/v1/automations/{automation_id}/run",
        json_body=_body({"inputs": inputs}),
    )


# ---------------------------------------------------------------------------
# personas
# ---------------------------------------------------------------------------

def personas_list(params: dict[str, Any]) -> Op:
    return Op("GET", "/v1/personas", params=_clean(params), kind="page")


def personas_create(body: dict[str, Any]) -> Op:
    return Op("POST", "/v1/personas", json_body=body)


def personas_get(persona_id: int) -> Op:
    return Op("GET", f"/v1/personas/{persona_id}")


def personas_update(persona_id: int, patch: dict[str, Any]) -> Op:
    return Op("PATCH", f"/v1/personas/{persona_id}", json_body=patch)


def personas_delete(persona_id: int) -> Op:
    return Op("DELETE", f"/v1/personas/{persona_id}")


def personas_runs(persona_id: int, params: dict[str, Any]) -> Op:
    return Op("GET", f"/v1/personas/{persona_id}/runs", params=_clean(params), kind="page")


def personas_validate_totp(body: dict[str, Any]) -> Op:
    return Op("POST", "/v1/personas/validate-totp", json_body=body)


def personas_test_2fa(persona_id: int) -> Op:
    return Op("POST", f"/v1/personas/{persona_id}/test-2fa")


# ---------------------------------------------------------------------------
# secrets (addressed by unique TEXT key; values never come back)
# ---------------------------------------------------------------------------

def secrets_list(params: dict[str, Any]) -> Op:
    return Op("GET", "/v1/secrets", params=_clean(params), kind="page")


def secrets_set(
    key: str,
    value: str | None,
    username: str | None,
    password: str | None,
    card: dict[str, Any] | None,
    description: str | None,
    category: str | None,
) -> Op:
    return Op(
        "POST",
        "/v1/secrets",
        json_body=_body(
            {
                "name": key,
                "value": value,
                "username": username,
                "password": password,
                "card": card,
                "description": description,
                "category": category,
            }
        ),
    )


def secrets_get(key: str) -> Op:
    return Op("GET", f"/v1/secrets/{_seg(key)}")


def secrets_delete(key: str) -> Op:
    return Op("DELETE", f"/v1/secrets/{_seg(key)}")


# ---------------------------------------------------------------------------
# vault (app-lock)
# ---------------------------------------------------------------------------

def vault_status() -> Op:
    return Op("GET", "/v1/vault/status")


def vault_lock() -> Op:
    return Op("POST", "/v1/vault/lock")


def vault_unlock(passphrase: str) -> Op:
    return Op("POST", "/v1/vault/unlock", json_body={"passphrase": passphrase})


# ---------------------------------------------------------------------------
# files
# ---------------------------------------------------------------------------

def files_list(params: dict[str, Any]) -> Op:
    return Op("GET", "/v1/files", params=_clean(params), kind="page")


def files_upload(
    content: bytes,
    filename: str,
    content_type: str | None,
    source: str | None,
) -> Op:
    files = {"file": (filename, content, content_type or "application/octet-stream")}
    data = {"source": source} if source else None
    return Op("POST", "/v1/files", files=files, data=data)


def files_from_data(
    workflow_id: int, format: str | None, filters: Any | None
) -> Op:
    return Op(
        "POST",
        "/v1/files/from-data",
        json_body=_body(
            {"workflow_id": workflow_id, "format": format, "filters": filters}
        ),
    )


def files_get(file_id: str) -> Op:
    return Op("GET", f"/v1/files/{_seg(file_id)}")


def files_delete(file_id: str) -> Op:
    return Op("DELETE", f"/v1/files/{_seg(file_id)}")


def files_content(file_id: str) -> Op:
    return Op("GET", f"/v1/files/{_seg(file_id)}/content", kind="bytes")


# ---------------------------------------------------------------------------
# data (extracted-data explorer)
# ---------------------------------------------------------------------------

def data_query(params: dict[str, Any]) -> Op:
    # Returns {"workflows": [...]} — not one of the three list envelopes.
    return Op("GET", "/v1/data", params=_clean(params))


def data_workflow_data(workflow_id: int, params: dict[str, Any]) -> Op:
    return Op("GET", f"/v1/workflows/{workflow_id}/data", params=_clean(params))


def data_delete_workflow_data(
    workflow_id: int,
    records: list[dict[str, Any]] | None,
    record_uids: list[str] | None,
    key: str | None,
) -> Op:
    return Op(
        "DELETE",
        f"/v1/workflows/{workflow_id}/data",
        json_body=_body(
            {"records": records or [], "record_uids": record_uids or [], "key": key}
        ),
    )


def data_facets(workflow_id: int, params: dict[str, Any]) -> Op:
    return Op("GET", f"/v1/workflows/{workflow_id}/data/facets", params=_clean(params))


def data_export(workflow_id: int, params: dict[str, Any]) -> Op:
    return Op(
        "GET", f"/v1/workflows/{workflow_id}/data/export", params=_clean(params), kind="text"
    )


def data_runs(workflow_id: int, params: dict[str, Any]) -> Op:
    return Op("GET", f"/v1/workflows/{workflow_id}/data/runs", params=_clean(params))


# ---------------------------------------------------------------------------
# crawl (the Dragnet whole-site crawl)
# ---------------------------------------------------------------------------

def crawl_list(params: dict[str, Any]) -> Op:
    # Returns {"crawls": [...]} — NOT one of the list envelopes (no Page).
    return Op("GET", "/v1/crawl", params=_clean(params))


def crawl_start(
    url: str,
    name: str | None,
    extract_mode: str | None,
    extract_schema: dict[str, Any] | None,
    persona_id: int | None,
    include_paths: list[str] | None,
    exclude_paths: list[str] | None,
    max_depth: int | None,
    page_budget: int | None,
    max_concurrent: int | None,
    delay_ms: int | None,
    respect_robots: bool | None,
    same_domain: bool | None,
    allow_subdomains: bool | None,
) -> Op:
    return Op(
        "POST",
        "/v1/crawl",
        json_body=_body(
            {
                "url": url,
                "name": name,
                "extract_mode": extract_mode,
                "extract_schema": extract_schema,
                "persona_id": persona_id,
                "include_paths": include_paths,
                "exclude_paths": exclude_paths,
                "max_depth": max_depth,
                "page_budget": page_budget,
                "max_concurrent": max_concurrent,
                "delay_ms": delay_ms,
                "respect_robots": respect_robots,
                "same_domain": same_domain,
                "allow_subdomains": allow_subdomains,
            }
        ),
    )


def crawl_get(crawl_id: int) -> Op:
    return Op("GET", f"/v1/crawl/{crawl_id}")


def crawl_cancel(crawl_id: int) -> Op:
    # Always the refreshed view (+ cancel_requested_now) — never a 409.
    return Op("POST", f"/v1/crawl/{crawl_id}/cancel")


# ---------------------------------------------------------------------------
# datasets (cross-source extracted-data explorer)
# ---------------------------------------------------------------------------

#: Output shapes a dataset read accepts (``?format=``). ``json`` is the documented
#: envelope; every other format is rendered TEXT and is CONTENT-AWARE (a crawl's
#: pages render as documents, structured data as a table).
DATASET_FORMATS = ("json", "csv", "markdown", "html")


def _dataset_kind(params: dict[str, Any]) -> str:
    """``text`` when the caller asked for a rendered format, else ``json``.

    A non-json format returns prose/CSV, so the Op must NOT run it through the
    JSON parser — that is the whole reason this lives next to the ops.
    """
    fmt = str(params.get("format") or "json").strip().lower()
    return "json" if fmt == "json" else "text"


def datasets_list() -> Op:
    # Returns {"datasets": [...]} — NOT one of the list envelopes (no Page).
    return Op("GET", "/v1/datasets")


def datasets_get(dataset_id: int | str) -> Op:
    return Op("GET", f"/v1/datasets/{_seg(dataset_id)}")


def datasets_records(dataset_id: int | str, params: dict[str, Any]) -> Op:
    # `filter` is repeatable (pass a list); `filters` is a JSON string.
    return Op(
        "GET",
        f"/v1/datasets/{_seg(dataset_id)}/records",
        params=_clean(params),
        kind=_dataset_kind(params),
    )


def datasets_export(dataset_id: int | str, format: str, params: dict[str, Any]) -> Op:
    merged = {**params, "format": format}
    return Op(
        "GET",
        f"/v1/datasets/{_seg(dataset_id)}/export",
        params=_clean(merged),
        kind="text",
    )


def datasets_search(q: str, params: dict[str, Any]) -> Op:
    # Global full-text search across every dataset. Params: `limit`, `offset`, `format`.
    merged = {**params, "q": q}
    return Op("GET", "/v1/datasets/search", params=_clean(merged), kind=_dataset_kind(merged))


def datasets_search_one(dataset_id: int | str, q: str, params: dict[str, Any]) -> Op:
    # Full-text search scoped to one dataset. Params: `limit`, `offset`, `format`.
    merged = {**params, "q": q}
    return Op(
        "GET",
        f"/v1/datasets/{_seg(dataset_id)}/search",
        params=_clean(merged),
        kind=_dataset_kind(merged),
    )


# ---------------------------------------------------------------------------
# keys (requires the manage scope, i.e. a wlt_ token)
# ---------------------------------------------------------------------------

def keys_list(params: dict[str, Any]) -> Op:
    return Op("GET", "/v1/keys", params=_clean(params), kind="page")


def keys_create(name: str, scopes: str | None) -> Op:
    return Op("POST", "/v1/keys", json_body=_body({"name": name, "scopes": scopes}))


def keys_get(key_id: int) -> Op:
    return Op("GET", f"/v1/keys/{key_id}")


def keys_delete(key_id: int) -> Op:
    return Op("DELETE", f"/v1/keys/{key_id}")


# ---------------------------------------------------------------------------
# ws-ticket
# ---------------------------------------------------------------------------

def ws_ticket(route: str, channel: str | None) -> Op:
    return Op(
        "POST", "/v1/ws-ticket", json_body=_body({"route": route, "channel": channel})
    )
