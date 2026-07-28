"""Uniform ``Page`` shape over the daemon's inconsistent list envelopes (DESIGN §6).

The daemon returns three list envelope kinds:

- ``{"data": [...], "count": n}`` — workflows, personas, secrets, files, keys …
- ``{"data": [...], "count": n, "total": n}`` — runs
- a bare JSON array — monitors, automations, selectors, extractors, recent changes

Every SDK list method normalizes to :class:`Page` — for bare arrays,
``count = len(data)`` and ``total = None``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Generic, Iterator, TypeVar

from .errors import WritError

__all__ = ["Page"]

T = TypeVar("T")


@dataclass
class Page(Generic[T]):
    """A single page of results. Iterable and ``len()``-able for convenience."""

    data: list[T] = field(default_factory=list)
    count: int = 0
    #: Total matching rows across all pages when the endpoint reports it (runs); else ``None``.
    total: int | None = None

    def __iter__(self) -> Iterator[T]:
        return iter(self.data)

    def __len__(self) -> int:
        return len(self.data)

    def __getitem__(self, index: int) -> T:
        return self.data[index]

    def __bool__(self) -> bool:
        return bool(self.data)


def to_page(body: Any) -> Page[Any]:
    """Normalize any of the three wire envelopes into a :class:`Page`."""
    if isinstance(body, list):
        return Page(data=body, count=len(body), total=None)
    if isinstance(body, dict) and isinstance(body.get("data"), list):
        data = body["data"]
        count = body.get("count")
        total = body.get("total")
        return Page(
            data=data,
            count=count if isinstance(count, int) else len(data),
            total=total if isinstance(total, int) else None,
        )
    raise WritError(
        f"unexpected list envelope from the daemon: {type(body).__name__}"
    )
