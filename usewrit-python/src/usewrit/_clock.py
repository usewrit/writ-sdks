"""The wall clock, in one place.

Every expiry the bridge decides (token and challenge ``exp``, command ``expires_at``, presence,
stored entries) reads :func:`now_ms`, so a test can move time by replacing it. Waits (long-polls,
result waits, Writ Cloud polling) always use the event loop's real time.
"""

from __future__ import annotations

import time

__all__ = ["now_ms", "now_seconds"]


def now_ms() -> float:
    """Unix time in milliseconds."""
    return time.time() * 1000.0


def now_seconds(now_ms_value: float | None = None) -> int:
    """Unix time in whole seconds (floored), from ``now_ms_value`` or the clock."""
    value = now_ms() if now_ms_value is None else now_ms_value
    return int(value // 1000)
