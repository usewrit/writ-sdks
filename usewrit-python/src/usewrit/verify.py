"""Binding a receipt to a call: the server's challenge, the function, the user, the origin and the
data (docs/browser-extension/CONTRACT.md §12.1, §12.3 "Server checks").
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final, Literal, Union
from urllib.parse import urlsplit

from .canonical import data_hash, inputs_hash
from .errors import WritBridgeError
from .receipt import verify_receipt_signature
from .tokens import read_challenge

__all__ = [
    "UNSET",
    "CheckDevice",
    "DevicePolicy",
    "PinDevices",
    "ReceiptVerdict",
    "VerifyResult",
    "check_receipt",
    "is_device_policy",
    "normalize_origin",
]


class _Unset:
    """The marker for "no value given" where ``None`` is a value (JSON ``null`` data)."""

    _instance: _Unset | None = None

    def __new__(cls) -> _Unset:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "UNSET"

    def __bool__(self) -> bool:
        return False


#: Pass nothing for ``data``: the data hash is not checked. ``data=None`` checks JSON ``null``.
UNSET: Final = _Unset()

#: Your own device registry: ``(subject, device) -> bool`` (or an awaitable of one).
PinDevices = Callable[[str, Mapping[str, Any]], Union[bool, Awaitable[bool]]]

#: Which Writ installs may sign a user's receipts (CONTRACT.md §12.4 "Device pins").
#:
#: A receipt carries the public key that signed it, so a signature alone proves nothing about WHO
#: signed: anyone can make a key and sign a receipt that claims success. Pinning is what ties
#: receipts to the user's own Writ:
#:
#: - ``"first-use"`` (default): the first device whose receipt verifies for a user is pinned to
#:   that user, and only pinned devices verify afterwards. Another computer is refused
#:   (``unknown_device=True``) until you approve it with ``bridge.approve_device()``, after
#:   checking it is theirs (an email link, say). Pins live in the bridge's store: use a durable one
#:   (Redis) in production, or a function.
#: - a function ``(user_id, device) -> bool``: your own registry decides.
#: - ``"off"``: any signer is accepted. Receipts then stop replays and cross-site reuse but not
#:   forgery; use it only where the result gates nothing.
DevicePolicy = Union[Literal["first-use", "off"], PinDevices]

#: The store's atomic pin check: ``(subject, public_key, first_use) -> "known" | "pinned" | "unknown"``.
CheckDevice = Callable[[str, str, bool], Awaitable[str]]


def is_device_policy(value: object) -> bool:
    """True for ``"first-use"``, ``"off"`` or a callable."""
    return value in ("first-use", "off") if isinstance(value, str) else callable(value)


@dataclass(frozen=True)
class VerifyResult:
    """What ``bridge.verify()`` answers.

    ``ok``: the receipt is genuine, answers this challenge for this function, and the call
    succeeded. ``outcome``: how the call ended, once the signature verified (``None`` for a
    receipt that is not genuine). ``reason``: why ``ok`` is false. ``device``: the signing
    device, once the signature verified. ``unknown_device``: the receipt was refused only because
    this user has not pinned its signer (another computer, or a forgery); approve it with
    ``bridge.approve_device(user_id, device)`` once you have confirmed it is theirs, never on the
    page's word alone.
    """

    ok: bool
    outcome: str | None
    reason: str | None
    device: Mapping[str, Any] | None
    unknown_device: bool = False


@dataclass(frozen=True)
class ReceiptVerdict:
    """A :class:`VerifyResult`, plus the receipt when its signature verified."""

    ok: bool
    outcome: str | None
    reason: str | None
    device: Mapping[str, Any] | None
    receipt: dict[str, Any] | None = None
    unknown_device: bool = False

    def result(self) -> VerifyResult:
        return VerifyResult(
            ok=self.ok,
            outcome=self.outcome,
            reason=self.reason,
            device=self.device,
            unknown_device=self.unknown_device,
        )


def normalize_origin(origin: str) -> str:
    """``scheme://host[:port]`` of a URL, as a browser's ``URL.origin`` names it; the text itself
    when it is not an http(s) URL."""
    try:
        parts = urlsplit(origin.strip())
        scheme = parts.scheme.lower()
        host = parts.hostname
        port = parts.port
    except ValueError:
        return origin
    if scheme not in ("http", "https") or not host:
        return origin
    if ":" in host:
        host = f"[{host}]"
    default = 443 if scheme == "https" else 80
    return f"{scheme}://{host}" if port in (None, default) else f"{scheme}://{host}:{port}"


async def _device_pinned(
    devices: DevicePolicy, check_device: CheckDevice, subject: str, device: Mapping[str, Any]
) -> bool:
    """Whether ``device`` may sign for ``subject`` under the policy. A raising hook or store refuses."""
    try:
        if devices == "off":
            return True
        if devices == "first-use":
            return await check_device(subject, str(device["public_key"]), True) != "unknown"
        if not callable(devices):
            return False
        answer = devices(subject, device)
        if inspect.isawaitable(answer):
            answer = await answer
        return answer is True
    except Exception:
        return False


async def check_receipt(
    receipt: object,
    *,
    secret: bytes,
    now_seconds: int,
    challenge: str,
    key: str,
    require_success: bool,
    spend_nonce: Callable[[str, int], Awaitable[bool]],
    devices: DevicePolicy,
    check_device: CheckDevice,
    subject: str | None = None,
    nonce: str | None = None,
    origin: str | None = None,
    data: Any = UNSET,
    inputs: Any = UNSET,
    expected_inputs_hash: str | None = None,
) -> ReceiptVerdict:
    """Check every rule, in order.

    Signature (and key id), function key, challenge equality, the challenge itself (minted here,
    unexpired, for this key, subject and nonce), origin, the device pin (``devices``; under
    ``"first-use"`` through the store's atomic ``check_device``), single use, outcome, and the
    data hash. The challenge is spent once the receipt is proven to answer it, whatever the
    outcome, so a genuine receipt is never accepted twice. The same order as the Node twin's
    ``checkReceipt``.
    """
    signature = verify_receipt_signature(receipt)
    if not signature.ok or signature.receipt is None:
        return ReceiptVerdict(ok=False, outcome=None, reason=signature.reason, device=None)
    r = signature.receipt
    device = signature.device

    def refuse(reason: str) -> ReceiptVerdict:
        return ReceiptVerdict(ok=False, outcome=r["outcome"], reason=reason, device=device, receipt=r)

    if r["key"] != key:
        return refuse(f'the receipt is for "{r["key"]}", not "{key}"')
    if r["challenge"] is None:
        return refuse("the receipt carries no challenge")
    if r["challenge"] != challenge:
        return refuse("the receipt answers another challenge")

    reading = read_challenge(secret, challenge, now_seconds)
    if not reading.ok or reading.payload is None:
        return refuse(reading.reason or "the challenge is not valid")
    payload = reading.payload
    if payload["key"] != key:
        return refuse("the challenge was minted for another function")
    if subject is not None and payload["sub"] != subject:
        return refuse("the challenge was minted for another subject")
    if nonce is not None and payload["nonce"] != nonce:
        return refuse("the challenge was minted for another command")

    if origin is not None:
        expected = normalize_origin(origin)
        if r["origin"] != expected:
            return refuse(f"the receipt comes from {r['origin']}, not {expected}")

    if not await _device_pinned(devices, check_device, payload["sub"], dict(device or {})):
        return ReceiptVerdict(
            ok=False,
            outcome=r["outcome"],
            reason="the receipt was signed by a device this user has not registered",
            device=device,
            receipt=r,
            unknown_device=True,
        )

    ttl_ms = max(1_000, (payload["exp"] - now_seconds + 1) * 1_000)
    if not await spend_nonce(payload["nonce"], ttl_ms):
        return refuse("the challenge was already used")

    if require_success and r["outcome"] != "success":
        suffix = f" ({r['error_code']})" if r["error_code"] is not None else ""
        return refuse(f'the call ended "{r["outcome"]}"{suffix}')

    # What the call ran with: a page can't run the function with one account's sign-in and claim
    # another (``inputs``: what the server knows it must have run with; ``expected_inputs_hash``: the
    # hash of a command the server sent itself).
    if inputs is not UNSET or expected_inputs_hash is not None:
        got = r.get("inputs_hash")
        if not isinstance(got, str):
            return refuse("the receipt doesn't say what the call ran with")
        want = expected_inputs_hash
        if want is None:
            try:
                want = inputs_hash(challenge, inputs)
            except WritBridgeError as exc:
                return refuse(f"the inputs have no canonical form ({exc.message})")
        if want != got:
            return refuse("the call ran with other inputs than these")

    if data is not UNSET and r["outcome"] == "success":
        if r["data_hash"] is None:
            return refuse("the receipt carries no data hash")
        try:
            digest = data_hash(data)
        except WritBridgeError as exc:
            return refuse(f"the data has no canonical form ({exc.message})")
        if digest != r["data_hash"]:
            return refuse("the data does not match the receipt")

    return ReceiptVerdict(ok=True, outcome=r["outcome"], reason=None, device=device, receipt=r)
