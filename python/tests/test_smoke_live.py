"""Env-gated live smoke test (DESIGN §9): ``WRIT_SMOKE=1 pytest`` discovers the
real local daemon and performs three read-only calls. Skipped by default."""

from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("WRIT_SMOKE") != "1",
    reason="live smoke test (set WRIT_SMOKE=1 to run against a local daemon)",
)


def test_live_smoke_status_workflows_runs():
    from writ_agent import Page, WritAgent

    with WritAgent() as client:
        status = client.agent.status()
        assert status.get("status") == "ok"
        assert "version" in status

        workflows = client.workflows.list()
        assert isinstance(workflows, Page)
        assert workflows.count == len(workflows.data)

        runs = client.runs.list(limit=1)
        assert isinstance(runs, Page)
        assert len(runs.data) <= 1
        if runs.data:
            item = runs.data[0]
            assert isinstance(item.get("id"), str)
