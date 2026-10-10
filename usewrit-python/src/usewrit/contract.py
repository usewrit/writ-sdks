"""The contract file (``writ-contract.json``, docs/browser-extension/CONTRACT.md §10), as the
server reads it: the functions, their inputs, where each may run (``mode``) and, for Writ Cloud,
which published workflow answers (``cloud``).

The rules are the Node twin's ``validateContract`` / ``checkInputs``.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final, Literal, Union

from ._json import JsonObject, clone_json, describe_value, dumps, utf8_length
from .constants import (
    CONTRACT_FORMAT,
    FUNCTION_KEY_PATTERN,
    MAX_INPUT_BYTES,
    MAX_JSON_DEPTH,
    MAX_PACKAGE_SETTINGS,
    MAX_SETTING_LABEL_LENGTH,
    SETTING_KEY_PATTERN,
)
from .errors import WritBridgeError

__all__ = [
    "MODES",
    "CloudMapping",
    "ContractFunction",
    "ContractInput",
    "ContractSetting",
    "ContractSource",
    "Mode",
    "WritContract",
    "check_inputs",
    "validate_contract",
]

#: Where a function runs (CONTRACT.md §12, WRIT_BRIDGE_DESIGN.md §2).
Mode = Literal["required", "recommended", "cloud"]

#: The modes, in order.
MODES: Final[tuple[str, ...]] = ("required", "recommended", "cloud")

#: What a package setting holds: free text, or one address on the user's local network.
SettingKind = Literal["text", "lan_host"]

#: The setting kinds.
SETTING_KINDS: Final[tuple[str, ...]] = ("text", "lan_host")

#: Key segments a contract may not use: each becomes an attribute of a proxy, and these break
#: the JavaScript twin's (``then`` makes a namespace look like a promise to ``await``).
RESERVED_SEGMENTS: Final[frozenset[str]] = frozenset({"then", "__proto__", "constructor", "prototype"})

_ISO_8601: Final = re.compile(
    r"\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?"
)
_WORKFLOW_ID_TEXT: Final = re.compile(r"[1-9][0-9]{0,15}")
_MAX_SAFE_INTEGER: Final = 2**53 - 1


@dataclass(frozen=True)
class ContractInput:
    """One declared input."""

    name: str
    required: bool
    description: str | None = None


@dataclass(frozen=True)
class ContractSetting:
    """One setting of a function's package (CONTRACT.md §8): a value each user gives once in
    Writ's consent window, never a call input. Listed for the site's own form."""

    key: str
    label: str
    kind: SettingKind


@dataclass(frozen=True)
class CloudMapping:
    """The Writ Cloud workflow that answers a function, filled when the contract is published."""

    #: The workflow id in the developer's Writ Cloud account.
    workflow_id: int
    #: The workflow function to run, or ``None`` for the whole workflow.
    function: str | None


@dataclass(frozen=True)
class ContractFunction:
    """One function of the contract."""

    key: str
    description: str
    package: str
    function: str | None
    inputs: tuple[ContractInput, ...]
    outputs: tuple[str, ...]
    writes: bool
    #: Hosts on the visitor's network this function reaches; any forces ``required``.
    local_network: tuple[str, ...]
    #: This function's own mode, over the bridge's.
    mode: Mode | None = None
    #: Its Writ Cloud workflow, required for ``recommended`` and ``cloud``.
    cloud: CloudMapping | None = None
    #: The package's settings, for the site's own form (empty when the contract lists none).
    settings: tuple[ContractSetting, ...] = ()


@dataclass(frozen=True)
class WritContract:
    """A validated contract file."""

    format: str
    generated_at: str
    generator: str
    functions: tuple[ContractFunction, ...]
    packages: tuple[Mapping[str, Any], ...]
    publisher: Mapping[str, Any] | None = None
    _by_key: Mapping[str, ContractFunction] = field(default_factory=dict, repr=False, compare=False)
    _namespaces: frozenset[str] = field(default_factory=frozenset, repr=False, compare=False)

    def function_of(self, key: str) -> ContractFunction | None:
        """The function with this key, or ``None``."""
        return self._by_key.get(key)

    @property
    def keys(self) -> tuple[str, ...]:
        """Every function key, in contract order."""
        return tuple(fn.key for fn in self.functions)

    def is_function(self, path: str) -> bool:
        return path in self._by_key

    def is_namespace(self, path: str) -> bool:
        """True for a dotted prefix of some key (``"pos"`` for ``"pos.receive"``)."""
        return path in self._namespaces

    def children(self, path: str) -> list[str]:
        """The next segments under ``path`` (``""`` for the top level), sorted."""
        prefix = f"{path}." if path else ""
        names = {
            candidate[len(prefix):].split(".", 1)[0]
            for candidate in (*self._by_key, *self._namespaces)
            if candidate.startswith(prefix) and candidate != path
        }
        return sorted(names)


ContractSource = Union[WritContract, Mapping[str, Any], str, bytes, bytearray, "os.PathLike[str]"]


def _invalid(message: str) -> WritBridgeError:
    return WritBridgeError("INPUT_INVALID", message)


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_contract(source: ContractSource) -> WritContract:
    """Check a contract file and return it as a frozen :class:`WritContract`.

    Accepts the parsed JSON (a mapping), its text (``str`` / ``bytes``), or a path
    (``pathlib.Path``). Rules: ``format`` is ``"writ.contract/v1"``; packages have unique ids
    (bundled ``writ.workflow/v1`` or linked ``writ.linked/v1`` entries, CONTRACT.md §8 and §11,
    both kept as given: the visitor's Writ checks them); every function key is valid, unique, made of non-empty dot-separated segments, and never both
    a function and a namespace (``"pos"`` next to ``"pos.receive"``); every function names one of
    ``packages``; inputs are unique ``{name, required}``; ``settings``, when present, are unique
    ``{key, label, kind}``; ``mode``, when present, is a mode; ``cloud``, when present, is
    ``{workflow_id, function}``.

    Raises a :class:`~usewrit.errors.WritBridgeError` ``INPUT_INVALID`` whose message names the
    field at fault.
    """
    if isinstance(source, WritContract):
        return source
    parsed: Any = source
    if isinstance(source, os.PathLike):
        try:
            parsed = Path(source).read_text(encoding="utf-8")
        except OSError as exc:
            raise WritBridgeError("INPUT_INVALID", f"The contract file could not be read ({exc}).") from exc
    if isinstance(parsed, (bytes, bytearray)):
        try:
            parsed = bytes(parsed).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WritBridgeError("INPUT_INVALID", "The contract is not UTF-8 text.") from exc
    if isinstance(parsed, str):
        try:
            parsed = json.loads(parsed)
        except ValueError as exc:
            raise WritBridgeError(
                "INPUT_INVALID",
                "The contract is not valid JSON. To load writ-contract.json from disk, pass a pathlib.Path.",
            ) from exc
    if not isinstance(parsed, Mapping):
        raise _invalid(
            f'The contract must be an object {{ format: "{CONTRACT_FORMAT}", functions, packages }}; '
            f"got {describe_value(parsed)}."
        )
    value = parsed
    if value.get("format") != CONTRACT_FORMAT:
        raise _invalid(f'contract.format must be "{CONTRACT_FORMAT}"; got {describe_value(value.get("format"))}.')
    generated_at = value.get("generated_at")
    if not isinstance(generated_at, str) or _ISO_8601.fullmatch(generated_at.strip()) is None:
        raise _invalid(f"contract.generated_at must be an ISO 8601 date; got {describe_value(generated_at)}.")
    generator = value.get("generator")
    if not isinstance(generator, str) or generator.strip() == "":
        raise _invalid(
            'contract.generator must name what produced the file (e.g. "writ-cloud"); '
            f"got {describe_value(generator)}."
        )

    publisher: Mapping[str, Any] | None = None
    raw_publisher = value.get("publisher")
    if raw_publisher is not None:
        if not isinstance(raw_publisher, Mapping):
            raise _invalid("contract.publisher must be an object { name? }.")
        name = raw_publisher.get("name")
        if name is not None and not isinstance(name, str):
            raise _invalid("contract.publisher.name must be text.")
        publisher = MappingProxyType({"name": name} if isinstance(name, str) else {})

    raw_packages = value.get("packages")
    if not isinstance(raw_packages, list):
        raise _invalid(
            f"contract.packages must be an array of workflow packages; got {describe_value(raw_packages)}."
        )
    package_ids: set[str] = set()
    packages: list[Mapping[str, Any]] = []
    for index, raw in enumerate(raw_packages):
        if not isinstance(raw, Mapping):
            raise _invalid(f"contract.packages[{index}] must be a package object.")
        package_id = raw.get("id")
        if not isinstance(package_id, str) or package_id == "":
            raise _invalid(f"contract.packages[{index}].id must be a non-empty id.")
        if package_id in package_ids:
            raise _invalid(f'contract.packages[{index}].id "{package_id}" is used by another package; each id once.')
        package_ids.add(package_id)
        copy = clone_json(raw, f"contract.packages[{index}]", MAX_JSON_DEPTH)
        assert isinstance(copy, dict)
        packages.append(MappingProxyType(copy))

    raw_functions = value.get("functions")
    if not isinstance(raw_functions, list) or len(raw_functions) == 0:
        raise _invalid("contract.functions must list at least one function.")
    functions: list[ContractFunction] = []
    by_key: dict[str, ContractFunction] = {}
    for index, raw in enumerate(raw_functions):
        fn = _validate_function(raw, f"contract.functions[{index}]", package_ids)
        if fn.key in by_key:
            raise _invalid(f'contract.functions[{index}].key "{fn.key}" is listed twice.')
        by_key[fn.key] = fn
        functions.append(fn)
    namespaces = _check_namespaces(list(by_key))

    return WritContract(
        format=CONTRACT_FORMAT,
        generated_at=generated_at,
        generator=generator,
        functions=tuple(functions),
        packages=tuple(packages),
        publisher=publisher,
        _by_key=MappingProxyType(by_key),
        _namespaces=namespaces,
    )


def _validate_function(raw: object, where: str, package_ids: set[str]) -> ContractFunction:
    if not isinstance(raw, Mapping):
        raise _invalid(f"{where} must be an object {{ key, description, package, function, inputs, outputs }}.")

    key = raw.get("key")
    if not isinstance(key, str) or FUNCTION_KEY_PATTERN.fullmatch(key) is None:
        raise _invalid(
            f'{where}.key {describe_value(key)} is not valid: use 1 to 64 lowercase letters, digits, ".", "_" '
            'or "-", starting with a letter or digit.'
        )
    for segment in key.split("."):
        if segment == "":
            raise _invalid(f'{where}.key "{key}" has an empty segment; dots separate namespaces, as in "pos.receive".')
        if segment in RESERVED_SEGMENTS:
            raise _invalid(f'{where}.key "{key}" uses "{segment}", which cannot be a method or namespace name.')

    description = raw.get("description")
    if not isinstance(description, str):
        raise _invalid(f"{where}.description must be text.")

    package_id = raw.get("package")
    if not isinstance(package_id, str) or package_id not in package_ids:
        raise _invalid(f"{where}.package must be the id of one of contract.packages; got {describe_value(package_id)}.")
    fn_name = raw.get("function")
    if fn_name is not None and (not isinstance(fn_name, str) or fn_name == ""):
        raise _invalid(f"{where}.function must be a package function name, or null.")

    inputs = _validate_inputs(raw.get("inputs"), f"{where}.inputs")

    outputs = raw.get("outputs")
    if not isinstance(outputs, list) or not all(isinstance(name, str) for name in outputs):
        raise _invalid(f"{where}.outputs must be an array of field names.")
    writes = raw.get("writes")
    if not isinstance(writes, bool):
        raise _invalid(f"{where}.writes must be true or false.")
    # Required, never defaulted: a function that reaches the visitor's network must say so, or it
    # could be routed to Writ Cloud, which cannot reach it.
    local_network = raw.get("local_network")
    if not isinstance(local_network, list) or not all(isinstance(host, str) for host in local_network):
        raise _invalid(f"{where}.local_network must be an array of hosts (empty when it reaches none).")

    settings: tuple[ContractSetting, ...] = ()
    raw_settings = raw.get("settings")
    if raw_settings is not None:
        settings = _validate_settings(raw_settings, f"{where}.settings")

    mode: Mode | None = None
    raw_mode = raw.get("mode")
    if raw_mode is not None:
        if not isinstance(raw_mode, str) or raw_mode not in MODES:
            raise _invalid(f'{where}.mode must be "required", "recommended" or "cloud"; got {describe_value(raw_mode)}.')
        mode = raw_mode  # type: ignore[assignment]

    cloud: CloudMapping | None = None
    raw_cloud = raw.get("cloud")
    if raw_cloud is not None:
        cloud = _validate_cloud_mapping(raw_cloud, f"{where}.cloud")

    return ContractFunction(
        key=key,
        description=description,
        package=package_id,
        function=fn_name,
        inputs=inputs,
        outputs=tuple(outputs),
        writes=writes,
        local_network=tuple(local_network),
        mode=mode,
        cloud=cloud,
        settings=settings,
    )


def _validate_settings(raw: object, where: str) -> tuple[ContractSetting, ...]:
    """``{key, label, kind}[]``, each key once. The visitor's Writ checks them against the package
    at install; the server only keeps them."""
    if not isinstance(raw, list):
        raise _invalid(f"{where} must be an array of {{ key, label, kind }}.")
    if len(raw) > MAX_PACKAGE_SETTINGS:
        raise _invalid(
            f"{where} has {len(raw)} entries; a package declares at most {MAX_PACKAGE_SETTINGS} settings."
        )
    keys: set[str] = set()
    settings: list[ContractSetting] = []
    for index, entry in enumerate(raw):
        at = f"{where}[{index}]"
        if not isinstance(entry, Mapping):
            raise _invalid(f"{at} must be an object {{ key, label, kind }}.")
        key = entry.get("key")
        if not isinstance(key, str) or SETTING_KEY_PATTERN.fullmatch(key) is None:
            raise _invalid(f'{at}.key {describe_value(key)} is not valid: use 1 to 64 ASCII letters, digits or "_".')
        if key in keys:
            raise _invalid(f'{at}.key "{key}" is listed twice.')
        keys.add(key)
        label = entry.get("label")
        if not isinstance(label, str) or label.strip() == "" or len(label) > MAX_SETTING_LABEL_LENGTH:
            raise _invalid(f"{at}.label must be 1 to {MAX_SETTING_LABEL_LENGTH} characters of text.")
        kind = entry.get("kind")
        if not isinstance(kind, str) or kind not in SETTING_KINDS:
            raise _invalid(f'{at}.kind must be "text" or "lan_host"; got {describe_value(kind)}.')
        settings.append(ContractSetting(key=key, label=label, kind=kind))  # type: ignore[arg-type]
    return tuple(settings)


def _validate_cloud_mapping(raw: object, where: str) -> CloudMapping:
    if not isinstance(raw, Mapping):
        raise _invalid(f"{where} must be {{ workflow_id, function }}.")
    workflow_id: object = raw.get("workflow_id")
    if isinstance(workflow_id, str) and _WORKFLOW_ID_TEXT.fullmatch(workflow_id) is not None:
        workflow_id = int(workflow_id)
    if not _is_int(workflow_id) or not 0 < workflow_id <= _MAX_SAFE_INTEGER:  # type: ignore[operator]
        raise _invalid(
            f"{where}.workflow_id must be the positive id of a Writ Cloud workflow; "
            f"got {describe_value(raw.get('workflow_id'))}."
        )
    fn_name = raw.get("function")
    if fn_name is not None and (not isinstance(fn_name, str) or fn_name.strip() == ""):
        raise _invalid(f"{where}.function must be the workflow function to run, or null for the whole workflow.")
    return CloudMapping(workflow_id=int(workflow_id), function=fn_name)  # type: ignore[call-overload]


def _validate_inputs(raw: object, where: str) -> tuple[ContractInput, ...]:
    if not isinstance(raw, list):
        raise _invalid(f"{where} must be an array of {{ name, required, description? }}.")
    names: set[str] = set()
    inputs: list[ContractInput] = []
    for index, entry in enumerate(raw):
        at = f"{where}[{index}]"
        if not isinstance(entry, Mapping):
            raise _invalid(f"{at} must be an object {{ name, required, description? }}.")
        name = entry.get("name")
        if not isinstance(name, str) or name.strip() == "":
            raise _invalid(f"{at}.name must be a non-empty input name.")
        if name in names:
            raise _invalid(f'{at}.name "{name}" is declared twice.')
        names.add(name)
        required = entry.get("required")
        if not isinstance(required, bool):
            raise _invalid(f"{at}.required must be true or false.")
        description = entry.get("description")
        if description is not None and not isinstance(description, str):
            raise _invalid(f"{at}.description must be text.")
        inputs.append(ContractInput(name=name, required=required, description=description))
    return tuple(inputs)


def _check_namespaces(keys: list[str]) -> frozenset[str]:
    """A key may not be a function and a namespace at once: "pos" next to "pos.receive"."""
    leaves = set(keys)
    namespaces: set[str] = set()
    for key in keys:
        segments = key.split(".")
        for end in range(1, len(segments)):
            prefix = ".".join(segments[:end])
            if prefix in leaves:
                raise _invalid(
                    f'contract.functions has both "{prefix}" and "{key}": "{prefix}" would be a method and a '
                    "namespace at once. Rename one of them."
                )
            namespaces.add(prefix)
    return frozenset(namespaces)


def check_inputs(fn: ContractFunction, inputs: object) -> JsonObject:
    """Check ``inputs`` against a function's declared inputs, and return a plain-JSON copy.

    A mapping (or ``None`` for none), every required input present, nothing undeclared, JSON
    only, at most 1 MB. Raises ``INPUT_INVALID``.
    """
    if inputs is not None and not isinstance(inputs, Mapping):
        raise _invalid(f"{fn.key}() takes a dict of inputs; got {describe_value(inputs)}.")
    given: Mapping[Any, Any] = inputs if isinstance(inputs, Mapping) else {}
    declared = {entry.name for entry in fn.inputs}
    for name in given:
        if name not in declared:
            known = ", ".join(f'"{entry.name}"' for entry in fn.inputs)
            listed = "it takes no inputs" if known == "" else f"its inputs are {known}"
            raise _invalid(f'{fn.key}() has no input "{name}"; {listed}.')
    missing = [f'"{entry.name}"' for entry in fn.inputs if entry.required and entry.name not in given]
    if missing:
        raise _invalid(f"{fn.key}() needs {', '.join(missing)}.")
    copy = clone_json(given, "inputs", MAX_JSON_DEPTH)
    assert isinstance(copy, dict)
    if utf8_length(dumps(copy)) > MAX_INPUT_BYTES:
        raise _invalid(f"{fn.key}() inputs are larger than {MAX_INPUT_BYTES} bytes as JSON.")
    return copy
