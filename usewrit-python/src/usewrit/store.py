"""Where the bridge keeps what several requests share: each user's presence, the commands queued
for their pages, the commands waiting for a result, the results on their way back, and the
challenge nonces already spent.

:class:`MemoryStore` serves one server process. Behind a load balancer, with several workers
(``uvicorn --workers 4``, gunicorn), or on serverless hosts where the page's poll and your call
land on different processes, use :class:`~usewrit.redis_store.RedisStore`.

Every time-to-live is relative (milliseconds from now), so a store never compares clocks. The
interface is the Node twin's ``WritBridgeStore``, in snake_case.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypedDict, runtime_checkable

from . import _clock

__all__ = [
    "Command",
    "CommandOptions",
    "CommandOutcome",
    "DeviceCheck",
    "MemoryStore",
    "PendingCommand",
    "Presence",
    "Store",
]


class Presence(TypedDict):
    """What the user's pages last reported (CONTRACT.md §12.3 ``hello``), plus when."""

    #: Writ is installed, running and connected to this site.
    ready: bool
    #: The contract keys the user granted to this site.
    granted: list[str]
    #: The Writ version the page reported.
    writ_version: str | None
    #: Unix milliseconds of the last hello or poll.
    last_seen: float
    #: The user reported Writ ready at least once while this record lived.
    ever_ready: bool


class CommandOptions(TypedDict, total=False):
    timeout_ms: int
    dry_run: bool


class Command(TypedDict):
    """A command for one of the user's pages (CONTRACT.md §12.3, ``GET`` answer)."""

    #: 16 random bytes, base64url; also the nonce of its challenge.
    id: str
    key: str
    inputs: dict[str, Any]
    options: CommandOptions
    #: Minted for this command's id and key; the receipt must carry it back.
    challenge: str
    #: Unix seconds after which the page must not start it.
    expires_at: int


class _PendingCommandOptional(TypedDict, total=False):
    #: ``inputs_hash(challenge, inputs)`` of what the command was sent with: its receipt must carry it.
    inputs_hash: str


class PendingCommand(_PendingCommandOptional):
    """What the bridge remembers about a command until its result arrives."""

    id: str
    #: The user the command was sent to; only their pages may answer it.
    user: str
    key: str
    challenge: str
    #: Unix seconds.
    expires_at: int


#: A command's outcome, as handed to the caller waiting for it:
#: ``{"ok": True, "data", "receipt"}`` or
#: ``{"ok": False, "error": {"code", "message"}, "receipt"?, "unknown_device"?}``, where
#: ``unknown_device`` is the signing device of a genuine receipt refused only because its signer
#: is not pinned for the user.
CommandOutcome = dict[str, Any]

#: What :meth:`Store.check_device` answers.
DeviceCheck = Literal["known", "pinned", "unknown"]


@runtime_checkable
class Store(Protocol):
    """The storage the bridge needs. Implement it to put the bridge on any shared store; every
    method may be called concurrently from many requests."""

    async def get_presence(self, user_id: str) -> Presence | None:
        """The user's last presence, or ``None``."""

    async def set_presence(self, user_id: str, presence: Presence, ttl_ms: float) -> None:
        """Replace the user's presence, kept ``ttl_ms``."""

    async def enqueue(self, user_id: str, command: Command, pending: PendingCommand, ttl_ms: float) -> None:
        """Remember ``pending`` (until it is resolved, cancelled, or ``ttl_ms`` passes) and queue
        ``command`` for the user's pages, waking a page waiting in :meth:`take`."""

    async def take(self, user_id: str, wait_ms: float, limit: int) -> list[Command]:
        """Remove and answer the user's queued commands, oldest first, at most ``limit``. When none
        is queued, wait up to ``wait_ms`` for one; answer ``[]`` when none came. Cancelling the
        call must never lose a command."""

    async def requeue(self, user_id: str, commands: Sequence[Command]) -> None:
        """Put commands a page took but never received back at the front of the queue."""

    async def withdraw(self, user_id: str, command: Command) -> bool:
        """Remove ``command`` from the user's queue if no page took it yet; ``True`` when removed."""

    async def pending(self, command_id: str) -> PendingCommand | None:
        """The pending command with this id, or ``None`` once it was resolved, cancelled or expired."""

    async def resolve(self, command_id: str, outcome: CommandOutcome) -> bool:
        """Hand ``outcome`` to the caller waiting in :meth:`await_result`, and forget the pending
        command. Exactly one resolve wins: ``False`` when the command was no longer pending."""

    async def await_result(self, command_id: str, timeout_ms: float) -> CommandOutcome | None:
        """Wait up to ``timeout_ms`` for the command's outcome; ``None`` on timeout."""

    async def cancel(self, command_id: str) -> None:
        """Forget a pending command and any outcome not collected yet."""

    async def spend_nonce(self, nonce: str, ttl_ms: float) -> bool:
        """Record ``nonce`` as spent for ``ttl_ms``; ``False`` when it was already spent."""

    async def check_device(self, subject: str, public_key: str, first_use: bool) -> DeviceCheck:
        """The device pin check of a receipt's signer, atomic: ``"known"`` when ``public_key`` is
        pinned for ``subject``; when nothing is pinned for ``subject`` yet and ``first_use``, pin it
        and answer ``"pinned"``; otherwise ``"unknown"``. Pins never expire."""

    async def pin_device(self, subject: str, public_key: str) -> None:
        """Pin ``public_key`` for ``subject`` (a further device you approved). Idempotent."""

    async def forget_devices(self, subject: str) -> None:
        """Forget every device pinned for ``subject``."""

    async def aclose(self) -> None:
        """Release waiters, timers and connections the store opened itself."""


# -------------------------------------------------------------------------------------------------
# MemoryStore
# -------------------------------------------------------------------------------------------------


@dataclass
class _Expiring:
    value: Any
    expires_at: float


#: How often expired entries are swept, at most (ms).
_SWEEP_EVERY_MS = 30_000


class _Waiters:
    """Parked coroutines per id, woken all at once when what they watch changes."""

    def __init__(self) -> None:
        self._parked: dict[str, set[asyncio.Future[None]]] = {}

    def wake(self, name: str) -> None:
        parked = self._parked.pop(name, None)
        if parked is None:
            return
        for future in parked:
            if not future.done():
                future.set_result(None)

    def wake_everyone(self) -> None:
        for name in list(self._parked):
            self.wake(name)

    async def park(self, name: str, seconds: float) -> None:
        """Wait until woken or ``seconds`` pass."""
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._parked.setdefault(name, set()).add(future)
        try:
            await asyncio.wait({future}, timeout=max(0.0, seconds))
        finally:
            parked = self._parked.get(name)
            if parked is not None:
                parked.discard(future)
                if not parked:
                    self._parked.pop(name, None)
            if not future.done():
                future.cancel()


class MemoryStore:
    """The default store: everything in this process's memory.

    Right for one server process on one event loop (and for development); state is lost on
    restart, and other processes cannot see it.

    ``now`` is a clock in unix milliseconds that times entries out, for tests; waits always use
    real time.
    """

    def __init__(self, *, now: Callable[[], float] | None = None) -> None:
        self._now_fn = now
        self._presence: dict[str, _Expiring] = {}
        self._queues: dict[str, list[_Expiring]] = {}
        self._pendings: dict[str, _Expiring] = {}
        self._results: dict[str, _Expiring] = {}
        self._nonces: dict[str, float] = {}
        #: Pinned device public keys per subject; never expire (a process restart forgets them).
        self._devices: dict[str, set[str]] = {}
        self._queue_waiters = _Waiters()
        self._result_waiters = _Waiters()
        self._last_sweep = self._now()

    def _now(self) -> float:
        return self._now_fn() if self._now_fn is not None else _clock.now_ms()

    def _sweep(self) -> None:
        t = self._now()
        if t - self._last_sweep < _SWEEP_EVERY_MS:
            return
        self._last_sweep = t
        for table in (self._presence, self._pendings, self._results):
            for name in [name for name, entry in table.items() if entry.expires_at <= t]:
                del table[name]
        for nonce in [nonce for nonce, until in self._nonces.items() if until <= t]:
            del self._nonces[nonce]
        for user in list(self._queues):
            live = [entry for entry in self._queues[user] if entry.expires_at > t]
            if live:
                self._queues[user] = live
            else:
                del self._queues[user]

    def _take_now(self, user_id: str, limit: int) -> list[Command]:
        queue = self._queues.get(user_id)
        if queue is None:
            return []
        t = self._now()
        live = [entry for entry in queue if entry.expires_at > t]
        count = max(1, limit)
        taken, rest = live[:count], live[count:]
        if rest:
            self._queues[user_id] = rest
        else:
            self._queues.pop(user_id, None)
        return [entry.value for entry in taken]

    def _take_result(self, command_id: str) -> CommandOutcome | None:
        entry = self._results.pop(command_id, None)
        if entry is None:
            return None
        return entry.value if entry.expires_at > self._now() else None

    async def get_presence(self, user_id: str) -> Presence | None:
        self._sweep()
        entry = self._presence.get(user_id)
        if entry is None:
            return None
        if entry.expires_at <= self._now():
            del self._presence[user_id]
            return None
        value: Presence = entry.value
        return Presence(
            ready=value["ready"],
            granted=list(value["granted"]),
            writ_version=value["writ_version"],
            last_seen=value["last_seen"],
            ever_ready=value["ever_ready"],
        )

    async def set_presence(self, user_id: str, presence: Presence, ttl_ms: float) -> None:
        self._sweep()
        value = Presence(
            ready=presence["ready"],
            granted=list(presence["granted"]),
            writ_version=presence["writ_version"],
            last_seen=presence["last_seen"],
            ever_ready=presence["ever_ready"],
        )
        self._presence[user_id] = _Expiring(value, self._now() + ttl_ms)

    async def enqueue(self, user_id: str, command: Command, pending: PendingCommand, ttl_ms: float) -> None:
        self._sweep()
        expires_at = self._now() + ttl_ms
        self._pendings[pending["id"]] = _Expiring(dict(pending), expires_at)
        self._queues.setdefault(user_id, []).append(_Expiring(command, expires_at))
        self._queue_waiters.wake(user_id)

    async def take(self, user_id: str, wait_ms: float, limit: int) -> list[Command]:
        self._sweep()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(0.0, wait_ms) / 1000.0
        while True:
            taken = self._take_now(user_id, limit)
            if taken:
                return taken
            left = deadline - loop.time()
            if left <= 0:
                return []
            # Cancelled while parked, nothing was taken: no command is lost.
            await self._queue_waiters.park(user_id, left)

    async def requeue(self, user_id: str, commands: Sequence[Command]) -> None:
        if not commands:
            return
        t = self._now()
        back: list[_Expiring] = []
        for command in commands:
            pending = self._pendings.get(command["id"])
            expires_at = pending.expires_at if pending is not None else 0.0
            if expires_at > t:
                back.append(_Expiring(command, expires_at))
        if not back:
            return
        self._queues[user_id] = [*back, *self._queues.get(user_id, [])]
        self._queue_waiters.wake(user_id)

    async def withdraw(self, user_id: str, command: Command) -> bool:
        queue = self._queues.get(user_id)
        if queue is None:
            return False
        for index, entry in enumerate(queue):
            if entry.value["id"] == command["id"]:
                del queue[index]
                if not queue:
                    del self._queues[user_id]
                return True
        return False

    async def pending(self, command_id: str) -> PendingCommand | None:
        entry = self._pendings.get(command_id)
        if entry is None:
            return None
        if entry.expires_at <= self._now():
            del self._pendings[command_id]
            return None
        value: PendingCommand = dict(entry.value)  # type: ignore[assignment]
        return value

    async def resolve(self, command_id: str, outcome: CommandOutcome) -> bool:
        entry = self._pendings.pop(command_id, None)
        if entry is None or entry.expires_at <= self._now():
            return False
        self._results[command_id] = _Expiring(outcome, entry.expires_at)
        self._result_waiters.wake(command_id)
        return True

    async def await_result(self, command_id: str, timeout_ms: float) -> CommandOutcome | None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(0.0, timeout_ms) / 1000.0
        while True:
            outcome = self._take_result(command_id)
            if outcome is not None:
                return outcome
            left = deadline - loop.time()
            if left <= 0:
                return None
            await self._result_waiters.park(command_id, left)

    async def cancel(self, command_id: str) -> None:
        self._pendings.pop(command_id, None)
        self._results.pop(command_id, None)

    async def spend_nonce(self, nonce: str, ttl_ms: float) -> bool:
        self._sweep()
        t = self._now()
        until = self._nonces.get(nonce)
        if until is not None and until > t:
            return False
        self._nonces[nonce] = t + max(1.0, ttl_ms)
        return True

    async def check_device(self, subject: str, public_key: str, first_use: bool) -> DeviceCheck:
        # No await in here: on one event loop the check and the first pin are one step.
        pinned = self._devices.get(subject)
        if pinned is not None and public_key in pinned:
            return "known"
        if first_use and not pinned:
            self._devices[subject] = {public_key}
            return "pinned"
        return "unknown"

    async def pin_device(self, subject: str, public_key: str) -> None:
        self._devices.setdefault(subject, set()).add(public_key)

    async def forget_devices(self, subject: str) -> None:
        self._devices.pop(subject, None)

    async def aclose(self) -> None:
        self._queue_waiters.wake_everyone()
        self._result_waiters.wake_everyone()
