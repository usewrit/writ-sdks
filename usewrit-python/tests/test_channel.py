"""The page channel (CONTRACT.md §12.3) through the framework-free ``bridge.handle()``."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from usewrit import WritBridgeError, read_challenge, sign_token

from .conftest import FakeClock
from .helpers import HELLO, LOGIN, ORIGIN, OTHER_SEED, SECRET, auth, make_bridge, make_receipt, poll, post

KEY = "auth.verify_login"
DATA = {"ok": True, "user": "Zoé", "n": 3}


async def _start_call(bridge: Any, user: str = "u1", **options: Any) -> tuple[asyncio.Task[Any], dict[str, Any]]:
    """Say hello as the user's page, start a server call, and take its command from the poll."""
    token = bridge.user_token(user)
    status, _, _ = await post(bridge, token, HELLO)
    assert status == 204
    task = asyncio.ensure_future(bridge.user(user).auth.verify_login(LOGIN, **options))
    status, body = await poll(bridge, token, wait=5)
    assert status == 200
    assert len(body["commands"]) == 1
    return task, body["commands"][0]


# -------------------------------------------------------------------------------------------------
# Authentication and request shape
# -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "header",
    [None, "Bearer abc", "Writ", "Writ not-a-token", "Writ a.b.c"],
)
async def test_a_bad_or_missing_token_is_401(clock: FakeClock, header: str | None) -> None:
    bridge = make_bridge()
    headers = {} if header is None else {"Authorization": header}
    status, response_headers, payload = await bridge.handle("GET", headers, "wait=0", b"")
    assert status == 401
    assert response_headers["www-authenticate"] == "Writ"
    assert json.loads(payload)["error"]["code"] == "NOT_GRANTED"


async def test_an_expired_token_or_another_secret_is_401(clock: FakeClock) -> None:
    bridge = make_bridge()
    token = bridge.user_token("u1", ttl_seconds=10)
    clock.advance(11)
    assert (await bridge.handle("GET", auth(token), None, b""))[0] == 401
    foreign = sign_token("another-secret-that-is-long-enough-000", {"v": 1, "typ": "user", "sub": "u1", "exp": 2**40})
    assert (await bridge.handle("GET", auth(foreign), None, b""))[0] == 401


async def test_a_challenge_is_not_a_user_token(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("u1", KEY)
    assert (await bridge.handle("GET", auth(challenge), None, b""))[0] == 401


async def test_scheme_is_case_insensitive_and_headers_may_be_pairs(clock: FakeClock) -> None:
    bridge = make_bridge()
    token = bridge.user_token("u1")
    status, _, payload = await bridge.handle("GET", [(b"authorization", f"writ  {token} ".encode())], b"wait=0", b"")
    assert status == 200 and json.loads(payload) == {"commands": []}


async def test_other_methods_are_405(clock: FakeClock) -> None:
    bridge = make_bridge()
    status, headers, payload = await bridge.handle("PUT", auth(bridge.user_token("u1")), None, b"{}")
    assert status == 405 and headers["allow"] == "GET, POST"
    assert json.loads(payload)["error"]["code"] == "BAD_REQUEST"


@pytest.mark.parametrize(
    "body",
    [b"not json", b"[]", b'{"hello": {}, "run": {}}', b"{}", b'{"hello": {"ready": NaN}}', b"\xff"],
)
async def test_malformed_bodies_are_400(clock: FakeClock, body: bytes) -> None:
    bridge = make_bridge()
    status, _, payload = await bridge.handle("POST", auth(bridge.user_token("u1")), None, body)
    assert status == 400
    assert json.loads(payload)["error"]["code"] == "BAD_REQUEST"


async def test_a_body_over_the_limit_is_413(clock: FakeClock) -> None:
    bridge = make_bridge(max_body_bytes=1_024)
    status, _, payload = await bridge.handle("POST", auth(bridge.user_token("u1")), None, b" " * 1_025)
    assert status == 413
    assert json.loads(payload)["error"]["code"] == "BAD_REQUEST"


@pytest.mark.parametrize("wait", ["-1", "1.5", "abc", "1234567"])
async def test_wait_must_be_whole_seconds(clock: FakeClock, wait: str) -> None:
    bridge = make_bridge()
    status, _, _ = await bridge.handle("GET", auth(bridge.user_token("u1")), {"wait": wait}, b"")
    assert status == 400


async def test_every_answer_is_never_cached(clock: FakeClock) -> None:
    bridge = make_bridge()
    token = bridge.user_token("u1")
    for method, body in (("GET", b""), ("POST", json.dumps(HELLO).encode())):
        _, headers, _ = await bridge.handle(method, auth(token), None, body)
        assert headers["cache-control"] == "no-store"
        assert headers["x-content-type-options"] == "nosniff"


# -------------------------------------------------------------------------------------------------
# Hello and presence
# -------------------------------------------------------------------------------------------------


async def test_hello_marks_the_user_online_for_90_seconds(clock: FakeClock) -> None:
    bridge = make_bridge()
    token = bridge.user_token("u1")
    assert not await bridge.online("u1")
    status, _, payload = await post(bridge, token, HELLO)
    assert status == 204 and payload is None
    assert await bridge.online("u1")
    clock.advance(89)
    assert await bridge.online("u1")
    clock.advance(2)
    assert not await bridge.online("u1")


async def test_a_poll_keeps_the_user_online(clock: FakeClock) -> None:
    bridge = make_bridge()
    token = bridge.user_token("u1", ttl_seconds=3600)
    await post(bridge, token, HELLO)
    clock.advance(80)
    await poll(bridge, token)
    clock.advance(80)
    assert await bridge.online("u1")


async def test_hello_keeps_only_contract_keys_once(clock: FakeClock) -> None:
    bridge = make_bridge()
    token = bridge.user_token("u1")
    body = {"hello": {"ready": True, "granted": [KEY, "other.site.key", KEY], "writ_version": None}}
    assert (await post(bridge, token, body))[0] == 204
    presence = await bridge._store.get_presence("u1")
    assert presence is not None and presence["granted"] == [KEY] and presence["ever_ready"] is True


@pytest.mark.parametrize(
    "hello",
    [
        {"ready": "yes", "granted": []},
        {"ready": True, "granted": "auth.verify_login"},
        {"ready": True, "granted": [1]},
        {"ready": True, "granted": ["k"] * 513},
        {"ready": True, "granted": [], "writ_version": "x" * 65},
        [],
    ],
)
async def test_bad_hellos_are_400(clock: FakeClock, hello: Any) -> None:
    bridge = make_bridge()
    status, _, _ = await post(bridge, bridge.user_token("u1"), {"hello": hello})
    assert status == 400


# -------------------------------------------------------------------------------------------------
# Long-poll and results
# -------------------------------------------------------------------------------------------------


async def test_an_empty_poll_answers_after_its_wait(clock: FakeClock) -> None:
    bridge = make_bridge(poll_seconds=1)
    token = bridge.user_token("u1")
    loop = asyncio.get_running_loop()
    started = loop.time()
    status, body = await asyncio.wait_for(poll(bridge, token, wait=999), timeout=5)
    assert status == 200 and body == {"commands": []}
    assert 0.8 <= loop.time() - started < 4  # wait is capped at poll_seconds


async def test_a_verified_result_answers_the_server_call(clock: FakeClock) -> None:
    bridge = make_bridge()
    task, command = await _start_call(bridge, timeout_ms=5_000)
    assert command["key"] == KEY
    assert command["inputs"] == LOGIN
    assert command["options"] == {"timeout_ms": 5_000}
    assert command["expires_at"] == clock.ms // 1000 + 5
    reading = read_challenge(SECRET, command["challenge"], int(clock.ms // 1000))
    assert reading.ok and reading.payload is not None
    assert reading.payload["nonce"] == command["id"]
    assert reading.payload["sub"] == "u1" and reading.payload["key"] == KEY

    receipt = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], data=DATA)
    token = bridge.user_token("u1")
    status, _, _ = await post(bridge, token, {"result": {"id": command["id"], "ok": True, "data": DATA, "receipt": receipt}})
    assert status == 204

    result = await asyncio.wait_for(task, timeout=5)
    assert result.venue == "user"
    assert result.data == DATA
    assert result.receipt is not None and result.receipt["sig"] == receipt["sig"]

    # The same result again: the command is no longer waiting.
    status, _, payload = await post(bridge, token, {"result": {"id": command["id"], "ok": True, "data": DATA, "receipt": receipt}})
    assert status == 404 and payload["error"]["code"] == "BAD_REQUEST"


async def test_a_result_with_fractions_verifies(clock: FakeClock) -> None:
    bridge = make_bridge()
    task, command = await _start_call(bridge)
    data = {"price": 12.5, "qty": 3, "lines": [{"amount": 0.1}, {"amount": 1e-7}]}
    receipt = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], data=data)
    status, _, _ = await post(
        bridge, bridge.user_token("u1"), {"result": {"id": command["id"], "ok": True, "data": data, "receipt": receipt}}
    )
    assert status == 204
    assert (await asyncio.wait_for(task, timeout=5)).data == data


async def test_dry_run_reaches_the_command(clock: FakeClock) -> None:
    bridge = make_bridge()
    task, command = await _start_call(bridge, dry_run=True)
    assert command["options"] == {"timeout_ms": 120_000, "dry_run": True}
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_a_forged_result_is_result_unverified(clock: FakeClock) -> None:
    bridge = make_bridge()
    task, command = await _start_call(bridge)
    receipt = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], data=DATA)
    forged = {**DATA, "ok": False}
    status, _, _ = await post(
        bridge, bridge.user_token("u1"), {"result": {"id": command["id"], "ok": True, "data": forged, "receipt": receipt}}
    )
    assert status == 204
    with pytest.raises(WritBridgeError) as caught:
        await asyncio.wait_for(task, timeout=5)
    assert caught.value.code == "RESULT_UNVERIFIED"
    assert "the data does not match the receipt" in caught.value.message


@pytest.mark.parametrize(
    "change",
    ["no receipt", "tampered receipt", "other challenge", "other key", "no data", "failed outcome"],
)
async def test_any_unverifiable_success_is_result_unverified(clock: FakeClock, change: str) -> None:
    bridge = make_bridge()
    task, command = await _start_call(bridge)
    receipt: Any = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], data=DATA)
    result: dict[str, Any] = {"id": command["id"], "ok": True, "data": DATA, "receipt": receipt}
    if change == "no receipt":
        del result["receipt"]
    elif change == "tampered receipt":
        receipt["finished_at"] += 1
    elif change == "other challenge":
        result["receipt"] = make_receipt(key=KEY, challenge=bridge.challenge("u1", KEY), data=DATA)
    elif change == "other key":
        result["receipt"] = make_receipt(key="pos.receive", challenge=command["challenge"], inputs=command["inputs"], data=DATA)
    elif change == "no data":
        del result["data"]
    elif change == "failed outcome":
        result["receipt"] = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], outcome="failed", error_code="RUN_FAILED")
    status, _, _ = await post(bridge, bridge.user_token("u1"), {"result": result})
    assert status == 204
    with pytest.raises(WritBridgeError) as caught:
        await asyncio.wait_for(task, timeout=5)
    assert caught.value.code == "RESULT_UNVERIFIED"


async def test_the_first_device_pins_and_another_is_handed_back_to_approve(clock: FakeClock) -> None:
    bridge = make_bridge()
    token = bridge.user_token("u1")
    task, command = await _start_call(bridge)
    receipt = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], data=DATA)
    await post(bridge, token, {"result": {"id": command["id"], "ok": True, "data": DATA, "receipt": receipt}})
    assert (await asyncio.wait_for(task, timeout=5)).venue == "user"

    # A second command answered with another key's genuine receipt.
    second = asyncio.ensure_future(bridge.user("u1").auth.verify_login(LOGIN))
    _, body = await poll(bridge, token, wait=5)
    following = body["commands"][0]
    foreign = make_receipt(key=KEY, challenge=following["challenge"], inputs=following["inputs"], data=DATA, seed=OTHER_SEED)
    status, _, _ = await post(bridge, token, {"result": {"id": following["id"], "ok": True, "data": DATA, "receipt": foreign}})
    assert status == 204
    with pytest.raises(WritBridgeError) as caught:
        await asyncio.wait_for(second, timeout=5)
    assert caught.value.code == "RESULT_UNVERIFIED"
    assert caught.value.details["unknown_device"] is True
    assert caught.value.details["device"] == foreign["device"]
    assert "has not registered" in caught.value.message

    # Approved, that computer's next result is accepted.
    await bridge.approve_device("u1", caught.value.details["device"])
    third = asyncio.ensure_future(bridge.user("u1").auth.verify_login(LOGIN))
    _, body = await poll(bridge, token, wait=5)
    last = body["commands"][0]
    receipt = make_receipt(key=KEY, challenge=last["challenge"], inputs=last["inputs"], data=DATA, seed=OTHER_SEED)
    await post(bridge, token, {"result": {"id": last["id"], "ok": True, "data": DATA, "receipt": receipt}})
    assert (await asyncio.wait_for(third, timeout=5)).venue == "user"


async def test_a_device_the_developer_did_not_pin_is_result_unverified(clock: FakeClock) -> None:
    seen: list[tuple[str, str]] = []

    def registry(user_id: str, device: Any) -> bool:
        seen.append((user_id, device["kid"]))
        return False

    bridge = make_bridge(pin_devices=registry)
    task, command = await _start_call(bridge)
    receipt = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], data=DATA)
    await post(bridge, bridge.user_token("u1"), {"result": {"id": command["id"], "ok": True, "data": DATA, "receipt": receipt}})
    with pytest.raises(WritBridgeError) as caught:
        await asyncio.wait_for(task, timeout=5)
    assert caught.value.code == "RESULT_UNVERIFIED" and caught.value.details["unknown_device"] is True
    assert seen == [("u1", receipt["device"]["kid"])]


async def test_a_tampered_result_does_not_offer_a_device(clock: FakeClock) -> None:
    bridge = make_bridge()
    task, command = await _start_call(bridge)
    receipt = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], data=DATA, seed=OTHER_SEED)
    receipt["run_id"] += 1
    await post(bridge, bridge.user_token("u1"), {"result": {"id": command["id"], "ok": True, "data": DATA, "receipt": receipt}})
    with pytest.raises(WritBridgeError) as caught:
        await asyncio.wait_for(task, timeout=5)
    assert caught.value.code == "RESULT_UNVERIFIED"
    assert "unknown_device" not in caught.value.details


async def test_another_users_result_is_404_and_changes_nothing(clock: FakeClock) -> None:
    bridge = make_bridge()
    task, command = await _start_call(bridge)
    receipt = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], data=DATA)
    body = {"result": {"id": command["id"], "ok": True, "data": DATA, "receipt": receipt}}
    status, _, _ = await post(bridge, bridge.user_token("u2"), body)
    assert status == 404
    assert not task.done()
    status, _, _ = await post(bridge, bridge.user_token("u1"), body)
    assert status == 204
    assert (await asyncio.wait_for(task, timeout=5)).data == DATA


async def test_a_verified_failure_raises_the_visitors_code(clock: FakeClock) -> None:
    bridge = make_bridge()
    task, command = await _start_call(bridge)
    receipt = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], outcome="failed", error_code="RUN_FAILED")
    error = {"code": "RUN_FAILED", "message": "The login was refused."}
    status, _, _ = await post(
        bridge, bridge.user_token("u1"), {"result": {"id": command["id"], "ok": False, "error": error, "receipt": receipt}}
    )
    assert status == 204
    with pytest.raises(WritBridgeError) as caught:
        await asyncio.wait_for(task, timeout=5)
    assert caught.value.code == "RUN_FAILED"
    assert caught.value.message == "The login was refused."
    assert caught.value.details["receipt"]["sig"] == receipt["sig"]
    assert caught.value.details["command_id"] == command["id"]


async def test_an_unknown_visitor_code_becomes_internal(clock: FakeClock) -> None:
    bridge = make_bridge()
    task, command = await _start_call(bridge)
    error = {"code": "SOMETHING_NEW", "message": "?"}
    await post(bridge, bridge.user_token("u1"), {"result": {"id": command["id"], "ok": False, "error": error}})
    with pytest.raises(WritBridgeError) as caught:
        await asyncio.wait_for(task, timeout=5)
    assert caught.value.code == "INTERNAL"
    assert caught.value.details["visitor_code"] == "SOMETHING_NEW"


async def test_not_granted_without_receipt_is_not_granted_in_required_mode(clock: FakeClock) -> None:
    bridge = make_bridge()
    task, command = await _start_call(bridge)
    error = {"code": "NOT_GRANTED", "message": "not granted"}
    await post(bridge, bridge.user_token("u1"), {"result": {"id": command["id"], "ok": False, "error": error}})
    with pytest.raises(WritBridgeError) as caught:
        await asyncio.wait_for(task, timeout=5)
    assert caught.value.code == "NOT_GRANTED"


async def test_a_failure_with_a_forged_receipt_is_result_unverified(clock: FakeClock) -> None:
    bridge = make_bridge()
    task, command = await _start_call(bridge)
    receipt = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], outcome="failed", error_code="RUN_FAILED")
    receipt["error_code"] = "CANCELLED"
    error = {"code": "CANCELLED", "message": "x"}
    await post(bridge, bridge.user_token("u1"), {"result": {"id": command["id"], "ok": False, "error": error, "receipt": receipt}})
    with pytest.raises(WritBridgeError) as caught:
        await asyncio.wait_for(task, timeout=5)
    assert caught.value.code == "RESULT_UNVERIFIED"


async def test_a_command_nobody_picks_up_is_user_offline(clock: FakeClock, monkeypatch: pytest.MonkeyPatch) -> None:
    import usewrit.bridge as bridge_module

    monkeypatch.setattr(bridge_module, "PICKUP_TIMEOUT_MS", 200)
    bridge = make_bridge()
    token = bridge.user_token("u1")
    await post(bridge, token, HELLO)
    with pytest.raises(WritBridgeError) as caught:
        await asyncio.wait_for(bridge.user("u1").auth.verify_login(LOGIN), timeout=5)
    assert caught.value.code == "USER_OFFLINE"
    # The command was taken back: a later poll does not run it.
    assert (await poll(bridge, token))[1] == {"commands": []}


async def test_a_picked_up_command_that_never_answers_times_out(clock: FakeClock, monkeypatch: pytest.MonkeyPatch) -> None:
    import usewrit.bridge as bridge_module

    monkeypatch.setattr(bridge_module, "RESULT_GRACE_MS", 0)
    monkeypatch.setattr(bridge_module, "PICKUP_TIMEOUT_MS", 100)
    bridge = make_bridge()
    task, command = await _start_call(bridge, timeout_ms=1_000)
    with pytest.raises(WritBridgeError) as caught:
        await asyncio.wait_for(task, timeout=5)
    assert caught.value.code == "TIMEOUT"
    # Too late: the command is forgotten.
    receipt = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], data=DATA)
    status, _, _ = await post(
        bridge, bridge.user_token("u1"), {"result": {"id": command["id"], "ok": True, "data": DATA, "receipt": receipt}}
    )
    assert status == 404


async def test_a_disconnected_poll_gives_its_commands_back(clock: FakeClock) -> None:
    bridge = make_bridge()
    token = bridge.user_token("u1")
    await post(bridge, token, HELLO)
    gone = asyncio.Event()
    waiting = asyncio.ensure_future(bridge.handle("GET", auth(token), {"wait": "5"}, b"", disconnected=gone))
    await asyncio.sleep(0.05)
    gone.set()
    status, _, payload = await asyncio.wait_for(waiting, timeout=5)
    assert status == 200 and json.loads(payload) == {"commands": []}
    # A command queued afterwards is still there for the next poll.
    task = asyncio.ensure_future(bridge.user("u1").auth.verify_login(LOGIN))
    status, body = await poll(bridge, token, wait=5)
    assert len(body["commands"]) == 1
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_a_cancelled_call_withdraws_its_command(clock: FakeClock) -> None:
    bridge = make_bridge()
    token = bridge.user_token("u1")
    await post(bridge, token, HELLO)
    task = asyncio.ensure_future(bridge.user("u1").auth.verify_login(LOGIN))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert (await poll(bridge, token))[1] == {"commands": []}


async def test_expired_commands_are_not_handed_out(clock: FakeClock) -> None:
    bridge = make_bridge()
    token = bridge.user_token("u1", ttl_seconds=3600)
    await post(bridge, token, HELLO)
    task = asyncio.ensure_future(bridge.user("u1").auth.verify_login(LOGIN, timeout_ms=1_000))
    await asyncio.sleep(0.05)
    clock.advance(2)
    assert (await poll(bridge, token))[1] == {"commands": []}
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# -------------------------------------------------------------------------------------------------
# Page calls routed to Writ Cloud are covered in test_cloud.py; in required mode they are refused.
# -------------------------------------------------------------------------------------------------


async def test_a_page_run_in_required_mode_is_writ_required(clock: FakeClock) -> None:
    bridge = make_bridge()
    status, _, payload = await post(bridge, bridge.user_token("u1"), {"run": {"key": KEY, "inputs": LOGIN}})
    assert status == 403
    assert payload["error"]["code"] == "WRIT_REQUIRED"


async def test_a_page_run_of_an_unknown_function_is_input_invalid(clock: FakeClock) -> None:
    bridge = make_bridge()
    status, _, payload = await post(bridge, bridge.user_token("u1"), {"run": {"key": "nope.nothing", "inputs": {}}})
    assert status == 400 and payload["error"]["code"] == "INPUT_INVALID"
    status, _, payload = await post(bridge, bridge.user_token("u1"), {"run": {"key": "Bad Key", "inputs": {}}})
    assert status == 400 and payload["error"]["code"] == "BAD_REQUEST"


async def test_origin_header_is_not_needed(clock: FakeClock) -> None:
    bridge = make_bridge()
    task, command = await _start_call(bridge)
    receipt = make_receipt(key=KEY, challenge=command["challenge"], inputs=command["inputs"], data=DATA, origin=ORIGIN)
    await post(bridge, bridge.user_token("u1"), {"result": {"id": command["id"], "ok": True, "data": DATA, "receipt": receipt}})
    assert (await asyncio.wait_for(task, timeout=5)).venue == "user"
