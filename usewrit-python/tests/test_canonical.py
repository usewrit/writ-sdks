"""RFC 8785 canonical JSON (CONTRACT.md §11): the bytes every hash and signature covers."""

from __future__ import annotations

import json
from typing import Any

import pytest

from usewrit import WritBridgeError
from usewrit.canonical import canonical_bytes, canonical_json, data_hash, format_number, sha256_hex


def test_keys_sorted_recursively_and_compact() -> None:
    value = {"b": 1, "a": {"z": [3, 2, 1], "y": "hi", "x": True}, "c": "str"}
    assert canonical_json(value) == '{"a":{"x":true,"y":"hi","z":[3,2,1]},"b":1,"c":"str"}'


def test_integers_and_minimal_string_escapes() -> None:
    assert canonical_json({"n": 192847362, "s": 'a"b\\c', "neg": -5}) == '{"n":192847362,"neg":-5,"s":"a\\"b\\\\c"}'


def test_non_ascii_is_emitted_as_is() -> None:
    assert canonical_bytes({"user": "Zoé", "city": "東京"}) == '{"city":"東京","user":"Zoé"}'.encode()


def test_control_characters_use_short_or_lowercase_escapes() -> None:
    assert canonical_json("\b\f\n\r\t\x01\x1f\x7f") == '"\\b\\f\\n\\r\\t\\u0001\\u001f\x7f"'


def test_keys_sort_by_utf16_code_units_not_code_points() -> None:
    # U+1F600 is the surrogate pair D83D DE00, which sorts before U+E000 in UTF-16
    # (and after it by code point).
    value = {"": 1, "\U0001f600": 2, "a": 3}
    assert canonical_json(value) == '{"a":3,"\U0001f600":2,"":1}'


def test_matches_json_dumps_for_ascii_keys_and_small_integers() -> None:
    value = {"z": [1, {"b": None, "a": False}], "a": "x", "m": {"k": -0, "j": 10**18}}
    assert canonical_json(value) == json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def test_tuples_are_arrays_and_bools_are_not_integers() -> None:
    assert canonical_json({"t": (1, 2), "b": True, "i": 1}) == '{"b":true,"i":1,"t":[1,2]}'


#: Expected strings are what JavaScript's String(x) prints (RFC 8785 §3.2.2.3).
NUMBERS: list[tuple[Any, str]] = [
    (0.0, "0"),
    (-0.0, "0"),
    (1.0, "1"),
    (12.5, "12.5"),
    (-12.5, "-12.5"),
    (0.1, "0.1"),
    (100.0, "100"),
    (1e20, "100000000000000000000"),
    (1e21, "1e+21"),
    (1.5e-7, "1.5e-7"),
    (0.000001, "0.000001"),
    (1e-7, "1e-7"),
    (0.00001, "0.00001"),
    (123e-20, "1.23e-18"),
    (1e16, "10000000000000000"),
    (123456789012345680.0, "123456789012345680"),
    (2**53, "9007199254740992"),
    (-(2**53), "-9007199254740992"),
    (2**53 + 1, "9007199254740992"),
    (10**25, "1e+25"),
    (5e-324, "5e-324"),
    (1.7976931348623157e308, "1.7976931348623157e+308"),
    (-1.7976931348623157e308, "-1.7976931348623157e+308"),
    (0.3, "0.3"),
    (1 / 3, "0.3333333333333333"),
    (42, "42"),
    (-7, "-7"),
]


@pytest.mark.parametrize(("value", "expected"), NUMBERS, ids=[text for _, text in NUMBERS])
def test_numbers_print_as_ecmascript_does(value: Any, expected: str) -> None:
    assert format_number(value) == expected
    assert canonical_json(value) == expected


def test_numbers_nested_in_a_document() -> None:
    assert canonical_json({"qty": 3, "price": 12.5}) == '{"price":12.5,"qty":3}'
    assert canonical_json([1.0, -0.0, 2.5e-8]) == "[1,0,2.5e-8]"


def test_a_float_from_json_hashes_like_the_integer_javascript_reads() -> None:
    # The page's JSON.stringify sends 3 for 3.0; either way the bytes are the same.
    assert canonical_json(json.loads('{"n": 3.0}')) == canonical_json({"n": 3}) == '{"n":3}'
    assert data_hash({"price": 12.5}) == sha256_hex(b'{"price":12.5}')


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf"), {"x": [float("nan")]}, 10**400])
def test_non_finite_numbers_are_refused(value: Any) -> None:
    with pytest.raises(WritBridgeError) as caught:
        canonical_json(value)
    assert caught.value.code == "INPUT_INVALID"


@pytest.mark.parametrize("value", [{1: "a"}, {"s": "\ud800"}, {"\udc00": 1}, b"bytes", {"x": object()}, {1, 2}])
def test_values_without_a_canonical_form_are_refused(value: Any) -> None:
    with pytest.raises(WritBridgeError) as caught:
        canonical_json(value)
    assert caught.value.code == "INPUT_INVALID"


def test_cycles_and_deep_nesting_are_refused() -> None:
    loop: list[Any] = []
    loop.append(loop)
    with pytest.raises(WritBridgeError):
        canonical_json(loop)
    deep: Any = 0
    for _ in range(130):
        deep = [deep]
    with pytest.raises(WritBridgeError):
        canonical_json(deep)


def test_shared_but_acyclic_values_are_fine() -> None:
    shared = {"a": 1}
    assert canonical_json([shared, shared]) == '[{"a":1},{"a":1}]'


def test_data_hash_is_sha256_of_the_canonical_bytes() -> None:
    value = {"ok": True, "user": "Zoé", "n": 3}
    assert data_hash(value) == sha256_hex(canonical_bytes(value))
    assert data_hash(None) == sha256_hex(b"null")
