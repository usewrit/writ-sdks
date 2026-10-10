"""Shared fixtures: a movable clock and a clean environment."""

from __future__ import annotations

import pytest

from usewrit import _clock

from .helpers import START_MS


class FakeClock:
    """Unix milliseconds that only move when a test says so."""

    def __init__(self, start_ms: float = START_MS) -> None:
        self.ms = float(start_ms)

    def __call__(self) -> float:
        return self.ms

    def advance(self, seconds: float) -> None:
        self.ms += seconds * 1000.0


@pytest.fixture()
def clock(monkeypatch: pytest.MonkeyPatch) -> FakeClock:
    fake = FakeClock()
    monkeypatch.setattr(_clock, "now_ms", fake)
    return fake


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("WRIT_BRIDGE_SECRET", "WRIT_API_KEY"):
        monkeypatch.delenv(name, raising=False)
