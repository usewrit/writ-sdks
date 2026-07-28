"""Discovery (DESIGN §4/§9.1): temp-home resolution, stale fallthrough, env
override, WRIT_HOME precedence, profile scan, and the missing-daemon error."""

from __future__ import annotations

import pytest

from writ_agent import WritAgent, WritDiscoveryError

from .conftest import write_runtime


def test_active_profile_candidate_resolves_port_and_token(fake_home, live_daemon):
    base = fake_home / ".writ"
    base.mkdir()
    (base / "active_profile").write_text("team1")
    write_runtime(base / "profiles" / "team1", live_daemon.port, live_daemon.token)

    client = WritAgent()
    try:
        assert client.base_url == f"http://127.0.0.1:{live_daemon.port}"
        assert client.token == live_daemon.token
        # The probe actually hit /v1/agent with the candidate's bearer.
        assert live_daemon.requests[0]["path"] == "/v1/agent"
        assert live_daemon.requests[0]["authorization"] == f"Bearer {live_daemon.token}"
        # And the discovered client works end-to-end against the live server.
        assert client.agent.status()["status"] == "ok"
    finally:
        client.close()


def test_stale_candidate_falls_through_to_next(fake_home, live_daemon, dead_port):
    base = fake_home / ".writ"
    base.mkdir()
    (base / "active_profile").write_text("team1")
    # Active-profile candidate points at a crashed daemon (closed port)...
    write_runtime(base / "profiles" / "team1", dead_port, "wlt_stale")
    # ...the root descriptor is the live one.
    write_runtime(base, live_daemon.port, live_daemon.token)

    client = WritAgent()
    try:
        assert client.token == live_daemon.token
        assert client.base_url == f"http://127.0.0.1:{live_daemon.port}"
    finally:
        client.close()


def test_env_override_wins_and_skips_probe(fake_home, live_daemon, monkeypatch):
    monkeypatch.setenv("WRIT_API_URL", live_daemon.base_url + "/")  # trailing / stripped
    monkeypatch.setenv("WRIT_TOKEN", live_daemon.token)
    client = WritAgent()
    try:
        # Both env fields set → discovery is done, no probe request was made.
        assert live_daemon.requests == []
        assert client.base_url == live_daemon.base_url
        assert client.token == live_daemon.token
        assert client.agent.status()["status"] == "ok"
    finally:
        client.close()


def test_partial_env_token_fills_field_rest_discovered(fake_home, live_daemon, monkeypatch):
    # runtime.json supplies the port; WRIT_TOKEN overrides the file token.
    stub_token_server = live_daemon
    stub_token_server.server.token = "wlt_env"
    monkeypatch.setenv("WRIT_TOKEN", "wlt_env")
    base = fake_home / ".writ"
    write_runtime(base, live_daemon.port, "wlt_file_token_ignored")

    client = WritAgent()
    try:
        assert client.token == "wlt_env"
        assert client.base_url == f"http://127.0.0.1:{live_daemon.port}"
    finally:
        client.close()


def test_writ_home_candidate_probed_first(fake_home, live_daemon, monkeypatch):
    # ~/.writ/runtime.json exists but WRIT_HOME must be probed FIRST.
    live_daemon.server.token = "wlt_home"
    base = fake_home / ".writ"
    write_runtime(base, live_daemon.port, "wlt_root")
    home_dir = fake_home / "custom-home"
    write_runtime(home_dir, live_daemon.port, "wlt_home")
    monkeypatch.setenv("WRIT_HOME", str(home_dir))

    client = WritAgent()
    try:
        assert client.token == "wlt_home"
        assert live_daemon.requests[0]["authorization"] == "Bearer wlt_home"
    finally:
        client.close()


def test_profiles_scan_finds_daemon_without_active_profile(fake_home, live_daemon):
    base = fake_home / ".writ"
    write_runtime(base / "profiles" / "zz-scan-only", live_daemon.port, live_daemon.token)

    client = WritAgent()
    try:
        assert client.token == live_daemon.token
    finally:
        client.close()


def test_invalid_active_profile_pointer_is_ignored(fake_home, live_daemon):
    base = fake_home / ".writ"
    base.mkdir()
    # "local" and traversal-shaped ids are rejected by the profile grammar.
    (base / "active_profile").write_text("../evil")
    write_runtime(base, live_daemon.port, live_daemon.token)

    client = WritAgent()
    try:
        assert client.token == live_daemon.token
    finally:
        client.close()


def test_missing_daemon_raises_discovery_error(fake_home):
    with pytest.raises(WritDiscoveryError) as excinfo:
        WritAgent()
    assert "WRIT_TOKEN" in str(excinfo.value)


def test_all_candidates_stale_raises_discovery_error(fake_home, dead_port):
    write_runtime(fake_home / ".writ", dead_port, "wlt_stale")
    with pytest.raises(WritDiscoveryError) as excinfo:
        WritAgent()
    assert "candidate" in str(excinfo.value)
