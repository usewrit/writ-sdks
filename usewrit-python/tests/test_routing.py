"""Where a call runs (CONTRACT.md §12.4, WRIT_BRIDGE_DESIGN.md §2-3), and the nested proxy."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from usewrit import BridgeResult, FunctionNamespace, WritBridgeError

from .conftest import FakeClock
from .helpers import HELLO, LOGIN, CloudStub, cloud_bridge, contract_doc, make_bridge, make_receipt, poll, post

KEY = "auth.verify_login"
DATA = {"ok": True}


async def _answer_next_command(bridge: Any, user: str = "u1") -> dict[str, Any]:
    """Act as the user's page: take the next command and post a verified result."""
    token = bridge.user_token(user)
    _, body = await poll(bridge, token, wait=5)
    command = body["commands"][0]
    receipt = make_receipt(key=command["key"], challenge=command["challenge"], inputs=command["inputs"], data=DATA)
    status, _, _ = await post(bridge, token, {"result": {"id": command["id"], "ok": True, "data": DATA, "receipt": receipt}})
    assert status == 204
    return command


# -------------------------------------------------------------------------------------------------
# required
# -------------------------------------------------------------------------------------------------


async def test_required_without_a_user_is_writ_required(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    with pytest.raises(WritBridgeError) as caught:
        await bridge.auth.verify_login(LOGIN)
    assert caught.value.code == "WRIT_REQUIRED"


async def test_required_for_a_user_never_seen_is_writ_required(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    with pytest.raises(WritBridgeError) as caught:
        await bridge.user("u1").auth.verify_login(LOGIN)
    assert caught.value.code == "WRIT_REQUIRED"


async def test_required_for_a_user_whose_pages_left_is_user_offline(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    await post(bridge, bridge.user_token("u1"), HELLO)
    clock.advance(91)
    with pytest.raises(WritBridgeError) as caught:
        await bridge.user("u1").auth.verify_login(LOGIN)
    assert caught.value.code == "USER_OFFLINE"


async def test_required_with_writ_not_ready_is_writ_required(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    await post(bridge, bridge.user_token("u1"), {"hello": {"ready": False, "granted": [], "writ_version": None}})
    with pytest.raises(WritBridgeError) as caught:
        await bridge.user("u1").auth.verify_login(LOGIN)
    assert caught.value.code == "WRIT_REQUIRED"


async def test_required_with_the_key_not_granted_is_not_granted(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    await post(bridge, bridge.user_token("u1"), {"hello": {"ready": True, "granted": [], "writ_version": "1.0.7"}})
    with pytest.raises(WritBridgeError) as caught:
        await bridge.user("u1").auth.verify_login(LOGIN)
    assert caught.value.code == "NOT_GRANTED"


async def test_required_runs_on_the_users_computer(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    await post(bridge, bridge.user_token("u1"), HELLO)
    task = asyncio.ensure_future(bridge.user("u1").auth.verify_login(LOGIN))
    command = await _answer_next_command(bridge)
    result = await asyncio.wait_for(task, timeout=5)
    assert result == BridgeResult(data=DATA, venue="user", receipt=result.receipt)
    assert result.receipt is not None and result.receipt["challenge"] == command["challenge"]


async def test_wait_for_user_waits_for_the_page_to_arrive(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    task = asyncio.ensure_future(bridge.user("u1").auth.verify_login(LOGIN, wait_for_user_ms=5_000))
    await asyncio.sleep(0.3)
    assert not task.done()
    await post(bridge, bridge.user_token("u1"), HELLO)
    await _answer_next_command(bridge)
    assert (await asyncio.wait_for(task, timeout=5)).venue == "user"


async def test_wait_for_user_gives_up(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    loop = asyncio.get_running_loop()
    started = loop.time()
    with pytest.raises(WritBridgeError) as caught:
        await bridge.user("u1").auth.verify_login(LOGIN, wait_for_user_ms=300)
    assert caught.value.code == "WRIT_REQUIRED"
    assert loop.time() - started >= 0.25


async def test_a_local_network_function_is_required_even_in_a_cloud_bridge(clock: FakeClock) -> None:
    bridge, stub = cloud_bridge("recommended")
    with pytest.raises(WritBridgeError) as caught:
        await bridge.user("u1").pos.receive({"invoice_no": "F-1"})
    assert caught.value.code == "WRIT_REQUIRED"
    with pytest.raises(WritBridgeError) as caught:
        await bridge.pos.receive({"invoice_no": "F-1"})
    assert caught.value.code == "WRIT_REQUIRED"
    assert stub.requests == []


async def test_a_function_reaching_a_lan_host_setting_is_required_too(clock: FakeClock) -> None:
    # No local_network in the contract: the address is each visitor's own setting, which Writ Cloud
    # can't reach either.
    doc = contract_doc()
    pos = doc["functions"][1]
    pos["local_network"] = []
    pos["settings"] = [{"key": "pos_host", "label": "Your POS address", "kind": "lan_host"}]
    bridge, stub = cloud_bridge("recommended", contract=doc)
    assert bridge.mode_of("pos.receive") == "required"
    with pytest.raises(WritBridgeError) as caught:
        await bridge.pos.receive({"invoice_no": "F-1"})
    assert caught.value.code == "WRIT_REQUIRED"
    assert stub.requests == []
    pos["mode"] = "cloud"
    pos["cloud"] = {"workflow_id": 9, "function": None}
    with pytest.raises(WritBridgeError) as caught:
        make_bridge("recommended", contract=doc, api_key="wrk_test")
    assert caught.value.code == "CONFIG_INVALID"
    assert "{{pos_host}}" in caught.value.message


# -------------------------------------------------------------------------------------------------
# recommended / cloud
# -------------------------------------------------------------------------------------------------


async def test_recommended_runs_on_the_user_when_ready(clock: FakeClock) -> None:
    bridge, stub = cloud_bridge("recommended")
    await post(bridge, bridge.user_token("u1"), HELLO)
    task = asyncio.ensure_future(bridge.user("u1").auth.verify_login(LOGIN))
    await _answer_next_command(bridge)
    assert (await asyncio.wait_for(task, timeout=5)).venue == "user"
    assert stub.requests == []


@pytest.mark.parametrize("hello", [None, {"ready": False, "granted": [], "writ_version": None}, {"ready": True, "granted": [], "writ_version": "1"}])
async def test_recommended_falls_to_writ_cloud_otherwise(clock: FakeClock, hello: Any) -> None:
    bridge, stub = cloud_bridge("recommended")
    if hello is not None:
        await post(bridge, bridge.user_token("u1"), {"hello": hello})
    result = await bridge.user("u1").auth.verify_login(LOGIN)
    assert result == BridgeResult(data={"ok": True}, venue="cloud", receipt=None)
    assert len(stub.run_requests) == 1


async def test_recommended_falls_to_writ_cloud_when_nobody_picks_up(clock: FakeClock, monkeypatch: pytest.MonkeyPatch) -> None:
    import usewrit.bridge as bridge_module

    monkeypatch.setattr(bridge_module, "PICKUP_TIMEOUT_MS", 100)
    bridge, stub = cloud_bridge("recommended")
    await post(bridge, bridge.user_token("u1"), HELLO)
    result = await asyncio.wait_for(bridge.user("u1").auth.verify_login(LOGIN), timeout=5)
    assert result.venue == "cloud"
    assert len(stub.run_requests) == 1


async def test_cloud_mode_runs_on_writ_cloud_even_when_the_user_is_ready(clock: FakeClock) -> None:
    bridge, stub = cloud_bridge("cloud")
    await post(bridge, bridge.user_token("u1"), HELLO)
    result = await bridge.user("u1").auth.verify_login(LOGIN)
    assert result.venue == "cloud"
    _, body = await poll(bridge, bridge.user_token("u1"))
    assert body == {"commands": []}


async def test_without_a_user_recommended_and_cloud_run_on_writ_cloud(clock: FakeClock) -> None:
    for mode in ("recommended", "cloud"):
        bridge, stub = cloud_bridge(mode)
        result = await bridge.auth.verify_login(LOGIN, timeout_ms=10_000)
        assert result.venue == "cloud" and result.data == {"ok": True}
        assert stub.run_body_sent() == {"form_data": LOGIN, "function_name": "verify_login"}


async def test_function_modes_route_one_function_differently(clock: FakeClock) -> None:
    bridge, stub = cloud_bridge("required", function_modes={KEY: "cloud"})
    assert (await bridge.auth.verify_login(LOGIN)).venue == "cloud"


# -------------------------------------------------------------------------------------------------
# Validation happens before routing
# -------------------------------------------------------------------------------------------------


async def test_inputs_are_checked_before_routing(clock: FakeClock) -> None:
    bridge, stub = cloud_bridge("recommended")
    for call in (
        bridge.auth.verify_login({"company": "acme"}),
        bridge.user("u1").auth.verify_login({"company": "acme", "username": "z", "other": 1}),
        bridge.auth.verify_login(["acme"]),  # type: ignore[arg-type]
    ):
        with pytest.raises(WritBridgeError) as caught:
            await call
        assert caught.value.code == "INPUT_INVALID"
    # Even in required mode with no user, bad inputs say INPUT_INVALID, not WRIT_REQUIRED.
    with pytest.raises(WritBridgeError) as caught:
        await make_bridge("required").auth.verify_login({})
    assert caught.value.code == "INPUT_INVALID"
    assert stub.requests == []


@pytest.mark.parametrize(
    "options",
    [
        {"timeout_ms": 999},
        {"timeout_ms": 900_001},
        {"timeout_ms": 1.5e3},
        {"timeout_ms": True},
        {"wait_for_user_ms": -1},
        {"wait_for_user_ms": 900_001},
        {"dry_run": "yes"},
    ],
)
async def test_call_options_are_checked(clock: FakeClock, options: dict[str, Any]) -> None:
    bridge = make_bridge("required")
    with pytest.raises(WritBridgeError) as caught:
        await bridge.user("u1").auth.verify_login(LOGIN, **options)
    assert caught.value.code == "BAD_REQUEST"


@pytest.mark.parametrize("user_id", ["", "x" * 257, "a\nb", True, 1.5, None, 2**60])
def test_bad_user_ids_are_input_invalid(clock: FakeClock, user_id: Any) -> None:
    bridge = make_bridge("required")
    with pytest.raises(WritBridgeError) as caught:
        bridge.user(user_id)
    assert caught.value.code == "INPUT_INVALID"
    with pytest.raises(WritBridgeError):
        bridge.user_token(user_id)


def test_an_integer_user_id_is_its_text(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    assert bridge.user_token(42) == bridge.user_token("42")


# -------------------------------------------------------------------------------------------------
# The nested proxy
# -------------------------------------------------------------------------------------------------


def test_dotted_keys_nest(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    user = bridge.user("u1")
    assert isinstance(user.auth, FunctionNamespace)
    assert isinstance(user.auth.verify_login, FunctionNamespace)
    assert isinstance(user["auth.verify_login"], FunctionNamespace)
    assert isinstance(bridge.pos.receive, FunctionNamespace)
    assert isinstance(bridge["pos.receive"], FunctionNamespace)
    assert "auth" in dir(bridge) and "pos" in dir(bridge)
    assert dir(user) == ["auth", "pos"]
    assert dir(user.auth) == ["verify_login"]
    assert "verify_login" in repr(user.auth.verify_login) and "u1" in repr(user.auth.verify_login)


def test_unknown_names_are_attribute_errors(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    with pytest.raises(AttributeError):
        bridge.user("u1").auth.nope  # noqa: B018
    with pytest.raises(AttributeError):
        bridge.nothing  # noqa: B018
    with pytest.raises(KeyError):
        bridge.user("u1")["auth.nope"]
    assert not hasattr(bridge, "_private")
    assert not hasattr(bridge.user("u1"), "__wrapped__")


async def test_calling_a_namespace_is_bad_request(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    with pytest.raises(WritBridgeError) as caught:
        await bridge.user("u1").auth({})
    assert caught.value.code == "BAD_REQUEST"
    assert "verify_login" in caught.value.message
    with pytest.raises(WritBridgeError) as caught:
        await bridge.user("u1")({})
    assert caught.value.code == "BAD_REQUEST"


def test_bridge_members_win_over_the_contract(clock: FakeClock) -> None:
    bridge = make_bridge("required")
    assert callable(bridge.user) and not isinstance(bridge.user, FunctionNamespace)
    assert bridge.contract.keys == ("auth.verify_login", "pos.receive")


async def test_a_page_run_carries_dry_run_and_clamps_the_timeout(clock: FakeClock) -> None:
    stub = CloudStub()
    bridge, _ = cloud_bridge("recommended", stub)
    body = {"run": {"key": KEY, "inputs": LOGIN, "options": {"timeout_ms": 5, "dry_run": True}}}
    status, _, payload = await post(bridge, bridge.user_token("u1"), body)
    assert status == 200 and payload == {"data": {"ok": True}, "venue": "cloud"}
    sent = json.loads(stub.run_requests[0].content)
    assert sent == {"form_data": LOGIN, "function_name": "verify_login", "mutation_mode": "dry_run"}
