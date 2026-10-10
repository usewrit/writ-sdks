"""Signed Writ receipts (docs/browser-extension/CONTRACT.md §12.1).

The Writ engine on the visitor's computer signs, with an Ed25519 key of its own per site, what a
call did: which site and function, the server's challenge, the outcome, and a hash of the data
the page received. This module checks that a receipt is well formed and that its signature is
genuine; binding it to a challenge, a function and data is :mod:`usewrit.verify`'s job.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Literal

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .canonical import b64url_decode, canonical_bytes, sha256_hex
from .constants import MAX_CHALLENGE_CHARS
from .errors import WritBridgeError

__all__ = [
    "OUTCOMES",
    "ReceiptOutcome",
    "ReceiptParse",
    "ReceiptSignatureCheck",
    "kid_of",
    "parse_receipt",
    "receipt_signing_bytes",
    "verify_receipt_signature",
]

ReceiptOutcome = Literal["success", "failed", "error", "timeout", "cancelled"]

#: How a call on the visitor's computer can end.
OUTCOMES: Final[frozenset[str]] = frozenset({"success", "failed", "error", "timeout", "cancelled"})

_HEX64: Final = re.compile(r"[0-9a-f]{64}")
_HEX16: Final = re.compile(r"[0-9a-f]{16}")
_MAX_SAFE_INTEGER: Final = 2**53 - 1


@dataclass(frozen=True)
class ReceiptParse:
    """A parsed receipt (``receipt``), or why it is not one (``reason``)."""

    ok: bool
    receipt: dict[str, Any] | None = None
    reason: str | None = None


@dataclass(frozen=True)
class ReceiptSignatureCheck:
    """The outcome of :func:`verify_receipt_signature`."""

    ok: bool
    receipt: dict[str, Any] | None = None
    device: dict[str, Any] | None = field(default=None)
    reason: str | None = None


def _nullable_text(value: object) -> bool:
    return value is None or isinstance(value, str)


def _safe_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER


def _refused(reason: str) -> ReceiptParse:
    return ReceiptParse(False, reason=reason)


def parse_receipt(value: object) -> ReceiptParse:
    """Check a receipt's shape.

    Every field present with its type, the outcome known, the hashes and keys well formed.
    Fields Writ does not know are left in place (the signature covers them). A receipt given as
    JSON text is parsed first.
    """
    if isinstance(value, (str, bytes, bytearray)):
        try:
            value = json.loads(value)
        except (UnicodeDecodeError, ValueError):
            return _refused("the receipt is not JSON")
    if not isinstance(value, Mapping):
        return _refused("the receipt is not an object")
    r: dict[str, Any] = dict(value)
    version = r.get("v")
    if not (isinstance(version, int) and not isinstance(version, bool) and version == 1):
        return _refused("the receipt version is not 1")
    if not isinstance(r.get("origin"), str) or r["origin"] == "":
        return _refused("the receipt has no origin")
    if not isinstance(r.get("key"), str) or r["key"] == "":
        return _refused("the receipt has no function key")
    if "package" not in r or not _nullable_text(r["package"]):
        return _refused("the receipt package is malformed")
    if "function" not in r or not _nullable_text(r["function"]):
        return _refused("the receipt function is malformed")
    challenge = r.get("challenge", ...)
    if challenge is ... or not _nullable_text(challenge) or (
        isinstance(challenge, str) and len(challenge) > MAX_CHALLENGE_CHARS
    ):
        return _refused("the receipt challenge is malformed")
    if not isinstance(r.get("outcome"), str) or r["outcome"] not in OUTCOMES:
        return _refused("the receipt outcome is unknown")
    if "error_code" not in r or not _nullable_text(r["error_code"]):
        return _refused("the receipt error code is malformed")
    digest = r.get("data_hash", ...)
    if not (digest is None or (isinstance(digest, str) and _HEX64.fullmatch(digest) is not None)):
        return _refused("the receipt data hash is malformed")
    bound = r.get("inputs_hash", ...)
    if not (bound is ... or (isinstance(bound, str) and _HEX64.fullmatch(bound) is not None)):
        return _refused("the receipt inputs hash is malformed")
    for name in ("run_id", "started_at", "finished_at"):
        if not _safe_int(r.get(name)):
            return _refused(f"the receipt {name} is not an integer")
    writ = r.get("writ")
    if not isinstance(writ, Mapping) or not isinstance(writ.get("version"), str):
        return _refused("the receipt has no Writ version")
    device = r.get("device")
    if not isinstance(device, Mapping):
        return _refused("the receipt has no device")
    if device.get("alg") != "Ed25519":
        return _refused("the receipt key is not Ed25519")
    kid = device.get("kid")
    if not isinstance(kid, str) or _HEX16.fullmatch(kid) is None:
        return _refused("the receipt key id is malformed")
    public_key = device.get("public_key")
    if not isinstance(public_key, str):
        return _refused("the receipt has no public key")
    raw_key = b64url_decode(public_key)
    if raw_key is None or len(raw_key) != 32:
        return _refused("the receipt public key is not 32 bytes")
    if not isinstance(device.get("hardware"), bool):
        return _refused("the receipt hardware flag is malformed")
    sig = r.get("sig")
    if not isinstance(sig, str):
        return _refused("the receipt is not signed")
    raw_sig = b64url_decode(sig)
    if raw_sig is None or len(raw_sig) != 64:
        return _refused("the receipt signature is not 64 bytes")
    return ReceiptParse(True, receipt=r)


def kid_of(public_key: bytes) -> str:
    """``kid`` of a raw public key: the first 16 hex characters of its sha256."""
    return sha256_hex(bytes(public_key))[:16]


def receipt_signing_bytes(receipt: Mapping[str, Any]) -> bytes:
    """The exact bytes a receipt's signature covers: canonical JSON of the receipt without ``sig``."""
    return canonical_bytes({name: item for name, item in receipt.items() if name != "sig"})


def verify_receipt_signature(value: object) -> ReceiptSignatureCheck:
    """Check a receipt's shape, that ``device.kid`` names ``device.public_key``, and its Ed25519
    signature over the canonical bytes.

    Any one-field change fails. This says the receipt is what some Writ install signed; it does
    not say which call it answers (see ``bridge.verify()``).
    """
    parsed = parse_receipt(value)
    if not parsed.ok or parsed.receipt is None:
        return ReceiptSignatureCheck(False, reason=parsed.reason)
    receipt = parsed.receipt
    device = receipt["device"]
    public_key = b64url_decode(device["public_key"])
    signature = b64url_decode(receipt["sig"])
    assert public_key is not None and signature is not None  # parse_receipt checked both
    if kid_of(public_key) != device["kid"]:
        return ReceiptSignatureCheck(False, reason="the receipt key id does not match its public key")
    try:
        message = receipt_signing_bytes(receipt)
    except WritBridgeError:
        return ReceiptSignatureCheck(False, reason="the receipt has no canonical form")
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
    except (InvalidSignature, ValueError):
        return ReceiptSignatureCheck(False, reason="the receipt signature does not verify")
    return ReceiptSignatureCheck(
        True,
        receipt=receipt,
        device={
            "kid": device["kid"],
            "alg": "Ed25519",
            "public_key": device["public_key"],
            "hardware": device["hardware"],
        },
    )
