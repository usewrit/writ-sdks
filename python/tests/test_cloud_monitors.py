"""Cloud monitors tests (``client.cloud.monitors``) — the metered ``/api/targets/*``
surface that mirrors the local daemon's ``client.monitors``:

  * every verb routes to the real backend path and method
  * unset query params are omitted entirely (``?limit=`` 422s against a typed int)
  * the create body goes out snake_case; the answer comes back camelCase
  * DELETE answers 204 with an empty body and must not blow up on the decode
  * the keyless tier refuses BEFORE any network call — there is no account to own a monitor

Uses httpx.MockTransport — no cloud, no network.
"""
from __future__ import annotations

import httpx
import pytest

from writ_agent import Cloud, WritApiKeyRequiredError

MONITOR = {
    "id": 412,
    "url": "https://example.com/pricing",
    "checkType": "content",
    "selector": ".price",
    "checkPeriodMs": 300000,
    "enabled": True,
    "requiresPlaywright": False,
    "changesCount": 0,
}

# The two change routes answer DIFFERENT shapes and must be mocked separately.
# Serving one camelCase body for both is what hid a shipped bug: the global feed
# sends snake_case rows with INTEGER ids, so every field a caller read off a
# "recent change" came back missing.
CHANGE = {
    "id": "9",
    "targetId": "412",
    "timestamp": "2026-08-05T00:00:00Z",
    "firstDetectedAt": "2026-08-05T00:00:00Z",
    "lastDetectedAt": "2026-08-05T00:01:00Z",
    "oldContent": "$1,199",
    "newContent": "$1,099",
    "diff": "-$1,199\n+$1,099",
    "detectedBy": "1 agent",
}

# Verbatim RecentChangeInfo (backend/routers/targets.py).
RECENT_CHANGE = {
    "id": 9,
    "target_id": 412,
    "target_url": "https://example.com/pricing",
    "target_selector_id": None,
    "selector_name": None,
    "diff_snippet": "-$1,199 +$1,099",
    "first_detected_at": "2026-08-05T00:00:00+00:00",
    "last_detected_at": "2026-08-05T00:01:00+00:00",
}


def _mock():
    """Route by (method, path) the way the real backend does — 204 for DELETE."""
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.method == "DELETE":
            return httpx.Response(204)
        path = request.url.path
        if path.endswith("/run"):
            return httpx.Response(200, json={"ok": True, "dispatched": 2})
        if path.endswith("/changes/recent"):
            return httpx.Response(200, json=[RECENT_CHANGE])
        if path.endswith("/changes"):
            return httpx.Response(200, json=[CHANGE])
        if path == "/api/targets" and request.method == "GET":
            return httpx.Response(200, json=[MONITOR])
        return httpx.Response(200, json=MONITOR)

    return httpx.MockTransport(handler), calls


def _metered():
    transport, calls = _mock()
    return Cloud(api_key="wt_test", transport=transport), calls


def test_create_sends_snake_case_and_returns_camel_case():
    cloud, calls = _metered()

    mon = cloud.monitors.create(
        {
            "url": "https://example.com/pricing",
            "check_type": "content",
            "selector": ".price",
            "check_period_ms": 300000,
        }
    )

    assert calls[0].method == "POST"
    assert str(calls[0].url) == "https://api.usewrit.app/api/targets"
    assert calls[0].headers["authorization"] == "Bearer wt_test"
    # The cloud ACCEPTS snake_case even though it ANSWERS camelCase.
    assert b'"check_period_ms":300000' in calls[0].content
    assert mon["checkPeriodMs"] == 300000


def test_list_omits_unset_query_params():
    cloud, calls = _metered()

    cloud.monitors.list()
    assert str(calls[0].url) == "https://api.usewrit.app/api/targets"

    cloud.monitors.list(limit=50, enabled_only=True, check_type=None)
    assert str(calls[1].url) == "https://api.usewrit.app/api/targets?limit=50&enabled_only=true"


def test_every_verb_hits_its_real_path():
    cloud, calls = _metered()

    cloud.monitors.get(412)
    cloud.monitors.update(412, {"check_period_ms": 600000})
    cloud.monitors.toggle(412, False)
    run = cloud.monitors.run(412)
    changes = cloud.monitors.changes(412, limit=25)
    cloud.monitors.recent_changes(10)
    cloud.monitors.recent_changes()
    cloud.monitors.delete(412)

    assert [(c.method, str(c.url).replace("https://api.usewrit.app", "")) for c in calls] == [
        ("GET", "/api/targets/412"),
        ("PATCH", "/api/targets/412"),
        ("PATCH", "/api/targets/412/toggle?enabled=false"),
        ("POST", "/api/targets/412/run"),
        ("GET", "/api/targets/412/changes?limit=25"),
        ("GET", "/api/targets/changes/recent?limit=10"),
        ("GET", "/api/targets/changes/recent"),
        ("DELETE", "/api/targets/412"),
    ]
    assert run == {"ok": True, "dispatched": 2}
    assert changes[0]["newContent"] == "$1,099"


def test_delete_survives_the_204_empty_body():
    cloud, calls = _metered()
    assert cloud.monitors.delete(412) == {}
    assert calls[0].method == "DELETE"


@pytest.mark.parametrize(
    "call",
    [
        lambda m: m.list(),
        lambda m: m.create({"url": "https://x.test"}),
        lambda m: m.get(1),
        lambda m: m.update(1, {}),
        lambda m: m.delete(1),
        lambda m: m.toggle(1, True),
        lambda m: m.run(1),
        lambda m: m.changes(1),
        lambda m: m.recent_changes(),
    ],
)
def test_keyless_refuses_before_any_request(call):
    transport, calls = _mock()
    cloud = Cloud(transport=transport, client_id="device-123")
    assert cloud.tier == "keyless"

    with pytest.raises(WritApiKeyRequiredError):
        call(cloud.monitors)
    assert calls == []


@pytest.mark.asyncio
async def test_async_cloud_monitors_match_the_sync_paths():
    from writ_agent import AsyncCloud

    transport, calls = _mock()
    cloud = AsyncCloud(api_key="wt_test", transport=transport)

    await cloud.monitors.create({"url": "https://example.com/pricing"})
    await cloud.monitors.list(limit=5)
    await cloud.monitors.toggle(412, True)
    await cloud.monitors.changes(412, limit=3)
    await cloud.monitors.delete(412)
    await cloud.aclose()

    assert [(c.method, str(c.url).replace("https://api.usewrit.app", "")) for c in calls] == [
        ("POST", "/api/targets"),
        ("GET", "/api/targets?limit=5"),
        ("PATCH", "/api/targets/412/toggle?enabled=true"),
        ("GET", "/api/targets/412/changes?limit=3"),
        ("DELETE", "/api/targets/412"),
    ]


def test_plan_ceiling_is_not_insufficient_credits():
    """A 402 is either a wallet problem or a PLAN CEILING; they need different
    fixes, and the plan denial is the one that reports a numeric ``limit``."""
    from writ_agent import WritInsufficientCreditsError, WritPlanLimitError

    def plan_handler(request: httpx.Request) -> httpx.Response:
        # The backend sends plan denials FLAT — reading only the (string)
        # `detail` used to black-hole code/current/limit/upgrade_hint.
        return httpx.Response(402, json={
            "detail": "Check interval too short. Minimum for your plan: 10s.",
            "code": "interval_too_short",
            "current": 1000, "limit": 10000, "upgrade_hint": "growth",
        })

    cloud = Cloud(api_key="wt_test", transport=httpx.MockTransport(plan_handler))
    with pytest.raises(WritPlanLimitError) as excinfo:
        cloud.monitors.create({"url": "https://x.test", "check_period_ms": 1000})
    err = excinfo.value
    assert err.code == "interval_too_short"
    assert err.limit == 10000
    assert err.current == 1000
    assert err.upgrade_hint == "growth"

    def wallet_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json={
            "detail": {"message": "allotment spent", "code": "insufficient_credits"}
        })

    wallet = Cloud(api_key="wt_test", transport=httpx.MockTransport(wallet_handler))
    with pytest.raises(WritInsufficientCreditsError):
        wallet.scrape("https://x.test")


AUTOMATION = {"id": 7, "name": "a", "event_type": "change_detected", "enabled": True, "actions": []}
PERSONA = {"id": 3, "name": "p", "has_password": False, "has_totp_seed": False, "twofa_method": "none"}


def _mock_ap():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.method == "DELETE":
            return httpx.Response(204)
        path = request.url.path
        if path.endswith("/all") or path.startswith("/api/triggers/target/"):
            return httpx.Response(200, json=[AUTOMATION])
        if path.startswith("/api/triggers"):
            return httpx.Response(200, json=AUTOMATION)
        if path.endswith("/validate-totp"):
            return httpx.Response(200, json={"valid_base32": True})
        if path == "/api/personas" and request.method == "GET":
            return httpx.Response(200, json=[PERSONA])
        return httpx.Response(200, json=PERSONA)

    return httpx.MockTransport(handler), calls


def test_automations_and_personas_route_to_their_real_paths():
    transport, calls = _mock_ap()
    cloud = Cloud(api_key="wt_test", transport=transport)

    cloud.automations.list(enabled_only=True)
    cloud.automations.create({"name": "a"})
    cloud.automations.get(7)
    cloud.automations.update(7, {"description": "d"})
    cloud.automations.toggle(7)
    cloud.automations.run(7, {"x": 1})
    cloud.automations.executions(7, limit=5)
    cloud.automations.for_monitor(42)
    cloud.automations.delete(7)

    cloud.personas.list(domain="example.com")
    cloud.personas.create({"name": "p"})
    cloud.personas.get(3)
    cloud.personas.update(3, {"password": "x"})
    cloud.personas.runs(3, limit=5)
    cloud.personas.test_2fa(3)
    cloud.personas.validate_totp("JBSWY3DPEHPK3PXP", "123456")
    cloud.personas.delete(3)

    assert [(c.method, str(c.url).replace("https://api.usewrit.app", "")) for c in calls] == [
        ("GET", "/api/triggers/all?enabled_only=true"),
        ("POST", "/api/triggers"),
        ("GET", "/api/triggers/7"),
        ("PATCH", "/api/triggers/7"),
        ("PATCH", "/api/triggers/7/toggle"),
        ("POST", "/api/triggers/7/run"),
        ("GET", "/api/triggers/7/executions?limit=5"),
        ("GET", "/api/triggers/target/42"),
        ("DELETE", "/api/triggers/7"),
        ("GET", "/api/personas?domain=example.com"),
        ("POST", "/api/personas"),
        ("GET", "/api/personas/3"),
        ("PATCH", "/api/personas/3"),
        ("GET", "/api/personas/3/runs?limit=5"),
        ("POST", "/api/personas/3/test-2fa"),
        ("POST", "/api/personas/validate-totp"),
        ("DELETE", "/api/personas/3"),
    ]


@pytest.mark.parametrize("call", [
    lambda c: c.automations.list(),
    lambda c: c.automations.create({"name": "a"}),
    lambda c: c.automations.delete(1),
    lambda c: c.personas.list(),
    lambda c: c.personas.create({"name": "p"}),
    lambda c: c.personas.validate_totp("JBSWY3DPEHPK3PXP"),
])
def test_automations_and_personas_refuse_keyless(call):
    transport, calls = _mock_ap()
    cloud = Cloud(transport=transport, client_id="device-123")
    with pytest.raises(WritApiKeyRequiredError):
        call(cloud)
    assert calls == []
