"""Writ Cloud runs through the run API, with httpx.MockTransport standing in for Writ Cloud."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from usewrit import WritBridgeError

from .conftest import FakeClock
from .helpers import API_KEY, LOGIN, CloudStub, cloud_bridge, cloud_client, contract_doc, make_bridge, post

DONE = {
    "status": "completed",
    "success": True,
    "result_data": {"extracted_data": {"ok": True}, "steps_completed": 3},
    "extracted_data": {"ok": True},
    "error": None,
}


async def test_run_then_poll_until_done(clock: FakeClock) -> None:
    stub = CloudStub([{"status": "pending"}, {"status": "running", "success": None}, DONE])
    bridge, _ = cloud_bridge("cloud", stub)
    result = await bridge.auth.verify_login(LOGIN)
    assert result.venue == "cloud" and result.data == {"ok": True} and result.receipt is None

    run = stub.run_requests[0]
    assert run.url == httpx.URL("https://api.usewrit.app/api/automation/workflows/215/run")
    assert run.headers["authorization"] == f"Bearer {API_KEY}"
    assert run.headers["content-type"] == "application/json"
    assert stub.run_body_sent() == {"form_data": LOGIN, "function_name": "verify_login"}
    reads = [request for request in stub.requests if request.method == "GET"]
    assert len(reads) == 3
    assert all(request.url.path == "/api/automation/tasks/9001/results" for request in reads)
    assert all(request.headers["authorization"] == f"Bearer {API_KEY}" for request in reads)


async def test_result_data_when_there_is_no_extracted_data(clock: FakeClock) -> None:
    stub = CloudStub([{"status": "success", "success": True, "extracted_data": None, "result_data": {"rows": [1, 2]}}])
    bridge, _ = cloud_bridge("cloud", stub)
    assert (await bridge.auth.verify_login(LOGIN)).data == {"rows": [1, 2]}


async def test_nothing_returned_is_none(clock: FakeClock) -> None:
    stub = CloudStub([{"status": "done", "success": True}])
    bridge, _ = cloud_bridge("cloud", stub)
    assert (await bridge.auth.verify_login(LOGIN)).data is None


async def test_dry_run_and_a_whole_workflow_mapping(clock: FakeClock) -> None:
    doc = contract_doc()
    doc["functions"][0]["cloud"] = {"workflow_id": 215, "function": None}
    stub = CloudStub()
    bridge, _ = cloud_bridge("cloud", stub, contract=doc)
    await bridge.auth.verify_login(LOGIN, dry_run=True)
    assert stub.run_body_sent() == {"form_data": LOGIN, "mutation_mode": "dry_run"}


async def test_a_custom_cloud_base(clock: FakeClock) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "POST":
            return httpx.Response(200, json={"task_id": "t-1"})
        return httpx.Response(200, json=DONE)

    bridge = make_bridge(
        "cloud",
        api_key=API_KEY,
        cloud_base="http://localhost:8000/",
        http_client=cloud_client(handler),
        cloud_poll={"initial_ms": 5, "max_ms": 10},
    )
    await bridge.auth.verify_login(LOGIN)
    assert str(seen[0].url) == "http://localhost:8000/api/automation/workflows/215/run"
    assert str(seen[1].url) == "http://localhost:8000/api/automation/tasks/t-1/results"


@pytest.mark.parametrize(
    ("status", "body", "code"),
    [
        (401, {"detail": "Invalid API key"}, "NOT_GRANTED"),
        (403, {"detail": "API key cannot run this workflow"}, "NOT_GRANTED"),
        (402, {"detail": {"code": "quota", "message": "Plan limit reached"}}, "QUOTA_EXCEEDED"),
        (404, {"detail": "Workflow not found"}, "CLOUD_NOT_CONFIGURED"),
        (422, {"detail": {"code": "unknown_function", "message": "no such function"}}, "CLOUD_NOT_CONFIGURED"),
        (422, {"detail": [{"loc": ["body"], "msg": "bad"}]}, "INPUT_INVALID"),
        (400, {"detail": "bad"}, "INPUT_INVALID"),
        (429, {"detail": "slow down"}, "RATE_LIMITED"),
        (500, {"detail": "boom"}, "CLOUD_UNAVAILABLE"),
        (503, None, "CLOUD_UNAVAILABLE"),
        (409, {"detail": "conflict"}, "RUN_FAILED"),
    ],
)
async def test_dispatch_refusals_map_to_codes(clock: FakeClock, status: int, body: Any, code: str) -> None:
    stub = CloudStub(run_status=status, run_body=body if body is not None else {}, run_headers={"retry-after": "7"})
    bridge, _ = cloud_bridge("cloud", stub)
    with pytest.raises(WritBridgeError) as caught:
        await bridge.auth.verify_login(LOGIN)
    assert caught.value.code == code
    assert caught.value.details["status"] == status
    if code == "RATE_LIMITED":
        assert caught.value.details["retry_after_ms"] == 7_000
    assert len([request for request in stub.requests if request.method == "GET"]) == 0


async def test_an_unreachable_writ_cloud_is_cloud_unavailable(clock: FakeClock) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    bridge = make_bridge("cloud", api_key=API_KEY, http_client=cloud_client(handler))
    with pytest.raises(WritBridgeError) as caught:
        await bridge.auth.verify_login(LOGIN)
    assert caught.value.code == "CLOUD_UNAVAILABLE"


async def test_a_dispatch_answer_without_task_id_is_cloud_unavailable(clock: FakeClock) -> None:
    bridge, _ = cloud_bridge("cloud", CloudStub(run_body={"status": "pending"}))
    with pytest.raises(WritBridgeError) as caught:
        await bridge.auth.verify_login(LOGIN)
    assert caught.value.code == "CLOUD_UNAVAILABLE"


@pytest.mark.parametrize(
    ("result", "code"),
    [
        ({"status": "failed", "success": False, "error": "Login form not found"}, "RUN_FAILED"),
        ({"status": "error"}, "RUN_FAILED"),
        ({"status": "timeout", "error": "took too long"}, "TIMEOUT"),
        ({"status": "cancelled"}, "CANCELLED"),
        ({"status": "pending", "success": False}, "RUN_FAILED"),
        ({"status": "completed", "success": None, "error": "partial failure"}, "RUN_FAILED"),
    ],
)
async def test_how_the_task_ended_maps_to_codes(clock: FakeClock, result: dict[str, Any], code: str) -> None:
    bridge, _ = cloud_bridge("cloud", CloudStub([result]))
    with pytest.raises(WritBridgeError) as caught:
        await bridge.auth.verify_login(LOGIN)
    assert caught.value.code == code
    assert caught.value.details["task_id"] == 9001
    if "error" in result and result["error"]:
        assert result["error"] in caught.value.message


async def test_transient_reads_are_retried(clock: FakeClock) -> None:
    stub = CloudStub([{"__status__": 502}, {"__status__": 404}, {"__status__": 429}, {"status": "queued"}, DONE])
    bridge, _ = cloud_bridge("cloud", stub)
    assert (await bridge.auth.verify_login(LOGIN)).data == {"ok": True}


async def test_a_refused_read_is_not_granted(clock: FakeClock) -> None:
    bridge, _ = cloud_bridge("cloud", CloudStub([{"__status__": 401}]))
    with pytest.raises(WritBridgeError) as caught:
        await bridge.auth.verify_login(LOGIN)
    assert caught.value.code == "NOT_GRANTED"


async def test_unknown_statuses_end_as_run_failed(clock: FakeClock) -> None:
    bridge, _ = cloud_bridge("cloud", CloudStub([{"status": "frobnicating"}]))
    with pytest.raises(WritBridgeError) as caught:
        await bridge.auth.verify_login(LOGIN)
    assert caught.value.code == "RUN_FAILED"
    assert "frobnicating" in caught.value.message


async def test_a_run_still_going_at_the_deadline_is_timeout(clock: FakeClock) -> None:
    stub = CloudStub([{"status": "running"}])
    bridge, _ = cloud_bridge("cloud", stub, cloud_poll={"initial_ms": 50, "max_ms": 100})
    with pytest.raises(WritBridgeError) as caught:
        await bridge.auth.verify_login(LOGIN, timeout_ms=1_000)
    assert caught.value.code == "TIMEOUT"
    assert "last status: running" in caught.value.message
    reads = [request for request in stub.requests if request.method == "GET"]
    assert 3 <= len(reads) <= 40  # backed off, not hammered


async def test_page_run_routes_to_writ_cloud(clock: FakeClock) -> None:
    stub = CloudStub()
    bridge, _ = cloud_bridge("recommended", stub)
    status, _, payload = await post(bridge, bridge.user_token("u1"), {"run": {"key": "auth.verify_login", "inputs": LOGIN}})
    assert status == 200
    assert payload == {"data": {"ok": True}, "venue": "cloud"}


async def test_page_run_errors_use_the_error_envelope(clock: FakeClock) -> None:
    bridge, _ = cloud_bridge("recommended", CloudStub(run_status=402, run_body={"detail": "Plan limit"}))
    status, _, payload = await post(bridge, bridge.user_token("u1"), {"run": {"key": "auth.verify_login", "inputs": LOGIN}})
    assert status == 402
    assert payload["error"]["code"] == "QUOTA_EXCEEDED"
    status, _, payload = await post(bridge, bridge.user_token("u1"), {"run": {"key": "auth.verify_login", "inputs": {}}})
    assert status == 400 and payload["error"]["code"] == "INPUT_INVALID"


async def test_authorize_run_gates_page_runs(clock: FakeClock) -> None:
    calls: list[tuple[str, str, Any]] = []

    def authorize(user_id: str, key: str, inputs: Any) -> bool:
        calls.append((user_id, key, inputs))
        return user_id == "admin"

    stub = CloudStub()
    bridge, _ = cloud_bridge("recommended", stub, authorize_run=authorize)
    body = {"run": {"key": "auth.verify_login", "inputs": LOGIN}}
    status, _, payload = await post(bridge, bridge.user_token("u1"), body)
    assert status == 403 and payload["error"]["code"] == "NOT_GRANTED"
    status, _, _ = await post(bridge, bridge.user_token("admin"), body)
    assert status == 200
    assert calls == [("u1", "auth.verify_login", LOGIN), ("admin", "auth.verify_login", LOGIN)]
    assert len(stub.run_requests) == 1


async def test_page_runs_per_user_are_limited(clock: FakeClock) -> None:
    release = asyncio.Event()

    async def slow(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"task_id": 9001})
        await release.wait()
        return httpx.Response(200, json=DONE)

    bridge = make_bridge(
        "recommended",
        api_key=API_KEY,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(slow)),
        cloud_poll={"initial_ms": 5, "max_ms": 10},
    )
    token = bridge.user_token("u1")
    body = {"run": {"key": "auth.verify_login", "inputs": LOGIN}}
    running = [asyncio.ensure_future(post(bridge, token, body)) for _ in range(4)]
    await asyncio.sleep(0.1)
    status, _, payload = await post(bridge, token, body)
    assert status == 429 and payload["error"]["code"] == "RATE_LIMITED"
    release.set()
    assert [result[0] for result in await asyncio.gather(*running)] == [200, 200, 200, 200]
