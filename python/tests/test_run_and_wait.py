"""``workflows.run_and_wait`` (DESIGN §8/§9.5): happy path over SSE, the
SSE-drop → polling fallback, keep-alive tolerance, and the non-cancelling
timeout."""

from __future__ import annotations

import json

import httpx
import pytest

from writ_agent import WritTimeoutError

from .helpers import json_response, make_client, sse_body, sse_response


class Router:
    """A tiny stateful mock daemon for the run lifecycle."""

    def __init__(
        self,
        *,
        sse: httpx.Response | Exception | None = None,
        statuses: list[str] | None = None,
    ) -> None:
        self.sse = sse
        # Successive answers for GET /v1/runs/5 (last one repeats).
        self.statuses = statuses or ["success"]
        self.get_calls = 0
        self.cancel_calls = 0
        self.run_calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "POST" and path == "/v1/workflows/3/run":
            self.run_calls += 1
            assert json.loads(request.content).get("dry_run") is None
            return json_response(202, {"run_id": 5, "status": "running"})
        if request.method == "GET" and path == "/v1/runs/5/events":
            if isinstance(self.sse, Exception):
                raise self.sse
            assert self.sse is not None, "unexpected SSE subscription"
            return self.sse
        if request.method == "GET" and path == "/v1/runs/5":
            status = self.statuses[min(self.get_calls, len(self.statuses) - 1)]
            self.get_calls += 1
            return json_response(
                200,
                {
                    "id": "workflow-5",
                    "run_type": "workflow",
                    "entity_id": 3,
                    "entity_name": "wf",
                    "status": status,
                    "rows_extracted": 2,
                },
            )
        if request.method == "GET" and path == "/v1/runs/5/results":
            return json_response(
                200, {"run_id": 5, "status": "success", "result": {"extracted_data": {"k": "v"}}}
            )
        if request.method == "POST" and path == "/v1/runs/5/cancel":
            self.cancel_calls += 1
            return json_response(202, {"run_id": 5, "status": "cancel_requested"})
        raise AssertionError(f"unexpected request {request.method} {path}")


HAPPY_SSE = sse_body(
    ("started", {"run_id": 5, "total_steps": 2}),
    ": keep-alive\n\n",
    ("step", {"run_id": 5, "index": 0, "step_type": "navigate", "status": "succeeded"}),
    ": keep-alive\n\n",
    ("finished", {"run_id": 5, "status": "success"}),
)


def test_run_and_wait_happy_path_over_sse():
    router = Router(sse=sse_response(HAPPY_SSE))
    with make_client(router) as client:
        final = client.workflows.run_and_wait(3, inputs={"a": 1})
    assert final["status"] == "success"
    assert final["id"] == "workflow-5"
    # Terminal came from SSE: exactly one final fetch, no polling loop.
    assert router.get_calls == 1
    assert router.cancel_calls == 0
    assert "results" not in final


def test_run_and_wait_include_results_attaches_results():
    router = Router(sse=sse_response(HAPPY_SSE))
    with make_client(router) as client:
        final = client.workflows.run_and_wait(3, include_results=True)
    assert final["results"]["result"] == {"extracted_data": {"k": "v"}}


def test_run_and_wait_sse_connect_failure_falls_back_to_polling():
    router = Router(
        sse=httpx.ConnectError("boom"), statuses=["running", "running", "success"]
    )
    with make_client(router) as client:
        final = client.workflows.run_and_wait(3, poll_interval=0.01)
    assert final["status"] == "success"
    assert router.get_calls == 3  # polled until terminal


def test_run_and_wait_sse_drop_pre_terminal_falls_back_to_polling():
    # The stream delivers a started frame then closes without a terminal event
    # (producer dropped its sender) → polling fallback resolves the run.
    dropped = sse_body(("started", {"run_id": 5, "total_steps": 2}))
    router = Router(sse=sse_response(dropped), statuses=["running", "failed"])
    with make_client(router) as client:
        final = client.workflows.run_and_wait(3, poll_interval=0.01)
    assert final["status"] == "failed"
    assert router.get_calls == 2


def test_run_and_wait_sse_error_event_resolves():
    errored = sse_body(
        ("started", {"run_id": 5, "total_steps": 2}),
        ("error", {"run_id": 5, "message": "navigation failed"}),
    )
    router = Router(sse=sse_response(errored), statuses=["failed"])
    with make_client(router) as client:
        final = client.workflows.run_and_wait(3)
    assert final["status"] == "failed"


def test_run_and_wait_timeout_raises_and_never_cancels():
    router = Router(sse=httpx.ConnectError("boom"), statuses=["running"])
    with make_client(router) as client:
        with pytest.raises(WritTimeoutError) as excinfo:
            client.workflows.run_and_wait(3, wait_timeout=0.05, poll_interval=0.01)
    assert "NOT cancelled" in str(excinfo.value)
    assert router.cancel_calls == 0  # the run is never auto-cancelled
    assert router.get_calls >= 1


def test_run_and_wait_rejects_dry_run_keyword():
    router = Router(sse=sse_response(HAPPY_SSE))
    with make_client(router) as client:
        with pytest.raises(TypeError):
            client.workflows.run_and_wait(3, dry_run=True)  # type: ignore[call-arg]
    assert router.run_calls == 0
