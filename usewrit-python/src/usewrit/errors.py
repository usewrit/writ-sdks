"""Error model: one class, :class:`WritBridgeError`, carrying a stable code.

The codes are CONTRACT.md §12.4's, plus every code the visitor's side can answer (CONTRACT.md,
"Error codes"). They are the same set, with the same HTTP statuses on the page channel, as the
Node twin's ``WritBridgeError``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from types import MappingProxyType
from typing import Any, Final, Literal

__all__ = [
    "BRIDGE_ERROR_CODES",
    "VISITOR_ERROR_CODES",
    "WRIT_BRIDGE_ERROR_CODES",
    "WritBridgeError",
    "WritBridgeErrorCode",
    "default_message",
    "http_status_of",
    "is_writ_bridge_error",
    "is_writ_bridge_error_code",
    "normalize_visitor_code",
]

WritBridgeErrorCode = Literal[
    # Raised by the server bridge itself.
    "WRIT_REQUIRED",
    "USER_OFFLINE",
    "RESULT_UNVERIFIED",
    "CLOUD_NOT_CONFIGURED",
    "CLOUD_UNAVAILABLE",
    "QUOTA_EXCEEDED",
    "CONFIG_INVALID",
    # A call on the visitor's computer can end with these.
    "NOT_INSTALLED",
    "DESKTOP_MISSING",
    "DESKTOP_OUTDATED",
    "DAEMON_UNAVAILABLE",
    "VAULT_LOCKED",
    "CONSENT_DENIED",
    "NOT_GRANTED",
    "GRANT_STALE",
    "WRITE_NEEDS_CONFIRM",
    "INPUT_INVALID",
    "RATE_LIMITED",
    "LAN_NOT_ALLOWED",
    "RUN_FAILED",
    "CANCELLED",
    "TIMEOUT",
    "RESULT_TOO_LARGE",
    "BAD_REQUEST",
    "ORIGIN_NOT_ALLOWED",
    "INTERNAL",
    # Linked workflows (CONTRACT.md §11): the visitor's Writ could not fetch the recipe.
    "RECIPE_UNAVAILABLE",
    "PUBLICATION_REVOKED",
]

_DEFAULT_MESSAGES: Final[Mapping[str, str]] = MappingProxyType(
    {
        "WRIT_REQUIRED": "This function runs only on the user's own computer, and the user has not set Writ up for this site.",
        "USER_OFFLINE": "None of the user's pages is connected right now.",
        "RESULT_UNVERIFIED": "The result did not come with a valid Writ receipt for this call.",
        "CLOUD_NOT_CONFIGURED": "This function has no Writ Cloud workflow mapped, or WRIT_API_KEY is not set.",
        "CLOUD_UNAVAILABLE": "Writ Cloud could not be reached.",
        "QUOTA_EXCEEDED": "The Writ Cloud plan behind WRIT_API_KEY is out of runs, or of linked workflow deliveries.",
        "CONFIG_INVALID": "The bridge configuration is invalid.",
        "NOT_INSTALLED": "The Writ browser extension is not installed in the user's browser.",
        "DESKTOP_MISSING": "Writ desktop is not installed on the user's computer.",
        "DESKTOP_OUTDATED": "The user's Writ extension and Writ desktop speak different protocol versions.",
        "DAEMON_UNAVAILABLE": "Writ could not reach or start its engine on the user's computer.",
        "VAULT_LOCKED": "The user's Writ vault is locked.",
        "CONSENT_DENIED": "The user declined.",
        "NOT_GRANTED": "This site has no permission for that function.",
        "GRANT_STALE": "The function changed since the user approved it.",
        "WRITE_NEEDS_CONFIRM": "This change needs the user's confirmation.",
        "INPUT_INVALID": "The inputs were refused.",
        "RATE_LIMITED": "Too many calls. Wait, then try again.",
        "LAN_NOT_ALLOWED": "The run needed a local-network address the owner has not approved.",
        "RUN_FAILED": "The run failed.",
        "CANCELLED": "The call was cancelled.",
        "TIMEOUT": "The call took too long.",
        "RESULT_TOO_LARGE": "The result is larger than Writ returns to a website.",
        "BAD_REQUEST": "The request was malformed.",
        "ORIGIN_NOT_ALLOWED": "Writ only answers https pages, in the top frame.",
        "INTERNAL": "Writ failed unexpectedly.",
        "RECIPE_UNAVAILABLE": "The user's Writ could not get the linked workflow's recipe from Writ Cloud.",
        "PUBLICATION_REVOKED": "The linked workflow was withdrawn from Writ Cloud.",
    }
)

#: Codes the server bridge itself raises.
BRIDGE_ERROR_CODES: Final[tuple[str, ...]] = (
    "WRIT_REQUIRED",
    "USER_OFFLINE",
    "RESULT_UNVERIFIED",
    "CLOUD_NOT_CONFIGURED",
    "CLOUD_UNAVAILABLE",
    "QUOTA_EXCEEDED",
    "CONFIG_INVALID",
)

#: Codes a call on the visitor's computer can end with.
VISITOR_ERROR_CODES: Final[tuple[str, ...]] = tuple(
    code for code in _DEFAULT_MESSAGES if code not in BRIDGE_ERROR_CODES
)

#: Every code a :class:`WritBridgeError` can carry.
WRIT_BRIDGE_ERROR_CODES: Final[frozenset[str]] = frozenset(_DEFAULT_MESSAGES)

#: The HTTP status the page channel answers each code with (anything else is 500).
_HTTP_STATUS: Final[Mapping[str, int]] = MappingProxyType(
    {
        "BAD_REQUEST": 400,
        "INPUT_INVALID": 400,
        "QUOTA_EXCEEDED": 402,
        "NOT_GRANTED": 403,
        "WRIT_REQUIRED": 403,
        "RATE_LIMITED": 429,
        "RUN_FAILED": 502,
        "CLOUD_UNAVAILABLE": 503,
        "CLOUD_NOT_CONFIGURED": 503,
        "CONFIG_INVALID": 503,
        "TIMEOUT": 504,
    }
)

_CODE_SHAPE: Final = re.compile(r"[A-Z][A-Z0-9_]{0,63}")


class WritBridgeError(Exception):
    """Every failure this library reports: a stable ``code`` plus a readable ``message``.

    Branch on ``code``, never on ``message``. ``details`` carries structured context when there
    is any (the receipt of a failed call, the Writ Cloud task id, an HTTP status), never secrets.
    """

    code: str
    message: str
    details: Mapping[str, Any]

    def __init__(
        self,
        code: str,
        message: str | None = None,
        *,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        if code not in WRIT_BRIDGE_ERROR_CODES:
            raise ValueError(f"{code!r} is not a Writ Bridge error code")
        text = message if isinstance(message, str) and message != "" else _DEFAULT_MESSAGES[code]
        super().__init__(text)
        self.code = code
        self.message = text
        self.details = MappingProxyType(dict(details or {}))

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"

    def __repr__(self) -> str:
        return f"WritBridgeError({self.code!r}, {self.message!r})"

    def to_dict(self) -> dict[str, dict[str, str]]:
        """The page channel's error envelope: ``{"error": {"code", "message"}}``."""
        return {"error": {"code": self.code, "message": self.message}}


def is_writ_bridge_error_code(value: object) -> bool:
    """True when ``value`` is one of the codes above."""
    return isinstance(value, str) and value in WRIT_BRIDGE_ERROR_CODES


def is_writ_bridge_error(error: object, code: str | Iterable[str] | None = None) -> bool:
    """True when ``error`` is a :class:`WritBridgeError`, optionally with one of the given codes.

    ::

        if is_writ_bridge_error(e, "USER_OFFLINE"):
            return ask_user_to_open_the_app()
        if is_writ_bridge_error(e, ("NOT_GRANTED", "GRANT_STALE")):
            return show_setup_help()
    """
    if not isinstance(error, WritBridgeError):
        return False
    if code is None:
        return True
    if isinstance(code, str):
        return error.code == code
    return error.code in set(code)


def default_message(code: str) -> str:
    """The built-in message for a code."""
    return _DEFAULT_MESSAGES[code]


def http_status_of(code: str) -> int:
    """The HTTP status for a code on the page channel."""
    return _HTTP_STATUS.get(code, 500)


def normalize_visitor_code(raw: object) -> str:
    """A code reported by the visitor's side, as a known code.

    ``PROTOCOL_MISMATCH`` is the host's spelling of ``DESKTOP_OUTDATED``; anything else unknown
    becomes ``INTERNAL``.
    """
    if isinstance(raw, str) and raw in WRIT_BRIDGE_ERROR_CODES:
        return raw
    if raw == "PROTOCOL_MISMATCH":
        return "DESKTOP_OUTDATED"
    return "INTERNAL"


def is_code_shaped(raw: object) -> bool:
    """True for an upper-case code a page may report (``[A-Z][A-Z0-9_]{0,63}``)."""
    return isinstance(raw, str) and _CODE_SHAPE.fullmatch(raw) is not None
