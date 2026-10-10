"""Server-minted values (docs/browser-extension/CONTRACT.md §12.2): user tokens and challenges.

Both are ``base64url(canonical JSON) "." base64url(HMAC-SHA256(secret, first part as ASCII))``.
The Node twin mints the same bytes for the same input (``sdks/fixtures/bridge_tokens_golden.json``).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from .canonical import b64url_decode, b64url_encode, canonical_json
from .constants import MAX_SUBJECT_LENGTH, MAX_TOKEN_CHARS
from .errors import WritBridgeError

__all__ = [
    "ChallengeReading",
    "mint_challenge",
    "mint_user_token",
    "new_nonce",
    "open_token",
    "read_challenge",
    "read_user_token",
    "secret_bytes",
    "sign_token",
    "subject_of",
]

#: Bytes of randomness in a challenge nonce or a command id.
NONCE_BYTES: Final = 16

_MAX_SAFE_INTEGER: Final = 2**53 - 1


def _is_int(value: object) -> bool:
    """An integer that is not a bool (JSON ``true`` is not ``1``)."""
    return isinstance(value, int) and not isinstance(value, bool)


def _is_safe_int(value: object) -> bool:
    return _is_int(value) and -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER  # type: ignore[operator]


def secret_bytes(secret: str | bytes | bytearray) -> bytes:
    """The secret as bytes: a string is taken as UTF-8."""
    if isinstance(secret, str):
        return secret.encode("utf-8")
    if isinstance(secret, (bytes, bytearray)):
        return bytes(secret)
    raise WritBridgeError("CONFIG_INVALID", "The bridge secret must be text or bytes.")


def _mac(secret: bytes, body: str) -> str:
    return b64url_encode(hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest())


def sign_token(secret: str | bytes, payload: Mapping[str, Any]) -> str:
    """Sign any JSON object into the token format, over its RFC 8785 canonical JSON."""
    body = b64url_encode(canonical_json(payload))
    return f"{body}.{_mac(secret_bytes(secret), body)}"


def open_token(secret: str | bytes, token: object) -> dict[str, Any] | None:
    """The payload of a token this secret signed, or ``None``.

    ``None`` for a wrong shape, a non-canonical encoding, or a MAC that does not match (compared
    in constant time). Expiry and type are the caller's.
    """
    if not isinstance(token, str) or token == "" or len(token) > MAX_TOKEN_CHARS:
        return None
    body, dot, given = token.partition(".")
    if dot == "" or body == "" or "." in given:
        return None
    body_bytes = b64url_decode(body)
    if body_bytes is None or b64url_decode(given) is None:
        return None
    expected = _mac(secret_bytes(secret), body)
    if not hmac.compare_digest(given.encode("ascii"), expected.encode("ascii")):
        return None
    try:
        payload = json.loads(body_bytes.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def subject_of(value: object) -> str | None:
    """A user id or challenge subject as the string tokens carry, or ``None`` when it cannot be one.

    An integer becomes its decimal text (``42`` and ``"42"`` are the same user). Text is 1 to
    256 characters with no control characters: a subject ends up in logs and in the developer's
    own lookups.
    """
    if _is_int(value):
        return str(value) if _is_safe_int(value) else None
    if not isinstance(value, str):
        return None
    if value == "" or len(value) > MAX_SUBJECT_LENGTH:
        return None
    for char in value:
        code = ord(char)
        if code < 0x20 or code == 0x7F:
            return None
        if 0xD800 <= code <= 0xDFFF:  # a lone surrogate is not text
            return None
    return value


def new_nonce() -> str:
    """16 random bytes, base64url (22 characters). Used for challenge nonces and command ids."""
    return b64url_encode(_random_bytes(NONCE_BYTES))


def _random_bytes(count: int) -> bytes:
    return secrets.token_bytes(count)


def mint_user_token(secret: str | bytes, sub: str, exp: int) -> str:
    """Mint a user token (CONTRACT.md §12.2). ``exp`` in unix seconds."""
    return sign_token(secret, {"v": 1, "typ": "user", "sub": sub, "exp": exp})


def mint_challenge(secret: str | bytes, *, sub: str, key: str, exp: int, nonce: str | None = None) -> str:
    """Mint a challenge (CONTRACT.md §12.2). ``exp`` in unix seconds; ``nonce`` defaults to 16
    random bytes."""
    return sign_token(
        secret,
        {
            "v": 1,
            "typ": "challenge",
            "sub": sub,
            "key": key,
            "nonce": nonce if nonce is not None else new_nonce(),
            "exp": exp,
        },
    )


def read_user_token(secret: str | bytes, token: object, now_seconds: int) -> dict[str, Any] | None:
    """The payload when ``token`` is a valid, unexpired user token for this secret, else ``None``."""
    payload = open_token(secret, token)
    if payload is None:
        return None
    if not (_is_int(payload.get("v")) and payload.get("v") == 1) or payload.get("typ") != "user":
        return None
    sub = payload.get("sub")
    if not isinstance(sub, str) or subject_of(sub) is None:
        return None
    exp = payload.get("exp")
    if not _is_safe_int(exp) or exp <= now_seconds:  # type: ignore[operator]
        return None
    return {"v": 1, "typ": "user", "sub": sub, "exp": exp}


@dataclass(frozen=True)
class ChallengeReading:
    """A challenge read by :func:`read_challenge`: its payload, or why it was refused."""

    ok: bool
    payload: dict[str, Any] | None = None
    reason: str | None = None


def read_challenge(secret: str | bytes, challenge: object, now_seconds: int) -> ChallengeReading:
    """Read a challenge minted with this secret.

    Valid only with a matching MAC, ``typ: "challenge"``, a subject, a key, a nonce of 16 bytes,
    and an expiry after ``now_seconds``.
    """
    payload = open_token(secret, challenge)
    if payload is None:
        return ChallengeReading(False, reason="the challenge was not minted by this server")
    if not (_is_int(payload.get("v")) and payload.get("v") == 1) or payload.get("typ") != "challenge":
        return ChallengeReading(False, reason="the token is not a challenge")
    sub = payload.get("sub")
    if not isinstance(sub, str) or subject_of(sub) is None:
        return ChallengeReading(False, reason="the challenge has no valid subject")
    key = payload.get("key")
    if not isinstance(key, str) or key == "":
        return ChallengeReading(False, reason="the challenge names no function")
    nonce = payload.get("nonce")
    nonce_bytes = b64url_decode(nonce) if isinstance(nonce, str) else None
    if nonce_bytes is None or len(nonce_bytes) != NONCE_BYTES:
        return ChallengeReading(False, reason="the challenge nonce is malformed")
    exp = payload.get("exp")
    if not _is_safe_int(exp):
        return ChallengeReading(False, reason="the challenge has no valid expiry")
    if exp <= now_seconds:  # type: ignore[operator]
        return ChallengeReading(False, reason="the challenge expired")
    return ChallengeReading(
        True,
        payload={"v": 1, "typ": "challenge", "sub": sub, "key": key, "nonce": nonce, "exp": exp},
    )
