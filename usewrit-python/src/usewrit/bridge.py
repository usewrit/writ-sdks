"""``create_writ_bridge()``: the server side of the Writ Bridge.

docs/browser-extension/CONTRACT.md §12.4 and WRIT_BRIDGE_DESIGN.md. The same surface as the Node
twin's ``createWritBridge`` (``@usewrit/server``), in snake_case::

    from pathlib import Path
    from usewrit import create_writ_bridge

    bridge = create_writ_bridge(Path("writ-contract.json"), mode="recommended")
    app.include_router(bridge.fastapi_router())                 # the one route to mount
    result = await bridge.user(user_id).pos.receive({"invoice_no": "F-1029"})
    result.data, result.venue                                    # venue: "user" or "cloud"
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import cached_property
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import urlsplit

from . import _clock
from ._json import JsonObject, describe_value
from .canonical import inputs_hash
from .asgi import BridgeASGIApp
from .channel import AuthorizeRun, ChannelContext, ChannelResponse, HeadersLike, QueryLike, handle_channel
from .cloud import CloudRunner, CloudTiming
from .constants import (
    BRIDGE_MEMBER_NAMES,
    CLOUD_POLL_INITIAL_MS,
    CLOUD_POLL_MAX_MS,
    DEFAULT_CALL_TIMEOUT_MS,
    DEFAULT_CHALLENGE_TTL_SECONDS,
    DEFAULT_CLOUD_BASE,
    DEFAULT_MAX_BODY_BYTES,
    DEFAULT_POLL_SECONDS,
    DEFAULT_USER_TOKEN_TTL_SECONDS,
    MAX_CALL_TIMEOUT_MS,
    MAX_POLL_SECONDS,
    MAX_TOKEN_TTL_SECONDS,
    MAX_WAIT_FOR_USER_MS,
    MIN_CALL_TIMEOUT_MS,
    MIN_POLL_SECONDS,
    MIN_SECRET_BYTES,
    PICKUP_TIMEOUT_MS,
    PRESENCE_RECHECK_MS,
    PRESENCE_TTL_MS,
    RESULT_GRACE_MS,
)
from .contract import MODES, ContractFunction, ContractSource, Mode, WritContract, check_inputs, validate_contract
from .errors import WritBridgeError, normalize_visitor_code
from .store import Command, MemoryStore, PendingCommand, Store
from .tokens import mint_challenge, mint_user_token, new_nonce, secret_bytes, subject_of
from .verify import UNSET, DevicePolicy, VerifyResult, check_receipt, is_device_policy

if TYPE_CHECKING:
    import httpx

__all__ = ["BridgeResult", "FunctionNamespace", "WritBridge", "create_writ_bridge"]

#: The store methods the bridge calls.
_STORE_METHODS = (
    "get_presence",
    "set_presence",
    "enqueue",
    "take",
    "requeue",
    "withdraw",
    "pending",
    "resolve",
    "await_result",
    "cancel",
    "spend_nonce",
    "check_device",
    "pin_device",
    "forget_devices",
)

_LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")

#: A device public key as ``approve_device()`` accepts it: 32 bytes, base64url (or base64).
_PUBLIC_KEY = re.compile(r"[A-Za-z0-9+/_-]{43}=?")


@dataclass(frozen=True)
class BridgeResult:
    """What every call resolves to.

    ``data``: the function's data, what the page received on the user's computer or the Writ
    Cloud run's. ``venue``: where it ran. ``receipt``: the verified receipt, when it ran on the
    user's computer.
    """

    data: Any
    venue: Literal["user", "cloud"]
    receipt: Mapping[str, Any] | None = None


def _local_network_of(fn: ContractFunction) -> list[str]:
    """Where on the visitor's local network a function goes: the hosts its package names, and the
    address each visitor gives once as a ``lan_host`` setting (CONTRACT.md §8 "Settings"). Writ
    Cloud can reach neither, so such a function always runs on the visitor's computer."""
    return [*fn.local_network, *(f"{{{{{s.key}}}}}" for s in fn.settings if s.kind == "lan_host")]


def _config_invalid(message: str) -> WritBridgeError:
    return WritBridgeError("CONFIG_INVALID", message)


def _env(name: str) -> str | None:
    value = os.environ.get(name)
    return None if value is None or value == "" else value


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _cloud_base_of(raw: object) -> str:
    if not isinstance(raw, str):
        raise _config_invalid(f"cloud_base must be a URL; got {describe_value(raw)}.")
    try:
        parts = urlsplit(raw.strip())
        host = parts.hostname
        port = parts.port
    except ValueError:
        raise _config_invalid(f"cloud_base {describe_value(raw)} is not a URL.") from None
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https") or not host:
        raise _config_invalid(f"cloud_base {describe_value(raw)} is not a URL.")
    if scheme != "https" and not (scheme == "http" and host in _LOCAL_HOSTS):
        raise _config_invalid("cloud_base must use https (http only for localhost): it carries WRIT_API_KEY.")
    if parts.query or parts.fragment or parts.username is not None or parts.password is not None:
        raise _config_invalid("cloud_base must be a plain base URL, without credentials, query or fragment.")
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc = f"{netloc}:{port}"
    return f"{scheme}://{netloc}{parts.path}".rstrip("/")


def _timeout_of(value: object) -> int:
    if value is None:
        return DEFAULT_CALL_TIMEOUT_MS
    if not _is_int(value) or not MIN_CALL_TIMEOUT_MS <= value <= MAX_CALL_TIMEOUT_MS:  # type: ignore[operator]
        raise WritBridgeError(
            "BAD_REQUEST",
            f"timeout_ms must be a whole number of milliseconds from {MIN_CALL_TIMEOUT_MS} to {MAX_CALL_TIMEOUT_MS}.",
        )
    return int(value)  # type: ignore[call-overload]


def _wait_of(value: object) -> int:
    if value is None:
        return 0
    if not _is_int(value) or not 0 <= value <= MAX_WAIT_FOR_USER_MS:  # type: ignore[operator]
        raise WritBridgeError(
            "BAD_REQUEST", f"wait_for_user_ms must be a whole number of milliseconds from 0 to {MAX_WAIT_FOR_USER_MS}."
        )
    return int(value)  # type: ignore[call-overload]


def _dry_run_of(value: object) -> bool:
    if value is None:
        return False
    if not isinstance(value, bool):
        raise WritBridgeError("BAD_REQUEST", "dry_run must be True or False.")
    return value


class FunctionNamespace:
    """The contract's functions as nested attributes: ``"pos.receive"`` is ``.pos.receive``.

    ``bridge.user(user_id)`` answers one for that user (the call runs on their computer, or by
    mode on Writ Cloud); the bridge itself serves the root one without a user (Writ Cloud). A key
    whose segments are not Python names (``"pos-v2.receive"``, ``"orders.import"``) is reached
    by item: ``bridge.user(uid)["pos-v2.receive"]``.
    """

    __slots__ = ("_bridge", "_path", "_user_id")

    def __init__(self, bridge: WritBridge, user_id: str | None, path: str) -> None:
        self._bridge = bridge
        self._user_id = user_id
        self._path = path

    def _child(self, segment: str) -> FunctionNamespace:
        path = f"{self._path}.{segment}" if self._path else segment
        contract = self._bridge.contract
        if not (contract.is_function(path) or contract.is_namespace(path)):
            raise AttributeError(f'The Writ contract has no function or namespace "{path}".')
        return FunctionNamespace(self._bridge, self._user_id, path)

    def __getattr__(self, name: str) -> FunctionNamespace:
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return self._child(name)

    def __getitem__(self, path: str) -> FunctionNamespace:
        if not isinstance(path, str) or path == "":
            raise KeyError(path)
        node = self
        try:
            for segment in path.split("."):
                node = node._child(segment)
        except AttributeError as exc:
            raise KeyError(path) from exc
        return node

    def __dir__(self) -> list[str]:
        return self._bridge.contract.children(self._path)

    def __repr__(self) -> str:
        who = "Writ Cloud" if self._user_id is None else f"user {self._user_id!r}"
        return f"<Writ function namespace {self._path or '(root)'!r} for {who}>"

    async def __call__(
        self,
        inputs: Mapping[str, Any] | None = None,
        *,
        timeout_ms: int | None = None,
        wait_for_user_ms: int | None = None,
        dry_run: bool | None = None,
    ) -> BridgeResult:
        """Call this function with ``inputs``.

        ``timeout_ms``: how long the call may take once started (1000 to 900000; default
        120000). ``wait_for_user_ms`` (``bridge.user(...)`` calls, ``required`` mode): how long to
        wait for one of the user's pages to connect with Writ ready and the function granted,
        before failing; default 0, not counted in ``timeout_ms``. ``dry_run``: preview a function
        that writes, without sending its changes, where it supports it.
        """
        contract = self._bridge.contract
        fn = contract.function_of(self._path) if self._path else None
        if fn is None:
            if self._path:
                listed = ", ".join(contract.children(self._path))
                raise WritBridgeError(
                    "BAD_REQUEST", f'"{self._path}" is a namespace of the contract, not a function; its members: {listed}.'
                )
            raise WritBridgeError("BAD_REQUEST", "Call a function of the contract, as in bridge.user(user_id).pos.receive({...}).")
        if self._user_id is None:
            return await self._bridge._call_on_cloud(fn, inputs, timeout_ms, dry_run)
        return await self._bridge._call_for_user(self._user_id, fn, inputs, timeout_ms, wait_for_user_ms, dry_run)


class WritBridge:
    """The server bridge. Build it with :func:`create_writ_bridge`.

    Its members (``asgi``, ``fastapi_router``, ``handle``, ``user_token``, ``user``,
    ``challenge``, ``verify``, ``approve_device``, ``forget_devices``, ``online``, ``mode_of``,
    ``contract``, ``close``) plus the contract's functions on Writ Cloud
    (``await bridge.pos.lookup({...})``).
    """

    def __init__(
        self,
        *,
        contract: WritContract,
        modes: Mapping[str, Mode],
        secret: bytes | None,
        store: Store,
        poll_seconds: int,
        max_body_bytes: int,
        cloud: CloudRunner | None,
        devices: DevicePolicy,
        authorize_run: AuthorizeRun | None,
        now: Callable[[], float] | None,
    ) -> None:
        self._contract = contract
        self._modes = dict(modes)
        self._secret = secret
        self._store = store
        self._poll_seconds = poll_seconds
        self._max_body_bytes = max_body_bytes
        self._cloud = cloud
        self._devices = devices
        self._now_fn = now
        self._functions = {fn.key: fn for fn in contract.functions}
        self._root = FunctionNamespace(self, None, "")
        self._channel = ChannelContext(
            secret=secret,
            store=store,
            poll_seconds=poll_seconds,
            max_body_bytes=max_body_bytes,
            now=self._now_ms,
            functions=self._functions,
            mode_of=self.mode_of,
            run_cloud=self._run_cloud,
            devices=devices,
            authorize_run=authorize_run,
        )

    # -- the contract's functions on Writ Cloud ----------------------------------------------

    def __getattr__(self, name: str) -> FunctionNamespace:
        if name.startswith("_"):
            raise AttributeError(name)
        return self._root._child(name)

    def __getitem__(self, path: str) -> FunctionNamespace:
        return self._root[path]

    def __dir__(self) -> list[str]:
        return sorted({*super().__dir__(), *self._contract.children("")})

    def __repr__(self) -> str:
        return f"<WritBridge {len(self._functions)} functions>"

    async def __aenter__(self) -> WritBridge:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()

    # -- members -------------------------------------------------------------------------------

    @property
    def contract(self) -> WritContract:
        """The validated contract."""
        return self._contract

    def _now_ms(self) -> float:
        return self._now_fn() if self._now_fn is not None else _clock.now_ms()

    def mode_of(self, key: str) -> Mode:
        """Where a function runs, after the contract, ``function_modes`` and the local-network rule."""
        mode = self._modes.get(key)
        if mode is None:
            raise WritBridgeError("INPUT_INVALID", f'The contract has no function "{key}".')
        return mode

    @cached_property
    def asgi(self) -> BridgeASGIApp:
        """The page channel as an ASGI 3 app: mount it on the route the page bridge talks to."""
        return BridgeASGIApp(self.handle, max_body_bytes=lambda: self._max_body_bytes, on_shutdown=self.close)

    def fastapi_router(self, path: str = "/writ-bridge") -> Any:
        """A FastAPI ``APIRouter`` serving the page channel at ``path``:
        ``app.include_router(bridge.fastapi_router())``. Needs FastAPI (``usewrit[fastapi]``)."""
        if not isinstance(path, str) or not path.startswith("/"):
            raise WritBridgeError("BAD_REQUEST", 'fastapi_router() path must start with "/", as in "/writ-bridge".')
        try:
            from fastapi import APIRouter
        except ImportError as exc:
            raise _config_invalid('fastapi_router() needs FastAPI: pip install "usewrit[fastapi]".') from exc
        router = APIRouter()
        # A plain route whose endpoint is an ASGI app: the channel reads the body itself and
        # watches for the page leaving while a poll waits.
        router.add_route(path, self.asgi, methods=["GET", "POST"], include_in_schema=False)
        return router

    async def handle(
        self,
        method: str,
        headers: HeadersLike | None,
        query: QueryLike,
        body: bytes | None,
        *,
        disconnected: asyncio.Event | None = None,
    ) -> ChannelResponse:
        """Serve one page channel request, framework-free: ``(status, headers, body)``.

        ``headers`` is a mapping or ``(name, value)`` pairs; ``query`` the raw query text or a
        mapping. Never raises: every failure is an error response. Set ``disconnected`` when the
        client goes away, if your framework can tell, so a waiting poll gives its commands back.
        """
        return await handle_channel(self._channel, method, headers, query, body, disconnected=disconnected)

    def _require_secret(self, what: str) -> bytes:
        if self._secret is None:
            raise _config_invalid(f"{what} needs WRIT_BRIDGE_SECRET (at least {MIN_SECRET_BYTES} bytes).")
        return self._secret

    @staticmethod
    def _ttl_of(value: object, fallback: int, name: str) -> int:
        ttl = fallback if value is None else value
        if not _is_int(ttl) or not 1 <= ttl <= MAX_TOKEN_TTL_SECONDS:  # type: ignore[operator]
            raise WritBridgeError("BAD_REQUEST", f"{name} must be a whole number of seconds from 1 to {MAX_TOKEN_TTL_SECONDS}.")
        return int(ttl)  # type: ignore[call-overload]

    @staticmethod
    def _user_of(user_id: object) -> str:
        sub = subject_of(user_id)
        if sub is None:
            raise WritBridgeError(
                "INPUT_INVALID",
                "A user id is a non-empty string of at most 256 characters, or a safe integer; "
                f"got {describe_value(user_id)}.",
            )
        return sub

    def user_token(self, user_id: str | int, ttl_seconds: int | None = None) -> str:
        """The token your page passes to its bridge, for ``user_id`` (CONTRACT.md §12.2).

        Signs ``{v: 1, typ: "user", sub, exp}``; ``ttl_seconds`` defaults to 3600.
        """
        sub = self._user_of(user_id)
        ttl = self._ttl_of(ttl_seconds, DEFAULT_USER_TOKEN_TTL_SECONDS, "ttl_seconds")
        return mint_user_token(self._require_secret("user_token()"), sub, _clock.now_seconds(self._now_ms()) + ttl)

    def user(self, user_id: str | int) -> FunctionNamespace:
        """The contract's functions, run for this user: on their computer, or by mode on Writ Cloud."""
        return FunctionNamespace(self, self._user_of(user_id), "")

    def challenge(self, subject: str | int, key: str, ttl_seconds: int | None = None) -> str:
        """A single-use challenge for a page call you will check with :meth:`verify`.

        ``subject``: who or what it is for (a user id, a login attempt). ``key``: the contract key
        the visitor's computer must run. ``ttl_seconds`` defaults to 120.
        """
        sub = subject_of(subject)
        if sub is None:
            raise WritBridgeError(
                "INPUT_INVALID",
                "challenge() subject must be a non-empty string of at most 256 characters, or a safe integer.",
            )
        self.mode_of(key)
        ttl = self._ttl_of(ttl_seconds, DEFAULT_CHALLENGE_TTL_SECONDS, "ttl_seconds")
        return mint_challenge(
            self._require_secret("challenge()"), sub=sub, key=key, exp=_clock.now_seconds(self._now_ms()) + ttl
        )

    async def verify(
        self,
        receipt: object,
        *,
        challenge: str,
        key: str,
        origin: str | None = None,
        data: Any = UNSET,
        subject: str | int | None = None,
        inputs: Any = UNSET,
    ) -> VerifyResult:
        """Check a receipt the page relayed against your challenge. Never raises for a bad receipt.

        ``ok`` is true only when the receipt is genuine, answers ``challenge`` (unexpired, minted
        here for ``key``, never used before) for ``key``, comes from ``origin`` when given,
        carries the hash of ``data`` when given (``data=None`` checks JSON ``null``), ran with
        ``inputs`` when given (say, the username and password your sign-in form got), and the call
        succeeded. The challenge is spent once a genuine receipt answers it, whatever the outcome.
        """
        if not isinstance(challenge, str) or not isinstance(key, str):
            raise WritBridgeError("BAD_REQUEST", "verify() takes (receipt, challenge=..., key=..., origin=, data=, subject=).")
        expected_subject: str | None = None
        if subject is not None:
            expected_subject = subject_of(subject)
            if expected_subject is None:
                raise WritBridgeError("BAD_REQUEST", "verify() subject must be a user id.")
        if origin is not None and not isinstance(origin, str):
            raise WritBridgeError("BAD_REQUEST", "verify() origin must be a string.")
        verdict = await check_receipt(
            receipt,
            secret=self._require_secret("verify()"),
            now_seconds=_clock.now_seconds(self._now_ms()),
            challenge=challenge,
            key=key,
            subject=expected_subject,
            origin=origin,
            data=data,
            inputs=inputs,
            require_success=True,
            devices=self._devices,
            check_device=self._store.check_device,
            spend_nonce=self._store.spend_nonce,
        )
        return verdict.result()

    async def approve_device(self, user_id: str | int, device: Mapping[str, Any] | str) -> None:
        """Pin a further device for a user (or challenge subject): a computer whose receipt came
        back ``unknown_device``, once you have confirmed it is theirs (an email link, say). Never
        on the page's word alone. ``device`` is the receipt's ``device`` or its ``public_key``."""
        public_key = device if isinstance(device, str) else device.get("public_key") if isinstance(device, Mapping) else None
        if not isinstance(public_key, str) or _PUBLIC_KEY.fullmatch(public_key) is None:
            raise WritBridgeError(
                "BAD_REQUEST", "approve_device() takes the user id and the receipt's device (or its public_key)."
            )
        await self._store.pin_device(self._user_of(user_id), public_key)

    async def forget_devices(self, user_id: str | int) -> None:
        """Forget every device pinned for a user; under ``"first-use"`` their next receipt pins anew."""
        await self._store.forget_devices(self._user_of(user_id))

    async def online(self, user_id: str | int) -> bool:
        """Whether one of the user's pages is connected with Writ ready."""
        presence = await self._store.get_presence(self._user_of(user_id))
        return (
            presence is not None
            and presence["ready"] is True
            and self._now_ms() - presence["last_seen"] <= PRESENCE_TTL_MS
        )

    async def close(self) -> None:
        """Release the store's resources, wake every waiting poll, and close Writ Cloud's client."""
        closer = getattr(self._store, "aclose", None)
        if closer is not None:
            await closer()
        if self._cloud is not None:
            await self._cloud.aclose()

    async def aclose(self) -> None:
        """:meth:`close`, under Python's async-close name (``contextlib.aclosing``)."""
        await self.close()

    # -- Writ Cloud ----------------------------------------------------------------------------

    async def _run_cloud(self, fn: ContractFunction, inputs: JsonObject, timeout_ms: int, dry_run: bool) -> Any:
        if fn.cloud is None or self._cloud is None:
            raise WritBridgeError(
                "CLOUD_NOT_CONFIGURED", f'"{fn.key}" has no Writ Cloud workflow mapped, or WRIT_API_KEY is not set.'
            )
        return await self._cloud.run(mapping=fn.cloud, key=fn.key, inputs=inputs, timeout_ms=timeout_ms, dry_run=dry_run)

    async def _call_on_cloud(
        self, fn: ContractFunction, inputs: object, timeout_ms: object, dry_run: object
    ) -> BridgeResult:
        clean = check_inputs(fn, inputs)
        timeout = _timeout_of(timeout_ms)
        dry = _dry_run_of(dry_run)
        if self.mode_of(fn.key) == "required":
            raise WritBridgeError(
                "WRIT_REQUIRED", f'"{fn.key}" runs only on a user\'s computer: call bridge.user(user_id).{fn.key}(...) instead.'
            )
        return BridgeResult(data=await self._run_cloud(fn, clean, timeout, dry), venue="cloud")

    # -- the user's computer ---------------------------------------------------------------------

    async def _route_for(self, user_id: str, key: str) -> str:
        """``"user"``, or why the user cannot take the call: ``NOT_GRANTED``, ``WRIT_REQUIRED`` or
        ``USER_OFFLINE``."""
        presence = await self._store.get_presence(user_id)
        online = presence is not None and self._now_ms() - presence["last_seen"] <= PRESENCE_TTL_MS
        if presence is not None and online and presence["ready"] and key in presence["granted"]:
            return "user"
        if presence is not None and online and presence["ready"]:
            return "NOT_GRANTED"
        if online:
            return "WRIT_REQUIRED"
        if presence is not None and presence.get("ever_ready") is True:
            return "USER_OFFLINE"
        return "WRIT_REQUIRED"

    async def _wait_for_user(self, user_id: str, key: str, wait_ms: int) -> str:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait_ms / 1000.0
        route = await self._route_for(user_id, key)
        while route != "user":
            left = deadline - loop.time()
            if left <= 0:
                break
            await asyncio.sleep(min(PRESENCE_RECHECK_MS / 1000.0, left))
            route = await self._route_for(user_id, key)
        return route

    async def _run_on_user(
        self, user_id: str, fn: ContractFunction, inputs: JsonObject, timeout_ms: int, dry_run: bool
    ) -> BridgeResult | str:
        """The call's result, or an away code when the user's pages could not take it."""
        secret = self._require_secret("Running a function on a user's computer")
        store = self._store
        command_id = new_nonce()
        sent_at = self._now_ms()
        expires_at = math.ceil((sent_at + timeout_ms) / 1000)
        challenge_exp = math.ceil((sent_at + timeout_ms + RESULT_GRACE_MS) / 1000) + 1
        challenge = mint_challenge(secret, sub=user_id, key=fn.key, nonce=command_id, exp=challenge_exp)
        command = Command(
            id=command_id,
            key=fn.key,
            inputs=inputs,
            options={"timeout_ms": timeout_ms, "dry_run": True} if dry_run else {"timeout_ms": timeout_ms},
            challenge=challenge,
            expires_at=expires_at,
        )
        pending = PendingCommand(
            id=command_id,
            user=user_id,
            key=fn.key,
            challenge=challenge,
            expires_at=challenge_exp,
            inputs_hash=inputs_hash(challenge, inputs),
        )
        budget = timeout_ms + RESULT_GRACE_MS
        await store.enqueue(user_id, command, pending, budget + 1_000)

        loop = asyncio.get_running_loop()
        started = loop.time()
        try:
            outcome = await store.await_result(command_id, min(PICKUP_TIMEOUT_MS, budget))
            if outcome is None and await store.withdraw(user_id, command):
                # No page took it: the user's pages went away without saying so.
                await store.cancel(command_id)
                return "USER_OFFLINE"
            if outcome is None:
                outcome = await store.await_result(command_id, max(0.0, budget - (loop.time() - started) * 1000.0))
        except asyncio.CancelledError:
            # The caller gave up: take the command back if no page took it, and forget it.
            with contextlib.suppress(Exception):
                await store.withdraw(user_id, command)
                await store.cancel(command_id)
            raise
        if outcome is None:
            await store.cancel(command_id)
            raise WritBridgeError(
                "TIMEOUT",
                f"{fn.key} did not answer from the user's computer within {round(timeout_ms / 1000)} s.",
                details={"command_id": command_id},
            )
        if outcome.get("ok") is True:
            return BridgeResult(data=outcome.get("data"), venue="user", receipt=outcome.get("receipt"))

        error = outcome.get("error") if isinstance(outcome.get("error"), dict) else {}
        reported = error.get("code")
        code = normalize_visitor_code(reported)
        receipt = outcome.get("receipt")
        if code == "NOT_GRANTED" and receipt is None:
            # The page has not granted the key (its last hello was stale): nothing ran there.
            return "NOT_GRANTED"
        details: dict[str, Any] = {"command_id": command_id}
        if receipt is not None:
            details["receipt"] = receipt
        if code != reported:
            details["visitor_code"] = reported
        unknown_device = outcome.get("unknown_device")
        if isinstance(unknown_device, dict):
            # Refused only because the signer is not pinned: approve_device(user_id, device) once
            # you have confirmed this computer is the user's.
            details["unknown_device"] = True
            details["device"] = unknown_device
        message = error.get("message")
        raise WritBridgeError(code, message if isinstance(message, str) else None, details=details)

    @staticmethod
    def _away_error(code: str, key: str) -> WritBridgeError:
        if code == "NOT_GRANTED":
            return WritBridgeError("NOT_GRANTED", f'The user has not granted "{key}" to this site in Writ.')
        if code == "USER_OFFLINE":
            return WritBridgeError("USER_OFFLINE", f'"{key}" runs on the user\'s computer, and none of their pages is connected.')
        return WritBridgeError(
            "WRIT_REQUIRED", f'"{key}" runs on the user\'s computer, and the user has not reported Writ ready for this site.'
        )

    async def _call_for_user(
        self,
        user_id: str,
        fn: ContractFunction,
        inputs: object,
        timeout_ms: object,
        wait_for_user_ms: object,
        dry_run: object,
    ) -> BridgeResult:
        clean = check_inputs(fn, inputs)
        timeout = _timeout_of(timeout_ms)
        wait = _wait_of(wait_for_user_ms)
        dry = _dry_run_of(dry_run)
        mode = self.mode_of(fn.key)
        if mode == "cloud":
            return BridgeResult(data=await self._run_cloud(fn, clean, timeout, dry), venue="cloud")

        route = await self._route_for(user_id, fn.key)
        if route != "user" and mode == "required" and wait > 0:
            route = await self._wait_for_user(user_id, fn.key, wait)
        if route == "user":
            attempt = await self._run_on_user(user_id, fn, clean, timeout, dry)
            if isinstance(attempt, BridgeResult):
                return attempt
            route = attempt
        if mode == "recommended":
            return BridgeResult(data=await self._run_cloud(fn, clean, timeout, dry), venue="cloud")
        raise self._away_error(route, fn.key)


def create_writ_bridge(
    contract: ContractSource,
    mode: Mode = "required",
    *,
    function_modes: Mapping[str, Mode] | None = None,
    secret: str | bytes | None = None,
    api_key: str | None = None,
    store: Store | None = None,
    poll_seconds: int = DEFAULT_POLL_SECONDS,
    cloud_base: str = DEFAULT_CLOUD_BASE,
    pin_devices: DevicePolicy = "first-use",
    authorize_run: AuthorizeRun | None = None,
    cloud_poll: Mapping[str, float] | None = None,
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
    http_client: httpx.AsyncClient | None = None,
    now: Callable[[], float] | None = None,
) -> WritBridge:
    """Build the server bridge.

    ``contract``: ``writ-contract.json`` as a dict, its text, or a ``pathlib.Path``. ``mode``:
    where functions run unless the contract or ``function_modes`` says otherwise (``"required"``,
    ``"recommended"`` or ``"cloud"``). ``secret`` defaults to ``WRIT_BRIDGE_SECRET``, ``api_key``
    to ``WRIT_API_KEY``. ``store`` defaults to a :class:`~usewrit.store.MemoryStore` (one
    process); use :class:`~usewrit.redis_store.RedisStore` for several.

    ``pin_devices``: which Writ installs may sign a user's receipts. ``"first-use"`` (default):
    the first device that answers for a user is pinned to them, and another is refused
    (``unknown_device``) until you :meth:`~WritBridge.approve_device` it; pins live in the store,
    so use a durable one (Redis) in production. A function ``(user_id, device) -> bool`` (may be
    async) makes your own registry decide; ``"off"`` accepts any signer (no protection against
    forged results). See :data:`usewrit.verify.DevicePolicy`.

    ``authorize_run(user_id, key, inputs) -> bool`` (may be async) gates page calls routed to
    Writ Cloud, which spend your plan. ``cloud_poll`` (``{"initial_ms", "max_ms"}``) tunes the
    Writ Cloud result polling; ``http_client`` is the ``httpx.AsyncClient`` for Writ Cloud calls;
    ``now`` a clock in unix milliseconds, for tests.

    Refuses, at creation, anything that would fail later:

    - an invalid contract (``INPUT_INVALID``);
    - a ``recommended`` or ``cloud`` function without a ``cloud: {workflow_id, function}``
      mapping, or without ``WRIT_API_KEY`` (``CLOUD_NOT_CONFIGURED``);
    - a function with ``local_network`` hosts explicitly set to a mode other than ``required``,
      a secret shorter than 32 bytes, no secret while any function can run on a user's computer,
      a ``pin_devices`` that is not ``"first-use"``, ``"off"`` or a function, or a contract key
      whose first segment is a member of the bridge (``CONFIG_INVALID``).

    A function with ``local_network`` hosts that only inherits the bridge's mode is run as
    ``required``: Writ Cloud cannot reach the visitor's network.
    """
    clean = validate_contract(contract)
    functions = {fn.key: fn for fn in clean.functions}

    if mode not in MODES:
        raise _config_invalid(f'mode must be "required", "recommended" or "cloud"; got {describe_value(mode)}.')

    overrides: dict[str, Mode] = {}
    if function_modes is not None:
        if not isinstance(function_modes, Mapping):
            raise _config_invalid("function_modes must be a dict { key: mode }.")
        for key, value in function_modes.items():
            if key not in functions:
                raise _config_invalid(f'function_modes names "{key}", which is not a function of the contract.')
            if value not in MODES:
                raise _config_invalid(f'function_modes["{key}"] must be "required", "recommended" or "cloud".')
            overrides[key] = value

    raw_secret = secret if secret is not None else _env("WRIT_BRIDGE_SECRET")
    key_bytes: bytes | None = None
    if raw_secret is not None:
        if not isinstance(raw_secret, (str, bytes, bytearray)):
            raise _config_invalid("secret must be a string or bytes.")
        key_bytes = secret_bytes(raw_secret)
        if len(key_bytes) < MIN_SECRET_BYTES:
            raise _config_invalid(
                f"WRIT_BRIDGE_SECRET must be at least {MIN_SECRET_BYTES} bytes; it is {len(key_bytes)}. "
                "Generate one with: openssl rand -base64 48"
            )

    raw_api_key = api_key if api_key is not None else _env("WRIT_API_KEY")
    if raw_api_key is not None and not isinstance(raw_api_key, str):
        raise _config_invalid("api_key must be a string.")
    resolved_api_key = raw_api_key.strip() if raw_api_key is not None and raw_api_key.strip() != "" else None

    if not _is_int(poll_seconds) or not MIN_POLL_SECONDS <= poll_seconds <= MAX_POLL_SECONDS:
        raise _config_invalid(f"poll_seconds must be a whole number from {MIN_POLL_SECONDS} to {MAX_POLL_SECONDS}.")
    base = _cloud_base_of(cloud_base)
    if not _is_int(max_body_bytes) or max_body_bytes < 1_024:
        raise _config_invalid("max_body_bytes must be a whole number of at least 1024.")
    if not is_device_policy(pin_devices):
        raise _config_invalid('pin_devices must be "first-use", "off" or a function.')
    for name, hook in (("authorize_run", authorize_run), ("now", now)):
        if hook is not None and not callable(hook):
            raise _config_invalid(f"{name} must be a function.")
    timing: CloudTiming | None = None
    if cloud_poll is not None:
        if not isinstance(cloud_poll, Mapping):
            raise _config_invalid('cloud_poll must be a dict { "initial_ms": ..., "max_ms": ... }.')
        timing = CloudTiming(
            initial_ms=float(cloud_poll.get("initial_ms", CLOUD_POLL_INITIAL_MS)),
            max_ms=float(cloud_poll.get("max_ms", CLOUD_POLL_MAX_MS)),
        )

    if store is None:
        store = MemoryStore(now=now)
    missing = [name for name in _STORE_METHODS if not callable(getattr(store, name, None))]
    if missing:
        raise _config_invalid(f"store is missing {', '.join(missing)}; implement usewrit.Store.")

    # Effective modes, and the refusals that must happen now rather than on a user's first call.
    modes: dict[str, Mode] = {}
    for fn in clean.functions:
        explicit = overrides.get(fn.key, fn.mode)
        effective: Mode
        lan = _local_network_of(fn)
        if lan:
            if explicit is not None and explicit != "required":
                raise _config_invalid(
                    f'"{fn.key}" reaches the visitor\'s local network ({", ".join(lan)}), which Writ Cloud '
                    f'cannot reach; its mode must be "required", not "{explicit}".'
                )
            effective = "required"
        else:
            effective = explicit if explicit is not None else mode
        if effective != "required":
            if fn.cloud is None:
                raise WritBridgeError(
                    "CLOUD_NOT_CONFIGURED",
                    f'"{fn.key}" is "{effective}" but the contract maps it to no Writ Cloud workflow; publish it from '
                    'Writ Cloud, or make it "required".',
                )
            if resolved_api_key is None:
                raise WritBridgeError(
                    "CLOUD_NOT_CONFIGURED",
                    f'"{fn.key}" is "{effective}": set WRIT_API_KEY (or pass api_key) to run it on Writ Cloud.',
                )
        modes[fn.key] = effective
    user_side = any(value != "cloud" for value in modes.values())
    if user_side and key_bytes is None:
        raise _config_invalid(
            f"Set WRIT_BRIDGE_SECRET (at least {MIN_SECRET_BYTES} bytes, e.g. openssl rand -base64 48): functions can "
            "run on your users' computers, and their pages authenticate with it."
        )
    for fn in clean.functions:
        head = fn.key.split(".")[0]
        if head in BRIDGE_MEMBER_NAMES:
            raise _config_invalid(f'The contract key "{fn.key}" starts with "{head}", a member of the bridge itself; rename it.')

    cloud = (
        CloudRunner(base=base, api_key=resolved_api_key, client=http_client, timing=timing)
        if resolved_api_key is not None
        else None
    )
    return WritBridge(
        contract=clean,
        modes=modes,
        secret=key_bytes,
        store=store,
        poll_seconds=poll_seconds,
        max_body_bytes=max_body_bytes,
        cloud=cloud,
        devices=pin_devices,
        authorize_run=authorize_run,
        now=now,
    )
