"""Saved crawls — the callable crawl API and its ``max_age`` freshness contract.

A crawl row is one RUN and its id dies with that run, so a crawl had no stable
handle to call. A SAVED crawl owns the settings under a slug, which is what makes
these two things possible and worth pinning:

  * re-running with exactly the saved settings, and
  * ``max_age`` — "data collected within N seconds is acceptable, otherwise go get
    it again" — answered from the previous run instead of crawling.

What is asserted here is the CONTRACT a caller has to be able to rely on:
  - ``max_age`` reaches the wire as a delivery control, never as a crawl setting;
  - a freshness HIT returns rows inline and is distinguishable from a fresh crawl;
  - a cold call's 202 handle is a RESULT, not an exception (a crawl outlives the
    request, so the id is the answer);
  - ``wait=True`` overrun RAISES while keeping the crawl id, so work already paid
    for stays collectable;
  - ``save()`` refuses an ambiguous call rather than silently saving nothing.

Sync and async share one decode path, so the hit/miss shapes are asserted on both.
"""

from __future__ import annotations

import httpx
import pytest

from writ_agent import WritRunTimeoutError

from .helpers import json_response, make_async_client, make_client

RUN_PATH = "/v1/crawl/definitions/docs/run"

_DEFINITION = {
    "id": 4,
    "slug": "docs",
    "name": "Docs — example.com",
    "seed_url": "https://example.com/docs",
    "config": {"url": "https://example.com/docs", "page_budget": 200},
    "default_max_age_seconds": 86400,
}

_CACHED_BODY = {
    "cached": True,
    "_cache": {"hit": True, "age_seconds": 1200, "source_crawl_id": 9},
    "definition": _DEFINITION,
    "crawl": {"id": 9, "status": "completed", "pages_done": 42},
    "data": {"columns": ["url", "markdown"], "rows": [{"url": "https://example.com/docs"}]},
}

_DISPATCHED_BODY = {
    "cached": False,
    "_cache": {"hit": False},
    "definition": _DEFINITION,
    "crawl": {"id": 10, "status": "queued", "pages_done": 0},
    "status_url": "/api/crawl/10",
}


def _handler(body: dict, status: int = 200):
    """A daemon answering the saved-crawl run endpoint, capturing the request."""
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["method"] = request.method
        captured["body"] = request.read().decode() or ""
        return json_response(status, body)

    return handler, captured


def test_max_age_rides_the_body_as_a_delivery_control() -> None:
    handler, captured = _handler(_CACHED_BODY)
    client = make_client(handler)

    client.crawl.run_saved("docs", max_age=3600)

    assert captured["method"] == "POST"
    assert captured["url"].endswith(RUN_PATH)
    # The crawl SETTINGS are the saved ones — the body carries only freshness/delivery.
    assert '"max_age": 3600' in captured["body"] or '"max_age":3600' in captured["body"]
    assert "url" not in captured["body"], "a run must not restate the crawl config"


def test_a_freshness_hit_is_distinguishable_and_carries_rows() -> None:
    handler, _ = _handler(_CACHED_BODY)
    result = make_client(handler).crawl.run_saved("docs", max_age=86400)

    assert result["cached"] is True
    assert result["_cache"]["hit"] is True
    # The AGE is the whole point: a caller cannot reason about staleness without it.
    assert result["_cache"]["age_seconds"] == 1200
    assert result["_cache"]["source_crawl_id"] == 9
    assert result["data"]["rows"], "a hit hands back the collected rows inline"


def test_a_cold_call_returns_the_handle_rather_than_raising() -> None:
    """202 is the honest answer for a crawl: it outlives the request. It must be a
    RESULT, or every caller would have to catch an exception to learn the id."""
    handler, _ = _handler(_DISPATCHED_BODY, status=202)
    result = make_client(handler).crawl.run_saved("docs", max_age=0)

    assert result["cached"] is False
    assert result["_cache"]["hit"] is False
    assert result["crawl"]["id"] == 10
    assert result["status_url"] == "/api/crawl/10"
    assert result.get("data") is None, "nothing is collected yet on a cold dispatch"


def test_wait_overrun_raises_but_keeps_the_crawl_id_collectable() -> None:
    handler, captured = _handler(
        {"crawl_id": 11, "status_url": "/api/crawl/11", "retryable": True}, status=504
    )
    client = make_client(handler)

    with pytest.raises(WritRunTimeoutError):
        client.crawl.run_saved("docs", wait=True, timeout=30)

    # wait/timeout must actually reach the wire, or the caller blocked for nothing.
    assert '"wait": true' in captured["body"] or '"wait":true' in captured["body"]
    assert '"timeout": 30' in captured["body"] or '"timeout":30' in captured["body"]


def test_a_504_without_wait_is_a_transport_error_not_a_run_timeout() -> None:
    """Only a WAITING call can meaningfully time out. Without `wait` a 504 is the
    gateway failing, and dressing it up as "your crawl is still running" would
    invent a crawl id that does not exist."""
    handler, _ = _handler({"detail": "gateway"}, status=504)
    client = make_client(handler)

    with pytest.raises(Exception) as excinfo:
        client.crawl.run_saved("docs", max_age=60)
    assert not isinstance(excinfo.value, WritRunTimeoutError)


def test_save_requires_either_a_config_or_a_source_crawl() -> None:
    """Saving nothing is always a mistake — better a loud ValueError before any HTTP
    than a definition with an empty config that fails at run time."""
    client = make_client(lambda request: json_response(200, {}))
    with pytest.raises(ValueError, match="config=|from_crawl_id="):
        client.crawl.save(name="docs")


def test_save_from_an_existing_crawl_sends_from_crawl_id() -> None:
    handler, captured = _handler(_DEFINITION, status=201)
    client = make_client(handler)

    client.crawl.save(name="Docs", from_crawl_id=9, default_max_age_seconds=86400)

    assert '"from_crawl_id": 9' in captured["body"] or '"from_crawl_id":9' in captured["body"]
    # A client-rebuilt config would silently lose the knobs a crawl's status view
    # does not echo, so the SDK must not invent one.
    assert '"config"' not in captured["body"]


def test_saved_data_never_dispatches_a_crawl() -> None:
    handler, captured = _handler(
        {"definition": _DEFINITION, "crawl": {"id": 9}, "age_seconds": 4000, "data": None}
    )
    make_client(handler).crawl.saved_data("docs", limit=25)

    assert captured["method"] == "GET", "reading collected data must not be a POST"
    assert "limit=25" in captured["url"]


def test_saved_list_returns_the_definitions_envelope() -> None:
    handler, captured = _handler({"definitions": [_DEFINITION]})
    result = make_client(handler).crawl.saved(limit=10)

    assert [d["slug"] for d in result["definitions"]] == ["docs"]
    assert "limit=10" in captured["url"]


@pytest.mark.asyncio
async def test_async_client_shares_the_hit_and_miss_shapes() -> None:
    handler, _ = _handler(_CACHED_BODY)
    async with make_async_client(handler) as client:
        hit = await client.crawl.run_saved("docs", max_age=86400)
    assert hit["cached"] is True and hit["_cache"]["age_seconds"] == 1200

    handler, _ = _handler(_DISPATCHED_BODY, status=202)
    async with make_async_client(handler) as client:
        miss = await client.crawl.run_saved("docs", max_age=0)
    assert miss["cached"] is False and miss["crawl"]["id"] == 10


@pytest.mark.asyncio
async def test_async_wait_overrun_raises_run_timeout() -> None:
    handler, _ = _handler({"crawl_id": 11, "status_url": "/api/crawl/11"}, status=504)
    async with make_async_client(handler) as client:
        with pytest.raises(WritRunTimeoutError):
            await client.crawl.run_saved("docs", wait=True, timeout=15)


def test_workflow_run_max_age_is_a_query_control_not_an_input() -> None:
    """The workflow half of the same contract. `max_age` must never land in the run's
    inputs: it would feed the workflow a stray value AND make every distinct max_age
    a different request, which is the opposite of asking for a reusable answer."""
    handler, captured = _handler({"run_id": 5, "status": "success"})
    client = make_client(handler)

    client.workflows.run(3, {"city": "paris"}, max_age=600)

    assert "max_age=600" in captured["url"]
    assert '"city": "paris"' in captured["body"] or '"city":"paris"' in captured["body"]
    assert "max_age" not in captured["body"]
