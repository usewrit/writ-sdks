"""Run tokens for linked workflows in ``token`` mode (docs/browser-extension/CONTRACT.md §11
"Token mode").

A publication in ``token`` mode hands its recipe only to calls that carry a run token your backend
minted. Your page's ``getRunToken`` fetches one from a route of yours; the visitor's Writ passes it
to Writ Cloud, which verifies it. Neither the extension nor Writ desktop stores it.

A run token is a JWT, HS256:

- the HMAC key is the UTF-8 bytes of the publication's secret key, ``wsk_`` prefix included;
- header ``{"alg":"HS256","typ":"JWT"}``, exactly these keys in this order;
- claims ``{"pub","iat","exp","sub"?}``, exactly this key order, ``sub`` left out when there is
  none, ``exp = iat + ttl_seconds`` with ``ttl_seconds`` at most 3600;
- both compact JSON (no whitespace), UTF-8, base64url without padding; the signature is
  HMAC-SHA256 over the ASCII bytes of ``header.claims``.

The Node twin (``mintRunToken`` in ``@usewrit/server``) mints the same bytes for the same input
(``sdks/fixtures/run_token_golden.json``). Standard library only.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from typing import Any, Final

from . import _clock
from ._json import describe_value
from .constants import (
    DEFAULT_RUN_TOKEN_TTL_SECONDS,
    MAX_RUN_TOKEN_TTL_SECONDS,
    MAX_SUBJECT_LENGTH,
    PUBLICATION_ID_PATTERN,
    SECRET_KEY_PREFIX,
)
from .errors import WritBridgeError

__all__ = ["mint_run_token"]

#: The JOSE header, as signed: this exact text.
_HEADER_JSON: Final = '{"alg":"HS256","typ":"JWT"}'

#: A secret key as Writ Cloud shows it: ``wsk_`` and printable ASCII, no spaces or line breaks.
_SECRET_KEY_SHAPE: Final = re.compile(r"wsk_[\x21-\x7e]+")

_MAX_SAFE_INTEGER: Final = 2**53 - 1


def _is_int(value: object) -> bool:
    """An integer that is not a bool (``True`` is not ``1`` here)."""
    return isinstance(value, int) and not isinstance(value, bool)


def mint_run_token(
    secret_key: str,
    publication: str,
    sub: str | int | None = None,
    ttl_seconds: int = DEFAULT_RUN_TOKEN_TTL_SECONDS,
    *,
    issued_at: int | None = None,
) -> str:
    """Mint a run token for a linked workflow in ``token`` mode (CONTRACT.md §11): what your route
    answers the page's ``getRunToken``.

    ::

        @app.get("/api/writ-token", response_class=PlainTextResponse)
        def writ_token(user: User = Depends(current_user)) -> str:
            return mint_run_token(os.environ["WRIT_PUBLICATION_SECRET"], "pub_...", sub=user.id)

    ``sub`` is who the token is for, usually your signed-in user's id: text of 1 to 256
    characters (UTF-16 units, as the Node twin counts) without control characters, or an integer
    (sent as its decimal text). ``ttl_seconds`` is 1 to 3600. ``issued_at`` is ``iat`` in unix
    seconds, now by default (for tests and replays of a fixed clock).

    Raises a :class:`~usewrit.errors.WritBridgeError`: ``CONFIG_INVALID`` when ``secret_key`` is
    not a secret key (``wsk_...``, no spaces or line breaks; the message never repeats it),
    ``INPUT_INVALID`` for a ``publication`` or ``sub`` that cannot be one, and ``BAD_REQUEST`` for
    a ``ttl_seconds`` outside 1 to 3600 or an ``issued_at`` that is not whole seconds.
    """
    key = _check_secret_key(secret_key)
    if not isinstance(publication, str) or PUBLICATION_ID_PATTERN.fullmatch(publication) is None:
        raise WritBridgeError(
            "INPUT_INVALID",
            'publication must be the publication\'s id, "pub_" and 22 letters or digits; '
            f"got {describe_value(publication)}.",
        )
    if not _is_int(ttl_seconds) or not 1 <= ttl_seconds <= MAX_RUN_TOKEN_TTL_SECONDS:
        raise WritBridgeError(
            "BAD_REQUEST",
            f"ttl_seconds must be a whole number of seconds from 1 to {MAX_RUN_TOKEN_TTL_SECONDS}: Writ Cloud "
            f"refuses a run token that lives longer; got {describe_value(ttl_seconds)}.",
        )
    iat = _clock.now_seconds() if issued_at is None else issued_at
    if not _is_int(iat) or not 0 <= iat <= _MAX_SAFE_INTEGER:
        raise WritBridgeError("BAD_REQUEST", f"issued_at must be unix seconds, a whole number; got {describe_value(iat)}.")

    # The key order is part of the signed bytes: pub, iat, exp, then sub.
    claims: dict[str, Any] = {"pub": publication, "iat": iat, "exp": iat + ttl_seconds}
    if sub is not None:
        claims["sub"] = _subject(sub)

    signing_input = f"{_b64url(_HEADER_JSON)}.{_b64url(_compact(claims))}"
    signature = hmac.new(key.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode('ascii')}"


def _check_secret_key(secret_key: object) -> str:
    """The secret key, or ``CONFIG_INVALID``. Never echoes the value: it is a secret."""
    if not isinstance(secret_key, str) or not secret_key.startswith(SECRET_KEY_PREFIX):
        raise WritBridgeError(
            "CONFIG_INVALID",
            f'mint_run_token() needs the publication\'s secret key, which starts with "{SECRET_KEY_PREFIX}" '
            "(Writ Cloud shows it once, when you publish or rotate it). Never the publishable key (wpk_).",
        )
    if _SECRET_KEY_SHAPE.fullmatch(secret_key) is None:
        raise WritBridgeError(
            "CONFIG_INVALID",
            "The secret key holds spaces, line breaks or other characters a secret key never has: "
            "check how it is read from the environment.",
        )
    return secret_key


def _subject(value: object) -> str:
    """``sub`` as the token carries it: text, without control characters or lone surrogates."""
    text: object = str(value) if _is_int(value) and abs(value) <= _MAX_SAFE_INTEGER else value  # type: ignore[arg-type]
    if (
        not isinstance(text, str)
        or text == ""
        or len(text.encode("utf-16-le", "surrogatepass")) // 2 > MAX_SUBJECT_LENGTH
        or any(ord(char) < 0x20 or ord(char) == 0x7F or 0xD800 <= ord(char) <= 0xDFFF for char in text)
    ):
        raise WritBridgeError(
            "INPUT_INVALID",
            f"sub must be text of 1 to {MAX_SUBJECT_LENGTH} characters without control characters, or an integer; "
            f"got {describe_value(value)}.",
        )
    return text


def _compact(value: dict[str, Any]) -> str:
    """Compact JSON in insertion order (never sorted), non-ASCII as is: what ``JSON.stringify`` writes."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _b64url(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).rstrip(b"=").decode("ascii")
