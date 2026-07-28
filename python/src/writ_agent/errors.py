"""Error model for the Writ agent SDK (DESIGN.md §5).

Three error kinds, one shared base:

- :class:`WritApiError` — the daemon answered with a non-2xx HTTP response.
- :class:`WritConnectionError` — network failure / timeout (daemon down mid-session).
- :class:`WritDiscoveryError` — no live daemon found at construction.

Plus :class:`WritTimeoutError`, a small deliberate extension raised by
``workflows.run_and_wait`` when the overall ``wait_timeout`` deadline elapses
(the run itself is *not* cancelled).
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Any

__all__ = [
    "WritError",
    "WritApiError",
    "WritConnectionError",
    "WritDiscoveryError",
    "WritTimeoutError",
    "WritApiKeyRequiredError",
    "WritInsufficientCreditsError",
    "WritRateLimitedError",
]

#: Maximum length kept from a plain-text error body (DESIGN §5: "truncate to ~500 chars").
_TEXT_TRUNCATE = 500

#: Status → stable machine code, used when the body carries no ``code`` of its own.
_STATUS_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "unprocessable",
    429: "rate_limited",
}


class WritError(Exception):
    """Base class for every error raised by the Writ agent SDK."""


class WritApiError(WritError):
    """A non-2xx HTTP response from the daemon.

    Attributes:
        status: HTTP status code (int).
        code: stable machine code — the body's ``code`` field when present,
            otherwise derived from the status (``400→bad_request`` … ``5xx→internal``).
        message: human-readable message — resolved from the JSON body as
            ``error`` → ``detail`` → ``message`` → HTTP status text; for a
            plain-text body, the raw text truncated to ~500 chars.
        body: the parsed JSON body (any JSON value) or the raw text.
    """

    def __init__(self, status: int, code: str, message: str, body: Any) -> None:
        super().__init__(f"HTTP {status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.body = body


class WritApiKeyRequiredError(WritApiError):
    """A whole-site crawl was requested on the keyless cloud tier (no API key).

    Crawl is metered and always needs a credential — pass ``api_key`` (or set
    ``WRIT_API_KEY``). Keyless access covers ``scrape`` and ``map`` only. Raised by
    ``Cloud.crawl`` / ``AsyncCloud.crawl``. HTTP 402 ``api_key_required``.
    """


class WritInsufficientCreditsError(WritApiError):
    """Crawl-page allotment spent AND the wallet can't cover the call. HTTP 402."""


class WritRateLimitedError(WritApiError):
    """The keyless daily allowance (requests/day or pages/day) is exhausted. HTTP 429.

    Extra attributes: ``reset_at`` (ISO time the allowance refills),
    ``requests_remaining`` and ``pages_remaining`` when the server reports them.
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        body: Any,
        *,
        reset_at: Any = None,
        requests_remaining: Any = None,
        pages_remaining: Any = None,
    ) -> None:
        super().__init__(status, code, message, body)
        self.reset_at = reset_at
        self.requests_remaining = requests_remaining
        self.pages_remaining = pages_remaining


class WritConnectionError(WritError):
    """Network failure or timeout talking to the daemon (daemon down mid-session)."""


class WritDiscoveryError(WritError):
    """No live Writ agent could be found at client construction (DESIGN §4)."""


class WritTimeoutError(WritError):
    """``run_and_wait`` exceeded its ``wait_timeout``. The run is NOT cancelled."""


class WritRunTimeoutError(WritApiError):
    """A ``run(..., wait=True)`` call whose SERVER-side budget expired (HTTP 504).

    Not a failure of the run: it is still executing and ``run_id`` still addresses it —
    poll ``client.runs.get(run_id)``, stream ``client.runs.events(run_id)``, or
    ``client.runs.cancel(run_id)``. Retrying the call would start a SECOND run, which is
    exactly what carrying the id here is meant to prevent.

    Attributes:
        run_id: the still-running run.
    """

    def __init__(self, status: int, code: str, message: str, body: Any, run_id: int) -> None:
        super().__init__(status, code, message, body)
        self.run_id = run_id


def code_for_status(status: int) -> str:
    """Derive the stable machine code for a status with no body-supplied ``code``."""
    if status in _STATUS_CODES:
        return _STATUS_CODES[status]
    if status >= 500:
        return "internal"
    return f"http_{status}"


# Statuses whose stdlib reason phrase is NOT stable across Python versions.
#
# CPython 3.13 renamed several phrases to follow RFC 9110: 422 "Unprocessable
# Entity" → "Unprocessable Content", 413 "Request Entity Too Large" → "Content
# Too Large", 414 "Request-URI Too Long" → "URI Too Long". Delegating to
# HTTPStatus therefore made the fallback error message depend on the user's
# interpreter minor version — and disagree with the Go and Rust SDKs, which
# both produce the older spelling (Go via net/http.StatusText).
#
# DESIGN.md §5 is a cross-language contract: the same response must produce the
# same message everywhere. Pin the affected phrases rather than inherit a table
# that upstream is free to keep changing.
_PINNED_STATUS_TEXT = {
    413: "Request Entity Too Large",
    414: "Request-URI Too Long",
    422: "Unprocessable Entity",
}


def _status_text(status: int) -> str:
    pinned = _PINNED_STATUS_TEXT.get(status)
    if pinned is not None:
        return pinned
    try:
        return HTTPStatus(status).phrase
    except ValueError:
        return f"HTTP {status}"


def api_error_from_response(response: Any) -> WritApiError:
    """Build a :class:`WritApiError` from an ``httpx.Response`` (already read).

    Resolution rules (DESIGN §5):
    - JSON object body: ``message`` = ``error`` → ``detail`` → ``message`` →
      status text; ``code`` = body ``code`` → status-derived.
    - anything else (plain-text axum rejections, non-object JSON): ``message`` =
      raw text truncated to ~500 chars, ``code`` = status-derived.
    """
    status = response.status_code
    body: Any
    try:
        body = response.json()
    except ValueError:
        body = response.text

    code = code_for_status(status)
    message: str | None = None
    if isinstance(body, dict):
        raw_code = body.get("code")
        if isinstance(raw_code, str) and raw_code:
            code = raw_code
        for key in ("error", "detail", "message"):
            val = body.get(key)
            if val is None:
                continue
            message = val if isinstance(val, str) else str(val)
            break
        if message is None:
            message = _status_text(status)
    else:
        text = body if isinstance(body, str) else str(body)
        text = text.strip()
        if len(text) > _TEXT_TRUNCATE:
            text = text[:_TEXT_TRUNCATE]
        message = text or _status_text(status)

    return WritApiError(status, code, message, body)
