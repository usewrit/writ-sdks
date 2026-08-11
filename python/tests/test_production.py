"""Production-readiness behaviour: retry, idempotency, cursor watching, webhooks."""

from __future__ import annotations

import hashlib
import hmac
import time

import httpx
import pytest

from writ_agent import (
    RetryPolicy,
    WritAgent,
    WritWebhookVerificationError,
    auto_page,
    sign_webhook_request,
    verify_webhook,
)
from writ_agent.cloud import Cloud
from writ_agent.pagination import Page

FAST = RetryPolicy(max_attempts=4, base_delay=0.001, max_delay=0.005)


def _client(handler, **kw) -> WritAgent:
    return WritAgent(
        base_url="http://127.0.0.1:1",
        token="wlt_test",
        transport=httpx.MockTransport(handler),
        **kw,
    )


# ---------------------------------------------------------------------------
# retry
# ---------------------------------------------------------------------------

def test_transient_503_is_retried_not_surfaced():
    hits = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        hits["n"] += 1
        if hits["n"] < 3:
            return httpx.Response(503)
        return httpx.Response(200, json={"id": 1})

    with _client(handler, retry=FAST) as client:
        assert client.monitors.get(1)["id"] == 1
    assert hits["n"] == 3


def test_post_against_the_daemon_is_never_retried():
    # The daemon has no Idempotency-Key lane, so a second attempt is a second
    # monitor — the one failure mode a retry must never introduce.
    hits = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        hits["n"] += 1
        return httpx.Response(503)

    with _client(handler, retry=FAST) as client:
        with pytest.raises(Exception):
            client.monitors.create({"url": "https://example.com"})
    assert hits["n"] == 1


def test_cloud_retries_unsafe_calls_under_one_stable_idempotency_key():
    keys: list[str | None] = []
    hits = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers.get("idempotency-key"))
        hits["n"] += 1
        if hits["n"] < 2:
            return httpx.Response(502)
        return httpx.Response(200, json={"id": 7})

    cloud = Cloud(
        api_key="wt_test",
        cloud_url="http://cloud.test",
        transport=httpx.MockTransport(handler),
        retry=FAST,
    )
    assert cloud.monitors.create({"url": "https://example.com"})["id"] == 7
    assert len(keys) == 2
    assert keys[0], "an unsafe cloud request must carry an Idempotency-Key"
    # If the key changed between attempts the server would execute twice.
    assert keys[0] == keys[1]


def test_long_retry_after_is_not_slept_on():
    hits = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        hits["n"] += 1
        return httpx.Response(
            429,
            headers={"retry-after": "36000"},  # 10 hours
            json={"detail": {"code": "rate_limited", "message": "daily allowance spent"}},
        )

    cloud = Cloud(
        api_key="wt_test",
        cloud_url="http://cloud.test",
        transport=httpx.MockTransport(handler),
    )
    started = time.monotonic()
    with pytest.raises(Exception):
        cloud.monitors.list()
    assert time.monotonic() - started < 2.0
    assert hits["n"] == 1


# ---------------------------------------------------------------------------
# change-feed shape
# ---------------------------------------------------------------------------

def test_recent_changes_carries_the_real_global_feed_fields():
    # The regression this guards: the SDK's RecentChange named fields (`url`,
    # `created_at`) the server never sends, so reads came back empty.
    row = {
        "id": 9,
        "target_id": 412,
        "target_url": "https://example.com/pricing",
        "target_selector_id": None,
        "selector_name": None,
        "diff_snippet": "-$1,199 +$1,099",
        "first_detected_at": "2026-08-05T00:00:00+00:00",
        "last_detected_at": "2026-08-05T00:01:00+00:00",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/changes/recent"
        return httpx.Response(200, json=[row])

    with _client(handler) as client:
        page = client.monitors.recent_changes(limit=5)
    change = page[0]
    assert change["target_url"] == "https://example.com/pricing"
    assert change["diff_snippet"] == "-$1,199 +$1,099"
    # The cursor field: without it a watcher has nothing to advance on.
    assert change["last_detected_at"] == "2026-08-05T00:01:00+00:00"


def test_recent_changes_forwards_the_keyset_cursor():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(dict(request.url.params))
        return httpx.Response(200, json=[])

    with _client(handler) as client:
        client.monitors.recent_changes(limit=10, since="2026-08-05T00:00:00Z", since_id=4)
    assert seen["since"] == "2026-08-05T00:00:00Z"
    assert seen["since_id"] == "4"


# ---------------------------------------------------------------------------
# watch
# ---------------------------------------------------------------------------

def _feed(rows):
    """A handler mirroring the server: no cursor = newest-first browsing view,
    a cursor = oldest-first keyset walk."""

    def handler(request: httpx.Request) -> httpx.Response:
        params = request.url.params
        since = params.get("since")
        since_id = int(params.get("since_id") or 0)
        limit = int(params.get("limit") or 100)

        if since:
            matched = [
                r for r in rows
                if r["last_detected_at"] > since
                or (r["last_detected_at"] == since and r["id"] > since_id)
            ]
        else:
            matched = list(reversed(rows))
        return httpx.Response(200, json=matched[:limit])

    return handler


def _row(i: int, ts: str) -> dict:
    return {
        "id": i,
        "target_id": 1,
        "target_url": "https://a",
        "target_selector_id": None,
        "selector_name": None,
        "diff_snippet": None,
        "first_detected_at": ts,
        "last_detected_at": ts,
    }


def test_watch_walks_the_cursor_without_gaps_or_repeats():
    rows = [_row(i, f"2026-08-05T00:00:0{i}Z") for i in range(1, 6)]
    with _client(_feed(rows)) as client:
        seen = []
        # page_size 2 forces three pages — the exact case a naive newest-first
        # poller drops rows on.
        for change in client.monitors.watch(page_size=2, interval=0.001, replay_history=True):
            seen.append(change["id"])
            if len(seen) == 5:
                break
    assert seen == [1, 2, 3, 4, 5]


def test_watch_breaks_ties_so_same_instant_changes_all_arrive():
    same = "2026-08-05T00:00:01Z"
    rows = [_row(i, same) for i in (1, 2, 3)]
    with _client(_feed(rows)) as client:
        seen = []
        for change in client.monitors.watch(page_size=1, interval=0.001, replay_history=True):
            seen.append(change["id"])
            if len(seen) == 3:
                break
    # Without the since_id tie-break this loops forever on id 1.
    assert seen == [1, 2, 3]


def test_watch_starts_at_the_head_not_the_archive():
    rows = [_row(1, "2026-08-05T00:00:01Z"), _row(2, "2026-08-05T00:00:02Z")]
    polls = {"n": 0}

    def counting_feed(request: httpx.Request) -> httpx.Response:
        polls["n"] += 1
        return _feed(rows)(request)

    with _client(counting_feed) as client:
        # `stop` ends the loop after a few empty polls, so the assertion is
        # "nothing was delivered", not "the generator finished".
        seen = [
            change["id"]
            for change in client.monitors.watch(
                interval=0.001, stop=lambda: polls["n"] >= 4
            )
        ]
    # A fresh watcher opens on the head: the two pre-existing rows are history
    # and must NOT be re-delivered.
    assert seen == []
    assert polls["n"] >= 2, "the watcher never polled"


# ---------------------------------------------------------------------------
# auto_page
# ---------------------------------------------------------------------------

def test_auto_page_walks_past_the_first_page():
    pages = [
        Page(data=[1, 2], count=2),
        Page(data=[3, 4], count=2),
        Page(data=[5], count=1),
    ]
    calls = []

    def list_fn(**params):
        calls.append(params)
        return pages[len(calls) - 1]

    assert list(auto_page(list_fn, limit=2)) == [1, 2, 3, 4, 5]
    assert [c["offset"] for c in calls] == [0, 2, 4]


# ---------------------------------------------------------------------------
# webhooks
# ---------------------------------------------------------------------------

SECRET = "whsec_test"
BODY = b'{"event":"change_detected","target":{"id":42}}'


def _v1_headers(ts: str, body: bytes = BODY, secret: str = SECRET) -> dict:
    mac = hmac.new(secret.encode(), ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    return {"X-Writ-Timestamp": ts, "X-Writ-Signature-V1": f"sha256={mac}"}


def test_verify_webhook_accepts_a_valid_v1_delivery():
    verify_webhook(_v1_headers(str(int(time.time()))), BODY, SECRET)


def test_verify_webhook_rejects_tampering_and_a_wrong_secret():
    headers = _v1_headers(str(int(time.time())))
    with pytest.raises(WritWebhookVerificationError) as exc:
        verify_webhook(headers, BODY + b" ", SECRET)
    assert exc.value.reason == "signature_mismatch"

    with pytest.raises(WritWebhookVerificationError) as exc:
        verify_webhook(headers, BODY, "nope")
    assert exc.value.reason == "signature_mismatch"


def test_verify_webhook_rejects_a_correctly_signed_but_stale_delivery():
    # Signed correctly, but an hour old: that is a replay.
    stale = str(int(time.time()) - 3600)
    with pytest.raises(WritWebhookVerificationError) as exc:
        verify_webhook(_v1_headers(stale), BODY, SECRET)
    assert exc.value.reason == "stale"


def test_verify_webhook_refuses_body_only_unless_opted_in():
    mac = hmac.new(SECRET.encode(), BODY, hashlib.sha256).hexdigest()
    headers = {"X-Writ-Signature": f"sha256={mac}"}

    with pytest.raises(WritWebhookVerificationError):
        verify_webhook(headers, BODY, SECRET)
    verify_webhook(headers, BODY, SECRET, allow_legacy_body_only=True)


def test_sign_webhook_request_round_trips_through_the_verifier():
    headers = sign_webhook_request(BODY, SECRET)
    # The inbound scheme IS V1's scheme — one recipe for both directions.
    verify_webhook(
        {
            "X-Writ-Timestamp": headers["X-Writ-Timestamp"],
            "X-Writ-Signature-V1": headers["X-Writ-Signature"],
        },
        BODY,
        SECRET,
    )


def test_verify_webhook_reads_case_insensitive_headers():
    ts = str(int(time.time()))
    bag = {k.lower(): v for k, v in _v1_headers(ts).items()}
    verify_webhook(bag, BODY, SECRET)
