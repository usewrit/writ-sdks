"""The page channel over ASGI (``bridge.asgi``) and FastAPI (``bridge.fastapi_router()``)."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from .conftest import FakeClock
from .helpers import HELLO, LOGIN, auth, make_bridge, make_receipt

KEY = "auth.verify_login"
DATA = {"ok": True, "n": 1}


async def _round_trip(bridge: Any, client: httpx.AsyncClient, path: str) -> None:
    token = bridge.user_token("u1")
    response = await client.post(path, json=HELLO, headers=auth(token))
    assert response.status_code == 204
    assert response.content == b""

    task = asyncio.ensure_future(bridge.user("u1").auth.verify_login(LOGIN))
    response = await client.get(path, params={"wait": 5}, headers=auth(token))
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"].startswith("application/json")
    commands = response.json()["commands"]
    assert [command["key"] for command in commands] == [KEY]
    command = commands[0]

    receipt = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], data=DATA)
    response = await client.post(
        path,
        json={"result": {"id": command["id"], "ok": True, "data": DATA, "receipt": receipt}},
        headers=auth(token),
    )
    assert response.status_code == 204
    result = await asyncio.wait_for(task, timeout=5)
    assert result.venue == "user" and result.data == DATA


async def test_asgi_app_serves_the_channel(clock: FakeClock) -> None:
    bridge = make_bridge()
    transport = httpx.ASGITransport(app=bridge.asgi)
    async with httpx.AsyncClient(transport=transport, base_url="https://app.example.com") as client:
        response = await client.get("/writ-bridge", params={"wait": 0}, headers={"Authorization": "Writ forged.token"})
        assert response.status_code == 401
        assert response.headers["www-authenticate"] == "Writ"
        assert response.json() == {
            "error": {"code": "NOT_GRANTED", "message": "The Writ user token is missing, invalid or expired."}
        }
        await _round_trip(bridge, client, "/writ-bridge")


async def test_asgi_app_refuses_a_declared_oversized_body(clock: FakeClock) -> None:
    bridge = make_bridge(max_body_bytes=2_048)
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/writ-bridge",
        "query_string": b"",
        "headers": [(b"content-length", b"99999")],
    }
    await bridge.asgi(scope, receive, send)
    assert sent[0]["status"] == 413


async def test_asgi_app_refuses_a_streamed_oversized_body(clock: FakeClock) -> None:
    bridge = make_bridge(max_body_bytes=1_024)
    chunks = [{"type": "http.request", "body": b"x" * 600, "more_body": True}] * 2
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return chunks.pop(0) if chunks else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/", "query_string": b"", "headers": []}
    await bridge.asgi(scope, receive, send)
    assert sent[0]["status"] == 413


async def test_a_poll_whose_client_leaves_sends_nothing_and_loses_nothing(clock: FakeClock) -> None:
    bridge = make_bridge()
    token = bridge.user_token("u1")
    messages: list[dict[str, Any]] = [{"type": "http.request", "body": b"", "more_body": False}]

    async def receive() -> dict[str, Any]:
        if messages:
            return messages.pop(0)
        await asyncio.sleep(0.05)
        return {"type": "http.disconnect"}

    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/writ-bridge",
        "query_string": b"wait=5",
        "headers": [(b"authorization", f"Writ {token}".encode())],
    }
    await asyncio.wait_for(bridge.asgi(scope, receive, send), timeout=3)
    assert sent == []


async def test_lifespan_and_websockets(clock: FakeClock) -> None:
    bridge = make_bridge()
    messages: list[dict[str, Any]] = [{"type": "lifespan.startup"}, {"type": "lifespan.shutdown"}]
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return messages.pop(0)

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await bridge.asgi({"type": "lifespan"}, receive, send)
    assert [message["type"] for message in sent] == ["lifespan.startup.complete", "lifespan.shutdown.complete"]

    sent.clear()
    await bridge.asgi({"type": "websocket"}, receive, send)
    assert sent == [{"type": "websocket.close", "code": 1008}]


async def test_fastapi_router_mounts_the_channel(clock: FakeClock) -> None:
    fastapi = pytest.importorskip("fastapi")
    bridge = make_bridge()
    app = fastapi.FastAPI()
    app.include_router(bridge.fastapi_router("/writ-bridge"))

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://app.example.com") as client:
        response = await client.get("/writ-bridge", params={"wait": 0})
        assert response.status_code == 401
        response = await client.put("/writ-bridge", headers=auth(bridge.user_token("u1")))
        assert response.status_code == 405
        assert (await client.get("/elsewhere")).status_code == 404
        await _round_trip(bridge, client, "/writ-bridge")
    # The route stays out of the app's OpenAPI document.
    assert "/writ-bridge" not in app.openapi().get("paths", {})


async def test_fastapi_router_under_a_prefix(clock: FakeClock) -> None:
    fastapi = pytest.importorskip("fastapi")
    bridge = make_bridge()
    app = fastapi.FastAPI()
    app.include_router(bridge.fastapi_router(), prefix="/api")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://app.example.com") as client:
        await _round_trip(bridge, client, "/api/writ-bridge")


def test_fastapi_router_needs_a_path(clock: FakeClock) -> None:
    pytest.importorskip("fastapi")
    from usewrit import WritBridgeError

    with pytest.raises(WritBridgeError):
        make_bridge().fastapi_router("writ-bridge")
