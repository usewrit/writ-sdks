"""Cloud tier tests (writ_agent.Cloud): Firecrawl-style credential fallback + routing.

  * keyless (no key)  → /v1/keyless/*  with an X-Writ-Client-Id header, no bearer
  * metered (api key) → /api/crawl/*   with an Authorization: Bearer header
  * crawl WITHOUT a key raises WritApiKeyRequiredError before any network call
  * 429 maps to WritRateLimitedError (with reset_at)

Uses httpx.MockTransport — no daemon, no network.
"""
from __future__ import annotations

import httpx
import pytest

from writ_agent import Cloud, WritApiKeyRequiredError, WritRateLimitedError


def _mock(status: int, payload: dict):
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler), calls


def test_keyless_scrape_uses_client_id_and_no_bearer():
    tr, calls = _mock(200, {
        "verb": "scrape", "url": "https://x.test", "title": "Hi", "markdown": "# Hi",
        "counts": {"chars": 4},
        "quota": {"tier": "keyless", "requests_remaining": 9, "pages_remaining": 19,
                  "reset_at": "2026-07-17T00:00:00Z"},
    })
    c = Cloud(transport=tr, client_id="device-123")
    assert c.tier == "keyless"
    res = c.scrape("https://x.test")
    assert str(calls[0].url).endswith("/v1/keyless/scrape")
    assert calls[0].headers.get("x-writ-client-id") == "device-123"
    assert "authorization" not in calls[0].headers
    assert res["tier"] == "keyless"
    assert res["markdown"] == "# Hi"
    assert res["quota"]["requests_remaining"] == 9


def test_crawl_without_key_raises_and_makes_no_request():
    tr, calls = _mock(200, {})
    c = Cloud(transport=tr, client_id="device-123")
    with pytest.raises(WritApiKeyRequiredError):
        c.crawl("https://x.test")
    assert calls == []


def test_429_maps_to_rate_limited_with_reset_at():
    tr, _ = _mock(429, {"detail": {
        "message": "used your keyless allowance", "code": "keyless_rate_limited",
        "reset_at": "2026-07-17T00:00:00Z", "requests_remaining": 0,
    }})
    c = Cloud(transport=tr, client_id="device-123")
    with pytest.raises(WritRateLimitedError) as ei:
        c.scrape("https://x.test")
    assert ei.value.reset_at == "2026-07-17T00:00:00Z"


def test_metered_scrape_uses_bearer_and_no_client_id():
    tr, calls = _mock(200, {"verb": "scrape", "url": "https://x.test", "markdown": "# Hi",
                            "counts": {}, "tier": "metered"})
    c = Cloud(transport=tr, api_key="wt_secret")
    assert c.tier == "metered"
    res = c.scrape("https://x.test")
    assert str(calls[0].url).endswith("/api/crawl/scrape")
    assert calls[0].headers.get("authorization") == "Bearer wt_secret"
    assert "x-writ-client-id" not in calls[0].headers
    assert res["tier"] == "metered"


def test_metered_crawl_posts_to_api_crawl():
    tr, calls = _mock(200, {"id": 7, "status": "queued"})
    c = Cloud(transport=tr, api_key="wt_secret")
    job = c.crawl("https://x.test", page_budget=100)
    assert str(calls[0].url).endswith("/api/crawl")
    assert calls[0].headers.get("authorization") == "Bearer wt_secret"
    assert job["id"] == 7


def test_env_api_key_selects_metered(monkeypatch):
    monkeypatch.setenv("WRIT_API_KEY", "wt_env")
    assert Cloud().tier == "metered"


def test_no_key_is_keyless(monkeypatch):
    monkeypatch.delenv("WRIT_API_KEY", raising=False)
    assert Cloud().tier == "keyless"
