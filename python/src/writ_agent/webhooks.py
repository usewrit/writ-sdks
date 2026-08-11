"""Verify (and sign) Writ webhook deliveries.

Writ signs every outbound delivery twice::

    X-Writ-Signature-V1  HMAC-SHA256 over "{timestamp}." + raw body  <- verify this
    X-Writ-Signature     HMAC-SHA256 over the raw body alone         <- legacy

V1 binds the timestamp into the MAC, so a captured delivery stops being
replayable the moment its timestamp goes stale. The body-only signature is still
sent for handlers written before V1 and is accepted here as an opt-in fallback,
but it CANNOT support a freshness check — nothing ties it to a point in time.

Typical Flask/FastAPI handler::

    from writ_agent.webhooks import verify_webhook, WritWebhookVerificationError

    @app.post("/hooks/writ")
    async def hook(request: Request):
        body = await request.body()          # RAW bytes — see verify_webhook
        try:
            verify_webhook(request.headers, body, os.environ["WRIT_WEBHOOK_SECRET"])
        except WritWebhookVerificationError:
            raise HTTPException(401, "bad signature")
        ...
"""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any, Mapping, Optional

from .errors import WritError

__all__ = [
    "DEFAULT_TOLERANCE_SECONDS",
    "SIGNATURE_HEADER",
    "SIGNATURE_V1_HEADER",
    "TIMESTAMP_HEADER",
    "WritWebhookVerificationError",
    "sign_webhook_request",
    "verify_webhook",
]

SIGNATURE_V1_HEADER = "X-Writ-Signature-V1"
SIGNATURE_HEADER = "X-Writ-Signature"
TIMESTAMP_HEADER = "X-Writ-Timestamp"

#: Freshness window for a V1 signature, matching the server's own ±5 minutes.
DEFAULT_TOLERANCE_SECONDS = 300.0


class WritWebhookVerificationError(WritError):
    """A delivery failed verification.

    Treat ANY instance as "do not act on this payload" — ``reason`` is for
    logging and metrics, not for deciding to proceed. Values: ``no_secret``,
    ``no_signature``, ``bad_timestamp``, ``stale``, ``signature_mismatch``.
    """

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def _header(headers: Any, name: str) -> Optional[str]:
    """Read one header from a Mapping, a Starlette/Werkzeug Headers, or a dict
    with any casing. Header names are case-insensitive on the wire and every
    framework normalises them differently."""
    getter = getattr(headers, "get", None)
    if callable(getter):
        value = getter(name)
        if value is None:
            value = getter(name.lower())
        if value is not None:
            return value if isinstance(value, str) else str(value)
    if isinstance(headers, Mapping):
        lowered = name.lower()
        for key, value in headers.items():
            if str(key).lower() == lowered:
                return value if isinstance(value, str) else str(value)
    return None


def _to_bytes(body: Any) -> bytes:
    if isinstance(body, bytes):
        return body
    if isinstance(body, bytearray):
        return bytes(body)
    if isinstance(body, str):
        return body.encode("utf-8")
    raise TypeError(f"webhook body must be bytes or str, got {type(body).__name__}")


def _mac_hex(secret: str, signed: bytes) -> str:
    return hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()


def _strip(signature: str) -> str:
    sig = signature.strip()
    return (sig[7:] if sig.startswith("sha256=") else sig).lower()


def _check_freshness(raw_ts: str, tolerance: float, now: float) -> None:
    if tolerance < 0:
        return
    try:
        stamped = float(raw_ts)
    except (TypeError, ValueError):
        raise WritWebhookVerificationError(
            "bad_timestamp", f"{TIMESTAMP_HEADER} is not a unix timestamp: {raw_ts!r}"
        ) from None
    # Absolute skew: a delivery timestamped in the FUTURE is as suspect as a
    # stale one — it means forged headers or a badly wrong clock.
    drift = abs(now - stamped)
    if drift > tolerance:
        raise WritWebhookVerificationError(
            "stale",
            f"webhook timestamp {raw_ts} is {drift:.0f}s away from now "
            f"(tolerance {tolerance:.0f}s) — treat it as a replay",
        )


def verify_webhook(
    headers: Any,
    body: Any,
    secret: str,
    *,
    tolerance: float = DEFAULT_TOLERANCE_SECONDS,
    allow_legacy_body_only: bool = False,
    now: Optional[float] = None,
) -> None:
    """Authenticate an outbound Writ delivery. Returns None; raises on failure.

    ``body`` MUST be the exact bytes received. Parsing and re-serialising first
    changes them (key order, spacing, number formatting) and the MAC will not
    match — this is the single most common cause of a "wrong secret" report.

    Comparison is constant-time, so a caller cannot learn the expected MAC by
    timing repeated attempts.

    ``allow_legacy_body_only`` accepts a delivery carrying ONLY the body-only
    ``X-Writ-Signature``. Off by default: that signature cannot be checked for
    freshness, so accepting it silently reintroduces unlimited replay. Turn it on
    only while migrating a handler that predates V1.
    """
    if not secret:
        raise WritWebhookVerificationError("no_secret", "webhook secret is empty")
    payload = _to_bytes(body)
    clock = time.time() if now is None else now

    v1 = _header(headers, SIGNATURE_V1_HEADER)
    if v1 and v1.strip():
        raw_ts = _header(headers, TIMESTAMP_HEADER)
        if not raw_ts or not raw_ts.strip():
            raise WritWebhookVerificationError(
                "bad_timestamp",
                f"a {SIGNATURE_V1_HEADER} was present but {TIMESTAMP_HEADER} was missing",
            )
        raw_ts = raw_ts.strip()
        _check_freshness(raw_ts, tolerance, clock)
        expected = _mac_hex(secret, raw_ts.encode("utf-8") + b"." + payload)
        if not hmac.compare_digest(_strip(v1), expected):
            raise WritWebhookVerificationError(
                "signature_mismatch",
                "webhook signature does not match — treat this request as hostile",
            )
        return

    legacy = _header(headers, SIGNATURE_HEADER)
    if not legacy or not legacy.strip():
        raise WritWebhookVerificationError(
            "no_signature", "request carries no Writ webhook signature"
        )
    if not allow_legacy_body_only:
        raise WritWebhookVerificationError(
            "no_signature",
            f"only the body-only {SIGNATURE_HEADER} was present. It cannot be checked for "
            "freshness, so it is refused by default — pass allow_legacy_body_only=True "
            "while migrating",
        )
    if not hmac.compare_digest(_strip(legacy), _mac_hex(secret, payload)):
        raise WritWebhookVerificationError(
            "signature_mismatch",
            "webhook signature does not match — treat this request as hostile",
        )


def sign_webhook_request(body: Any, secret: str) -> dict[str, str]:
    """Headers for an INBOUND call to a Writ hook (``POST /api/webhooks/hook/{token}``).

    That route requires a fresh signed timestamp: the MAC covers
    ``"{timestamp}." + body``, and an unsigned or stale call is rejected 401.

    ::

        body = json.dumps({"sku": "SKU-123"}).encode()
        headers = sign_webhook_request(body, secret)
        httpx.post(hook_url, content=body, headers={**headers, "content-type": "application/json"})
    """
    payload = _to_bytes(body)
    ts = str(int(time.time()))
    return {
        TIMESTAMP_HEADER: ts,
        SIGNATURE_HEADER: "sha256=" + _mac_hex(secret, ts.encode("utf-8") + b"." + payload),
    }
