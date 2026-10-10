"""Golden vectors shared with the Writ engine and the Node twin (CONTRACT.md §12.1, §12.2).

The vectors are read from their shared homes when they are at hand: the SDK repository's
``fixtures/bridge_tokens_golden.json``, and the Writ engine's receipt golden file when
``WRIT_RECEIPT_GOLDEN`` names it (the monorepo's publish script does). ``fixtures/`` holds
byte-for-byte copies for a checkout of this package alone, and a test keeps them so.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from usewrit import tokens
from usewrit.canonical import b64url_decode, b64url_encode, canonical_json, data_hash
from usewrit.receipt import kid_of, receipt_signing_bytes, verify_receipt_signature
from usewrit.tokens import open_token, read_challenge, read_user_token, sign_token

from .helpers import FIXTURES, OTHER_SEED, make_bridge, resign

_ENGINE_RECEIPT = os.environ.get("WRIT_RECEIPT_GOLDEN")
if _ENGINE_RECEIPT and not Path(_ENGINE_RECEIPT).is_file():
    raise RuntimeError(f"WRIT_RECEIPT_GOLDEN names {_ENGINE_RECEIPT}, which is not a file")
_SHARED: dict[str, Path | None] = {
    "bridge_tokens_golden.json": Path(__file__).resolve().parents[2] / "fixtures" / "bridge_tokens_golden.json",
    "receipt_golden.json": Path(_ENGINE_RECEIPT) if _ENGINE_RECEIPT else None,
}


def _golden(name: str) -> dict[str, Any]:
    shared = _SHARED[name]
    path = shared if shared is not None and shared.exists() else FIXTURES / name
    loaded: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return loaded


TOKENS: dict[str, Any] = _golden("bridge_tokens_golden.json")
RECEIPT_FILE: dict[str, Any] = _golden("receipt_golden.json")
GOLDEN_RECEIPT: dict[str, Any] = RECEIPT_FILE["receipt"]


def _canonical_pairs(node: Any, where: str) -> list[tuple[str, Any, str]]:
    """Every ``(value, canonical text)`` pair a golden file declares, wherever it sits: a key ``X``
    beside ``X_canonical``, or an object ``{"value", "canonical"}``."""
    pairs: list[tuple[str, Any, str]] = []
    if isinstance(node, dict):
        if "value" in node and isinstance(node.get("canonical"), str):
            pairs.append((where, node["value"], node["canonical"]))
        for name, item in node.items():
            twin = node.get(f"{name}_canonical")
            if isinstance(twin, str) and not name.endswith("_canonical"):
                pairs.append((f"{where}.{name}", item, twin))
            pairs.extend(_canonical_pairs(item, f"{where}.{name}"))
    elif isinstance(node, list):
        for index, item in enumerate(node):
            pairs.extend(_canonical_pairs(item, f"{where}[{index}]"))
    return pairs


_PAIRS = _canonical_pairs(TOKENS, "tokens") + _canonical_pairs(RECEIPT_FILE, "receipt")


@pytest.mark.parametrize(("where", "value", "expected"), _PAIRS, ids=[where for where, _, _ in _PAIRS])
def test_every_declared_canonical_form(where: str, value: Any, expected: str) -> None:
    assert canonical_json(value) == expected


@pytest.mark.parametrize("name", sorted(_SHARED))
def test_the_copies_match_their_shared_homes(name: str) -> None:
    # The copies are what a checkout of this package alone tests against, so they must not drift.
    shared = _SHARED[name]
    if shared is None or not shared.exists():
        pytest.skip(f"the shared home of {name} is not at hand")
    assert (FIXTURES / name).read_bytes() == shared.read_bytes(), f"tests/fixtures/{name} drifted from {shared}"


def test_the_receipt_golden_names_its_unsigned_bytes() -> None:
    unsigned = {name: item for name, item in GOLDEN_RECEIPT.items() if name != "sig"}
    assert canonical_json(unsigned) == RECEIPT_FILE["receipt_canonical_unsigned"]


# -------------------------------------------------------------------------------------------------
# Tokens (§12.2)
# -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["user_token", "challenge"])
def test_payload_canonical_bytes(name: str) -> None:
    assert canonical_json(TOKENS[name]["payload"]) == TOKENS[name]["payload_canonical"]


@pytest.mark.parametrize("name", ["user_token", "challenge"])
def test_sign_token_reproduces_the_golden_bytes(name: str) -> None:
    assert sign_token(TOKENS["secret"], TOKENS[name]["payload"]) == TOKENS[name]["token"]
    assert sign_token(TOKENS["secret"].encode("utf-8"), TOKENS[name]["payload"]) == TOKENS[name]["token"]


def test_bridge_user_token_is_the_golden_token(clock: Any) -> None:
    clock.ms = (TOKENS["user_token"]["payload"]["exp"] - 3600) * 1000
    bridge = make_bridge(secret=TOKENS["secret"])
    assert bridge.user_token("user-42") == TOKENS["user_token"]["token"]


def test_bridge_challenge_is_the_golden_challenge(clock: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    clock.ms = (TOKENS["challenge"]["payload"]["exp"] - 120) * 1000
    monkeypatch.setattr(tokens, "_random_bytes", lambda count: b"\x01" * count)
    bridge = make_bridge(secret=TOKENS["secret"])
    assert bridge.challenge("user-42", "auth.verify_login") == TOKENS["challenge"]["token"]


def test_golden_tokens_read_back() -> None:
    now = TOKENS["user_token"]["payload"]["exp"] - 10
    assert read_user_token(TOKENS["secret"], TOKENS["user_token"]["token"], now) == TOKENS["user_token"]["payload"]
    reading = read_challenge(TOKENS["secret"], TOKENS["challenge"]["token"], TOKENS["challenge"]["payload"]["exp"] - 10)
    assert reading.ok and reading.payload == TOKENS["challenge"]["payload"]


def test_tokens_expire_at_exp() -> None:
    exp = TOKENS["user_token"]["payload"]["exp"]
    assert read_user_token(TOKENS["secret"], TOKENS["user_token"]["token"], exp) is None
    reading = read_challenge(TOKENS["secret"], TOKENS["challenge"]["token"], TOKENS["challenge"]["payload"]["exp"])
    assert not reading.ok and reading.reason == "the challenge expired"


def test_a_token_is_not_a_challenge_and_back() -> None:
    assert read_user_token(TOKENS["secret"], TOKENS["challenge"]["token"], 0) is None
    assert not read_challenge(TOKENS["secret"], TOKENS["user_token"]["token"], 0).ok


def test_another_secret_opens_nothing() -> None:
    assert open_token("x" * 40, TOKENS["user_token"]["token"]) is None


_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_."


@pytest.mark.parametrize("name", ["user_token", "challenge"])
def test_every_altered_character_is_rejected(name: str) -> None:
    token: str = TOKENS[name]["token"]
    for index, original in enumerate(token):
        # Two replacements per position: the next character of the alphabet, and one that
        # differs only in the low bits (the spare bits of a final base64url character).
        replacements = {_ALPHABET[(_ALPHABET.index(original) + 1) % len(_ALPHABET)]}
        if original != ".":
            replacements.add(_ALPHABET[_ALPHABET.index(original) ^ 1])
        for replacement in replacements - {original}:
            altered = token[:index] + replacement + token[index + 1 :]
            assert open_token(TOKENS["secret"], altered) is None, (index, original, replacement)


def test_truncated_and_extended_tokens_are_rejected() -> None:
    token: str = TOKENS["user_token"]["token"]
    for altered in (token[:-1], token + "A", token + "=", "." + token, token.replace(".", ".."), ""):
        assert open_token(TOKENS["secret"], altered) is None


# -------------------------------------------------------------------------------------------------
# Receipts (§12.1)
# -------------------------------------------------------------------------------------------------


def test_receipt_canonical_bytes_are_the_golden_bytes() -> None:
    assert receipt_signing_bytes(GOLDEN_RECEIPT) == RECEIPT_FILE["receipt_canonical_unsigned"].encode("utf-8")


def test_data_canonical_bytes_and_hash() -> None:
    assert canonical_json(RECEIPT_FILE["data"]) == RECEIPT_FILE["data_canonical"]
    assert data_hash(RECEIPT_FILE["data"]) == RECEIPT_FILE["data_hash"] == GOLDEN_RECEIPT["data_hash"]


def test_the_test_seed_reproduces_the_key_and_signature() -> None:
    private = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(RECEIPT_FILE["test_seed_hex"]))
    public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    assert b64url_encode(public) == RECEIPT_FILE["public_key"] == GOLDEN_RECEIPT["device"]["public_key"]
    assert kid_of(public) == GOLDEN_RECEIPT["device"]["kid"] == hashlib.sha256(public).hexdigest()[:16]
    signature = private.sign(RECEIPT_FILE["receipt_canonical_unsigned"].encode("utf-8"))
    assert b64url_encode(signature) == GOLDEN_RECEIPT["sig"]


def test_golden_receipt_verifies() -> None:
    check = verify_receipt_signature(GOLDEN_RECEIPT)
    assert check.ok, check.reason
    assert check.device == {
        "kid": "fe812c12f3ab4ce6",
        "alg": "Ed25519",
        "public_key": RECEIPT_FILE["public_key"],
        "hardware": False,
    }
    assert check.receipt is not None and check.receipt["outcome"] == "success"


def test_golden_receipt_verifies_as_json_text() -> None:
    assert verify_receipt_signature(json.dumps(GOLDEN_RECEIPT, ensure_ascii=False)).ok


_OTHER_PUBLIC = Ed25519PrivateKey.from_private_bytes(OTHER_SEED).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)

ONE_FIELD_CHANGES: list[tuple[str, Any]] = [
    ("v", 2),
    ("v", True),
    ("origin", "https://evil.example.com"),
    ("origin", "https://app.example.com/"),
    ("key", "auth.other"),
    ("package", "app.other"),
    ("package", None),
    ("function", "other"),
    ("function", None),
    ("challenge", "eyJ2IjoxfQ.c2lm"),
    ("challenge", None),
    ("outcome", "failed"),
    ("error_code", "RUN_FAILED"),
    ("data_hash", "0" * 64),
    ("data_hash", None),
    ("run_id", 43),
    ("started_at", 1_791_550_001),
    ("finished_at", 1_791_550_003),
    ("writ", {"version": "1.0.8"}),
    ("device.kid", "0" * 16),
    ("device.hardware", True),
    ("device.public_key", b64url_encode(_OTHER_PUBLIC)),
    ("device.consistent_other_key", None),
    ("extra", 1),
    ("drop:error_code", None),
    ("drop:writ", None),
]


@pytest.mark.parametrize(("field", "value"), ONE_FIELD_CHANGES, ids=[f"{f}={v!r}" for f, v in ONE_FIELD_CHANGES])
def test_any_one_field_change_fails(field: str, value: Any) -> None:
    receipt = copy.deepcopy(GOLDEN_RECEIPT)
    if field.startswith("drop:"):
        del receipt[field[5:]]
    elif field == "device.consistent_other_key":
        # Another key, with its own kid: the signature still names the golden bytes' key.
        receipt["device"]["public_key"] = b64url_encode(_OTHER_PUBLIC)
        receipt["device"]["kid"] = kid_of(_OTHER_PUBLIC)
    elif field.startswith("device."):
        receipt["device"][field[7:]] = value
    else:
        receipt[field] = value
    check = verify_receipt_signature(receipt)
    assert not check.ok
    assert check.reason
    assert check.device is None


def test_every_altered_signature_character_fails() -> None:
    sig: str = GOLDEN_RECEIPT["sig"]
    for index, original in enumerate(sig):
        for replacement in {"A", "B", "_"} - {original}:
            receipt = copy.deepcopy(GOLDEN_RECEIPT)
            receipt["sig"] = sig[:index] + replacement + sig[index + 1 :]
            assert not verify_receipt_signature(receipt).ok, (index, replacement)


def test_a_receipt_signed_by_another_key_verifies_for_that_key_only() -> None:
    changed = copy.deepcopy(GOLDEN_RECEIPT)
    changed["device"]["public_key"] = b64url_encode(_OTHER_PUBLIC)
    changed["device"]["kid"] = kid_of(_OTHER_PUBLIC)
    resigned = resign(changed, OTHER_SEED)
    check = verify_receipt_signature(resigned)
    assert check.ok
    assert check.device is not None and check.device["kid"] == kid_of(_OTHER_PUBLIC)


def test_base64url_is_strict() -> None:
    assert b64url_decode("AQ") == b"\x01"
    assert b64url_decode("AR") is None  # spare bits set
    assert b64url_decode("AQ==") is None  # padding
    assert b64url_decode("A") is None  # impossible length
    assert b64url_decode("A+") is None  # standard alphabet
    assert b64url_decode(42) is None


def test_the_receipt_inputs_hash_is_the_engines() -> None:
    """``inputs_hash`` = sha256 of the challenge, a newline and the canonical inputs, byte for byte as
    the Writ engine computes it (``local::site_receipt::inputs_hash``)."""
    from usewrit.canonical import inputs_hash, sha256_hex

    golden = RECEIPT_FILE
    assert inputs_hash(golden["receipt"]["challenge"], golden["inputs"]) == golden["inputs_hash"]
    assert golden["receipt"]["inputs_hash"] == golden["inputs_hash"]
    assert inputs_hash(None, {}) == sha256_hex(b"\n{}")
