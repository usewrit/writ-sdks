"""Test helpers: a contract, bridges, signed receipts, page channel calls, a mocked Writ Cloud."""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from usewrit import WritBridge, create_writ_bridge
from usewrit.canonical import b64url_encode, canonical_bytes, data_hash, inputs_hash

FIXTURES = Path(__file__).parent / "fixtures"
SECRET = "writ-bridge-test-secret-0123456789abcdef"
API_KEY = "wk_test_0123456789abcdef"
ORIGIN = "https://app.example.com"
#: 2026-10-09 (the golden vectors' clock), in unix milliseconds.
START_MS = 1_791_550_000_000
#: The golden receipt's test seed.
SEED = bytes([7]) * 32
OTHER_SEED = bytes([8]) * 32

HELLO = {"hello": {"ready": True, "granted": ["auth.verify_login"], "writ_version": "1.0.7"}}
LOGIN = {"company": "acme", "username": "zoe"}


def contract_doc() -> dict[str, Any]:
    """A contract with a cloud-mapped login check and a local-network POS function."""
    return copy.deepcopy(
        {
            "format": "writ.contract/v1",
            "generated_at": "2026-10-09T10:00:00Z",
            "generator": "writ-desktop/1.0.8",
            "publisher": {"name": "Example"},
            "functions": [
                {
                    "key": "auth.verify_login",
                    "description": "Check a login on the visitor's computer",
                    "package": "app.auth",
                    "function": "verify_login",
                    "inputs": [
                        {"name": "company", "required": True},
                        {"name": "username", "required": True},
                        {"name": "note", "required": False, "description": "Free text"},
                    ],
                    "outputs": ["ok"],
                    "writes": False,
                    "local_network": [],
                    "cloud": {"workflow_id": 215, "function": "verify_login"},
                },
                {
                    "key": "pos.receive",
                    "description": "Receive an invoice in the POS",
                    "package": "app.pos",
                    "function": None,
                    "inputs": [{"name": "invoice_no", "required": True}],
                    "outputs": ["received"],
                    "writes": True,
                    "local_network": ["192.168.1.20:8080"],
                },
            ],
            "packages": [
                {"format": "writ.workflow/v1", "id": "app.auth", "name": "Auth", "steps": []},
                {"format": "writ.workflow/v1", "id": "app.pos", "name": "POS", "steps": []},
            ],
        }
    )


def make_bridge(mode: str = "required", *, contract: Any = None, **options: Any) -> WritBridge:
    options.setdefault("secret", SECRET)
    return create_writ_bridge(contract if contract is not None else contract_doc(), mode, **options)  # type: ignore[arg-type]


def device_key(seed: bytes = SEED) -> tuple[Ed25519PrivateKey, bytes]:
    private = Ed25519PrivateKey.from_private_bytes(seed)
    public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return private, public


_NO_INPUTS: Any = object()


def make_receipt(
    *,
    key: str,
    challenge: str | None,
    data: Any = None,
    outcome: str = "success",
    error_code: str | None = None,
    origin: str = ORIGIN,
    seed: bytes = SEED,
    run_id: int = 7,
    inputs: Any = _NO_INPUTS,
) -> dict[str, Any]:
    """A receipt signed the way the Writ engine signs one (``local::site_receipt::sign``), saying what
    the call ran with (``inputs_hash``) when ``inputs`` is given."""
    private, public = device_key(seed)
    unsigned: dict[str, Any] = {
        "v": 1,
        "origin": origin,
        "key": key,
        "package": "app.auth",
        "function": key.rsplit(".", 1)[-1],
        "challenge": challenge,
        **({} if inputs is _NO_INPUTS else {"inputs_hash": inputs_hash(challenge, inputs)}),
        "outcome": outcome,
        "error_code": error_code,
        "data_hash": data_hash(data) if outcome == "success" else None,
        "run_id": run_id,
        "started_at": 1_791_550_000,
        "finished_at": 1_791_550_002,
        "writ": {"version": "1.0.7"},
        "device": {
            "kid": hashlib.sha256(public).hexdigest()[:16],
            "alg": "Ed25519",
            "public_key": b64url_encode(public),
            "hardware": False,
        },
    }
    signature = private.sign(canonical_bytes(unsigned))
    return {**unsigned, "sig": b64url_encode(signature)}


def resign(receipt: dict[str, Any], seed: bytes = SEED) -> dict[str, Any]:
    """The same receipt, signed again after a test changed it."""
    private, _ = device_key(seed)
    unsigned = {name: value for name, value in receipt.items() if name != "sig"}
    return {**unsigned, "sig": b64url_encode(private.sign(canonical_bytes(unsigned)))}


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Writ {token}"}


async def post(
    bridge: WritBridge, token: str, body: Any, headers: dict[str, str] | None = None
) -> tuple[int, dict[str, str], Any]:
    status, response_headers, payload = await bridge.handle(
        "POST",
        {**auth(token), "content-type": "application/json", **(headers or {})},
        None,
        json.dumps(body).encode("utf-8"),
    )
    return status, response_headers, (json.loads(payload) if payload else None)


async def poll(bridge: WritBridge, token: str, wait: int = 0) -> tuple[int, Any]:
    status, _, payload = await bridge.handle("GET", auth(token), {"wait": str(wait)}, b"")
    return status, json.loads(payload)


def cloud_client(
    handler: Callable[[httpx.Request], httpx.Response],
) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class CloudStub:
    """A Writ Cloud that answers the run and serves ``results`` in turn (the last one repeats)."""

    def __init__(
        self,
        results: list[dict[str, Any]] | None = None,
        *,
        run_status: int = 200,
        run_body: Any = None,
        run_headers: dict[str, str] | None = None,
        task_id: int = 9001,
    ) -> None:
        self.results = list(results or [{"status": "completed", "success": True, "extracted_data": {"ok": True}}])
        self.run_status = run_status
        self.run_body = run_body if run_body is not None else {"task_id": task_id, "status": "pending"}
        self.run_headers = run_headers or {}
        self.task_id = task_id
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "POST" and request.url.path == "/api/automation/workflows/215/run":
            return httpx.Response(self.run_status, json=self.run_body, headers=self.run_headers)
        if request.method == "GET" and request.url.path == f"/api/automation/tasks/{self.task_id}/results":
            item = self.results.pop(0) if len(self.results) > 1 else self.results[0]
            if "__status__" in item:
                return httpx.Response(item["__status__"], json={"detail": "transient"})
            return httpx.Response(200, json=item)
        return httpx.Response(404, json={"detail": "Not Found"})

    @property
    def run_requests(self) -> list[httpx.Request]:
        return [request for request in self.requests if request.method == "POST"]

    def run_body_sent(self) -> Any:
        return json.loads(self.run_requests[0].content)


def cloud_bridge(mode: str = "recommended", stub: CloudStub | None = None, **options: Any) -> tuple[WritBridge, CloudStub]:
    stub = stub or CloudStub()
    options.setdefault("api_key", API_KEY)
    options.setdefault("cloud_poll", {"initial_ms": 5, "max_ms": 10})
    bridge = make_bridge(mode, http_client=cloud_client(stub), **options)
    return bridge, stub
