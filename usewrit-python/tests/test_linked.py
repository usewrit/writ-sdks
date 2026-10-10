"""Linked workflows (CONTRACT.md §11): linked contract entries, and run tokens minted against the
golden file shared with the Node twin.

The golden file's home is ``sdks/fixtures/run_token_golden.json`` (written by
``run_token_golden_gen.py``); ``fixtures/`` holds a copy for a checkout of this package alone.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from pathlib import Path
from typing import Any

import pytest

from usewrit import WritBridgeError, mint_run_token, validate_contract

from .helpers import API_KEY, FIXTURES, contract_doc, make_bridge

_SHARED = Path(__file__).resolve().parents[2] / "fixtures" / "run_token_golden.json"
GOLDEN: dict[str, Any] = json.loads(
    (_SHARED if _SHARED.exists() else FIXTURES / "run_token_golden.json").read_text(encoding="utf-8")
)

PUBLICATION = "pub_0123456789abcdefABCDEF"
SECRET = "wsk_0123456789abcdefghijABCDEFGHIJ0123456789"
#: The JOSE header, as both SDKs sign it.
HEADER_JSON = b'{"alg":"HS256","typ":"JWT"}'


def _linked_auth() -> dict[str, Any]:
    """A linked entry for ``app.auth``, as Writ Cloud writes it in a linked contract."""
    return {
        "format": "writ.linked/v1",
        "id": "app.auth",
        "name": "Auth",
        "publication": {"id": PUBLICATION},
        "key": "wpk_0123456789abcdef0123456789ABCDEF",
        "access": "token",
        "manifest": {
            "format": "writ.manifest/v1",
            "publication": PUBLICATION,
            "name": "Auth",
            "description": None,
            "publisher": {"name": "Example"},
            "functions": [
                {
                    "name": "verify_login",
                    "inputs": [{"name": "company", "required": True}, {"name": "username", "required": True}],
                    "outputs": ["ok"],
                    "writes": False,
                }
            ],
            "destinations": ["portal.example.com"],
            "lan_hosts": [],
            "lan_reason": None,
            "credentials": [],
            "settings": [],
            "browser": False,
            "scripts": False,
        },
        "manifest_hash": "3f" * 32,
    }


def _linked_contract() -> dict[str, Any]:
    doc = contract_doc()
    doc["packages"] = [_linked_auth() if pkg["id"] == "app.auth" else pkg for pkg in doc["packages"]]
    return doc


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _expected_token(secret: str, claims_json: str) -> str:
    """The token computed the way the Node twin does (``JSON.stringify`` claims, node:crypto HMAC),
    written out independently of ``mint_run_token``."""
    signing_input = f"{_b64url(HEADER_JSON)}.{_b64url(claims_json.encode('utf-8'))}"
    signature = hmac.new(secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_b64url(signature)}"


def _claims_json(pub: str, iat: int, exp: int, sub: str | None = None) -> str:
    """JavaScript's ``JSON.stringify({ pub, iat, exp, sub? })`` for these claims."""
    head = f'{{"pub":{json.dumps(pub)},"iat":{iat},"exp":{exp}'
    return f"{head}}}" if sub is None else f'{head},"sub":{json.dumps(sub, ensure_ascii=False)}}}'


def _claims_of(token: str) -> dict[str, Any]:
    payload = token.split(".")[1]
    decoded: dict[str, Any] = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode("utf-8"))
    return decoded


# -------------------------------------------------------------------------------------------------
# Linked contracts
# -------------------------------------------------------------------------------------------------


def test_a_linked_entry_is_kept_as_given() -> None:
    contract = validate_contract(_linked_contract())
    assert dict(contract.packages[0]) == _linked_auth()
    fn = contract.function_of("auth.verify_login")
    assert fn is not None and fn.cloud is not None and fn.cloud.workflow_id == 215


def test_a_linked_function_routes_by_its_mode_and_cloud_mapping() -> None:
    bridge = make_bridge("recommended", contract=_linked_contract(), api_key=API_KEY)
    assert bridge.mode_of("auth.verify_login") == "recommended"
    assert bridge.mode_of("pos.receive") == "required"


# -------------------------------------------------------------------------------------------------
# Run tokens: the golden file
# -------------------------------------------------------------------------------------------------


def test_the_golden_token_with_a_sub() -> None:
    vector = GOLDEN["with_sub"]
    token = mint_run_token(
        GOLDEN["secret"], GOLDEN["publication"], sub=vector["sub"], ttl_seconds=GOLDEN["ttl_seconds"], issued_at=GOLDEN["iat"]
    )
    assert token == vector["token"]


def test_the_golden_token_without_a_sub() -> None:
    token = mint_run_token(GOLDEN["secret"], GOLDEN["publication"], ttl_seconds=GOLDEN["ttl_seconds"], issued_at=GOLDEN["iat"])
    assert token == GOLDEN["without_sub"]["token"]


@pytest.mark.parametrize("name", ["with_sub", "without_sub"])
def test_the_golden_parts(name: str) -> None:
    vector = GOLDEN[name]
    exp = GOLDEN["iat"] + GOLDEN["ttl_seconds"]
    assert vector["header_json"] == '{"alg":"HS256","typ":"JWT"}'
    assert vector["payload_json"] == _claims_json(GOLDEN["publication"], GOLDEN["iat"], exp, vector["sub"])
    assert vector["exp"] == exp
    assert vector["token"].startswith(vector["signing_input"] + ".")
    assert _expected_token(GOLDEN["secret"], vector["payload_json"]) == vector["token"]
    keys = ["pub", "iat", "exp"] + ([] if vector["sub"] is None else ["sub"])
    assert list(_claims_of(vector["token"])) == keys


@pytest.mark.parametrize(
    ("sub", "ttl", "text"),
    [
        ("Zoë 東京", 600, "Zoë 東京"),
        ('quote " and \\ backslash', 3_600, 'quote " and \\ backslash'),
        (42, 1, "42"),
        (None, 3_599, None),
    ],
)
def test_agrees_with_the_node_algorithm(sub: str | int | None, ttl: int, text: str | None) -> None:
    token = mint_run_token(GOLDEN["secret"], PUBLICATION, sub=sub, ttl_seconds=ttl, issued_at=1_791_550_000)
    assert token == _expected_token(GOLDEN["secret"], _claims_json(PUBLICATION, 1_791_550_000, 1_791_550_000 + ttl, text))


# -------------------------------------------------------------------------------------------------
# Run tokens: defaults and refusals
# -------------------------------------------------------------------------------------------------


def test_issues_at_the_current_second_for_600_seconds(clock: Any) -> None:
    clock.ms = 1_791_550_000_400
    claims = _claims_of(mint_run_token(SECRET, PUBLICATION, sub="u42"))
    assert claims == {"pub": PUBLICATION, "iat": 1_791_550_000, "exp": 1_791_550_600, "sub": "u42"}


@pytest.mark.parametrize(
    "secret",
    [
        "wpk_0123456789abcdef0123456789ABCDEF",
        "0123456789abcdefghijABCDEFGHIJ0123456789",
        "",
        SECRET + "\n",
        "wsk_ x",
        None,
        b"wsk_0123456789abcdefghijABCDEFGHIJ0123456789",
    ],
)
def test_a_secret_that_is_not_a_secret_key_is_config_invalid(secret: Any) -> None:
    with pytest.raises(WritBridgeError) as caught:
        mint_run_token(secret, PUBLICATION)
    assert caught.value.code == "CONFIG_INVALID"
    if isinstance(secret, str) and secret.strip() != "":
        assert secret.strip() not in caught.value.message


@pytest.mark.parametrize("ttl", [3_601, 0, -5, 1.5, True, "600"])
def test_a_ttl_outside_1_to_3600_is_bad_request(ttl: Any) -> None:
    with pytest.raises(WritBridgeError) as caught:
        mint_run_token(SECRET, PUBLICATION, ttl_seconds=ttl)
    assert caught.value.code == "BAD_REQUEST"


def test_the_longest_ttl_and_a_bad_issued_at() -> None:
    assert _claims_of(mint_run_token(SECRET, PUBLICATION, ttl_seconds=3_600, issued_at=10))["exp"] == 3_610
    with pytest.raises(WritBridgeError) as caught:
        mint_run_token(SECRET, PUBLICATION, issued_at=1.5)  # type: ignore[arg-type]
    assert caught.value.code == "BAD_REQUEST"


@pytest.mark.parametrize("publication", ["pub_short", "PUB_0123456789abcdefABCDEF", "pub_0123456789abcdef-BCDEF", 42])
def test_a_bad_publication_is_input_invalid(publication: Any) -> None:
    with pytest.raises(WritBridgeError) as caught:
        mint_run_token(SECRET, publication)
    assert caught.value.code == "INPUT_INVALID"


@pytest.mark.parametrize("sub", ["", "tab\there", "x" * 257, "\ud800 lone", 1.5, True, 2**53 + 1, "😀" * 129])
def test_a_bad_sub_is_input_invalid(sub: Any) -> None:
    with pytest.raises(WritBridgeError) as caught:
        mint_run_token(SECRET, PUBLICATION, sub=sub)
    assert caught.value.code == "INPUT_INVALID"
