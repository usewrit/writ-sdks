"""RFC 8785 (JCS) canonical JSON, and the hashes and encodings built on it.

docs/browser-extension/CONTRACT.md §11 "Canonical JSON", §12.1, §12.2. The rules, as the Writ
engine applies them (``local::update::manifest::canonicalize``) and the Node twin reproduces:

- object keys sorted by UTF-16 code units, recursively;
- compact separators, no whitespace;
- non-ASCII emitted as is (UTF-8 once encoded); only ``"``, ``\\`` and control characters escaped;
- numbers printed as RFC 8785 §3.2.2.3 says, which is ECMAScript's ``Number::toString`` (what
  JavaScript's ``JSON.stringify`` prints): ``12.5``, ``100`` for ``100.0``, ``0`` for ``-0.0``,
  ``1e+21``, ``1.5e-7``. An integer beyond 2**53 is printed as the double JavaScript would read
  (``2**53 + 1`` is ``9007199254740992``). ``NaN`` and infinities are refused.

``json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`` gives the same bytes
only for documents with ASCII keys and small integers; this module implements the rule itself so
that non-ASCII keys sort by UTF-16 code units and floats print the way the daemon and the Node twin
print them.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import re
from collections.abc import Mapping
from typing import Any, Final

from .constants import MAX_JSON_DEPTH
from .errors import WritBridgeError

__all__ = [
    "b64url_decode",
    "b64url_encode",
    "canonical_bytes",
    "canonical_json",
    "data_hash",
    "format_number",
    "sha256_hex",
]

_BASE64URL: Final = re.compile(r"[A-Za-z0-9_-]*")

#: Integers up to this magnitude are exact doubles and print as themselves.
_MAX_EXACT_INTEGER: Final = 2**53


def _refuse(path: str, message: str) -> WritBridgeError:
    return WritBridgeError("INPUT_INVALID", f"{path} {message}")


def canonical_json(value: Any) -> str:
    """The RFC 8785 canonical JSON text of ``value``.

    Accepts ``None``, booleans, strings, integers, floats, lists, tuples and mappings with string
    keys. Raises an ``INPUT_INVALID`` :class:`~usewrit.errors.WritBridgeError` naming the path for
    anything else: ``NaN``, an infinity (or an integer too large for a double), a lone surrogate,
    a non-string key, another type, a cycle, or nesting deeper than 128 levels.
    """
    parts: list[str] = []
    _emit(value, "$", 0, set(), parts)
    return "".join(parts)


def canonical_bytes(value: Any) -> bytes:
    """:func:`canonical_json` encoded as UTF-8: the bytes Writ hashes and signs."""
    return canonical_json(value).encode("utf-8")


def _emit(value: Any, path: str, depth: int, ancestors: set[int], out: list[str]) -> None:
    if value is None:
        out.append("null")
        return
    if value is True:
        out.append("true")
        return
    if value is False:
        out.append("false")
        return
    if isinstance(value, (int, float)):
        out.append(format_number(value, path))
        return
    if isinstance(value, str):
        out.append(_quote(value, path))
        return

    if depth >= MAX_JSON_DEPTH:
        raise _refuse(path, f"is nested deeper than {MAX_JSON_DEPTH} levels.")
    marker = id(value)
    if marker in ancestors:
        raise _refuse(path, "contains a circular reference.")

    if isinstance(value, (list, tuple)):
        ancestors.add(marker)
        try:
            out.append("[")
            for index, item in enumerate(value):
                if index:
                    out.append(",")
                _emit(item, f"{path}[{index}]", depth + 1, ancestors, out)
            out.append("]")
        finally:
            ancestors.discard(marker)
        return

    if isinstance(value, Mapping):
        ancestors.add(marker)
        try:
            entries: list[tuple[bytes, str, str, Any]] = []
            for key, item in value.items():
                if not isinstance(key, str):
                    raise _refuse(path, f"has the key {key!r}; JSON object keys are text.")
                quoted = _quote(key, path)
                # Big-endian UTF-16 bytes compare exactly like UTF-16 code units (RFC 8785 §3.2.3).
                entries.append((key.encode("utf-16-be"), key, quoted, item))
            entries.sort(key=lambda entry: entry[0])
            out.append("{")
            for index, (_, key, quoted, item) in enumerate(entries):
                if index:
                    out.append(",")
                out.append(quoted)
                out.append(":")
                _emit(item, f"{path}.{key}", depth + 1, ancestors, out)
            out.append("}")
        finally:
            ancestors.discard(marker)
        return

    raise _refuse(path, f"is a {type(value).__name__}; only JSON values have a canonical form.")


def format_number(value: int | float, path: str = "$") -> str:
    """A number as RFC 8785 §3.2.2.3 prints it: ECMAScript ``Number::toString``.

    An integer up to 2**53 in magnitude prints as itself; a larger one is first rounded to the
    double JavaScript would read. ``-0.0`` prints ``0``. ``NaN`` and infinities raise
    ``INPUT_INVALID``.
    """
    if isinstance(value, bool):
        raise _refuse(path, "is a boolean, not a number.")
    if isinstance(value, int):
        if -_MAX_EXACT_INTEGER <= value <= _MAX_EXACT_INTEGER:
            return str(int(value))
        try:
            value = float(value)
        except OverflowError:
            raise _refuse(path, "is an integer too large for a JSON number.") from None
    number = float(value)
    if not math.isfinite(number):
        raise _refuse(path, f"is {number!r}; canonical JSON has no such number.")
    if number == 0:
        return "0"  # 0.0 and -0.0
    if number < 0:
        return "-" + _format_positive(-number)
    return _format_positive(number)


def _format_positive(number: float) -> str:
    # repr() is the shortest text that reads back as the same double, as Number::toString's
    # digits are; only the layout differs.
    mantissa, _, exponent = repr(number).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    # number = 0.<digits> x 10^n
    n = len(whole) + (int(exponent) if exponent else 0)
    significant = digits.lstrip("0")
    n -= len(digits) - len(significant)
    d = significant.rstrip("0")
    k = len(d)
    if k <= n <= 21:
        return d + "0" * (n - k)
    if 0 < n <= 21:
        return f"{d[:n]}.{d[n:]}"
    if -6 < n <= 0:
        return f"0.{'0' * -n}{d}"
    e = n - 1
    head = d if k == 1 else f"{d[0]}.{d[1:]}"
    return f"{head}e{'+' if e >= 0 else '-'}{abs(e)}"


def _quote(text: str, path: str) -> str:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        raise _refuse(path, "holds a lone UTF-16 surrogate; it is not valid Unicode.") from None
    # With ensure_ascii=False, json.dumps escapes exactly what RFC 8785 requires: `"`, `\`,
    # \b \f \n \r \t, and the other control characters as lowercase \u00xx.
    return json.dumps(text, ensure_ascii=False)


def sha256_hex(data: str | bytes) -> str:
    """Lowercase hex sha256 of a string's UTF-8 bytes, or of raw bytes."""
    raw = data.encode("utf-8") if isinstance(data, str) else bytes(data)
    return hashlib.sha256(raw).hexdigest()


def inputs_hash(challenge: str | None, inputs: Any) -> str:
    """A receipt's ``inputs_hash``: lowercase hex sha256 of the call's challenge (empty when none),
    a newline, and the canonical JSON of the inputs it ran with (CONTRACT.md §12.1). Binds a receipt
    to what the call ran with; salted with the single-use challenge. Raises like :func:`canonical_json`.
    """
    body = canonical_json({} if inputs is None else inputs)
    return sha256_hex(f"{challenge or ''}\n{body}".encode("utf-8"))


def data_hash(data: Any) -> str:
    """A receipt's ``data_hash`` of ``data``: lowercase hex sha256 of its canonical JSON.

    CONTRACT.md §12.1. Raises like :func:`canonical_json`.
    """
    return sha256_hex(canonical_bytes(data))


# -------------------------------------------------------------------------------------------------
# base64url (RFC 4648 §5, no padding), strict
# -------------------------------------------------------------------------------------------------


def b64url_encode(data: bytes | str) -> str:
    """base64url without padding (a string is encoded as UTF-8 first)."""
    raw = data.encode("utf-8") if isinstance(data, str) else bytes(data)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(text: object) -> bytes | None:
    """The bytes of a base64url string, or ``None`` when it is not their one canonical encoding.

    Refused: a wrong alphabet, padding, an impossible length, or spare bits set in the last
    character (two spellings of the same bytes would let a token change and still verify).
    """
    if not isinstance(text, str) or _BASE64URL.fullmatch(text) is None or len(text) % 4 == 1:
        return None
    raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    return raw if b64url_encode(raw) == text else None
