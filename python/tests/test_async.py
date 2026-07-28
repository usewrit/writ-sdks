"""AsyncWritAgent parity (DESIGN §9: both clients tested): headers, envelopes,
errors, SSE events, run_and_wait over SSE and via polling fallback, lazy
discovery, and the async context manager."""

from __future__ import annotations

import json

import httpx
import pytest

from writ_agent import (
    AsyncWritAgent,
    Page,
    WritApiError,
    WritConnectionError,
    WritTimeoutError,
)

from .conftest import write_runtime
from .helpers import TOKEN, json_response, make_async_client, sse_body, sse_response


async def test_headers_and_page_envelopes():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        seen["ua"] = request.headers.get("User-Agent")
        if request.url.path == "/v1/workflows":
            return json_response(200, {"data": [{"id": 1}], "count": 1})
        if request.url.path == "/v1/runs":
            return json_response(200, {"data": [{"id": "workflow-2"}], "count": 1, "total": 9})
        return json_response(200, [{"id": 3}])

    async with make_async_client(handler) as client:
        workflows = await client.workflows.list()
        runs = await client.runs.list()
        monitors = await client.monitors.list()

    assert seen["auth"] == f"Bearer {TOKEN}"
    assert seen["ua"] == "writ-sdk-python/0.1.0"
    assert isinstance(workflows, Page) and workflows.count == 1 and workflows.total is None
    assert runs.total == 9
    assert monitors.count == 1 and monitors.total is None


async def test_error_mapping_and_cancel_result():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/workflows/999":
            return json_response(404, {"error": "not found: workflow 999", "code": "not_found"})
        if request.url.path == "/v1/runs/6/cancel":
            return json_response(409, {"run_id": 6, "status": "not_running"})
        return httpx.Response(400, headers={"Content-Type": "text/plain"}, content=b"bad body")

    async with make_async_client(handler) as client:
        with pytest.raises(WritApiError) as excinfo:
            await client.workflows.get(999)
        assert excinfo.value.code == "not_found"

        stopped = await client.runs.cancel(6)
        assert stopped["status"] == "not_running"

        with pytest.raises(WritApiError) as excinfo:
            await client.monitors.create({})
        assert excinfo.value.code == "bad_request"
        assert excinfo.value.message == "bad body"


async def test_connection_error(dead_port):
    async with AsyncWritAgent(f"http://127.0.0.1:{dead_port}", TOKEN) as client:
        with pytest.raises(WritConnectionError):
            await client.agent.status()


async def test_events_async_generator_terminates():
    body = sse_body(
        ("started", {"run_id": 5, "total_steps": 1}),
        ": keep-alive\n\n",
        ("finished", {"run_id": 5, "status": "success"}),
        ("step", {"run_id": 5, "index": 9, "step_type": "ghost", "status": "running"}),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/runs/5/events"
        return sse_response(body)

    events = []
    async with make_async_client(handler) as client:
        async for event in client.runs.events(5):
            events.append(event)
    assert [e["event"] for e in events] == ["started", "finished"]


class AsyncRouter:
    def __init__(self, *, sse=None, statuses=None):
        self.sse = sse
        self.statuses = statuses or ["success"]
        self.get_calls = 0
        self.cancel_calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "POST" and path == "/v1/workflows/3/run":
            return json_response(202, {"run_id": 5, "status": "running"})
        if request.method == "GET" and path == "/v1/runs/5/events":
            if isinstance(self.sse, Exception):
                raise self.sse
            return self.sse
        if request.method == "GET" and path == "/v1/runs/5":
            status = self.statuses[min(self.get_calls, len(self.statuses) - 1)]
            self.get_calls += 1
            return json_response(200, {"id": "workflow-5", "status": status})
        if request.method == "GET" and path == "/v1/runs/5/results":
            return json_response(200, {"run_id": 5, "status": "success", "result": [1]})
        if request.method == "POST" and path == "/v1/runs/5/cancel":
            self.cancel_calls += 1
            return json_response(202, {"run_id": 5, "status": "cancel_requested"})
        raise AssertionError(f"unexpected {request.method} {path}")


async def test_run_and_wait_over_sse():
    router = AsyncRouter(
        sse=sse_response(
            sse_body(
                ("started", {"run_id": 5, "total_steps": 1}),
                ("finished", {"run_id": 5, "status": "success"}),
            )
        )
    )
    async with make_async_client(router) as client:
        final = await client.workflows.run_and_wait(3, include_results=True)
    assert final["status"] == "success"
    assert final["results"]["result"] == [1]
    assert router.get_calls == 1


async def test_run_and_wait_polling_fallback_and_timeout():
    router = AsyncRouter(
        sse=httpx.ConnectError("boom"), statuses=["running", "running", "success"]
    )
    async with make_async_client(router) as client:
        final = await client.workflows.run_and_wait(3, poll_interval=0.01)
    assert final["status"] == "success"
    assert router.get_calls == 3

    stuck = AsyncRouter(sse=httpx.ConnectError("boom"), statuses=["running"])
    async with make_async_client(stuck) as client:
        with pytest.raises(WritTimeoutError):
            await client.workflows.run_and_wait(3, wait_timeout=0.05, poll_interval=0.01)
    assert stuck.cancel_calls == 0


async def test_lazy_discovery_on_aenter(fake_home, live_daemon):
    write_runtime(fake_home / ".writ", live_daemon.port, live_daemon.token)
    client = AsyncWritAgent()
    # No probe yet — discovery is lazy on the async client.
    assert client.base_url is None
    async with client:
        assert client.base_url == f"http://127.0.0.1:{live_daemon.port}"
        status = await client.agent.status()
    assert status["status"] == "ok"


async def test_async_env_override_configures_eagerly(fake_home, live_daemon, monkeypatch):
    monkeypatch.setenv("WRIT_API_URL", live_daemon.base_url)
    monkeypatch.setenv("WRIT_TOKEN", live_daemon.token)
    client = AsyncWritAgent()
    assert client.base_url == live_daemon.base_url  # ready without I/O
    async with client:
        assert (await client.agent.status())["status"] == "ok"


async def test_multipart_and_bytes_lanes():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/files" and request.method == "POST":
            body = request.read()
            assert b'filename="a.bin"' in body
            return json_response(200, {"id": "file_9"})
        if request.url.path == "/v1/files/file_9/content":
            return httpx.Response(200, content=b"\x01\x02")
        if request.url.path == "/v1/runs/5/data":
            return httpx.Response(200, content=b"run_id,a\n5,1\n")
        raise AssertionError(request.url.path)

    async with make_async_client(handler) as client:
        handle = await client.files.upload(b"\x01\x02", filename="a.bin")
        assert handle["id"] == "file_9"
        assert await client.files.content("file_9") == b"\x01\x02"
        assert (await client.runs.data_csv(5)).startswith("run_id,a")


async def test_crawl_surface():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and path == "/v1/crawl":
            return json_response(200, {"crawls": [{"id": 1, "brand": "Dragnet"}]})
        if request.method == "POST" and path == "/v1/crawl":
            body = json.loads(request.content)
            assert body == {"url": "https://example.com"}
            return json_response(
                200,
                {"id": 7, "brand": "Dragnet", "workflow_id": 42, "data_workflow_id": 42},
            )
        if request.method == "POST" and path == "/v1/crawl/7/cancel":
            return json_response(
                200, {"id": 7, "status": "stopping", "cancel_requested_now": True}
            )
        if request.method == "GET" and path == "/v1/crawl/404":
            return json_response(404, {"error": "crawl not found", "code": "not_found"})
        raise AssertionError(f"unexpected {request.method} {path}")

    async with make_async_client(handler) as client:
        listing = await client.crawl.list()
        assert not isinstance(listing, Page)
        assert listing["crawls"][0]["brand"] == "Dragnet"

        started = await client.crawl.start("https://example.com")
        assert started["brand"] == "Dragnet"
        assert started["data_workflow_id"] == started["workflow_id"] == 42

        cancelled = await client.crawl.cancel(7)
        assert cancelled["cancel_requested_now"] is True

        with pytest.raises(WritApiError) as excinfo:
            await client.crawl.get(404)
        assert excinfo.value.code == "not_found"
