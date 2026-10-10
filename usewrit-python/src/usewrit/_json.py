"""Plain-JSON helpers shared by contract, input and wire validation."""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from typing import Any, TypeAlias, Union

from .errors import WritBridgeError

__all__ = ["JsonObject", "JsonValue", "clone_json", "describe_value", "dumps", "utf8_length"]

JsonValue: TypeAlias = Union[None, bool, int, float, str, list["JsonValue"], dict[str, "JsonValue"]]
JsonObject: TypeAlias = dict[str, JsonValue]


def describe_value(value: object) -> str:
    """A short description of a value for error messages. Never prints a whole object."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        shown = value if len(value) <= 70 else f"{value[:70]}..."
        return json.dumps(shown, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "an array"
    if isinstance(value, Mapping):
        return "an object"
    if isinstance(value, (int, float)):
        return f"the number {value!r}"
    return f"a {type(value).__name__}"


def utf8_length(text: str) -> int:
    """UTF-8 byte length of a string."""
    return len(text.encode("utf-8", "surrogatepass"))


def dumps(value: Any) -> str:
    """Compact JSON text, non-ASCII as is, ``NaN`` and infinities refused."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def clone_json(value: Any, path: str, max_depth: int) -> JsonValue:
    """A fresh plain-JSON copy of ``value``.

    Raises ``INPUT_INVALID`` naming ``path`` for the first value JSON cannot carry: non-finite
    numbers, bytes, dates, sets, class instances, non-string keys, lone surrogates, cycles, or
    nesting deeper than ``max_depth``. Tuples become lists; any mapping becomes a dict.
    """
    return _clone(value, path, 0, max_depth, set())


def _invalid(message: str) -> WritBridgeError:
    return WritBridgeError("INPUT_INVALID", message)


def _clone(value: Any, path: str, depth: int, max_depth: int, ancestors: set[int]) -> JsonValue:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise _invalid(f"{path} is {value!r}; only finite numbers are JSON.")
        return float(value)
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise _invalid(f"{path} holds a lone UTF-16 surrogate; it is not valid Unicode.") from None
        return str(value)

    if depth >= max_depth:
        raise _invalid(f"{path} is nested deeper than {max_depth} levels.")
    marker = id(value)
    if marker in ancestors:
        raise _invalid(f"{path} contains a circular reference.")

    if isinstance(value, (list, tuple)):
        ancestors.add(marker)
        try:
            return [_clone(item, f"{path}[{index}]", depth + 1, max_depth, ancestors) for index, item in enumerate(value)]
        finally:
            ancestors.discard(marker)

    if isinstance(value, Mapping):
        ancestors.add(marker)
        try:
            out: dict[str, JsonValue] = {}
            for name, item in value.items():
                if not isinstance(name, str):
                    raise _invalid(f"{path} has the key {name!r}; JSON object keys are text.")
                out[name] = _clone(item, f"{path}.{name}", depth + 1, max_depth, ancestors)
            return out
        finally:
            ancestors.discard(marker)

    raise _invalid(
        f"{path} is {describe_value(value)}; convert it to a string, number, boolean, list or dict first."
    )
