"""The page channel as an ASGI 3 application (no framework needed).

Mount it on the one route the page bridge talks to::

    # Starlette
    from starlette.routing import Route
    routes = [Route("/writ-bridge", bridge.asgi, methods=["GET", "POST"])]

    # FastAPI (or use bridge.fastapi_router())
    app.add_route("/writ-bridge", bridge.asgi, methods=["GET", "POST"])

    # Any ASGI server, as the whole app
    uvicorn.run(bridge.asgi)

The app serves whatever path it is mounted at. While a poll waits, it watches for the client
going away, so a closed tab never takes a command with it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any, Protocol

from ._json import dumps
from .channel import ChannelResponse, HeadersLike, QueryLike

__all__ = ["BridgeASGIApp"]

logger = logging.getLogger("usewrit")

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]


class _Handle(Protocol):
    def __call__(
        self,
        method: str,
        headers: HeadersLike | None,
        query: QueryLike,
        body: bytes | None,
        *,
        disconnected: asyncio.Event | None = None,
    ) -> Awaitable[ChannelResponse]: ...


class BridgeASGIApp:
    """An ASGI 3 app serving the Writ Bridge page channel (``bridge.asgi``)."""

    def __init__(
        self,
        handle: _Handle,
        *,
        max_body_bytes: Callable[[], int],
        on_shutdown: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._handle = handle
        self._max_body_bytes = max_body_bytes
        self._on_shutdown = on_shutdown

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope.get("type")
        if kind == "lifespan":
            await self._lifespan(receive, send)
            return
        if kind == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        if kind != "http":
            return

        method = str(scope.get("method") or "GET")
        headers: list[tuple[bytes, bytes]] = list(scope.get("headers") or [])
        query = scope.get("query_string") or b""
        limit = self._max_body_bytes()

        declared = _content_length(headers)
        if declared is not None and declared > limit:
            await _send(send, *_too_large(limit))
            return
        body = bytearray()
        while True:
            message = await receive()
            kind = message.get("type")
            if kind == "http.disconnect":
                return
            if kind != "http.request":
                continue
            body.extend(message.get("body") or b"")
            if len(body) > limit:
                await _send(send, *_too_large(limit))
                return
            if not message.get("more_body", False):
                break

        disconnected = asyncio.Event()

        async def watch() -> None:
            # After the body, the next message an ASGI server sends is the disconnect.
            while True:
                message = await receive()
                if message.get("type") == "http.disconnect":
                    disconnected.set()
                    return

        watcher = asyncio.ensure_future(watch())
        try:
            status, response_headers, payload = await self._handle(
                method, headers, query, bytes(body), disconnected=disconnected
            )
        finally:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await watcher
        if disconnected.is_set():
            return  # nobody is there to read the answer
        await _send(send, status, response_headers, payload)

    async def _lifespan(self, receive: Receive, send: Send) -> None:
        while True:
            message = await receive()
            kind = message.get("type")
            if kind == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif kind == "lifespan.shutdown":
                if self._on_shutdown is not None:
                    try:
                        await self._on_shutdown()
                    except Exception:  # shutting down anyway
                        logger.exception("Writ Bridge: closing the bridge failed")
                await send({"type": "lifespan.shutdown.complete"})
                return


def _content_length(headers: list[tuple[bytes, bytes]]) -> int | None:
    for name, value in headers:
        if name.lower() == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None


def _too_large(limit: int) -> ChannelResponse:
    body = dumps({"error": {"code": "BAD_REQUEST", "message": f"The request body is larger than {limit} bytes."}})
    return (
        413,
        {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-type": "application/json; charset=utf-8",
        },
        body.encode("utf-8"),
    )


async def _send(send: Send, status: int, headers: dict[str, str], payload: bytes) -> None:
    raw = [(name.lower().encode("latin-1"), value.encode("latin-1")) for name, value in headers.items()]
    if status != 204 and status != 304:
        raw.append((b"content-length", str(len(payload)).encode("latin-1")))
    await send({"type": "http.response.start", "status": status, "headers": raw})
    await send({"type": "http.response.body", "body": payload if status != 204 else b""})
