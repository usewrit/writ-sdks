"""Cursor-driven change watchers shared by the sync and async clients.

Polling a change feed correctly is harder than it looks:

* The newest-first view plus a ``limit`` silently DROPS changes whenever more
  than ``limit`` of them land between two polls. Nothing errors; the rows simply
  never arrive.
* A change row is UPDATED, not re-inserted, when the same difference recurs, so
  ``last_detected_at`` moves and an id already processed resurfaces at the head
  of the feed.
* ``last_detected_at`` is not unique, so ordering on it alone lets two rows
  sharing a millisecond straddle a page boundary — and the trailing one is never
  returned again.

These helpers drive the server's keyset cursor instead, which makes "everything
after this point" exact. A resurfaced id is delivered as what it actually is: a
fresh detection, with a later cursor value.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, AsyncIterator, Callable, Iterator, Optional

__all__ = ["CURSOR_FLOOR", "watch_changes", "watch_changes_async"]

#: Cursor floor used to replay a feed from the beginning.
#:
#: This is NOT the same as omitting ``since``: omitting it selects the server's
#: newest-first BROWSING view, whose order runs backwards against a forward walk.
#: A floor cursor keeps the request in keyset mode — oldest-first, strictly
#: advancing — which is the only ordering a watcher can consume.
CURSOR_FLOOR = "1970-01-01T00:00:00+00:00"

DEFAULT_INTERVAL = 30.0
DEFAULT_PAGE_SIZE = 100


def _rows(payload: Any) -> list[dict[str, Any]]:
    """Normalize a feed response to a list of rows.

    The daemon answers a bare array; some lanes wrap it in ``{"data": [...]}``.
    A ``Page`` (from ``pagination.py``) is iterable, so it is handled too.
    """
    if payload is None:
        return []
    if isinstance(payload, dict):
        data = payload.get("data")
        return list(data) if isinstance(data, list) else []
    return [row for row in payload if isinstance(row, dict)]


def _advance(row: dict[str, Any]) -> tuple[str, int]:
    return str(row.get("last_detected_at") or ""), int(row.get("id") or 0)


def _is_behind(row: dict[str, Any], since: str, since_id: int) -> bool:
    """True when a row is at or before the cursor.

    Guards against a server echoing the cursor row back: strictly advancing
    means a malformed page can never loop forever.
    """
    ts, row_id = _advance(row)
    return ts < since or (ts == since and row_id <= since_id)


def _error_wait(interval: float, failures: int) -> float:
    """Grow the wait after consecutive failures, capped at 10 intervals, so a
    persistently broken feed does not hammer the API at the full poll rate."""
    return min(interval * (2 ** max(0, failures - 1)), interval * 10)


def watch_changes(
    fetch: Callable[[dict[str, Any]], Any],
    *,
    interval: float = DEFAULT_INTERVAL,
    page_size: int = DEFAULT_PAGE_SIZE,
    since: Optional[str] = None,
    since_id: int = 0,
    replay_history: bool = False,
    on_error: Optional[Callable[[Exception], bool]] = None,
    stop: Optional[Callable[[], bool]] = None,
) -> Iterator[dict[str, Any]]:
    """Yield detected changes forever, in detection order, without gaps.

    ``fetch`` takes a params dict and returns one page. ``stop`` is polled
    between pages so a caller can end the loop from another thread. ``on_error``
    returns True to keep polling (the default: one bad response should not
    silently kill a change feed a production system depends on) or False to
    re-raise.
    """
    survive = on_error or (lambda _exc: True)
    should_stop = stop or (lambda: False)

    if since is None:
        if replay_history:
            since, since_id = CURSOR_FLOOR, 0
        else:
            # The no-cursor view IS newest-first: read one row and start AFTER
            # it, so a fresh watcher opens on "what happens from now on" rather
            # than re-delivering the whole archive.
            try:
                head = _rows(fetch({"limit": 1}))
                since, since_id = _advance(head[0]) if head else (CURSOR_FLOOR, 0)
            except Exception as exc:  # noqa: BLE001 - policy is the caller's
                if not survive(exc):
                    raise
                since, since_id = CURSOR_FLOOR, 0

    failures = 0
    while not should_stop():
        try:
            batch = _rows(fetch({"limit": page_size, "since": since, "since_id": since_id}))
            failures = 0
        except Exception as exc:  # noqa: BLE001 - policy is the caller's
            if not survive(exc):
                raise
            failures += 1
            time.sleep(_error_wait(interval, failures))
            continue

        for row in batch:
            if _is_behind(row, since, since_id):
                continue
            yield row
            since, since_id = _advance(row)
            if should_stop():
                return

        # A full page means there is very likely more waiting: drain the backlog
        # immediately instead of sleeping a whole interval per page.
        if len(batch) == page_size:
            continue
        time.sleep(interval)


async def watch_changes_async(
    fetch: Callable[[dict[str, Any]], Any],
    *,
    interval: float = DEFAULT_INTERVAL,
    page_size: int = DEFAULT_PAGE_SIZE,
    since: Optional[str] = None,
    since_id: int = 0,
    replay_history: bool = False,
    on_error: Optional[Callable[[Exception], bool]] = None,
    stop: Optional[Callable[[], bool]] = None,
) -> AsyncIterator[dict[str, Any]]:
    """Async twin of :func:`watch_changes`. ``fetch`` returns an awaitable."""
    survive = on_error or (lambda _exc: True)
    should_stop = stop or (lambda: False)

    if since is None:
        if replay_history:
            since, since_id = CURSOR_FLOOR, 0
        else:
            try:
                head = _rows(await fetch({"limit": 1}))
                since, since_id = _advance(head[0]) if head else (CURSOR_FLOOR, 0)
            except Exception as exc:  # noqa: BLE001
                if not survive(exc):
                    raise
                since, since_id = CURSOR_FLOOR, 0

    failures = 0
    while not should_stop():
        try:
            batch = _rows(await fetch({"limit": page_size, "since": since, "since_id": since_id}))
            failures = 0
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            if not survive(exc):
                raise
            failures += 1
            await asyncio.sleep(_error_wait(interval, failures))
            continue

        for row in batch:
            if _is_behind(row, since, since_id):
                continue
            yield row
            since, since_id = _advance(row)
            if should_stop():
                return

        if len(batch) == page_size:
            continue
        await asyncio.sleep(interval)
