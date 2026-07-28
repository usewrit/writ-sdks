"""``workflows.run(..., wait=True)`` — the SERVER-side wait contract
(``?wait=true`` on ``POST /v1/workflows/:id/run``).

Distinct from ``run_and_wait``, which waits CLIENT-side over SSE with its own deadline.
This is one request: the daemon blocks and hands back the run's terminal document.

Pinned here because a caller has to be able to rely on all three:
  - the default is unchanged (202, no query params on the wire),
  - a failed run RETURNS (it is a result, not an exception),
  - an expired budget RAISES with the still-valid ``run_id``, so the run is collected
    rather than blindly re-run.

The sync and async clients share one decode path, so each behavior is asserted on BOTH.
"""

from __future__ import annotations

import httpx
import pytest

from writ_agent import WritRunTimeoutError

from .helpers import json_response, make_async_client, make_client

RUN_PATH = "/v1/workflows/3/run"


def _handler(body: dict, status: int = 200):
    """A daemon that answers the run endpoint with `body`, capturing the request."""
    captured: dict = {}

    def handle(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == RUN_PATH:
            captured["url"] = request.url
            return json_response(status, body)
        return json_response(404, {"error": "unexpected", "code": "not_found"})

    return handle, captured


def test_default_is_async_and_sends_no_wait_query() -> None:
    handle, captured = _handler({"run_id": 42, "status": "running"}, 202)
    client = make_client(handle)

    started = client.workflows.run(3, inputs={"a": 1})

    assert started["run_id"] == 42
    assert started["status"] == "running"
    assert "wait" not in captured["url"].params
    assert "timeout" not in captured["url"].params


def test_wait_true_sends_the_query_and_returns_the_terminal_document() -> None:
    handle, captured = _handler(
        {"run_id": 42, "status": "success", "done": True, "data": {"price": "19.99"}}
    )
    client = make_client(handle)

    done = client.workflows.run(3, wait=True, timeout=60)

    assert done["status"] == "success"
    assert done["done"] is True
    assert done["data"] == {"price": "19.99"}
    assert captured["url"].params["wait"] == "true"
    assert captured["url"].params["timeout"] == "60"


def test_failed_run_returns_rather_than_raising() -> None:
    # The REPORT succeeded; the run did not. Raising here would leave a caller unable to
    # distinguish a failed workflow from a rejected request.
    handle, _ = _handler(
        {"run_id": 43, "status": "failed", "done": True, "error": "login step timed out"}
    )
    client = make_client(handle)

    done = client.workflows.run(3, wait=True)

    assert done["status"] == "failed"
    assert done["error"] == "login step timed out"


def test_expired_budget_raises_with_the_still_running_run_id() -> None:
    handle, _ = _handler(
        {
            "run_id": 44,
            "status": "running",
            "done": False,
            "status_url": "/v1/runs/44",
            "events_url": "/v1/runs/44/events",
        },
        504,
    )
    client = make_client(handle)

    with pytest.raises(WritRunTimeoutError) as excinfo:
        client.workflows.run(3, wait=True, timeout=5)

    err = excinfo.value
    assert err.run_id == 44
    assert err.status == 504
    # The message must steer toward collecting, not retrying — a retry would start a
    # SECOND run of a workflow that is already executing.
    assert "STILL RUNNING" in err.message
    assert "do not retry" in err.message


def test_dry_run_still_works_alongside_the_new_options() -> None:
    handle, captured = _handler(
        {"dry_run": True, "workflow_id": 3, "step_count": 0, "steps": []}
    )
    client = make_client(handle)

    report = client.workflows.run(3, dry_run=True)

    assert report["dry_run"] is True
    assert "wait" not in captured["url"].params


# ── async client: same decode path, so the same guarantees ──────────────────────

@pytest.mark.asyncio
async def test_async_wait_returns_terminal_document() -> None:
    handle, captured = _handler(
        {"run_id": 42, "status": "success", "done": True, "data": {"ok": 1}}
    )
    client = make_async_client(handle)
    try:
        done = await client.workflows.run(3, wait=True, timeout=30)
    finally:
        await client.aclose()

    assert done["status"] == "success"
    assert captured["url"].params["wait"] == "true"


@pytest.mark.asyncio
async def test_async_expired_budget_raises_the_same_typed_error() -> None:
    """REGRESSION GUARD: the 504→typed-error conversion lives in the SHARED decode path
    precisely so the async client cannot silently skip it."""
    handle, _ = _handler({"run_id": 44, "status": "running", "done": False}, 504)
    client = make_async_client(handle)
    try:
        with pytest.raises(WritRunTimeoutError) as excinfo:
            await client.workflows.run(3, wait=True, timeout=5)
    finally:
        await client.aclose()

    assert excinfo.value.run_id == 44
