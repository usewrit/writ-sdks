"""Shared fixtures: a fake ``$HOME`` for discovery tests and a real threaded
loopback HTTP daemon stub for liveness-probe / end-to-end paths."""

from __future__ import annotations

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


@pytest.fixture()
def fake_home(tmp_path, monkeypatch):
    """Point ``~`` at a temp dir and clear every discovery env override."""
    monkeypatch.setenv("HOME", str(tmp_path))
    for var in ("WRIT_HOME", "WRIT_API_URL", "WRIT_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    return tmp_path


def write_runtime(dirpath: Path, port: int, token: str) -> Path:
    """Write a daemon-shaped ``runtime.json`` descriptor under ``dirpath``."""
    dirpath.mkdir(parents=True, exist_ok=True)
    payload = {
        "pid": 4242,
        "port": port,
        "token": token,
        "version": "0.1.0-test",
        "started_at": "2026-07-13T00:00:00+00:00",
    }
    path = dirpath / "runtime.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


class _DaemonHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (stdlib naming)
        server = self.server
        server.requests.append(
            {"path": self.path, "authorization": self.headers.get("Authorization")}
        )
        if self.path == "/v1/agent":
            expected = f"Bearer {server.token}"
            if self.headers.get("Authorization") == expected:
                body = json.dumps(
                    {"status": "ok", "version": "0.1.0-test", "active_runs": 0}
                ).encode()
                self.send_response(200)
            else:
                body = json.dumps(
                    {"error": "unauthorized", "code": "unauthorized"}
                ).encode()
                self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):  # silence test output
        pass


class DaemonStub:
    """A real loopback HTTP server that answers ``GET /v1/agent`` for one token."""

    def __init__(self, token: str = "wlt_live") -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _DaemonHandler)
        self.server.token = token
        self.server.requests = []
        self.token = token
        self.port = self.server.server_address[1]
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def requests(self):
        return self.server.requests

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def live_daemon():
    stub = DaemonStub()
    yield stub
    stub.stop()


@pytest.fixture()
def dead_port():
    """A loopback port that is guaranteed closed (bound then released)."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port
