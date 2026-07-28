"""Shared client core: configuration, header policy, response decoding, and the
resource-namespace wiring used by both ``WritAgent`` and ``AsyncWritAgent``."""

from __future__ import annotations

import os
from typing import Any

import httpx

from . import _ops as ops
from ._version import __version__
from .errors import WritConnectionError, WritRunTimeoutError, api_error_from_response
from .pagination import to_page
from .resources import (
    Agent,
    Automations,
    Crawl,
    Data,
    Datasets,
    Extractors,
    Files,
    Keys,
    Monitors,
    Personas,
    Runs,
    Secrets,
    Selectors,
    Vault,
    Workflows,
)
from .types import WsTicket

USER_AGENT = f"writ-sdk-python/{__version__}"

#: Per-read budget on an SSE stream while under a run_and_wait deadline. The
#: daemon sends a keep-alive comment every 15 s, so a healthy stream always
#: completes a read well within this; a silent-death stream trips ReadTimeout
#: and run_and_wait falls back to polling.
SSE_READ_TIMEOUT = 25.0

#: Default per-request timeout (seconds). run_and_wait manages its own deadline.
DEFAULT_TIMEOUT = 30.0


def request_kwargs(op: ops.Op) -> dict[str, Any]:
    """Build the httpx request kwargs for an :class:`Op` (omit unset pieces)."""
    kwargs: dict[str, Any] = {}
    if op.params is not None:
        kwargs["params"] = op.params
    if op.json_body is not None:
        kwargs["json"] = op.json_body
    if op.files is not None:
        kwargs["files"] = op.files
    if op.data is not None:
        kwargs["data"] = op.data
    return kwargs


def decode_response(op: ops.Op, response: httpx.Response) -> Any:
    """Decode a (successful or op-accepted) response per the op's kind."""
    if op.kind == "bytes":
        return response.content
    if op.kind == "text":
        return response.text
    body: Any = None
    if response.content:
        try:
            body = response.json()
        except ValueError:
            body = response.text
    if op.kind == "page":
        return to_page(body)
    if op.run_timeout_on_504 and response.status_code == 504:
        _raise_run_timeout(body)
    return body


def _raise_run_timeout(body: Any) -> None:
    """Convert the 504 body of a `wait=True` run into a typed, actionable error.

    The daemon answers 504 with `{run_id, done: false}` when the wait budget expires; the
    run is STILL EXECUTING. Surfacing that as a plain HTTP error would throw away the one
    thing that makes it recoverable — the id — and invite a retry that starts a second run.

    Lives here, in the SHARED decode path, so the sync and async clients cannot drift on it.
    """
    run_id = body.get("run_id") if isinstance(body, dict) else None
    raise WritRunTimeoutError(
        504,
        "run_timeout",
        f"run {run_id} did not finish within the requested budget and is STILL RUNNING — "
        f"observe it with runs.events({run_id}) or runs.get({run_id}); "
        f"do not retry, that would start a second run",
        body,
        run_id if isinstance(run_id, int) else -1,
    )


def connection_error(base_url: str | None, exc: Exception) -> WritConnectionError:
    where = base_url or "the Writ agent"
    return WritConnectionError(f"could not reach {where}: {exc}")


def check_response(op: ops.Op, response: httpx.Response) -> httpx.Response:
    """Raise :class:`WritApiError` unless the status is 2xx or op-accepted (e.g.
    cancel's 409)."""
    if response.is_success or response.status_code in op.ok:
        return response
    raise api_error_from_response(response)


class BaseClient:
    """Configuration + resource namespaces shared by the sync and async clients."""

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        verify: Any = True,
        ca_file: str | os.PathLike[str] | None = None,
        transport: Any = None,
    ) -> None:
        if ca_file is not None:
            verify = os.fspath(ca_file)
        self._init_base = base_url.rstrip("/") if base_url else None
        self._init_token = token
        self._timeout = timeout
        self._verify = verify
        self._transport = transport
        self._base_url: str | None = None
        self._token: str | None = None

        # Resource namespaces (DESIGN §7).
        self.agent = Agent(self)
        self.workflows = Workflows(self)
        self.runs = Runs(self)
        self.monitors = Monitors(self)
        self.selectors = Selectors(self)
        self.extractors = Extractors(self)
        self.automations = Automations(self)
        self.personas = Personas(self)
        self.secrets = Secrets(self)
        self.vault = Vault(self)
        self.files = Files(self)
        self.data = Data(self)
        self.crawl = Crawl(self)
        self.datasets = Datasets(self)
        self.keys = Keys(self)

    # -- introspection -------------------------------------------------------

    @property
    def base_url(self) -> str | None:
        """The resolved base URL (``None`` on an async client before discovery ran)."""
        return self._base_url

    @property
    def token(self) -> str | None:
        """The resolved bearer token (opaque; ``None`` before discovery ran)."""
        return self._token

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "User-Agent": USER_AGENT,
        }

    # -- shared surface ------------------------------------------------------

    def ws_ticket(self, route: str, channel: str | None = None) -> WsTicket:
        """Mint a single-use WebSocket connect ticket → ``{ticket, expires_in_secs}``.

        ``route`` is ``"record"`` or ``"ai-preview"``; ``ai-preview`` requires a
        ``channel``. Opening the socket itself is out of scope for the SDK v1.
        """
        return self._call(ops.ws_ticket(route, channel))

    # Subclasses implement: _call(op), _run_events(run_id), _run_and_wait(...)
    def _call(self, op: ops.Op) -> Any:  # pragma: no cover - abstract
        raise NotImplementedError
