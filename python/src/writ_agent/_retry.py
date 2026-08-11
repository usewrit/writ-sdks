"""Transient-failure retry shared by the sync and async transports.

A production caller cannot treat one 503 or one dropped socket as fatal — but it
also must not blindly repeat a request that may already have executed. The split
below is the whole safety story:

* ``GET`` / ``HEAD`` / ``OPTIONS`` are idempotent by definition and always
  eligible.
* ``POST`` / ``PUT`` / ``PATCH`` / ``DELETE`` are eligible ONLY when
  ``retry_unsafe_methods`` is set, which the SDK enables solely on the cloud
  surface, where every unsafe request carries an ``Idempotency-Key`` the server
  replays instead of re-executing. Against the local daemon (no such lane)
  unsafe methods are never retried, because a second POST there is a second
  monitor.
"""

from __future__ import annotations

import email.utils
import random
import secrets
import time
from dataclasses import dataclass, replace

import httpx

__all__ = [
    "DEFAULT_RETRY",
    "RetryPolicy",
    "backoff_seconds",
    "is_safe_method",
    "new_idempotency_key",
    "retry_after_seconds",
    "should_retry_status",
]

#: Statuses worth trying again. 408/425 are the server asking for exactly that;
#: 429 is a rate limit that WILL clear; the 5xx here are the transient members of
#: the family. 501/505 and the 4xx client errors are deliberately absent —
#: repeating them just burns quota.
RETRYABLE_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


@dataclass(frozen=True)
class RetryPolicy:
    """Tuning for transient-failure retries.

    ``max_attempts`` is the TOTAL number of attempts including the first; 0 or 1
    disables retrying.
    """

    max_attempts: int = 4
    base_delay: float = 0.25
    max_delay: float = 8.0
    #: Longest server-requested wait worth honouring. When ``Retry-After`` asks
    #: for longer the response is returned immediately instead — this is what
    #: keeps a genuinely exhausted quota ("retry in 9 hours", which a keyless
    #: daily allowance really does say) from being slept on and retried for
    #: nothing.
    max_retry_after: float = 30.0
    #: Allow unsafe methods to be retried. Only safe when the target honours
    #: ``Idempotency-Key``.
    retry_unsafe_methods: bool = False

    def with_unsafe(self, allowed: bool) -> "RetryPolicy":
        return replace(self, retry_unsafe_methods=allowed)

    def attempts_for(self, method: str) -> int:
        if is_safe_method(method) or self.retry_unsafe_methods:
            return max(1, self.max_attempts)
        return 1


#: Four attempts over roughly 0.25s + 0.5s + 1s of backoff — enough to ride out a
#: rolling deploy without turning a hung dependency into a minutes-long hang.
DEFAULT_RETRY = RetryPolicy()


def is_safe_method(method: str) -> bool:
    return method.upper() in _SAFE_METHODS


def should_retry_status(status: int) -> bool:
    return status in RETRYABLE_STATUSES


def backoff_seconds(policy: RetryPolicy, attempt: int) -> float:
    """Exponential backoff with FULL jitter.

    The randomisation is not a nicety: it is what stops a fleet of clients that
    all saw the same 503 from re-converging into a synchronised thundering herd
    on every retry.
    """
    base = policy.base_delay if policy.base_delay > 0 else DEFAULT_RETRY.base_delay
    cap = policy.max_delay if policy.max_delay > 0 else DEFAULT_RETRY.max_delay
    raw = min(base * (2 ** min(attempt - 1, 20)), cap)
    return raw / 2 + random.random() * (raw / 2)


def retry_after_seconds(response: httpx.Response | None) -> float | None:
    """Parse ``Retry-After`` (delta-seconds or HTTP-date) into seconds.

    The server's own number always beats our computed backoff — it knows when
    the limit resets and we are guessing.
    """
    if response is None:
        return None
    raw = response.headers.get("retry-after")
    if not raw:
        return None
    try:
        secs = float(raw)
    except ValueError:
        parsed = email.utils.parsedate_to_datetime(raw)
        if parsed is None:
            return None
        return max(0.0, parsed.timestamp() - time.time())
    return None if secs < 0 else secs


def new_idempotency_key() -> str:
    """Mint an opaque key for ONE logical unsafe request.

    Generated once per call and reused across that call's retries — that is the
    entire point: the server recognises the repeat and replays its first answer
    instead of executing twice.
    """
    return f"writ-{secrets.token_hex(16)}"
