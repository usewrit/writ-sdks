"""The contract file, input validation, and the refusals made when the bridge is created."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from usewrit import ContractSetting, MemoryStore, WritBridgeError, check_inputs, create_writ_bridge, validate_contract

from .helpers import API_KEY, SECRET, contract_doc, make_bridge


def _code(error: pytest.ExceptionInfo[WritBridgeError]) -> str:
    return error.value.code


# -------------------------------------------------------------------------------------------------
# Loading
# -------------------------------------------------------------------------------------------------


def test_loads_a_dict_text_bytes_and_a_path(tmp_path: Path) -> None:
    doc = contract_doc()
    path = tmp_path / "writ-contract.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    for source in (doc, json.dumps(doc), json.dumps(doc).encode("utf-8"), path):
        contract = validate_contract(source)  # type: ignore[arg-type]
        assert contract.keys == ("auth.verify_login", "pos.receive")
        fn = contract.function_of("auth.verify_login")
        assert fn is not None and fn.cloud is not None
        assert fn.cloud.workflow_id == 215 and fn.cloud.function == "verify_login"
        assert [entry.name for entry in fn.inputs] == ["company", "username", "note"]
        assert contract.function_of("pos.receive").local_network == ("192.168.1.20:8080",)  # type: ignore[union-attr]
        assert contract.is_namespace("auth") and not contract.is_function("auth")
        assert contract.children("") == ["auth", "pos"]
        assert contract.children("auth") == ["verify_login"]


def test_a_validated_contract_is_returned_as_is() -> None:
    contract = validate_contract(contract_doc())
    assert validate_contract(contract) is contract


def test_text_that_is_not_json_mentions_paths() -> None:
    with pytest.raises(WritBridgeError) as caught:
        validate_contract("writ-contract.json")
    assert _code(caught) == "INPUT_INVALID"
    assert "pathlib.Path" in caught.value.message


def test_workflow_id_as_text_becomes_a_number() -> None:
    doc = contract_doc()
    doc["functions"][0]["cloud"]["workflow_id"] = "215"
    fn = validate_contract(doc).function_of("auth.verify_login")
    assert fn is not None and fn.cloud is not None and fn.cloud.workflow_id == 215


def test_function_settings_are_kept() -> None:
    """A function's package settings (CONTRACT.md §10), for the site's own form, never inputs."""
    doc = contract_doc()
    doc["functions"][1]["settings"] = [
        {"key": "pos_host", "label": "Your POS address", "kind": "lan_host"},
        {"key": "store_no", "label": "Store number", "kind": "text"},
    ]
    contract = validate_contract(doc)
    fn = contract.function_of("pos.receive")
    assert fn is not None
    assert fn.settings == (
        ContractSetting(key="pos_host", label="Your POS address", kind="lan_host"),
        ContractSetting(key="store_no", label="Store number", kind="text"),
    )
    assert contract.function_of("auth.verify_login").settings == ()  # type: ignore[union-attr]
    with pytest.raises(WritBridgeError):
        check_inputs(fn, {"invoice_no": "F-1", "pos_host": "192.168.1.20"})


def _broken(change: Any) -> dict[str, Any]:
    doc = contract_doc()
    change(doc)
    return doc


BROKEN: dict[str, Any] = {
    "format": lambda d: d.update(format="writ.contract/v2"),
    "generated_at": lambda d: d.update(generated_at="yesterday"),
    "generator": lambda d: d.update(generator=" "),
    "publisher": lambda d: d.update(publisher="Example"),
    "packages not a list": lambda d: d.update(packages={}),
    "package without id": lambda d: d["packages"][0].pop("id"),
    "package twice": lambda d: d["packages"].append(dict(d["packages"][0])),
    "no functions": lambda d: d.update(functions=[]),
    "bad key": lambda d: d["functions"][0].update(key="Auth.Verify"),
    "empty segment": lambda d: d["functions"][0].update(key="auth..verify"),
    "reserved segment": lambda d: d["functions"][0].update(key="auth.then"),
    "key twice": lambda d: d["functions"][1].update(key="auth.verify_login", local_network=[]),
    "function and namespace": lambda d: d["functions"][1].update(key="auth"),
    "unknown package": lambda d: d["functions"][0].update(package="app.nope"),
    "empty function name": lambda d: d["functions"][0].update(function=""),
    "inputs not a list": lambda d: d["functions"][0].update(inputs={}),
    "input twice": lambda d: d["functions"][0]["inputs"].append({"name": "company", "required": False}),
    "input required not bool": lambda d: d["functions"][0]["inputs"][0].update(required="yes"),
    "outputs": lambda d: d["functions"][0].update(outputs=[1]),
    "writes": lambda d: d["functions"][0].update(writes="no"),
    "local_network missing": lambda d: d["functions"][0].pop("local_network"),
    "mode": lambda d: d["functions"][0].update(mode="sometimes"),
    "cloud not an object": lambda d: d["functions"][0].update(cloud=215),
    "cloud workflow id": lambda d: d["functions"][0].update(cloud={"workflow_id": 0, "function": None}),
    "cloud workflow id bool": lambda d: d["functions"][0].update(cloud={"workflow_id": True, "function": None}),
    "cloud function blank": lambda d: d["functions"][0].update(cloud={"workflow_id": 1, "function": " "}),
    "settings not a list": lambda d: d["functions"][1].update(settings={"pos_host": "lan_host"}),
    "setting key": lambda d: d["functions"][1].update(settings=[{"key": "pos-host", "label": "POS", "kind": "text"}]),
    "setting label": lambda d: d["functions"][1].update(settings=[{"key": "pos_host", "label": " ", "kind": "text"}]),
    "setting kind": lambda d: d["functions"][1].update(settings=[{"key": "pos_host", "label": "POS", "kind": "url"}]),
    "setting twice": lambda d: d["functions"][1].update(
        settings=[{"key": "pos_host", "label": "POS", "kind": "text"}, {"key": "pos_host", "label": "POS", "kind": "text"}]
    ),
}


@pytest.mark.parametrize("name", sorted(BROKEN))
def test_broken_contracts_are_refused(name: str) -> None:
    with pytest.raises(WritBridgeError) as caught:
        validate_contract(_broken(BROKEN[name]))
    assert _code(caught) == "INPUT_INVALID"


def test_not_an_object_is_refused() -> None:
    for source in ([], "[]", 42):
        with pytest.raises(WritBridgeError):
            validate_contract(source)  # type: ignore[arg-type]


# -------------------------------------------------------------------------------------------------
# Inputs
# -------------------------------------------------------------------------------------------------


def _login() -> Any:
    fn = validate_contract(contract_doc()).function_of("auth.verify_login")
    assert fn is not None
    return fn


def test_inputs_are_copied_as_plain_json() -> None:
    given = {"company": "acme", "username": "zoe", "note": ("a", 1.5, None)}
    clean = check_inputs(_login(), given)
    assert clean == {"company": "acme", "username": "zoe", "note": ["a", 1.5, None]}
    assert clean is not given


@pytest.mark.parametrize(
    "inputs",
    [
        {"company": "acme"},  # a required input missing
        {"company": "acme", "username": "zoe", "persona_id": 3},  # undeclared
        {"company": "acme", "username": "zoe", "note": float("nan")},  # not JSON
        {"company": "acme", "username": "zoe", "note": {1: "x"}},  # non-string key
        {"company": "acme", "username": "zoe", "note": object()},  # not JSON
        {"company": "acme", "username": "zoe", "note": "x" * 1_048_576},  # over 1 MB
        ["acme", "zoe"],  # not a dict
        "acme",
    ],
)
def test_bad_inputs_are_refused(inputs: Any) -> None:
    with pytest.raises(WritBridgeError) as caught:
        check_inputs(_login(), inputs)
    assert _code(caught) == "INPUT_INVALID"


def test_none_means_no_inputs() -> None:
    doc = contract_doc()
    doc["functions"][0]["inputs"] = [{"name": "note", "required": False}]
    fn = validate_contract(doc).function_of("auth.verify_login")
    assert fn is not None
    assert check_inputs(fn, None) == {}


def test_null_counts_as_given() -> None:
    assert check_inputs(_login(), {"company": None, "username": "zoe"}) == {"company": None, "username": "zoe"}


# -------------------------------------------------------------------------------------------------
# create_writ_bridge refusals
# -------------------------------------------------------------------------------------------------


def test_required_needs_no_api_key() -> None:
    bridge = make_bridge("required")
    assert bridge.mode_of("auth.verify_login") == "required"
    assert bridge.mode_of("pos.receive") == "required"


def test_environment_supplies_secret_and_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WRIT_BRIDGE_SECRET", SECRET)
    monkeypatch.setenv("WRIT_API_KEY", API_KEY)
    bridge = create_writ_bridge(contract_doc(), "recommended")
    assert bridge.mode_of("auth.verify_login") == "recommended"
    assert bridge.user_token("u1")


def test_recommended_without_api_key_is_refused() -> None:
    with pytest.raises(WritBridgeError) as caught:
        make_bridge("recommended")
    assert _code(caught) == "CLOUD_NOT_CONFIGURED"


def test_cloud_function_without_mapping_is_refused() -> None:
    doc = contract_doc()
    del doc["functions"][0]["cloud"]
    with pytest.raises(WritBridgeError) as caught:
        make_bridge("recommended", contract=doc, api_key=API_KEY)
    assert _code(caught) == "CLOUD_NOT_CONFIGURED"
    # The same contract is fine when that function stays on the user's computer.
    assert make_bridge("recommended", contract=doc, api_key=API_KEY, function_modes={"auth.verify_login": "required"})


def test_local_network_functions_are_forced_to_required() -> None:
    bridge = make_bridge("cloud", api_key=API_KEY)
    assert bridge.mode_of("pos.receive") == "required"
    assert bridge.mode_of("auth.verify_login") == "cloud"


@pytest.mark.parametrize("explicit", ["recommended", "cloud"])
def test_local_network_function_set_to_cloud_is_refused(explicit: str) -> None:
    with pytest.raises(WritBridgeError) as caught:
        make_bridge("required", api_key=API_KEY, function_modes={"pos.receive": explicit})
    assert _code(caught) == "CONFIG_INVALID"
    doc = contract_doc()
    doc["functions"][1]["mode"] = explicit
    with pytest.raises(WritBridgeError) as caught:
        make_bridge("required", contract=doc, api_key=API_KEY)
    assert _code(caught) == "CONFIG_INVALID"


def test_function_modes_override_the_contract() -> None:
    doc = contract_doc()
    doc["functions"][0]["mode"] = "cloud"
    bridge = make_bridge("required", contract=doc, api_key=API_KEY, function_modes={"auth.verify_login": "recommended"})
    assert bridge.mode_of("auth.verify_login") == "recommended"


@pytest.mark.parametrize(
    "options",
    [
        {"secret": "too-short"},
        {"secret": 12345},
        {"function_modes": {"nope": "required"}},
        {"function_modes": {"auth.verify_login": "maybe"}},
        {"poll_seconds": 0},
        {"poll_seconds": 121},
        {"poll_seconds": 2.5},
        {"cloud_base": "http://api.usewrit.app"},
        {"cloud_base": "https://user:pw@api.usewrit.app"},
        {"cloud_base": "https://api.usewrit.app/?x=1"},
        {"cloud_base": "not a url"},
        {"max_body_bytes": 10},
        {"pin_devices": "yes"},
        {"pin_devices": None},
        {"store": object()},
    ],
)
def test_bad_options_are_config_invalid(options: dict[str, Any]) -> None:
    with pytest.raises(WritBridgeError) as caught:
        make_bridge("required", **options)
    assert _code(caught) == "CONFIG_INVALID"


def test_bad_mode_is_config_invalid() -> None:
    with pytest.raises(WritBridgeError) as caught:
        make_bridge("sometimes")
    assert _code(caught) == "CONFIG_INVALID"


def test_missing_secret_is_refused_unless_every_function_is_cloud() -> None:
    with pytest.raises(WritBridgeError) as caught:
        create_writ_bridge(contract_doc(), "required")
    assert _code(caught) == "CONFIG_INVALID"

    doc = contract_doc()
    doc["functions"] = doc["functions"][:1]
    bridge = create_writ_bridge(doc, "cloud", api_key=API_KEY)
    with pytest.raises(WritBridgeError) as caught:
        bridge.user_token("u1")
    assert _code(caught) == "CONFIG_INVALID"


@pytest.mark.parametrize("key", ["user.lookup", "approve_device.run", "forget_devices", "verify.login"])
def test_contract_keys_may_not_shadow_bridge_members(key: str) -> None:
    doc = contract_doc()
    doc["functions"][0]["key"] = key
    with pytest.raises(WritBridgeError) as caught:
        make_bridge("required", contract=doc)
    assert _code(caught) == "CONFIG_INVALID"


def test_local_cloud_base_may_use_http() -> None:
    assert make_bridge("required", cloud_base="http://localhost:8000/")
    assert make_bridge("required", cloud_base="http://127.0.0.1:8000")


def test_a_store_implementing_the_protocol_is_accepted() -> None:
    assert make_bridge("required", store=MemoryStore())
