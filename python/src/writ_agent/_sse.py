"""Minimal in-package SSE parser (DESIGN §8).

Frames split on blank lines; multiple ``data:`` lines accumulate (joined with
``\\n``); ``:`` comment lines (the daemon's 15s keep-alives) plus ``id:`` /
``retry:`` fields are ignored. The daemon names each frame (``event: step``)
AND repeats the discriminant inside the JSON payload (serde tag ``"event"``),
so parsing ``data`` alone is sufficient — we still backfill ``event`` from the
frame name defensively.
"""

from __future__ import annotations

import json
from typing import Any

__all__ = ["SSEDecoder"]


class SSEDecoder:
    """Incremental line-fed decoder. Feed decoded text lines (no newline); get
    back a parsed event dict when a frame completes, else ``None``."""

    def __init__(self) -> None:
        self._event: str | None = None
        self._data: list[str] = []

    def feed(self, line: str) -> dict[str, Any] | None:
        if line == "":
            return self._dispatch()
        if line.startswith(":"):
            # Comment / keep-alive — ignored. (It does not terminate a frame.)
            return None
        field, sep, value = line.partition(":")
        if sep and value.startswith(" "):
            value = value[1:]
        if field == "event":
            self._event = value
        elif field == "data":
            self._data.append(value)
        # id: / retry: / anything else — ignored.
        return None

    def _dispatch(self) -> dict[str, Any] | None:
        if not self._data and self._event is None:
            return None
        data = "\n".join(self._data)
        name = self._event
        self._event = None
        self._data = []
        if not data:
            return None
        try:
            obj = json.loads(data)
        except ValueError:
            return None
        if not isinstance(obj, dict):
            return None
        if "event" not in obj and name:
            obj["event"] = name
        return obj
