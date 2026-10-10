"""Page-initiated gates: ``bridge.challenge()`` then ``bridge.verify()`` (CONTRACT.md §12.2, §12.4)."""

from __future__ import annotations

from typing import Any

import pytest

from usewrit import MemoryStore, WritBridgeError, read_challenge

from .conftest import FakeClock
from .helpers import ORIGIN, OTHER_SEED, SECRET, SEED, make_bridge, make_receipt

KEY = "auth.verify_login"
DATA = {"ok": True, "user": "Zoé", "n": 3}


async def test_a_genuine_receipt_for_the_challenge_verifies_once(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY)
    receipt = make_receipt(key=KEY, challenge=challenge, data=DATA)

    first = await bridge.verify(receipt, challenge=challenge, key=KEY, origin=ORIGIN, data=DATA)
    assert first.ok and first.outcome == "success" and first.reason is None
    assert first.device is not None and first.device["alg"] == "Ed25519"

    second = await bridge.verify(receipt, challenge=challenge, key=KEY, origin=ORIGIN, data=DATA)
    assert not second.ok
    assert second.reason == "the challenge was already used"
    assert second.outcome == "success"


async def test_verify_checks_what_the_call_ran_with(clock: FakeClock) -> None:
    """A page can't run the function with one account's sign-in and claim another: given ``inputs``,
    the receipt's ``inputs_hash`` must be theirs."""
    bridge = make_bridge()
    signin = {"company": "acme", "username": "zoe", "password": "right"}
    data = {"store_id": 7}
    challenge = bridge.challenge("acme/zoe", "auth.verify_login")
    receipt = make_receipt(key="auth.verify_login", challenge=challenge, data=data, inputs=signin)
    other = {**signin, "username": "mallory"}
    result = await bridge.verify(receipt, challenge=challenge, key="auth.verify_login", data=data, inputs=other)
    assert not result.ok and result.reason == "the call ran with other inputs than these"
    again = bridge.challenge("acme/zoe", "auth.verify_login")
    good = make_receipt(key="auth.verify_login", challenge=again, data=data, inputs=signin)
    assert (await bridge.verify(good, challenge=again, key="auth.verify_login", data=data, inputs=signin)).ok
    third = bridge.challenge("acme/zoe", "auth.verify_login")
    silent = make_receipt(key="auth.verify_login", challenge=third, data=data)
    assert not (await bridge.verify(silent, challenge=third, key="auth.verify_login", data=data, inputs=signin)).ok


async def test_the_challenge_carries_subject_key_and_a_fresh_nonce(clock: FakeClock) -> None:
    bridge = make_bridge()
    one = read_challenge(SECRET, bridge.challenge("user-42", KEY, ttl_seconds=60), 0)
    two = read_challenge(SECRET, bridge.challenge(42, KEY), 0)
    assert one.ok and one.payload is not None and two.ok and two.payload is not None
    assert one.payload["sub"] == "user-42" and one.payload["key"] == KEY
    assert one.payload["exp"] == clock.ms // 1000 + 60
    assert two.payload["sub"] == "42" and two.payload["exp"] == clock.ms // 1000 + 120
    assert one.payload["nonce"] != two.payload["nonce"]


async def test_an_expired_challenge_fails(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY)
    receipt = make_receipt(key=KEY, challenge=challenge, data=DATA)
    clock.advance(121)
    result = await bridge.verify(receipt, challenge=challenge, key=KEY, data=DATA)
    assert not result.ok and result.reason == "the challenge expired"


async def test_a_spent_nonce_expires_with_its_challenge(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY, ttl_seconds=5)
    receipt = make_receipt(key=KEY, challenge=challenge, data=DATA)
    assert (await bridge.verify(receipt, challenge=challenge, key=KEY)).ok
    clock.advance(10)
    # Past exp the nonce may be forgotten, but the challenge itself is expired by then.
    late = await bridge.verify(receipt, challenge=challenge, key=KEY)
    assert not late.ok and late.reason == "the challenge expired"


async def test_a_receipt_for_another_challenge_fails(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY)
    other = bridge.challenge("user-42", KEY)
    receipt = make_receipt(key=KEY, challenge=other, data=DATA)
    result = await bridge.verify(receipt, challenge=challenge, key=KEY, data=DATA)
    assert not result.ok and result.reason == "the receipt answers another challenge"
    # A failed check does not spend the challenge: the real receipt still verifies.
    real = make_receipt(key=KEY, challenge=challenge, data=DATA)
    assert (await bridge.verify(real, challenge=challenge, key=KEY, data=DATA)).ok


async def test_a_receipt_without_a_challenge_fails(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY)
    receipt = make_receipt(key=KEY, challenge=None, data=DATA)
    result = await bridge.verify(receipt, challenge=challenge, key=KEY)
    assert not result.ok and result.reason == "the receipt carries no challenge"


async def test_a_challenge_for_another_function_fails(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", "pos.receive")
    receipt = make_receipt(key=KEY, challenge=challenge, data=DATA)
    result = await bridge.verify(receipt, challenge=challenge, key=KEY, data=DATA)
    assert not result.ok and result.reason == "the challenge was minted for another function"
    receipt = make_receipt(key="pos.receive", challenge=challenge, data=DATA)
    result = await bridge.verify(receipt, challenge=challenge, key=KEY, data=DATA)
    assert not result.ok and result.reason == 'the receipt is for "pos.receive", not "auth.verify_login"'


async def test_a_forged_challenge_fails(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY)
    body, _, mac = challenge.partition(".")
    forged = f"{body}.{'A' if mac[0] != 'A' else 'B'}{mac[1:]}"
    receipt = make_receipt(key=KEY, challenge=forged, data=DATA)
    result = await bridge.verify(receipt, challenge=forged, key=KEY, data=DATA)
    assert not result.ok and result.reason == "the challenge was not minted by this server"


async def test_origin_subject_and_data_must_match(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY)
    receipt = make_receipt(key=KEY, challenge=challenge, data=DATA)

    assert (await bridge.verify(receipt, challenge=challenge, key=KEY, origin="https://evil.example.com")).reason == (
        "the receipt comes from https://app.example.com, not https://evil.example.com"
    )
    assert (await bridge.verify(receipt, challenge=challenge, key=KEY, subject="user-7")).reason == (
        "the challenge was minted for another subject"
    )
    changed = await bridge.verify(receipt, challenge=challenge, key=KEY, data={**DATA, "n": 4})
    assert not changed.ok and changed.reason == "the data does not match the receipt"
    # The data check comes after the challenge is spent, as in the Node twin.
    again = await bridge.verify(receipt, challenge=challenge, key=KEY, data=DATA)
    assert again.reason == "the challenge was already used"


async def test_origin_is_compared_as_an_origin(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY)
    receipt = make_receipt(key=KEY, challenge=challenge, data=DATA)
    result = await bridge.verify(receipt, challenge=challenge, key=KEY, origin="https://APP.example.com:443/login")
    assert result.ok


async def test_data_with_fractions_verifies(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY)
    data = {"price": 12.5, "qty": 3, "ratio": 1.0}
    receipt = make_receipt(key=KEY, challenge=challenge, data=data)
    result = await bridge.verify(receipt, challenge=challenge, key=KEY, data={"price": 12.5, "qty": 3, "ratio": 1})
    assert result.ok, result.reason


async def test_data_without_a_canonical_form_fails(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY)
    receipt = make_receipt(key=KEY, challenge=challenge, data={"price": 12})
    result = await bridge.verify(receipt, challenge=challenge, key=KEY, data={"price": float("nan")})
    assert not result.ok and result.reason is not None and result.reason.startswith("the data has no canonical form")


async def test_null_data_is_checked_and_unset_data_is_not(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY)
    receipt = make_receipt(key=KEY, challenge=challenge, data=None)
    assert (await bridge.verify(receipt, challenge=challenge, key=KEY, data=None)).ok

    challenge = bridge.challenge("user-42", KEY)
    receipt = make_receipt(key=KEY, challenge=challenge, data={"any": "thing"})
    assert (await bridge.verify(receipt, challenge=challenge, key=KEY)).ok


async def test_a_failed_call_is_genuine_but_not_ok(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY)
    receipt = make_receipt(key=KEY, challenge=challenge, outcome="failed", error_code="RUN_FAILED")
    result = await bridge.verify(receipt, challenge=challenge, key=KEY)
    assert not result.ok
    assert result.outcome == "failed"
    assert result.reason == 'the call ended "failed" (RUN_FAILED)'
    assert result.device is not None


async def test_a_tampered_receipt_is_not_genuine(clock: FakeClock) -> None:
    bridge = make_bridge()
    challenge = bridge.challenge("user-42", KEY)
    receipt = make_receipt(key=KEY, challenge=challenge, data=DATA)
    receipt["run_id"] = 8
    result = await bridge.verify(receipt, challenge=challenge, key=KEY)
    assert not result.ok and result.outcome is None and result.device is None
    assert result.reason == "the receipt signature does not verify"


async def test_pin_devices_decides_which_keys_are_accepted(clock: FakeClock) -> None:
    seen: list[tuple[str, Any]] = []

    async def pin(subject: str, device: Any) -> bool:
        seen.append((subject, device["kid"]))
        return device["public_key"] == make_receipt(key=KEY, challenge=None)["device"]["public_key"]

    bridge = make_bridge(pin_devices=pin)
    challenge = bridge.challenge("user-42", KEY)
    stranger = make_receipt(key=KEY, challenge=challenge, data=DATA, seed=OTHER_SEED)
    refused = await bridge.verify(stranger, challenge=challenge, key=KEY)
    assert not refused.ok and refused.reason == "the receipt was signed by a device this user has not registered"
    assert refused.unknown_device is True
    known = make_receipt(key=KEY, challenge=challenge, data=DATA)
    assert (await bridge.verify(known, challenge=challenge, key=KEY)).ok
    assert [subject for subject, _ in seen] == ["user-42", "user-42"]


async def test_the_first_device_pins_and_another_waits_for_approval(clock: FakeClock) -> None:
    bridge = make_bridge()
    first = bridge.challenge("u1", KEY)
    result = await bridge.verify(make_receipt(key=KEY, challenge=first, data=DATA), challenge=first, key=KEY, data=DATA)
    assert result.ok and result.unknown_device is False

    # A receipt signed by another key: a second computer, or a forgery made with a fresh key.
    second = bridge.challenge("u1", KEY)
    foreign = make_receipt(key=KEY, challenge=second, data=DATA, seed=OTHER_SEED)
    refused = await bridge.verify(foreign, challenge=second, key=KEY, data=DATA)
    assert not refused.ok and refused.unknown_device is True
    assert refused.reason == "the receipt was signed by a device this user has not registered"
    assert refused.outcome == "success" and refused.device == foreign["device"]

    # Another user is a different subject: its own first device pins.
    other_user = bridge.challenge("u2", KEY)
    receipt = make_receipt(key=KEY, challenge=other_user, data=DATA, seed=OTHER_SEED)
    assert (await bridge.verify(receipt, challenge=other_user, key=KEY, data=DATA)).ok

    # Approved by the developer, the second computer verifies.
    await bridge.approve_device("u1", foreign["device"])
    third = bridge.challenge("u1", KEY)
    receipt = make_receipt(key=KEY, challenge=third, data=DATA, seed=OTHER_SEED)
    assert (await bridge.verify(receipt, challenge=third, key=KEY, data=DATA)).ok
    for bad in ("not a key", "", {"public_key": 42}, {"kid": "x"}, 42):
        with pytest.raises(WritBridgeError) as caught:
            await bridge.approve_device("u1", bad)  # type: ignore[arg-type]
        assert caught.value.code == "BAD_REQUEST" and "approve_device" in caught.value.message

    # Forgotten, the next device pins anew, and the old one is then the stranger.
    await bridge.forget_devices("u1")
    fourth = bridge.challenge("u1", KEY)
    receipt = make_receipt(key=KEY, challenge=fourth, data=DATA, seed=OTHER_SEED)
    assert (await bridge.verify(receipt, challenge=fourth, key=KEY, data=DATA)).ok
    fifth = bridge.challenge("u1", KEY)
    receipt = make_receipt(key=KEY, challenge=fifth, data=DATA)
    assert (await bridge.verify(receipt, challenge=fifth, key=KEY, data=DATA)).unknown_device is True


async def test_an_unknown_device_does_not_spend_the_challenge(clock: FakeClock) -> None:
    bridge = make_bridge()
    first = bridge.challenge("u1", KEY)
    assert (await bridge.verify(make_receipt(key=KEY, challenge=first, data=DATA), challenge=first, key=KEY)).ok
    second = bridge.challenge("u1", KEY)
    foreign = make_receipt(key=KEY, challenge=second, data=DATA, seed=OTHER_SEED)
    assert (await bridge.verify(foreign, challenge=second, key=KEY)).unknown_device
    # Approved by its public key alone, the same receipt now answers its still-unspent challenge.
    await bridge.approve_device("u1", foreign["device"]["public_key"])
    assert (await bridge.verify(foreign, challenge=second, key=KEY)).ok


async def test_pinning_off_accepts_any_signer(clock: FakeClock) -> None:
    bridge = make_bridge(pin_devices="off")
    for seed in (SEED, OTHER_SEED):
        challenge = bridge.challenge("u1", KEY)
        receipt = make_receipt(key=KEY, challenge=challenge, data=DATA, seed=seed)
        assert (await bridge.verify(receipt, challenge=challenge, key=KEY, data=DATA)).ok


@pytest.mark.parametrize("policy", ["sometimes", "", None, 1, True])
def test_a_bad_pin_devices_is_config_invalid(clock: FakeClock, policy: Any) -> None:
    with pytest.raises(WritBridgeError) as caught:
        make_bridge(pin_devices=policy)
    assert caught.value.code == "CONFIG_INVALID"
    assert "pin_devices" in caught.value.message


async def test_a_raising_hook_or_store_refuses(clock: FakeClock) -> None:
    def broken_hook(subject: str, device: Any) -> bool:
        raise RuntimeError("registry down")

    bridge = make_bridge(pin_devices=broken_hook)
    challenge = bridge.challenge("u1", KEY)
    result = await bridge.verify(make_receipt(key=KEY, challenge=challenge, data=DATA), challenge=challenge, key=KEY)
    assert not result.ok and result.unknown_device is True

    class BrokenStore(MemoryStore):
        async def check_device(self, subject: str, public_key: str, first_use: bool) -> Any:
            raise ConnectionError("store down")

    bridge = make_bridge(store=BrokenStore())
    challenge = bridge.challenge("u1", KEY)
    result = await bridge.verify(make_receipt(key=KEY, challenge=challenge, data=DATA), challenge=challenge, key=KEY)
    assert not result.ok and result.unknown_device is True


async def test_a_callable_must_answer_true_itself(clock: FakeClock) -> None:
    bridge = make_bridge(pin_devices=lambda subject, device: "yes")
    challenge = bridge.challenge("u1", KEY)
    result = await bridge.verify(make_receipt(key=KEY, challenge=challenge, data=DATA), challenge=challenge, key=KEY)
    assert not result.ok and result.unknown_device is True


async def test_bad_arguments_raise(clock: FakeClock) -> None:
    bridge = make_bridge()
    with pytest.raises(WritBridgeError) as caught:
        bridge.challenge("user-42", "nope.nothing")
    assert caught.value.code == "INPUT_INVALID"
    with pytest.raises(WritBridgeError) as caught:
        bridge.challenge("", KEY)
    assert caught.value.code == "INPUT_INVALID"
    with pytest.raises(WritBridgeError) as caught:
        bridge.challenge("user-42", KEY, ttl_seconds=0)
    assert caught.value.code == "BAD_REQUEST"
    with pytest.raises(WritBridgeError) as caught:
        await bridge.verify({}, challenge=None, key=KEY)  # type: ignore[arg-type]
    assert caught.value.code == "BAD_REQUEST"
    # A receipt that is not even an object is a failed check, never an exception.
    result = await bridge.verify("not a receipt", challenge=bridge.challenge("u", KEY), key=KEY)
    assert not result.ok and result.reason == "the receipt is not JSON"
