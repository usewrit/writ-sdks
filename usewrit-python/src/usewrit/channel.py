"""The page channel: the one route the developer mounts (docs/browser-extension/CONTRACT.md §12.3).

==========  ==================================================================  ===================================
request     body                                                                answer
==========  ==================================================================  ===================================
``POST``    ``{"hello": {"ready", "granted", "writ_version"}}``                 ``204``
``GET``     none, ``?wait=N``                                                   ``200 {"commands": [...]}``
                                                                                (long-poll, N at most poll_seconds)
``POST``    ``{"result": {"id", "ok": true, "data", "receipt"}}`` or            ``204``
            ``{"result": {"id", "ok": false, "error", "receipt"?}}``
``POST``    ``{"run": {"key", "inputs", "options"}}``                           ``200 {"data", "venue": "cloud"}``
                                                                                (``recommended`` / ``cloud`` only)
==========  ==================================================================  ===================================

Every request carries ``Authorization: Writ <user token>``. Errors answer
``{"error": {"code", "message"}}``. The same answers, statuses and checks as the Node twin's
``handleChannel``.

:func:`handle_channel` is framework-free: ``(method, headers, query, body) -> (status, headers,
body)``. The ASGI app (:mod:`usewrit.asgi`) and the FastAPI router are thin adapters over it.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import logging
import math
import re
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Union
from urllib.parse import parse_qs

from . import _clock
from ._json import JsonObject, describe_value, dumps
from .constants import (
    DEFAULT_CALL_TIMEOUT_MS,
    FUNCTION_KEY_PATTERN,
    MAX_CALL_TIMEOUT_MS,
    MAX_COMMANDS_PER_POLL,
    MAX_GRANTED_KEYS,
    MAX_PAGE_RUNS_PER_USER,
    MIN_CALL_TIMEOUT_MS,
    PRESENCE_RETENTION_MS,
)
from .contract import ContractFunction, check_inputs
from .errors import WritBridgeError, default_message, http_status_of, is_code_shaped
from .store import CommandOutcome, PendingCommand, Presence, Store
from .tokens import read_user_token
from .verify import UNSET, DevicePolicy, ReceiptVerdict, check_receipt

__all__ = ["ChannelContext", "ChannelResponse", "HeadersLike", "QueryLike", "handle_channel"]

logger = logging.getLogger("usewrit")

#: ``(status, headers, body)``: what :func:`handle_channel` answers.
ChannelResponse = tuple[int, dict[str, str], bytes]

#: Request headers: a mapping, or ``(name, value)`` pairs (ASGI's raw form, bytes or text).
HeadersLike = Union[Mapping[str, str], Iterable[tuple[Union[str, bytes], Union[str, bytes]]]]

#: The query: its raw text (``"wait=25"``), or a mapping of names to a value or a list of values.
QueryLike = Union[str, bytes, Mapping[str, Union[str, list[str]]], None]

#: Runs a function on Writ Cloud: ``(fn, inputs, timeout_ms, dry_run) -> data``.
RunCloud = Callable[[ContractFunction, JsonObject, int, bool], Awaitable[Any]]

#: The page ``run`` gate: ``(user_id, key, inputs) -> bool`` (or an awaitable of one).
AuthorizeRun = Callable[[str, str, JsonObject], Union[bool, Awaitable[bool]]]

_BASE_HEADERS: Final = {"cache-control": "no-store", "x-content-type-options": "nosniff"}
_AUTHORIZATION: Final = re.compile(r"\s*Writ\s+(\S+)\s*", re.IGNORECASE)
_WAIT: Final = re.compile(r"[0-9]{1,6}")


@dataclass
class ChannelContext:
    """What the channel needs from the bridge."""

    secret: bytes | None
    store: Store
    poll_seconds: int
    max_body_bytes: int
    now: Callable[[], float]
    functions: Mapping[str, ContractFunction]
    mode_of: Callable[[str], str]
    run_cloud: RunCloud
    #: Which signers verify for a user (``"first-use"``, ``"off"`` or a function).
    devices: DevicePolicy = "first-use"
    authorize_run: AuthorizeRun | None = None
    #: Page ``run`` calls in flight per user, on this process.
    page_runs: dict[str, int] = field(default_factory=dict)


class _BodyTooLarge(Exception):
    pass


def _json_response(status: int, body: Any, extra: Mapping[str, str] | None = None) -> ChannelResponse:
    headers = {**_BASE_HEADERS, "content-type": "application/json; charset=utf-8", **(extra or {})}
    return status, headers, dumps(body).encode("utf-8")


def _no_content() -> ChannelResponse:
    return 204, dict(_BASE_HEADERS), b""


def _failure(status: int, code: str, message: str, extra: Mapping[str, str] | None = None) -> ChannelResponse:
    return _json_response(status, {"error": {"code": code, "message": message}}, extra)


def _bad_request(message: str) -> WritBridgeError:
    return WritBridgeError("BAD_REQUEST", message)


def _header_map(headers: HeadersLike | None) -> dict[str, str]:
    """Lower-cased header names; the first value wins."""
    out: dict[str, str] = {}
    if headers is None:
        return out
    pairs: Iterable[tuple[Any, Any]] = headers.items() if isinstance(headers, Mapping) else headers
    for name, value in pairs:
        key = name.decode("latin-1") if isinstance(name, (bytes, bytearray)) else str(name)
        text = value.decode("latin-1") if isinstance(value, (bytes, bytearray)) else str(value)
        out.setdefault(key.lower(), text)
    return out


def _query_value(query: QueryLike, name: str) -> str | None:
    if query is None:
        return None
    if isinstance(query, (bytes, bytearray)):
        query = bytes(query).decode("latin-1")
    if isinstance(query, str):
        values = parse_qs(query.lstrip("?"), keep_blank_values=True).get(name)
        return values[0] if values else None
    value = query.get(name)
    if isinstance(value, list):
        return value[0] if value else None
    return value


async def handle_channel(
    ctx: ChannelContext,
    method: str,
    headers: HeadersLike | None,
    query: QueryLike,
    body: bytes | None,
    *,
    disconnected: asyncio.Event | None = None,
) -> ChannelResponse:
    """Serve one page channel request. Never raises: every failure is an error response.

    ``disconnected``, when the adapter can tell, is set once the client has gone away: a waiting
    poll then stops and gives back any command it took.
    """
    try:
        verb = method.upper() if isinstance(method, str) else ""
        if verb not in ("GET", "POST"):
            return _failure(405, "BAD_REQUEST", "The Writ Bridge route answers GET and POST.", {"allow": "GET, POST"})
        if ctx.secret is None:
            return _failure(503, "CONFIG_INVALID", "WRIT_BRIDGE_SECRET is not set, so this bridge cannot serve pages.")
        lowered = _header_map(headers)
        user_id = _authenticate(ctx.secret, lowered.get("authorization"), ctx.now())
        if user_id is None:
            return _failure(
                401,
                "NOT_GRANTED",
                "The Writ user token is missing, invalid or expired.",
                {"www-authenticate": "Writ"},
            )
        if verb == "GET":
            return await _poll(ctx, user_id, query, disconnected)
        raw = body or b""
        if len(raw) > ctx.max_body_bytes:
            raise _BodyTooLarge()
        return await _post(ctx, user_id, raw, disconnected)
    except _BodyTooLarge:
        return _failure(413, "BAD_REQUEST", f"The request body is larger than {ctx.max_body_bytes} bytes.")
    except WritBridgeError as exc:
        if exc.code != "INTERNAL":
            return _failure(http_status_of(exc.code), exc.code, exc.message)
        logger.exception("Writ Bridge: the page channel failed")
        return _failure(500, "INTERNAL", default_message("INTERNAL"))
    except asyncio.CancelledError:
        raise
    except Exception:
        # Never echo an unexpected failure to the page: it may name internals.
        logger.exception("Writ Bridge: the page channel failed")
        return _failure(500, "INTERNAL", default_message("INTERNAL"))


def _authenticate(secret: bytes, header: str | None, now_ms: float) -> str | None:
    if header is None:
        return None
    match = _AUTHORIZATION.fullmatch(header)
    if match is None:
        return None
    payload = read_user_token(secret, match.group(1), _clock.now_seconds(now_ms))
    return None if payload is None else str(payload["sub"])


# -------------------------------------------------------------------------------------------------
# GET: long-poll for commands
# -------------------------------------------------------------------------------------------------


async def _poll(
    ctx: ChannelContext, user_id: str, query: QueryLike, disconnected: asyncio.Event | None
) -> ChannelResponse:
    wait_seconds = 0
    raw = _query_value(query, "wait")
    if raw is not None and raw != "":
        if _WAIT.fullmatch(raw) is None:
            raise _bad_request("`wait` must be a whole number of seconds.")
        wait_seconds = min(int(raw), ctx.poll_seconds)

    await _touch_presence(ctx, user_id)
    take = asyncio.ensure_future(ctx.store.take(user_id, wait_seconds * 1000, MAX_COMMANDS_PER_POLL))
    gone = asyncio.ensure_future(disconnected.wait()) if disconnected is not None else None
    try:
        await asyncio.wait({take} if gone is None else {take, gone}, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        # The server dropped this request: nobody will read what the take finds.
        await _abandon_take(ctx, user_id, take)
        raise
    finally:
        if gone is not None and not gone.done():
            gone.cancel()
    if not take.done():
        # The page left while we waited.
        await _abandon_take(ctx, user_id, take)
        return _json_response(200, {"commands": []})
    commands = take.result()
    if disconnected is not None and disconnected.is_set() and commands:
        # The page left while we waited: nobody will read this answer, so the commands go back.
        await ctx.store.requeue(user_id, commands)
        return _json_response(200, {"commands": []})
    now_seconds = _clock.now_seconds(ctx.now())
    return _json_response(200, {"commands": [command for command in commands if command["expires_at"] > now_seconds]})


async def _abandon_take(ctx: ChannelContext, user_id: str, take: asyncio.Future[list[Any]]) -> None:
    """Stop a take nobody will read, and give back any command it already took."""
    if not take.done():
        take.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await take
    if take.done() and not take.cancelled() and take.exception() is None:
        commands = take.result()
        if commands:
            await ctx.store.requeue(user_id, commands)


async def _touch_presence(ctx: ChannelContext, user_id: str) -> None:
    previous = await ctx.store.get_presence(user_id)
    if previous is None:
        presence = Presence(ready=False, granted=[], writ_version=None, last_seen=ctx.now(), ever_ready=False)
    else:
        presence = Presence(
            ready=previous["ready"],
            granted=list(previous["granted"]),
            writ_version=previous["writ_version"],
            last_seen=ctx.now(),
            ever_ready=previous["ever_ready"],
        )
    await ctx.store.set_presence(user_id, presence, PRESENCE_RETENTION_MS)


# -------------------------------------------------------------------------------------------------
# POST: hello, result, run
# -------------------------------------------------------------------------------------------------


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


async def _post(ctx: ChannelContext, user_id: str, raw: bytes, disconnected: asyncio.Event | None) -> ChannelResponse:
    try:
        body = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError):
        raise _bad_request("The body must be JSON.") from None
    if not isinstance(body, dict):
        raise _bad_request("The body must be a JSON object { hello } | { result } | { run }.")
    kinds = [name for name in ("hello", "result", "run") if name in body]
    if len(kinds) != 1:
        raise _bad_request("The body must carry exactly one of hello, result or run.")
    if kinds[0] == "hello":
        return await _hello(ctx, user_id, body["hello"])
    if kinds[0] == "result":
        return await _result(ctx, user_id, body["result"])
    return await _run(ctx, user_id, body["run"], disconnected)


async def _hello(ctx: ChannelContext, user_id: str, raw: Any) -> ChannelResponse:
    if not isinstance(raw, dict):
        raise _bad_request("hello must be { ready, granted, writ_version }.")
    ready = raw.get("ready")
    if not isinstance(ready, bool):
        raise _bad_request("hello.ready must be true or false.")
    granted = raw.get("granted")
    if granted is None:
        granted = []
    if (
        not isinstance(granted, list)
        or len(granted) > MAX_GRANTED_KEYS
        or not all(isinstance(key, str) for key in granted)
    ):
        raise _bad_request(f"hello.granted must be an array of at most {MAX_GRANTED_KEYS} function keys.")
    version = raw.get("writ_version")
    if version is not None and (not isinstance(version, str) or len(version) > 64):
        raise _bad_request("hello.writ_version must be a version string or null.")
    # Only keys of this contract matter; the rest is noise a page cannot use.
    keys = list(dict.fromkeys(key for key in granted if key in ctx.functions))
    previous = await ctx.store.get_presence(user_id)
    await ctx.store.set_presence(
        user_id,
        Presence(
            ready=ready,
            granted=keys,
            writ_version=version,
            last_seen=ctx.now(),
            ever_ready=bool(previous is not None and previous["ever_ready"]) or ready,
        ),
        PRESENCE_RETENTION_MS,
    )
    return _no_content()


async def _result(ctx: ChannelContext, user_id: str, raw: Any) -> ChannelResponse:
    if not isinstance(raw, dict):
        raise _bad_request("result must be { id, ok, data, receipt } or { id, ok: false, error, receipt? }.")
    command_id = raw.get("id")
    if not isinstance(command_id, str) or command_id == "" or len(command_id) > 64:
        raise _bad_request("result.id must be a command id.")
    ok = raw.get("ok")
    if not isinstance(ok, bool):
        raise _bad_request("result.ok must be true or false.")

    pending = await ctx.store.pending(command_id)
    # Another user's command answers exactly like an unknown one: ids are not to be probed.
    if pending is None or pending["user"] != user_id:
        return _failure(404, "BAD_REQUEST", "No command with that id is waiting for a result.")

    receipt = raw.get("receipt")
    outcome: CommandOutcome
    if ok:
        if "data" not in raw:
            outcome = _unverified(pending, "the result carries no data")
        else:
            verdict = await _check(ctx, pending, user_id, receipt, data=raw["data"], require_success=True)
            if verdict.ok and verdict.receipt is not None:
                outcome = {"ok": True, "data": raw["data"], "receipt": verdict.receipt}
            else:
                outcome = _unverified(pending, verdict.reason, verdict)
    else:
        error = _visitor_error(raw.get("error"))
        if receipt is None:
            outcome = {"ok": False, "error": error, "receipt": None}
        else:
            verdict = await _check(ctx, pending, user_id, receipt, data=UNSET, require_success=False)
            if verdict.ok and verdict.receipt is not None:
                outcome = {"ok": False, "error": error, "receipt": verdict.receipt}
            else:
                outcome = _unverified(pending, verdict.reason, verdict)
    await ctx.store.resolve(pending["id"], outcome)
    return _no_content()


async def _check(
    ctx: ChannelContext,
    pending: PendingCommand,
    user_id: str,
    receipt: Any,
    *,
    data: Any,
    require_success: bool,
) -> ReceiptVerdict:
    assert ctx.secret is not None
    return await check_receipt(
        receipt,
        secret=ctx.secret,
        now_seconds=_clock.now_seconds(ctx.now()),
        challenge=pending["challenge"],
        key=pending["key"],
        subject=user_id,
        nonce=pending["id"],
        data=data,
        expected_inputs_hash=pending.get("inputs_hash"),
        require_success=require_success,
        devices=ctx.devices,
        check_device=ctx.store.check_device,
        spend_nonce=ctx.store.spend_nonce,
    )


def _unverified(pending: PendingCommand, reason: str | None, verdict: ReceiptVerdict | None = None) -> CommandOutcome:
    text = reason or "the receipt does not verify"
    outcome: CommandOutcome = {
        "ok": False,
        "error": {"code": "RESULT_UNVERIFIED", "message": f"The result for {pending['key']} was refused: {text}."},
    }
    # Hand the developer the device to approve, when that is the only thing wrong.
    if verdict is not None and verdict.unknown_device and verdict.device:
        outcome["unknown_device"] = dict(verdict.device)
    return outcome


def _visitor_error(raw: Any) -> dict[str, str]:
    """The ``{code, message}`` a page reported, made safe to carry."""
    record = raw if isinstance(raw, dict) else {}
    code = record.get("code")
    message = record.get("message")
    return {
        "code": code if is_code_shaped(code) else "INTERNAL",
        "message": message[:1000]
        if isinstance(message, str) and message.strip() != ""
        else "The call failed on the user's computer.",
    }


async def _run(ctx: ChannelContext, user_id: str, raw: Any, disconnected: asyncio.Event | None) -> ChannelResponse:
    if not isinstance(raw, dict):
        raise _bad_request("run must be { key, inputs, options }.")
    key = raw.get("key")
    if not isinstance(key, str) or FUNCTION_KEY_PATTERN.fullmatch(key) is None:
        raise _bad_request(f"run.key {describe_value(key)} is not a function key.")
    fn = ctx.functions.get(key)
    if fn is None:
        raise WritBridgeError("INPUT_INVALID", f'This site has no function "{key}".')
    if ctx.mode_of(key) == "required":
        raise WritBridgeError("WRIT_REQUIRED", f'"{key}" runs only on the visitor\'s computer, never on Writ Cloud.')
    inputs = check_inputs(fn, raw.get("inputs"))

    options = raw.get("options")
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise _bad_request("run.options must be { timeout_ms?, dry_run? }.")
    timeout_ms = DEFAULT_CALL_TIMEOUT_MS
    raw_timeout = options.get("timeout_ms")
    if raw_timeout is not None:
        if (
            isinstance(raw_timeout, bool)
            or not isinstance(raw_timeout, (int, float))
            or not math.isfinite(raw_timeout)
        ):
            raise _bad_request("run.options.timeout_ms must be a number of milliseconds.")
        timeout_ms = min(MAX_CALL_TIMEOUT_MS, max(MIN_CALL_TIMEOUT_MS, _round_half_up(raw_timeout)))
    dry_run = options.get("dry_run")
    if dry_run is None:
        dry_run = False
    if not isinstance(dry_run, bool):
        raise _bad_request("run.options.dry_run must be true or false.")

    if ctx.authorize_run is not None and not await _allowed(ctx.authorize_run, user_id, key, inputs):
        raise WritBridgeError("NOT_GRANTED", f'This user may not run "{key}" on Writ Cloud.')

    in_flight = ctx.page_runs.get(user_id, 0)
    if in_flight >= MAX_PAGE_RUNS_PER_USER:
        raise WritBridgeError(
            "RATE_LIMITED", f"At most {MAX_PAGE_RUNS_PER_USER} Writ Cloud calls run at once for one user."
        )
    ctx.page_runs[user_id] = in_flight + 1
    try:
        work = asyncio.ensure_future(ctx.run_cloud(fn, inputs, timeout_ms, dry_run))
        gone = asyncio.ensure_future(disconnected.wait()) if disconnected is not None else None
        try:
            await asyncio.wait({work} if gone is None else {work, gone}, return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            work.cancel()  # the server dropped this request; the run itself continues on Writ Cloud
            raise
        finally:
            if gone is not None and not gone.done():
                gone.cancel()
        if not work.done():
            # The page left: stop waiting (the run itself continues on Writ Cloud).
            work.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await work
            raise WritBridgeError("CANCELLED", f"{key}: stopped waiting for the Writ Cloud run; the page left.")
        data = work.result()
        return _json_response(200, {"data": data, "venue": "cloud"})
    finally:
        left = ctx.page_runs.get(user_id, 1) - 1
        if left <= 0:
            ctx.page_runs.pop(user_id, None)
        else:
            ctx.page_runs[user_id] = left


def _round_half_up(value: float) -> int:
    """``Math.round``: halves round up, as the Node twin does."""
    return int(math.floor(value + 0.5))


async def _allowed(hook: AuthorizeRun, user_id: str, key: str, inputs: JsonObject) -> bool:
    answer = hook(user_id, key, inputs)
    if inspect.isawaitable(answer):
        answer = await answer
    return answer is True
