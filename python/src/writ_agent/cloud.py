"""Tiered Writ Cloud surface: ``scrape``, ``map``, ``crawl``, ``monitors``, ``automations``,
``personas`` and website→API ``builds``.

Unlike the rest of this SDK (which talks to the LOCAL daemon), these verbs run on
Writ Cloud — never on the calling machine — with a Firecrawl-style tier model
resolved from your credential:

  * **Metered** — an API key (``api_key`` arg → ``WRIT_API_KEY`` env) → the authed
    ``/api/crawl/*`` and ``/api/targets/*`` surfaces, billed against your plan.
    ``scrape``, ``map``, ``crawl`` AND ``monitors`` all work.
  * **Keyless** — no key → the free ``/v1/keyless/*`` tier, daily-capped per install
    (a stable client-id header) AND per IP. ``scrape`` + ``map`` only; ``crawl`` and
    ``monitors`` raise :class:`WritApiKeyRequiredError`.

The credential fallback chain (``api_key`` → ``WRIT_API_KEY`` → keyless) mirrors
Firecrawl's, so the same code scales from an anonymous test to a metered key.

``client.cloud.monitors`` mirrors the local daemon's ``client.monitors`` verb for
verb, so the same program runs against either venue by changing which object it
talks to. The wire paths differ (the cloud calls the resource ``targets``) and so
does the JSON casing — the cloud serialises ``checkPeriodMs`` where the daemon
serialises ``check_period_ms`` — because these are two independently versioned
services, not one service behind two hostnames. The SDK does not paper over that:
it returns each service's own body.
"""

from __future__ import annotations

import asyncio
import base64
import os
import secrets
import time
from pathlib import Path
from typing import Any, AsyncIterator, Iterator, Optional

import httpx

from ._retry import (
    DEFAULT_RETRY,
    RetryPolicy,
    backoff_seconds,
    is_safe_method,
    new_idempotency_key,
    retry_after_seconds,
    should_retry_status,
)
from ._watch import watch_changes, watch_changes_async

from .errors import (
    WritApiError,
    WritApiKeyRequiredError,
    WritConnectionError,
    WritInsufficientCreditsError,
    WritPlanLimitError,
    WritRateLimitedError,
    WritTimeoutError,
    code_for_status,
)

DEFAULT_CLOUD_URL = "https://api.usewrit.app"
CLIENT_ID_HEADER = "X-Writ-Client-Id"
# Server-minted, HMAC-signed keyless subject. The server issues one on any
# keyless response where we did not present a valid token; persisting it and
# sending it back is what earns this install its OWN daily bucket. Without it a
# caller is metered on its IP prefix, which it may share with every other
# install behind the same NAT. The client cannot forge or edit this value —
# it is signed server-side (backend/services/keyless_identity.py).
DEVICE_TOKEN_HEADER = "X-Writ-Device-Token"

__all__ = [
    "Cloud",
    "AsyncCloud",
    "CloudMonitors",
    "AsyncCloudMonitors",
    "CloudAutomations",
    "AsyncCloudAutomations",
    "CloudPersonas",
    "AsyncCloudPersonas",
    "CloudBuilds",
    "AsyncCloudBuilds",
    "TERMINAL_BUILD_STATUSES",
    "DEFAULT_CLOUD_URL",
]


def _resolve_api_key(api_key: Optional[str]) -> Optional[str]:
    return api_key or os.environ.get("WRIT_API_KEY") or None


def _resolve_cloud_url(cloud_url: Optional[str]) -> str:
    return (cloud_url or os.environ.get("WRIT_CLOUD_URL") or DEFAULT_CLOUD_URL).rstrip("/")


def _mint_id() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(16)).decode("ascii").rstrip("=")


def load_or_mint_client_id(override: Optional[str] = None) -> str:
    """The stable keyless device id: ``override`` → ``WRIT_CLIENT_ID`` → ``~/.writ/client_id``."""
    if override:
        return override
    env = os.environ.get("WRIT_CLIENT_ID")
    if env:
        return env
    try:
        path = Path.home() / ".writ" / "client_id"
        if path.exists():
            existing = path.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        cid = _mint_id()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(cid, encoding="utf-8")
            os.chmod(path, 0o600)
        except OSError:
            pass  # read-only fs → use the ephemeral id
        return cid
    except OSError:
        return _mint_id()


def _device_token_path() -> Path:
    return Path.home() / ".writ" / "device_token"


def load_device_token() -> Optional[str]:
    """The server-minted keyless subject, if we have been issued one."""
    env = os.environ.get("WRIT_DEVICE_TOKEN")
    if env:
        return env
    try:
        path = _device_token_path()
        if path.exists():
            token = path.read_text(encoding="utf-8").strip()
            return token or None
    except OSError:
        pass
    return None


def store_device_token(token: str) -> None:
    """Persist a freshly-issued token. Best-effort: a read-only home just means
    the next process starts over as an anonymous caller, which still works."""
    if not token:
        return
    try:
        path = _device_token_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(token, encoding="utf-8")
        os.chmod(path, 0o600)
    except OSError:
        pass


def _decode(resp: httpx.Response) -> Any:
    if not resp.text:
        return {}
    try:
        return resp.json()
    except ValueError:
        return resp.text


def _clean_params(params: Any) -> Optional[dict[str, Any]]:
    """Drop unset query params. ``limit=None`` must mean "don't send limit", not
    ``?limit=`` — FastAPI rejects the empty string for a typed int."""
    if not params:
        return None
    cleaned = {k: v for k, v in params.items() if v is not None}
    return cleaned or None


def _cloud_error(status: int, body: Any) -> WritApiError:
    detail = body.get("detail") if isinstance(body, dict) else None
    # Prefer the nested ``detail`` object, but fall back to the TOP level when
    # ``detail`` is a bare string. A plan denial sends the flat shape
    # ``{"detail": "<reason>", "code": …, "current": …, "limit": …}``, and reading
    # only the (string) detail loses every machine-readable field.
    d = detail if isinstance(detail, dict) else (body if isinstance(body, dict) else {})
    code = d.get("code") or code_for_status(status)
    message = d.get("message") or (detail if isinstance(detail, str) else None) or f"HTTP {status}"
    if status == 429:
        return WritRateLimitedError(
            status, code, message, body,
            reset_at=d.get("reset_at"),
            requests_remaining=d.get("requests_remaining"),
            pages_remaining=d.get("pages_remaining"),
        )
    if status == 402 and code == "api_key_required":
        return WritApiKeyRequiredError(status, code, message, body)
    if status == 402:
        # Two different 402s share this status. Tell them apart STRUCTURALLY
        # rather than by a code allowlist that would drift as the backend adds
        # limits: a plan denial always reports the ceiling it hit as a numeric
        # ``limit``, a credits/wallet 402 never does.
        if isinstance(d.get("limit"), int):
            return WritPlanLimitError(
                status, code, message, body,
                current=d.get("current"),
                limit=d.get("limit"),
                upgrade_hint=d.get("upgrade_hint"),
            )
        return WritInsufficientCreditsError(status, code, message, body)
    return WritApiError(status, code, message, body)


class _CloudConfig:
    """Shared credential/URL/client-id resolution for the sync + async cloud clients."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        cloud_url: Optional[str] = None,
        client_id: Optional[str] = None,
        timeout: float = 30.0,
        verify: Any = True,
        transport: Any = None,
        retry: Optional[RetryPolicy] = None,
    ) -> None:
        # Unsafe methods ARE retried on the cloud surface: every POST/PATCH/DELETE
        # below carries an Idempotency-Key, and the cloud replays its recorded
        # response instead of executing a second time.
        self._retry = (retry or DEFAULT_RETRY).with_unsafe(True)
        self._api_key = _resolve_api_key(api_key)
        self._base = _resolve_cloud_url(cloud_url)
        self._client_id_override = client_id
        self._client_id: Optional[str] = None
        self._device_token: Optional[str] = None
        self._device_token_loaded = False
        self._timeout = timeout
        self._verify = verify
        self._transport = transport

    @property
    def tier(self) -> str:
        """``"metered"`` when an API key is present, else ``"keyless"``."""
        return "metered" if self._api_key else "keyless"

    def _headers(self) -> dict[str, str]:
        if self._api_key:
            return {"Authorization": f"Bearer {self._api_key}"}
        if self._client_id is None:
            self._client_id = load_or_mint_client_id(self._client_id_override)
        headers = {CLIENT_ID_HEADER: self._client_id}
        if not self._device_token_loaded:
            self._device_token = load_device_token()
            self._device_token_loaded = True
        if self._device_token:
            headers[DEVICE_TOKEN_HEADER] = self._device_token
        return headers

    def _absorb_device_token(self, resp: httpx.Response) -> None:
        """Pick up a token the server minted for us. Only keyless responses carry
        one, and only when we did not already present a valid token."""
        if self._api_key:
            return
        issued = resp.headers.get(DEVICE_TOKEN_HEADER)
        if issued and issued != self._device_token:
            self._device_token = issued
            self._device_token_loaded = True
            store_device_token(issued)

    def _scrape_path(self) -> str:
        return "/api/crawl/scrape" if self._api_key else "/v1/keyless/scrape"

    def _map_path(self) -> str:
        return "/api/crawl/map" if self._api_key else "/v1/keyless/map"

    def _require_key(self, what: str) -> None:
        if not self._api_key:
            raise WritApiKeyRequiredError(
                402,
                "api_key_required",
                f"{what} needs an API key — set api_key or WRIT_API_KEY. "
                "Without one, scrape, map and the bounded crawl_keyless() still work.",
                None,
            )


# ─────────────────────────────── cloud monitors ─────────────────────────────
#
# On the wire the cloud calls this resource ``targets``; the product, the local
# daemon and every SDK call it a MONITOR. The rename is done here, once, so a
# caller writes ``client.cloud.monitors.create(...)`` exactly as they write
# ``client.monitors.create(...)`` against the daemon — same verbs, same order,
# different venue.
#
# Every verb is metered-only. The keyless tier has no account to own a monitor,
# so these raise before any network call rather than sending a request that can
# only come back 401.

_MONITORS = "/api/targets"


class _CloudMonitorsBase:
    def __init__(self, cloud: Any) -> None:
        self._cloud = cloud

    def _guard(self, what: str) -> None:
        self._cloud._require_key(what)


class CloudMonitors(_CloudMonitorsBase):
    """Synchronous cloud monitors. Mounted as ``client.cloud.monitors``."""

    def list(self, **params: Any) -> Any:
        """Every monitor on the account, newest first. Bare-array envelope.

        Params: ``enabled_only`` (bool), ``check_type`` (``content``/``uptime``),
        ``limit`` (1-1000), ``offset``. Omit ``limit`` for all of them.
        """
        self._guard("Listing cloud monitors")
        return self._cloud._send("GET", _MONITORS, params=params)

    def create(self, body: dict[str, Any]) -> Any:
        """Create a monitor. Requires a non-empty ``url``.

        A ``check_period_ms`` below the plan's minimum check interval is REJECTED
        with a 402 ``interval_too_short`` (:class:`WritInsufficientCreditsError`)
        naming the floor — it is never silently clamped, so a monitor never runs
        slower than the code asked for without saying so.
        """
        self._guard("Creating a cloud monitor")
        return self._cloud._send("POST", _MONITORS, body)

    def get(self, monitor_id: int) -> Any:
        self._guard("Reading a cloud monitor")
        return self._cloud._send("GET", f"{_MONITORS}/{monitor_id}")

    def update(self, monitor_id: int, patch: dict[str, Any]) -> Any:
        """Partial update — send only the fields you are changing."""
        self._guard("Updating a cloud monitor")
        return self._cloud._send("PATCH", f"{_MONITORS}/{monitor_id}", patch)

    def delete(self, monitor_id: int) -> Any:
        """Delete a monitor and its selectors, triggers and notification history.
        Answers 204, so the returned body is empty."""
        self._guard("Deleting a cloud monitor")
        return self._cloud._send("DELETE", f"{_MONITORS}/{monitor_id}")

    def toggle(self, monitor_id: int, enabled: bool) -> Any:
        """Pause or resume a monitor without deleting it."""
        self._guard("Toggling a cloud monitor")
        return self._cloud._send(
            "PATCH", f"{_MONITORS}/{monitor_id}/toggle", params={"enabled": enabled}
        )

    def run(self, monitor_id: int) -> Any:
        """Check this monitor NOW, out of schedule.

        Returns ``{"ok": bool, "dispatched": int}``. ``ok`` is False with a
        ``detail`` when no recorder is assigned yet — the check will still happen
        on the next scheduled cycle.
        """
        self._guard("Running a cloud monitor")
        return self._cloud._send("POST", f"{_MONITORS}/{monitor_id}/run")

    def changes(self, monitor_id: int, **params: Any) -> Any:
        """This monitor's detected-change history. Bare-array envelope.

        Params: ``limit``, plus the ``since`` / ``since_id`` keyset cursor (see
        :meth:`recent_changes`). Rows are camelCase with STRING ids — a genuinely
        different shape from the global feed's, which is why the two must never
        be modelled as one type.
        """
        self._guard("Reading cloud monitor changes")
        return self._cloud._send("GET", f"{_MONITORS}/{monitor_id}/changes", params=params)

    def watch(self, **options: Any) -> Iterator[dict[str, Any]]:
        """Stream detected changes across ALL monitors, in detection order.

        ::

            for change in client.cloud.monitors.watch():
                print(change["target_url"], change["diff_snippet"])

        This exists because polling the feed correctly by hand is harder than it
        looks: the newest-first view drops changes when more than a page of them
        lands between polls, and a change row is UPDATED (not re-inserted) when
        the same difference recurs, so an id already processed can resurface.
        ``watch`` drives the server's keyset cursor instead, which makes
        "everything after this point" exact — and a resurfaced id arrives as
        what it actually is, a fresh detection.

        Options mirror the other SDKs: ``interval`` (seconds, default 30),
        ``page_size`` (default 100), ``since`` / ``since_id`` to resume where a
        previous watcher stopped, ``replay_history`` to start from the beginning,
        ``on_error`` to decide whether a polling failure stops the loop, and
        ``stop`` — a callable returning True to end the stream.
        """
        self._guard("Watching cloud monitor changes")
        return watch_changes(
            lambda params: self.recent_changes(**params),
            **options,
        )

    def recent_changes(self, limit: Optional[int] = None, **params: Any) -> Any:
        """Detected changes across ALL monitors on the account (``limit`` 1-200).

        Rows are the GLOBAL feed's shape — snake_case with INTEGER ids — NOT the
        per-monitor camelCase shape returned by :meth:`changes`. See
        :class:`~writ_agent.types.RecentChange`.

        Without ``since`` this is the newest-first browsing view. Pass
        ``since=<ISO-8601>`` (and ``since_id=<int>`` to break ties) and the
        server switches to an oldest-first keyset walk returning only what was
        detected after that point — which is what a poller wants: newest-first
        plus a limit silently drops changes whenever more than ``limit`` of them
        land between two polls. For a continuous feed use :meth:`watch`.
        """
        self._guard("Reading recent cloud changes")
        return self._cloud._send(
            "GET", f"{_MONITORS}/changes/recent", params={"limit": limit, **params}
        )


class AsyncCloudMonitors(_CloudMonitorsBase):
    """Asynchronous cloud monitors. Mounted as ``client.cloud.monitors``."""

    async def list(self, **params: Any) -> Any:
        self._guard("Listing cloud monitors")
        return await self._cloud._send("GET", _MONITORS, params=params)

    async def create(self, body: dict[str, Any]) -> Any:
        self._guard("Creating a cloud monitor")
        return await self._cloud._send("POST", _MONITORS, body)

    async def get(self, monitor_id: int) -> Any:
        self._guard("Reading a cloud monitor")
        return await self._cloud._send("GET", f"{_MONITORS}/{monitor_id}")

    async def update(self, monitor_id: int, patch: dict[str, Any]) -> Any:
        self._guard("Updating a cloud monitor")
        return await self._cloud._send("PATCH", f"{_MONITORS}/{monitor_id}", patch)

    async def delete(self, monitor_id: int) -> Any:
        self._guard("Deleting a cloud monitor")
        return await self._cloud._send("DELETE", f"{_MONITORS}/{monitor_id}")

    async def toggle(self, monitor_id: int, enabled: bool) -> Any:
        self._guard("Toggling a cloud monitor")
        return await self._cloud._send(
            "PATCH", f"{_MONITORS}/{monitor_id}/toggle", params={"enabled": enabled}
        )

    async def run(self, monitor_id: int) -> Any:
        self._guard("Running a cloud monitor")
        return await self._cloud._send("POST", f"{_MONITORS}/{monitor_id}/run")

    async def changes(self, monitor_id: int, **params: Any) -> Any:
        self._guard("Reading cloud monitor changes")
        return await self._cloud._send("GET", f"{_MONITORS}/{monitor_id}/changes", params=params)

    async def recent_changes(self, limit: Optional[int] = None, **params: Any) -> Any:
        """See :meth:`CloudMonitors.recent_changes` — same shape, same cursor."""
        self._guard("Reading recent cloud changes")
        return await self._cloud._send(
            "GET", f"{_MONITORS}/changes/recent", params={"limit": limit, **params}
        )

    def watch(self, **options: Any) -> AsyncIterator[dict[str, Any]]:
        """Async twin of :meth:`CloudMonitors.watch`::

        async for change in client.cloud.monitors.watch():
            print(change["target_url"])
        """
        self._guard("Watching cloud monitor changes")
        return watch_changes_async(
            lambda params: self.recent_changes(**params),
            **options,
        )


# ─────────────────────────── cloud automations ──────────────────────────────
#
# On the wire the cloud calls this resource ``triggers``; the product, the local
# daemon and every SDK call it an AUTOMATION. Same rename-once rule as monitors.
#
# ⚠️ Two shape differences from the daemon, both the server's and neither a typo:
#   * the list route is ``/all``, not the collection root
#   * ``toggle`` FLIPS the enabled flag and takes no argument, where the daemon's
#     ``enable(id, enabled)`` sets it. Read the returned row rather than assuming.

_AUTOMATIONS = "/api/triggers"


class _CloudAutomationsBase(_CloudMonitorsBase):
    pass


class CloudAutomations(_CloudAutomationsBase):
    """Synchronous cloud automations. Mounted as ``client.cloud.automations``.

    An automation is an event → conditions → actions rule: when a monitor changes,
    a webhook fires, or a workflow finishes, run a workflow and/or notify.
    """

    def list(self, **params: Any) -> Any:
        """Every automation on the account. Params: ``enabled_only`` (bool),
        ``event_type``, ``workflow_id``."""
        self._guard("Listing cloud automations")
        return self._cloud._send("GET", f"{_AUTOMATIONS}/all", params=params)

    def create(self, body: dict[str, Any]) -> Any:
        """Create an automation. Requires a non-empty ``name``; ``actions`` is a
        list of ``{"type": "notification"|"workflow"|"ai_session", "config": {…}}``."""
        self._guard("Creating a cloud automation")
        return self._cloud._send("POST", _AUTOMATIONS, body)

    def get(self, automation_id: int) -> Any:
        self._guard("Reading a cloud automation")
        return self._cloud._send("GET", f"{_AUTOMATIONS}/{automation_id}")

    def update(self, automation_id: int, patch: dict[str, Any]) -> Any:
        """Partial update — send only the fields you are changing."""
        self._guard("Updating a cloud automation")
        return self._cloud._send("PATCH", f"{_AUTOMATIONS}/{automation_id}", patch)

    def delete(self, automation_id: int) -> Any:
        self._guard("Deleting a cloud automation")
        return self._cloud._send("DELETE", f"{_AUTOMATIONS}/{automation_id}")

    def toggle(self, automation_id: int) -> Any:
        """FLIP the enabled flag (the cloud has no set-to-value form) and return
        the refreshed row — read ``enabled`` off it rather than assuming."""
        self._guard("Toggling a cloud automation")
        return self._cloud._send("PATCH", f"{_AUTOMATIONS}/{automation_id}/toggle")

    def run(self, automation_id: int, inputs: Optional[dict[str, Any]] = None) -> Any:
        """Fire the automation NOW (manual trigger), skipping its event."""
        self._guard("Running a cloud automation")
        return self._cloud._send("POST", f"{_AUTOMATIONS}/{automation_id}/run", inputs)

    def test(self, automation_id: int, body: dict[str, Any]) -> Any:
        """Evaluate the rule against a sample event WITHOUT running its actions."""
        self._guard("Testing a cloud automation")
        return self._cloud._send("POST", f"{_AUTOMATIONS}/{automation_id}/test", body)

    def executions(self, automation_id: int, **params: Any) -> Any:
        """This automation's execution history (``limit``)."""
        self._guard("Reading cloud automation executions")
        return self._cloud._send("GET", f"{_AUTOMATIONS}/{automation_id}/executions", params=params)

    def for_monitor(self, monitor_id: int, **params: Any) -> Any:
        """The automations wired to one monitor — the other half of
        ``cloud.monitors``. Params: ``enabled_only``."""
        self._guard("Reading a monitor's cloud automations")
        return self._cloud._send("GET", f"{_AUTOMATIONS}/target/{monitor_id}", params=params)


class AsyncCloudAutomations(_CloudAutomationsBase):
    """Asynchronous cloud automations. Mounted as ``client.cloud.automations``."""

    async def list(self, **params: Any) -> Any:
        self._guard("Listing cloud automations")
        return await self._cloud._send("GET", f"{_AUTOMATIONS}/all", params=params)

    async def create(self, body: dict[str, Any]) -> Any:
        self._guard("Creating a cloud automation")
        return await self._cloud._send("POST", _AUTOMATIONS, body)

    async def get(self, automation_id: int) -> Any:
        self._guard("Reading a cloud automation")
        return await self._cloud._send("GET", f"{_AUTOMATIONS}/{automation_id}")

    async def update(self, automation_id: int, patch: dict[str, Any]) -> Any:
        self._guard("Updating a cloud automation")
        return await self._cloud._send("PATCH", f"{_AUTOMATIONS}/{automation_id}", patch)

    async def delete(self, automation_id: int) -> Any:
        self._guard("Deleting a cloud automation")
        return await self._cloud._send("DELETE", f"{_AUTOMATIONS}/{automation_id}")

    async def toggle(self, automation_id: int) -> Any:
        self._guard("Toggling a cloud automation")
        return await self._cloud._send("PATCH", f"{_AUTOMATIONS}/{automation_id}/toggle")

    async def run(self, automation_id: int, inputs: Optional[dict[str, Any]] = None) -> Any:
        self._guard("Running a cloud automation")
        return await self._cloud._send("POST", f"{_AUTOMATIONS}/{automation_id}/run", inputs)

    async def test(self, automation_id: int, body: dict[str, Any]) -> Any:
        self._guard("Testing a cloud automation")
        return await self._cloud._send("POST", f"{_AUTOMATIONS}/{automation_id}/test", body)

    async def executions(self, automation_id: int, **params: Any) -> Any:
        self._guard("Reading cloud automation executions")
        return await self._cloud._send("GET", f"{_AUTOMATIONS}/{automation_id}/executions", params=params)

    async def for_monitor(self, monitor_id: int, **params: Any) -> Any:
        self._guard("Reading a monitor's cloud automations")
        return await self._cloud._send("GET", f"{_AUTOMATIONS}/target/{monitor_id}", params=params)


# ───────────────────────────── cloud personas ───────────────────────────────
#
# SECRET MATERIAL IS WRITE-ONLY, on the server and therefore here. A password, a
# TOTP seed and proxy credentials go IN on create/update and are stored
# encrypted; they never come back. A persona reads back as ``has_password`` /
# ``has_totp_seed`` / ``has_proxy`` booleans, exactly like the daemon's.
#
# ⚠️ ``relay_token`` IS returned, because the owner needs it to point their OTP
# forwarding at the right address. It is a DEPOSIT-only credential (it can add
# messages to this persona's relay mailbox, never read them) — treat it as a
# secret in logs and screenshots even though it cannot read anything.

_PERSONAS = "/api/personas"


class CloudPersonas(_CloudMonitorsBase):
    """Synchronous cloud personas. Mounted as ``client.cloud.personas``.

    A persona is the login identity a cloud run acts as: credentials, 2FA method,
    fingerprint and egress. Use personas only with sites and accounts you are
    authorized to access.
    """

    def list(self, **params: Any) -> Any:
        """Every persona on the account. Params: ``domain`` (suggest by site)."""
        self._guard("Listing cloud personas")
        return self._cloud._send("GET", _PERSONAS, params=params)

    def create(self, body: dict[str, Any]) -> Any:
        """Create a persona. ``name`` is required. ``password``, ``totp_seed`` and
        ``proxy_password`` are WRITE-ONLY — stored encrypted, never returned."""
        self._guard("Creating a cloud persona")
        return self._cloud._send("POST", _PERSONAS, body)

    def get(self, persona_id: int) -> Any:
        self._guard("Reading a cloud persona")
        return self._cloud._send("GET", f"{_PERSONAS}/{persona_id}")

    def update(self, persona_id: int, patch: dict[str, Any]) -> Any:
        """Partial update. A secret is replaced only when you send it; omitting it
        leaves the stored one intact."""
        self._guard("Updating a cloud persona")
        return self._cloud._send("PATCH", f"{_PERSONAS}/{persona_id}", patch)

    def delete(self, persona_id: int) -> Any:
        self._guard("Deleting a cloud persona")
        return self._cloud._send("DELETE", f"{_PERSONAS}/{persona_id}")

    def runs(self, persona_id: int, **params: Any) -> Any:
        """Recent runs that acted as this persona (``limit``)."""
        self._guard("Reading cloud persona runs")
        return self._cloud._send("GET", f"{_PERSONAS}/{persona_id}/runs", params=params)

    def test_2fa(self, persona_id: int) -> Any:
        """Exercise this persona's configured 2FA path and report whether it
        produced a code — without running a login."""
        self._guard("Testing a cloud persona's 2FA")
        return self._cloud._send("POST", f"{_PERSONAS}/{persona_id}/test-2fa")

    def validate_totp(
        self,
        totp_seed: str,
        code: Optional[str] = None,
        *,
        algorithm: Optional[str] = None,
        digits: Optional[int] = None,
        period: Optional[int] = None,
    ) -> Any:
        """Check a pasted seed is well-formed base32 — and, with ``code``, that it
        reproduces that code. The seed is NEVER stored or logged by this call, so
        it is the safe way to check a seed before committing it to a persona."""
        body: dict[str, Any] = {"totp_seed": totp_seed}
        if code is not None:
            body["code"] = code
        if algorithm is not None:
            body["algorithm"] = algorithm
        if digits is not None:
            body["digits"] = digits
        if period is not None:
            body["period"] = period
        self._guard("Validating a TOTP seed")
        return self._cloud._send("POST", f"{_PERSONAS}/validate-totp", body)


class AsyncCloudPersonas(_CloudMonitorsBase):
    """Asynchronous cloud personas. Mounted as ``client.cloud.personas``."""

    async def list(self, **params: Any) -> Any:
        self._guard("Listing cloud personas")
        return await self._cloud._send("GET", _PERSONAS, params=params)

    async def create(self, body: dict[str, Any]) -> Any:
        self._guard("Creating a cloud persona")
        return await self._cloud._send("POST", _PERSONAS, body)

    async def get(self, persona_id: int) -> Any:
        self._guard("Reading a cloud persona")
        return await self._cloud._send("GET", f"{_PERSONAS}/{persona_id}")

    async def update(self, persona_id: int, patch: dict[str, Any]) -> Any:
        self._guard("Updating a cloud persona")
        return await self._cloud._send("PATCH", f"{_PERSONAS}/{persona_id}", patch)

    async def delete(self, persona_id: int) -> Any:
        self._guard("Deleting a cloud persona")
        return await self._cloud._send("DELETE", f"{_PERSONAS}/{persona_id}")

    async def runs(self, persona_id: int, **params: Any) -> Any:
        self._guard("Reading cloud persona runs")
        return await self._cloud._send("GET", f"{_PERSONAS}/{persona_id}/runs", params=params)

    async def test_2fa(self, persona_id: int) -> Any:
        self._guard("Testing a cloud persona's 2FA")
        return await self._cloud._send("POST", f"{_PERSONAS}/{persona_id}/test-2fa")

    async def validate_totp(
        self,
        totp_seed: str,
        code: Optional[str] = None,
        *,
        algorithm: Optional[str] = None,
        digits: Optional[int] = None,
        period: Optional[int] = None,
    ) -> Any:
        body: dict[str, Any] = {"totp_seed": totp_seed}
        for key, value in (("code", code), ("algorithm", algorithm), ("digits", digits), ("period", period)):
            if value is not None:
                body[key] = value
        self._guard("Validating a TOTP seed")
        return await self._cloud._send("POST", f"{_PERSONAS}/validate-totp", body)


# ───────────────────────── website → api builds ─────────────────────────────
#
# The REST twin of the MCP tool `writ_website_to_api`, and ASYNCHRONOUS for a
# reason: the tool works because the caller is a MODEL that drives the browser
# turn by turn. A program cannot, so Writ's own agent loop drives and this
# surface hands back a build id to poll.
#
# The server checks two cheap rungs before spending any AI — your own matching
# workflows, then ready-made marketplace listings — so `status` is one of
# `existing_workflows`, `marketplace_candidates` or a queued build.

_W2A = "/api/v1/website-to-api"

#: Build states that will never change again.
TERMINAL_BUILD_STATUSES = frozenset({"succeeded", "failed", "cancelled"})


class CloudBuilds(_CloudMonitorsBase):
    """Synchronous website → API builds. Mounted as ``client.cloud.builds``."""

    def start(
        self,
        url: str,
        goal: str,
        *,
        persona_id: Optional[int] = None,
        max_steps: Optional[int] = None,
        save_as: Optional[str] = None,
        skip_existing: bool = False,
        skip_marketplace: bool = False,
    ) -> Any:
        """Turn a website into a callable API — one call.

        Answers one of three ways, cheapest first, and the first two spend NO AI:
        ``existing_workflows`` (your library already covers it),
        ``marketplace_candidates``, or a queued build with a ``build_id``.

        Pass ``skip_existing`` / ``skip_marketplace`` to go straight to a build.
        A build spends AI credits, so the key must have AI enabled; a plan
        ceiling surfaces as :class:`WritPlanLimitError`, never as a credits error.
        """
        self._guard("Building an API from a website")
        body: dict[str, Any] = {"url": url, "goal": goal}
        for key, value in (
            ("persona_id", persona_id), ("max_steps", max_steps), ("save_as", save_as),
        ):
            if value is not None:
                body[key] = value
        if skip_existing:
            body["skip_existing"] = True
        if skip_marketplace:
            body["skip_marketplace"] = True
        return self._cloud._send("POST", _W2A, body)

    def get(self, build_id: int) -> Any:
        """Poll a build. Terminal: ``succeeded`` / ``failed`` / ``cancelled``."""
        self._guard("Reading a website-to-API build")
        return self._cloud._send("GET", f"{_W2A}/{build_id}")

    def start_and_wait(
        self,
        url: str,
        goal: str,
        *,
        timeout: float = 900.0,
        poll_interval: float = 5.0,
        **options: Any,
    ) -> Any:
        """:meth:`start`, then poll until the build reaches a terminal state.

        Returns the ladder answer unchanged when the server resolved it without
        building — there is nothing to wait for in that case. Raises
        :class:`WritTimeoutError` if the deadline passes; the build keeps going,
        and ``build_id`` still addresses it.
        """
        started = self.start(url, goal, **options)
        build_id = started.get("build_id") if isinstance(started, dict) else None
        if build_id is None:
            return started
        deadline = time.monotonic() + timeout
        while True:
            current = self.get(build_id)
            if str(current.get("status")) in TERMINAL_BUILD_STATUSES:
                return current
            if time.monotonic() >= deadline:
                raise WritTimeoutError(
                    f"website-to-API build {build_id} did not finish within {timeout:g}s. "
                    "It is still running — poll cloud.builds.get(build_id)."
                )
            time.sleep(poll_interval)


class AsyncCloudBuilds(_CloudMonitorsBase):
    """Asynchronous website → API builds. Mounted as ``client.cloud.builds``."""

    async def start(self, url: str, goal: str, **options: Any) -> Any:
        self._guard("Building an API from a website")
        body: dict[str, Any] = {"url": url, "goal": goal}
        for key in ("persona_id", "max_steps", "save_as"):
            if options.get(key) is not None:
                body[key] = options[key]
        for flag in ("skip_existing", "skip_marketplace"):
            if options.get(flag):
                body[flag] = True
        return await self._cloud._send("POST", _W2A, body)

    async def get(self, build_id: int) -> Any:
        self._guard("Reading a website-to-API build")
        return await self._cloud._send("GET", f"{_W2A}/{build_id}")

    async def start_and_wait(
        self, url: str, goal: str, *, timeout: float = 900.0,
        poll_interval: float = 5.0, **options: Any,
    ) -> Any:
        started = await self.start(url, goal, **options)
        build_id = started.get("build_id") if isinstance(started, dict) else None
        if build_id is None:
            return started
        deadline = time.monotonic() + timeout
        while True:
            current = await self.get(build_id)
            if str(current.get("status")) in TERMINAL_BUILD_STATUSES:
                return current
            if time.monotonic() >= deadline:
                raise WritTimeoutError(
                    f"website-to-API build {build_id} did not finish within {timeout:g}s. "
                    "It is still running — poll cloud.builds.get(build_id)."
                )
            await asyncio.sleep(poll_interval)


class Cloud(_CloudConfig):
    """Synchronous tiered cloud surface. Mounted as ``client.cloud``."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._http: Optional[httpx.Client] = None
        #: Cloud monitors — the same verbs as ``client.monitors`` on the daemon.
        self.monitors = CloudMonitors(self)
        #: Cloud automations — the same verbs as ``client.automations``.
        self.automations = CloudAutomations(self)
        #: Cloud personas — the same verbs as ``client.personas``.
        self.personas = CloudPersonas(self)
        #: Website → API builds — the REST twin of writ_website_to_api.
        self.builds = CloudBuilds(self)

    def _client(self) -> httpx.Client:
        if self._http is None:
            kw: dict[str, Any] = {"base_url": self._base, "timeout": self._timeout, "verify": self._verify}
            if self._transport is not None:
                kw["transport"] = self._transport
            self._http = httpx.Client(**kw)
        return self._http

    def _send(self, method: str, path: str, json: Any = None, params: Any = None) -> Any:
        headers = self._headers()
        # One key per logical call, reused by every retry of it — that is what
        # makes repeating an unsafe method safe rather than duplicative.
        if not is_safe_method(method):
            headers["Idempotency-Key"] = new_idempotency_key()

        policy = self._retry
        attempts = policy.attempts_for(method)
        clean = _clean_params(params)
        last_exc: Optional[Exception] = None

        for attempt in range(1, attempts + 1):
            resp: Optional[httpx.Response] = None
            try:
                resp = self._client().request(method, path, json=json, params=clean, headers=headers)
                if not should_retry_status(resp.status_code):
                    break
            except httpx.TransportError as exc:
                last_exc = exc

            if attempt >= attempts:
                break
            wait = backoff_seconds(policy, attempt)
            requested = retry_after_seconds(resp)
            if requested is not None:
                if requested > policy.max_retry_after and resp is not None:
                    # The server says this will not clear any time soon; hand the
                    # caller the real answer, which carries the reset time.
                    break
                wait = requested
            time.sleep(wait)

        if resp is None:
            assert last_exc is not None
            raise WritConnectionError(f"cloud request to {path} failed: {last_exc}") from last_exc
        # Absorb BEFORE the error check: a 429 carries a minted token too, and
        # dropping it would leave a rate-limited caller anonymous forever.
        self._absorb_device_token(resp)
        body = _decode(resp)
        if resp.is_success:
            return body
        raise _cloud_error(resp.status_code, body)

    def scrape(self, url: str) -> dict[str, Any]:
        """Scrape ONE page to clean markdown. Works on both tiers."""
        out = self._send("POST", self._scrape_path(), {"url": url})
        if isinstance(out, dict):
            out.setdefault("tier", self.tier)
        return out

    def map(self, url: str, *, search: Optional[str] = None, limit: Optional[int] = None) -> dict[str, Any]:
        """Map a site's URLs, ranked by an optional ``search``. Works on both tiers."""
        body: dict[str, Any] = {"url": url, "search": search or ""}
        if limit is not None:
            body["limit"] = limit
        out = self._send("POST", self._map_path(), body)
        if isinstance(out, dict):
            out.setdefault("tier", self.tier)
        return out

    def crawl(self, url: str, **options: Any) -> dict[str, Any]:
        """Start a whole-site crawl. METERED ONLY — raises :class:`WritApiKeyRequiredError`
        (before any network call) on the keyless tier."""
        self._require_key("Whole-site crawl")
        return self._send("POST", "/api/crawl", {"url": url, **options})

    def crawl_status(self, crawl_id: int) -> dict[str, Any]:
        """Poll a metered crawl's status (requires an API key)."""
        self._require_key("Crawl status")
        return self._send("GET", f"/api/crawl/{crawl_id}")


    def crawl_keyless(self, url: str, *, search: Optional[str] = None,
                      limit: Optional[int] = None) -> dict[str, Any]:
        """A bounded crawl with NO account — the free tier's version.

        Deliberately a separate method from :meth:`crawl`, because the two return
        genuinely different things and one type must never pretend to be both:
        :meth:`crawl` queues a fleet job you poll, while this fetches a few
        same-domain pages IN PROCESS and returns their markdown inline.

        Capped per request (see ``limits.page_cap`` in the response) and one level
        deep, and every page spends the same daily allowance as
        :meth:`scrape` — so the daily cap, not the per-request cap, is the real
        ceiling. Works on both tiers; a metered key gets the same bounded call.
        """
        body: dict[str, Any] = {"url": url}
        if search is not None:
            body["search"] = search
        if limit is not None:
            body["limit"] = limit
        return self._send("POST", "/v1/keyless/crawl", body)

    def quota(self) -> Optional[dict[str, Any]]:
        """Remaining keyless allowance for this install (``None`` when metered)."""
        if self._api_key:
            return None
        return self._send("GET", "/v1/keyless/quota")

    def close(self) -> None:
        if self._http is not None:
            self._http.close()


class AsyncCloud(_CloudConfig):
    """Asynchronous tiered cloud surface. Mounted as ``client.cloud`` on the async client."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._http: Optional[httpx.AsyncClient] = None
        #: Cloud monitors — the same verbs as ``client.monitors`` on the daemon.
        self.monitors = AsyncCloudMonitors(self)
        #: Cloud automations — the same verbs as ``client.automations``.
        self.automations = AsyncCloudAutomations(self)
        #: Cloud personas — the same verbs as ``client.personas``.
        self.personas = AsyncCloudPersonas(self)
        #: Website → API builds — the REST twin of writ_website_to_api.
        self.builds = AsyncCloudBuilds(self)

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            kw: dict[str, Any] = {"base_url": self._base, "timeout": self._timeout, "verify": self._verify}
            if self._transport is not None:
                kw["transport"] = self._transport
            self._http = httpx.AsyncClient(**kw)
        return self._http

    async def _send(self, method: str, path: str, json: Any = None, params: Any = None) -> Any:
        headers = self._headers()
        # One key per logical call, reused by every retry of it — see the sync twin.
        if not is_safe_method(method):
            headers["Idempotency-Key"] = new_idempotency_key()

        policy = self._retry
        attempts = policy.attempts_for(method)
        clean = _clean_params(params)
        last_exc: Optional[Exception] = None

        for attempt in range(1, attempts + 1):
            resp: Optional[httpx.Response] = None
            try:
                resp = await self._client().request(
                    method, path, json=json, params=clean, headers=headers
                )
                if not should_retry_status(resp.status_code):
                    break
            except httpx.TransportError as exc:
                last_exc = exc

            if attempt >= attempts:
                break
            wait = backoff_seconds(policy, attempt)
            requested = retry_after_seconds(resp)
            if requested is not None:
                if requested > policy.max_retry_after and resp is not None:
                    break
                wait = requested
            await asyncio.sleep(wait)

        if resp is None:
            assert last_exc is not None
            raise WritConnectionError(f"cloud request to {path} failed: {last_exc}") from last_exc
        # Absorb BEFORE the error check: a 429 carries a minted token too, and
        # dropping it would leave a rate-limited caller anonymous forever.
        self._absorb_device_token(resp)
        body = _decode(resp)
        if resp.is_success:
            return body
        raise _cloud_error(resp.status_code, body)

    async def scrape(self, url: str) -> dict[str, Any]:
        out = await self._send("POST", self._scrape_path(), {"url": url})
        if isinstance(out, dict):
            out.setdefault("tier", self.tier)
        return out

    async def map(self, url: str, *, search: Optional[str] = None, limit: Optional[int] = None) -> dict[str, Any]:
        body: dict[str, Any] = {"url": url, "search": search or ""}
        if limit is not None:
            body["limit"] = limit
        out = await self._send("POST", self._map_path(), body)
        if isinstance(out, dict):
            out.setdefault("tier", self.tier)
        return out

    async def crawl(self, url: str, **options: Any) -> dict[str, Any]:
        self._require_key("Whole-site crawl")
        return await self._send("POST", "/api/crawl", {"url": url, **options})

    async def crawl_status(self, crawl_id: int) -> dict[str, Any]:
        self._require_key("Crawl status")
        return await self._send("GET", f"/api/crawl/{crawl_id}")

    async def crawl_keyless(self, url: str, *, search: Optional[str] = None,
                            limit: Optional[int] = None) -> dict[str, Any]:
        """Async twin of :meth:`Cloud.crawl_keyless`."""
        body: dict[str, Any] = {"url": url}
        if search is not None:
            body["search"] = search
        if limit is not None:
            body["limit"] = limit
        return await self._send("POST", "/v1/keyless/crawl", body)

    async def quota(self) -> Optional[dict[str, Any]]:
        if self._api_key:
            return None
        return await self._send("GET", "/v1/keyless/quota")

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
