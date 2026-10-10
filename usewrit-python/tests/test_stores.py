"""The store contract, on MemoryStore and (with fakeredis installed) RedisStore, and two workers
sharing one Redis."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest

from usewrit import Command, MemoryStore, PendingCommand, Presence, RedisStore, WritBridgeError
from usewrit.redis_store import CHECK_DEVICE_SCRIPT

from .conftest import FakeClock
from .helpers import HELLO, LOGIN, OTHER_SEED, make_bridge, make_receipt, poll, post


def _fake_redis_server() -> Any:
    fakeredis = pytest.importorskip("fakeredis")
    pytest.importorskip("lupa")  # the device pin is a Lua script (fakeredis[lua])
    return fakeredis, fakeredis.FakeServer()


def _fake_redis_client(fakeredis: Any, server: Any) -> Any:
    factory = getattr(fakeredis, "FakeAsyncRedis", None)
    if factory is None:
        factory = fakeredis.aioredis.FakeRedis
    return factory(server=server)


@pytest.fixture(params=["memory", "redis"])
async def store(request: pytest.FixtureRequest) -> AsyncIterator[Any]:
    if request.param == "memory":
        made: Any = MemoryStore()
    else:
        fakeredis, server = _fake_redis_server()
        made = RedisStore(_fake_redis_client(fakeredis, server), prefix="test:")
    yield made
    await made.aclose()


def _command(command_id: str, expires_at: int = 2**40) -> Command:
    return Command(id=command_id, key="auth.verify_login", inputs={"a": 1}, options={"timeout_ms": 1000}, challenge="c", expires_at=expires_at)


def _pending(command_id: str, user: str = "u1") -> PendingCommand:
    return PendingCommand(id=command_id, user=user, key="auth.verify_login", challenge="c", expires_at=2**40)


async def test_presence_round_trips(store: Any) -> None:
    assert await store.get_presence("u1") is None
    presence = Presence(ready=True, granted=["auth.verify_login"], writ_version="1.0.7", last_seen=123.0, ever_ready=True)
    await store.set_presence("u1", presence, 60_000)
    assert await store.get_presence("u1") == presence


async def test_commands_queue_in_order_and_are_taken_once(store: Any) -> None:
    for name in ("a", "b", "c"):
        await store.enqueue("u1", _command(name), _pending(name), 60_000)
    assert [command["id"] for command in await store.take("u1", 0, 2)] == ["a", "b"]
    assert [command["id"] for command in await store.take("u1", 0, 16)] == ["c"]
    assert await store.take("u1", 0, 16) == []
    assert await store.take("u2", 0, 16) == []


async def test_a_waiting_take_wakes_on_enqueue(store: Any) -> None:
    taking = asyncio.ensure_future(store.take("u1", 3_000, 16))
    await asyncio.sleep(0.05)
    assert not taking.done()
    await store.enqueue("u1", _command("a"), _pending("a"), 60_000)
    assert [command["id"] for command in await asyncio.wait_for(taking, timeout=3)] == ["a"]


async def test_an_empty_take_waits_then_answers_nothing(store: Any) -> None:
    loop = asyncio.get_running_loop()
    started = loop.time()
    assert await store.take("u1", 1_000, 16) == []
    assert loop.time() - started >= 0.8


async def test_requeue_puts_commands_back_in_front(store: Any) -> None:
    for name in ("a", "b", "c"):
        await store.enqueue("u1", _command(name), _pending(name), 60_000)
    taken = await store.take("u1", 0, 2)
    await store.requeue("u1", taken)
    assert [command["id"] for command in await store.take("u1", 0, 16)] == ["a", "b", "c"]


async def test_withdraw_removes_a_command_nobody_took(store: Any) -> None:
    command = _command("a")
    await store.enqueue("u1", command, _pending("a"), 60_000)
    assert await store.withdraw("u1", command) is True
    assert await store.withdraw("u1", command) is False
    assert await store.take("u1", 0, 16) == []


async def test_exactly_one_resolve_wins(store: Any) -> None:
    await store.enqueue("u1", _command("a"), _pending("a"), 60_000)
    assert (await store.pending("a")) == _pending("a")
    assert await store.resolve("a", {"ok": True, "data": 1, "receipt": None}) is True
    assert await store.resolve("a", {"ok": True, "data": 2, "receipt": None}) is False
    assert await store.pending("a") is None
    assert await store.await_result("a", 1_000) == {"ok": True, "data": 1, "receipt": None}
    assert await store.await_result("a", 1_000) is None


async def test_a_waiting_caller_wakes_on_resolve(store: Any) -> None:
    await store.enqueue("u1", _command("a"), _pending("a"), 60_000)
    waiting = asyncio.ensure_future(store.await_result("a", 3_000))
    await asyncio.sleep(0.05)
    assert not waiting.done()
    await store.resolve("a", {"ok": False, "error": {"code": "RUN_FAILED", "message": "x"}})
    assert (await asyncio.wait_for(waiting, timeout=3))["error"]["code"] == "RUN_FAILED"


async def test_cancel_forgets_pending_and_results(store: Any) -> None:
    await store.enqueue("u1", _command("a"), _pending("a"), 60_000)
    await store.cancel("a")
    assert await store.pending("a") is None
    assert await store.resolve("a", {"ok": True}) is False


async def test_a_nonce_is_spent_once(store: Any) -> None:
    assert await store.spend_nonce("n1", 60_000) is True
    assert await store.spend_nonce("n1", 60_000) is False
    assert await store.spend_nonce("n2", 60_000) is True


async def test_the_first_device_of_a_subject_is_pinned_and_approved_ones_after_it(store: Any) -> None:
    assert await store.check_device("u1", "key-a", False) == "unknown"
    assert await store.check_device("u1", "key-a", True) == "pinned"
    assert await store.check_device("u1", "key-a", True) == "known"
    assert await store.check_device("u1", "key-b", True) == "unknown"
    assert await store.check_device("u2", "key-b", True) == "pinned"
    await store.pin_device("u1", "key-b")
    await store.pin_device("u1", "key-b")  # idempotent
    assert await store.check_device("u1", "key-b", False) == "known"
    assert await store.check_device("u1", "key-a", False) == "known"
    await store.forget_devices("u1")
    assert await store.check_device("u1", "key-a", False) == "unknown"
    assert await store.check_device("u1", "key-c", True) == "pinned"
    assert await store.check_device("u2", "key-b", False) == "known"
    await store.forget_devices("nobody")  # forgetting nothing is fine


async def test_two_first_devices_racing_pin_exactly_one(store: Any) -> None:
    answers = await asyncio.gather(
        store.check_device("u9", "key-a", True),
        store.check_device("u9", "key-b", True),
    )
    assert sorted(answers) == ["pinned", "unknown"]
    winner = "key-a" if answers[0] == "pinned" else "key-b"
    assert await store.check_device("u9", winner, False) == "known"


async def test_memory_store_entries_expire_on_its_clock(clock: FakeClock) -> None:
    store = MemoryStore()
    await store.set_presence("u1", Presence(ready=True, granted=[], writ_version=None, last_seen=0, ever_ready=True), 1_000)
    await store.enqueue("u1", _command("a"), _pending("a"), 1_000)
    assert await store.spend_nonce("n", 1_000) is True
    assert await store.check_device("u1", "key-a", True) == "pinned"
    clock.advance(2)
    assert await store.get_presence("u1") is None
    assert await store.take("u1", 0, 16) == []
    assert await store.pending("a") is None
    assert await store.spend_nonce("n", 1_000) is True
    clock.advance(10 * 365 * 24 * 3600)
    assert await store.check_device("u1", "key-a", False) == "known"  # pins never expire


def test_the_device_script_is_byte_for_byte_the_node_script() -> None:
    assert CHECK_DEVICE_SCRIPT == (
        "if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 1 end\n"
        "if ARGV[2] == '1' and redis.call('SCARD', KEYS[1]) == 0 then redis.call('SADD', KEYS[1], ARGV[1]) return 2 end\n"
        "return 0"
    )


class _RecordingRedis:
    """Records the commands a RedisStore sends, answering EVAL with a fixed reply."""

    def __init__(self, reply: Any) -> None:
        self.reply = reply
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    async def eval(self, *args: Any) -> Any:
        self.calls.append(("eval", args))
        return self.reply

    async def sadd(self, *args: Any) -> int:
        self.calls.append(("sadd", args))
        return 1

    async def delete(self, *args: Any) -> int:
        self.calls.append(("delete", args))
        return 1


@pytest.mark.parametrize(("reply", "answer"), [(1, "known"), (2, "pinned"), (0, "unknown"), (b"2", "pinned")])
async def test_redis_device_pin_is_one_eval_with_the_node_arguments(reply: Any, answer: str) -> None:
    client = _RecordingRedis(reply)
    store = RedisStore(client, prefix="p:")
    assert await store.check_device("u1", "PUBLIC", True) == answer
    assert await store.check_device("u1", "PUBLIC", False) == answer
    await store.pin_device("u1", "PUBLIC")
    await store.forget_devices("u1")
    assert client.calls == [
        ("eval", (CHECK_DEVICE_SCRIPT, 1, "p:devices:u1", "PUBLIC", "1")),
        ("eval", (CHECK_DEVICE_SCRIPT, 1, "p:devices:u1", "PUBLIC", "0")),
        ("sadd", ("p:devices:u1", "PUBLIC")),
        ("delete", ("p:devices:u1",)),
    ]


def test_redis_store_needs_a_client_or_url() -> None:
    with pytest.raises(WritBridgeError) as caught:
        RedisStore()
    assert caught.value.code == "CONFIG_INVALID"


async def test_two_workers_share_one_redis(clock: FakeClock) -> None:
    """The page polls worker B while the call waits on worker A."""
    fakeredis, server = _fake_redis_server()
    worker_a = make_bridge(store=RedisStore(_fake_redis_client(fakeredis, server)))
    worker_b = make_bridge(store=RedisStore(_fake_redis_client(fakeredis, server)))
    token = worker_a.user_token("u1")

    assert (await post(worker_b, token, HELLO))[0] == 204
    assert await worker_a.online("u1")

    call = asyncio.ensure_future(worker_a.user("u1").auth.verify_login(LOGIN, timeout_ms=5_000))
    await asyncio.sleep(0.1)
    status, body = await poll(worker_b, token, wait=2)
    assert status == 200 and len(body["commands"]) == 1
    command = body["commands"][0]

    data = {"ok": True}
    receipt = make_receipt(key="auth.verify_login", challenge=command["challenge"], inputs=command["inputs"], data=data)
    status, _, _ = await post(worker_b, token, {"result": {"id": command["id"], "ok": True, "data": data, "receipt": receipt}})
    assert status == 204
    result = await asyncio.wait_for(call, timeout=5)
    assert result.venue == "user" and result.data == data

    # A gate verified on one worker is spent for the other.
    challenge = worker_a.challenge("u1", "auth.verify_login")
    receipt = make_receipt(key="auth.verify_login", challenge=challenge, data=data)
    assert (await worker_b.verify(receipt, challenge=challenge, key="auth.verify_login")).ok
    again = await worker_a.verify(receipt, challenge=challenge, key="auth.verify_login")
    assert not again.ok and again.reason == "the challenge was already used"

    # The device pinned through worker B is the only one worker A accepts for u1.
    challenge = worker_a.challenge("u1", "auth.verify_login")
    forged = make_receipt(key="auth.verify_login", challenge=challenge, data=data, seed=OTHER_SEED)
    refused = await worker_a.verify(forged, challenge=challenge, key="auth.verify_login")
    assert not refused.ok and refused.unknown_device
