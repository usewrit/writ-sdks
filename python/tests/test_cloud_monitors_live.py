"""Env-gated LIVE test: drives ``client.cloud.monitors`` and ``client.cloud.crawl``
against a REAL running coordinator. No mocks — this is the test that catches a
wrong path, a wrong JSON casing, or a scope the route map never mapped.

.. code-block:: sh

    WRIT_E2E=1 WRIT_CLOUD_URL=http://localhost:8000 WRIT_API_KEY=wt_… \\
      python -m pytest tests/test_cloud_monitors_live.py -v

The key needs monitors:read/write/execute/delete and crawl:read/execute.
Skipped (not failed) when ``WRIT_E2E`` is unset, so the suite stays hermetic.
"""
from __future__ import annotations

import os

import pytest

from writ_agent import Cloud, WritPlanLimitError

# example.com is the one seed guaranteed to answer 200 — the API fetches the page
# to establish a baseline, so a 404 seed is rejected outright.
SEED = "https://example.com"

pytestmark = pytest.mark.skipif(
    os.environ.get("WRIT_E2E") != "1",
    reason="set WRIT_E2E=1 (plus WRIT_CLOUD_URL/WRIT_API_KEY) to run against a live coordinator",
)


@pytest.fixture()
def cloud() -> Cloud:
    client = Cloud(
        api_key=os.environ["WRIT_API_KEY"],
        cloud_url=os.environ.get("WRIT_CLOUD_URL", "http://localhost:8000"),
    )
    assert client.tier == "metered"
    yield client
    client.close()


def test_monitor_lifecycle(cloud: Cloud):
    mon = cloud.monitors.create(
        {"url": SEED, "check_type": "content", "selector": "h1", "check_period_ms": 300_000}
    )
    try:
        # The docstrings claim the cloud answers camelCase — assert it does.
        assert mon["checkPeriodMs"] == 300_000
        assert mon["selector"] == "h1"
        assert mon["enabled"] is True

        assert any(m["id"] == mon["id"] for m in cloud.monitors.list(limit=100))
        assert cloud.monitors.get(mon["id"])["url"] == SEED
        assert cloud.monitors.update(mon["id"], {"check_period_ms": 600_000})["checkPeriodMs"] == 600_000
        assert cloud.monitors.toggle(mon["id"], False)["enabled"] is False
        assert cloud.monitors.toggle(mon["id"], True)["enabled"] is True

        run = cloud.monitors.run(mon["id"])
        assert "ok" in run and "dispatched" in run
        assert isinstance(cloud.monitors.changes(mon["id"], limit=5), list)
        assert isinstance(cloud.monitors.recent_changes(5), list)
    finally:
        # Never leave a monitor behind, even if an assertion above failed.
        cloud.monitors.delete(mon["id"])

    assert all(m["id"] != mon["id"] for m in cloud.monitors.list(limit=100))


def test_plan_interval_floor_is_a_plan_limit_not_a_wallet_problem(cloud: Cloud):
    # plan_enforcer REJECTS a sub-floor interval rather than clamping it, and it
    # is a PLAN ceiling — calling it "insufficient credits" would send the caller
    # to top up a wallet that was never the problem.
    with pytest.raises(WritPlanLimitError) as excinfo:
        cloud.monitors.create({"url": SEED, "check_period_ms": 1000})
    assert excinfo.value.code == "interval_too_short"
    assert excinfo.value.limit


def test_crawl_start_and_status(cloud: Cloud):
    job = cloud.crawl(SEED, max_depth=0, page_budget=1)
    assert isinstance(job["id"], int)
    assert cloud.crawl_status(job["id"])["seed_url"].startswith(SEED)


# ── automations + personas ─────────────────────────────────────────────────

def test_automation_lifecycle(cloud: Cloud):
    # SELF-HEALING, same reason as the persona test: leftovers from a crashed run
    # must not accumulate on the tenant or skew the list assertions below.
    for stale in cloud.automations.list():
        if stale["name"] == "sdk-e2e-automation":
            cloud.automations.delete(stale["id"])
    a = cloud.automations.create({
        "name": "sdk-e2e-automation", "event_type": "change_detected",
        "actions": [{"type": "notification", "config": {"channels": ["email"]}}],
    })
    try:
        assert a["enabled"] is True
        assert a["actions"][0]["type"] == "notification"
        assert any(x["id"] == a["id"] for x in cloud.automations.list())
        assert cloud.automations.get(a["id"])["name"] == "sdk-e2e-automation"
        assert cloud.automations.update(a["id"], {"description": "e2e"})["description"] == "e2e"
        # toggle FLIPS — it does not take a value.
        assert cloud.automations.toggle(a["id"])["enabled"] is False
        assert cloud.automations.toggle(a["id"])["enabled"] is True
        assert cloud.automations.executions(a["id"], limit=5) is not None
        assert cloud.automations.for_monitor(999999) is not None
    finally:
        cloud.automations.delete(a["id"])
    assert all(x["id"] != a["id"] for x in cloud.automations.list())


def test_persona_secrets_are_write_only(cloud: Cloud):
    """The contract that matters: a secret goes IN and never comes back out."""
    # SELF-HEALING: a live tenant is not a fixture. Personas are unique by name,
    # so a run that died before its cleanup would 409 every run after it.
    for stale in cloud.personas.list():
        if stale["name"] == "sdk-e2e-persona":
            cloud.personas.delete(stale["id"])
    p = cloud.personas.create({"name": "sdk-e2e-persona", "target_domain": "example.com"})
    try:
        assert p["has_password"] is False, "no secret sent ⇒ has_password false"
        assert "password" not in p and "totp_seed" not in p

        updated = cloud.personas.update(p["id"], {"password": "e2e-not-a-real-credential"})
        assert updated["has_password"] is True, "a written secret must flip the boolean"
        assert "password" not in updated, "the VALUE must never come back"

        assert any(x["id"] == p["id"] for x in cloud.personas.list())
        assert cloud.personas.get(p["id"])["name"] == "sdk-e2e-persona"
        assert cloud.personas.runs(p["id"], limit=5) is not None
        # Checking a seed must not require storing it anywhere.
        assert cloud.personas.validate_totp("JBSWY3DPEHPK3PXP")["valid_base32"] is True
    finally:
        cloud.personas.delete(p["id"])
    assert all(x["id"] != p["id"] for x in cloud.personas.list())
