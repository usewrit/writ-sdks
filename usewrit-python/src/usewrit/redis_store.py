"""A :class:`~usewrit.store.Store` on Redis, for several server processes (or serverless hosts)
sharing one bridge. Needs the ``redis`` package (``pip install "usewrit[redis]"``) and Redis 6.2
or later (``LPOP`` with a count, decimal ``BLPOP`` timeouts).

::

    import redis.asyncio as redis
    from usewrit import RedisStore, create_writ_bridge

    bridge = create_writ_bridge(contract, store=RedisStore(redis.from_url(os.environ["REDIS_URL"])))

Layout (every key under ``prefix``, default ``writ:bridge:``, the Node twin's layout):

- ``presence:<user>``: the user's presence, JSON, with a TTL;
- ``queue:<user>``: a list of commands for the user's pages (``RPUSH``; ``LPOP`` / ``BLPOP``);
- ``pending:<id>``: a command waiting for its result; ``DEL`` decides which result wins;
- ``result:<id>``: a one-item list holding the outcome for the caller (``BLPOP``);
- ``nonce:<nonce>``: a spent challenge nonce (``SET NX PX``);
- ``devices:<subject>``: the public keys of the devices pinned for a user (a set, no TTL; the
  first-use pin is one atomic ``EVAL``, so the server must allow Lua scripting);
- channel ``wake``: ``q:<user>`` when a command is queued, ``r:<id>`` when a result is in, so a
  Node server subscribed to it on the same Redis wakes at once too.

Waiting uses ``BLPOP``, which holds one connection of the client's pool while it waits (up to
``poll_seconds`` for a page's poll, up to a call's timeout for a caller). The default
``redis.asyncio`` pool grows as needed; if you cap ``max_connections``, leave room for every
page that may be polling at once, and leave ``socket_timeout`` unset (or above the longest wait).
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from typing import Any, Final

from ._json import dumps
from .errors import WritBridgeError
from .store import Command, CommandOutcome, DeviceCheck, PendingCommand, Presence

__all__ = ["RedisStore"]

#: How long an outcome waits for its caller to collect it (ms).
RESULT_TTL_MS: Final = 10 * 60 * 1000

#: The first-use pin, in one step so two first receipts racing cannot both pin: 1 = known,
#: 2 = pinned now (nothing was pinned), 0 = unknown. Byte for byte the Node store's script, so
#: both can share one Redis.
CHECK_DEVICE_SCRIPT: Final = "\n".join(
    [
        "if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 1 end",
        "if ARGV[2] == '1' and redis.call('SCARD', KEYS[1]) == 0 then redis.call('SADD', KEYS[1], ARGV[1]) return 2 end",
        "return 0",
    ]
)


def _text(reply: Any) -> str | None:
    if reply is None:
        return None
    if isinstance(reply, (bytes, bytearray, memoryview)):
        return bytes(reply).decode("utf-8")
    return str(reply)


def _items(reply: Any) -> list[str]:
    if reply is None:
        return []
    if isinstance(reply, (list, tuple)):
        return [text for text in (_text(item) for item in reply) if text is not None]
    one = _text(reply)
    return [] if one is None else [one]


def _ms(value: float) -> int:
    return max(1, math.ceil(value))


def _blpop_seconds(ms: float) -> float | int:
    """A BLPOP timeout: never 0 (which waits forever); whole seconds when exact."""
    seconds = max(0.01, ms / 1000.0)
    return int(seconds) if seconds == int(seconds) else round(seconds, 3)


class RedisStore:
    """A Redis-backed store. See the module documentation for wiring and layout.

    ``client`` is a ``redis.asyncio.Redis`` (or a compatible client); or pass ``url`` and the store
    opens (and closes, in :meth:`aclose`) its own.
    """

    def __init__(self, client: Any | None = None, *, url: str | None = None, prefix: str = "writ:bridge:") -> None:
        if client is None:
            if not url:
                raise WritBridgeError("CONFIG_INVALID", "RedisStore needs a redis.asyncio client, or url=.")
            try:
                import redis.asyncio as redis_asyncio
            except ImportError as exc:  # pragma: no cover - depends on the environment
                raise WritBridgeError(
                    "CONFIG_INVALID", 'RedisStore needs the redis package: pip install "usewrit[redis]".'
                ) from exc
            client = redis_asyncio.from_url(url)
            self._owned = True
        else:
            self._owned = False
        if not isinstance(prefix, str):
            raise WritBridgeError("CONFIG_INVALID", "RedisStore prefix must be text.")
        self._redis = client
        self._prefix = prefix
        self._channel = f"{prefix}wake"

    # -- keys ---------------------------------------------------------------------------------

    def _presence_key(self, user: str) -> str:
        return f"{self._prefix}presence:{user}"

    def _queue_key(self, user: str) -> str:
        return f"{self._prefix}queue:{user}"

    def _pending_key(self, command_id: str) -> str:
        return f"{self._prefix}pending:{command_id}"

    def _result_key(self, command_id: str) -> str:
        return f"{self._prefix}result:{command_id}"

    def _nonce_key(self, nonce: str) -> str:
        return f"{self._prefix}nonce:{nonce}"

    def _devices_key(self, subject: str) -> str:
        return f"{self._prefix}devices:{subject}"

    async def _publish(self, token: str) -> None:
        await self._redis.publish(self._channel, token)

    # -- presence -----------------------------------------------------------------------------

    async def get_presence(self, user_id: str) -> Presence | None:
        raw = _text(await self._redis.get(self._presence_key(user_id)))
        if raw is None:
            return None
        value: Presence = json.loads(raw)
        return value

    async def set_presence(self, user_id: str, presence: Presence, ttl_ms: float) -> None:
        await self._redis.set(self._presence_key(user_id), dumps(presence), px=_ms(ttl_ms))

    # -- commands -----------------------------------------------------------------------------

    async def enqueue(self, user_id: str, command: Command, pending: PendingCommand, ttl_ms: float) -> None:
        await self._redis.set(self._pending_key(pending["id"]), dumps(pending), px=_ms(ttl_ms))
        queue = self._queue_key(user_id)
        await self._redis.rpush(queue, dumps(command))
        await self._redis.pexpire(queue, _ms(ttl_ms))
        await self._publish(f"q:{user_id}")

    async def take(self, user_id: str, wait_ms: float, limit: int) -> list[Command]:
        queue = self._queue_key(user_id)
        count = max(1, limit)
        items = _items(await self._redis.lpop(queue, count))
        if not items and wait_ms > 0:
            # A cancellation lands while BLPOP waits, before Redis hands an item over: redis-py
            # drops that connection, so nothing popped is left unread in practice.
            got = await self._redis.blpop([queue], timeout=_blpop_seconds(wait_ms))
            if got:
                first = _text(got[1])
                if first is not None:
                    items.append(first)
                if count > 1:
                    items.extend(_items(await self._redis.lpop(queue, count - 1)))
        return [json.loads(item) for item in items]

    async def requeue(self, user_id: str, commands: Sequence[Command]) -> None:
        if not commands:
            return
        # LPUSH inserts each value at the head in turn: push in reverse to keep their order.
        values = [dumps(command) for command in reversed(list(commands))]
        await self._redis.lpush(self._queue_key(user_id), *values)
        await self._publish(f"q:{user_id}")

    async def withdraw(self, user_id: str, command: Command) -> bool:
        removed = await self._redis.lrem(self._queue_key(user_id), 1, dumps(command))
        return int(removed or 0) > 0

    # -- results ------------------------------------------------------------------------------

    async def pending(self, command_id: str) -> PendingCommand | None:
        raw = _text(await self._redis.get(self._pending_key(command_id)))
        if raw is None:
            return None
        value: PendingCommand = json.loads(raw)
        return value

    async def resolve(self, command_id: str, outcome: CommandOutcome) -> bool:
        removed = await self._redis.delete(self._pending_key(command_id))
        if int(removed or 0) <= 0:
            return False
        key = self._result_key(command_id)
        await self._redis.rpush(key, dumps(outcome))
        await self._redis.pexpire(key, RESULT_TTL_MS)
        await self._publish(f"r:{command_id}")
        return True

    async def await_result(self, command_id: str, timeout_ms: float) -> CommandOutcome | None:
        key = self._result_key(command_id)
        raw = _text(await self._redis.lpop(key))
        if raw is None and timeout_ms > 0:
            got = await self._redis.blpop([key], timeout=_blpop_seconds(timeout_ms))
            raw = _text(got[1]) if got else None
        if raw is None:
            return None
        value: CommandOutcome = json.loads(raw)
        return value

    async def cancel(self, command_id: str) -> None:
        await self._redis.delete(self._pending_key(command_id), self._result_key(command_id))

    async def spend_nonce(self, nonce: str, ttl_ms: float) -> bool:
        reply = await self._redis.set(self._nonce_key(nonce), "1", px=_ms(ttl_ms), nx=True)
        return bool(reply)

    # -- device pins (no TTL) -------------------------------------------------------------------

    async def check_device(self, subject: str, public_key: str, first_use: bool) -> DeviceCheck:
        reply = await self._redis.eval(
            CHECK_DEVICE_SCRIPT, 1, self._devices_key(subject), public_key, "1" if first_use else "0"
        )
        code = int(reply or 0)
        return "known" if code == 1 else "pinned" if code == 2 else "unknown"

    async def pin_device(self, subject: str, public_key: str) -> None:
        await self._redis.sadd(self._devices_key(subject), public_key)

    async def forget_devices(self, subject: str) -> None:
        await self._redis.delete(self._devices_key(subject))

    async def aclose(self) -> None:
        """Close the client when the store opened it from ``url``; a client you passed stays open."""
        if not self._owned:
            return
        close = getattr(self._redis, "aclose", None) or getattr(self._redis, "close", None)
        if close is not None:
            await close()
