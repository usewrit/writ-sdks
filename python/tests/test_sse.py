"""SSE parsing + ``runs.events`` (DESIGN §8): typed frames, keep-alive comments
ignored, multi-``data:`` accumulation, terminal close, already-finished runs."""

from __future__ import annotations

import httpx

from writ_agent._sse import SSEDecoder

from .helpers import make_client, sse_body, sse_response


def feed_all(decoder: SSEDecoder, text: str):
    events = []
    for line in text.split("\n"):
        event = decoder.feed(line)
        if event is not None:
            events.append(event)
    return events


def test_decoder_basic_named_frame():
    events = feed_all(
        SSEDecoder(), 'event: started\ndata: {"event":"started","run_id":5,"total_steps":3}\n\n'
    )
    assert events == [{"event": "started", "run_id": 5, "total_steps": 3}]


def test_decoder_accumulates_multi_data_lines():
    # Split the JSON across two data: lines — must be joined with \n and parsed.
    events = feed_all(
        SSEDecoder(), 'event: progress\ndata: {"event":"progress",\ndata: "run_id":5,"completed":1,"total":3}\n\n'
    )
    assert events == [{"event": "progress", "run_id": 5, "completed": 1, "total": 3}]


def test_decoder_ignores_comments_id_and_retry():
    text = (
        ": keep-alive\n\n"
        "id: 42\n"
        "retry: 1000\n"
        ': another comment\n'
        'event: finished\ndata: {"event":"finished","run_id":5,"status":"success"}\n\n'
    )
    events = feed_all(SSEDecoder(), text)
    assert events == [{"event": "finished", "run_id": 5, "status": "success"}]


def test_decoder_backfills_event_from_frame_name():
    events = feed_all(SSEDecoder(), 'event: step\ndata: {"run_id":5,"index":0}\n\n')
    assert events == [{"event": "step", "run_id": 5, "index": 0}]


def test_events_yields_typed_frames_and_stops_after_terminal():
    body = sse_body(
        ("started", {"run_id": 5, "total_steps": 2}),
        ": keep-alive\n\n",
        ("step", {"run_id": 5, "index": 0, "step_type": "navigate", "status": "succeeded"}),
        ("progress", {"run_id": 5, "completed": 1, "total": 2}),
        ("finished", {"run_id": 5, "status": "success"}),
        # Anything after the terminal frame must never be yielded.
        ("step", {"run_id": 5, "index": 99, "step_type": "ghost", "status": "running"}),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/runs/5/events"
        return sse_response(body)

    with make_client(handler) as client:
        events = list(client.runs.events(5))

    assert [e["event"] for e in events] == ["started", "step", "progress", "finished"]
    assert events[1]["step_type"] == "navigate"
    assert events[-1]["status"] == "success"


def test_events_error_event_is_terminal():
    body = sse_body(("error", {"run_id": 6, "message": "navigation failed"}))

    def handler(request: httpx.Request) -> httpx.Response:
        return sse_response(body)

    with make_client(handler) as client:
        events = list(client.runs.events(6))
    assert events == [{"event": "error", "run_id": 6, "message": "navigation failed"}]


def test_events_already_finished_run_single_terminal_frame():
    # The daemon's immediate-close path: exactly one synthetic terminal frame.
    body = sse_body(("finished", {"run_id": 7, "status": "cancelled"}))

    def handler(request: httpx.Request) -> httpx.Response:
        return sse_response(body)

    with make_client(handler) as client:
        events = list(client.runs.events(7))
    assert len(events) == 1
    assert events[0]["status"] == "cancelled"


def test_events_missing_run_raises_api_error():
    import pytest

    from writ_agent import WritApiError

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "not found: run 999", "code": "not_found"})

    with make_client(handler) as client:
        with pytest.raises(WritApiError) as excinfo:
            list(client.runs.events(999))
    assert excinfo.value.code == "not_found"


def test_events_streams_from_chunked_iterator_content():
    # Exercise the true streaming lane: content arrives in arbitrary chunk splits.
    payload = sse_body(
        ("started", {"run_id": 5, "total_steps": 1}),
        ("finished", {"run_id": 5, "status": "success"}),
    )
    chunks = [payload[i : i + 7] for i in range(0, len(payload), 7)]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"Content-Type": "text/event-stream"}, content=iter(chunks)
        )

    with make_client(handler) as client:
        events = list(client.runs.events(5))
    assert [e["event"] for e in events] == ["started", "finished"]
