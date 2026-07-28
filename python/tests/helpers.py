"""Test helpers: MockTransport clients and SSE body builders."""

from __future__ import annotations

import json
from typing import Any, Callable

import httpx

from writ_agent import AsyncWritAgent, WritAgent

BASE_URL = "http://127.0.0.1:8131"
TOKEN = "wlt_test"


def make_client(handler: Callable[[httpx.Request], httpx.Response], **kwargs: Any) -> WritAgent:
    """A sync client wired to a MockTransport (explicit base_url+token → no discovery probe)."""
    return WritAgent(
        BASE_URL, TOKEN, transport=httpx.MockTransport(handler), **kwargs
    )


def make_async_client(
    handler: Callable[[httpx.Request], httpx.Response], **kwargs: Any
) -> AsyncWritAgent:
    return AsyncWritAgent(
        BASE_URL, TOKEN, transport=httpx.MockTransport(handler), **kwargs
    )


def json_response(status: int, body: Any) -> httpx.Response:
    return httpx.Response(status, json=body)


def sse_body(*chunks: Any) -> bytes:
    """Build an SSE payload. Each chunk is either a ``(event_name, payload_dict)``
    tuple (one named frame) or a raw string appended verbatim (comments, etc.)."""
    out: list[str] = []
    for chunk in chunks:
        if isinstance(chunk, str):
            out.append(chunk)
        else:
            name, payload = chunk
            data = dict(payload)
            data.setdefault("event", name)
            out.append(f"event: {name}\ndata: {json.dumps(data)}\n\n")
    return "".join(out).encode()


def sse_response(body: bytes) -> httpx.Response:
    return httpx.Response(
        200, headers={"Content-Type": "text/event-stream"}, content=body
    )
