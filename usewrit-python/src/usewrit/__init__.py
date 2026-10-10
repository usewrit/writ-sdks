"""usewrit: the server side of the Writ Bridge for Python.

Run your website's Writ functions on a signed-in visitor's own computer (with signed receipts) or
on Writ Cloud, from one object, behind one route you mount. The Python twin of ``@usewrit/server``
(docs/browser-extension/CONTRACT.md §12)::

    from pathlib import Path
    from fastapi import FastAPI
    from usewrit import create_writ_bridge

    bridge = create_writ_bridge(Path("writ-contract.json"), mode="required")
    app = FastAPI()
    app.include_router(bridge.fastapi_router("/writ-bridge"))

    token = bridge.user_token(user.id)                    # hand it to the page's bridge
    result = await bridge.user(user.id).pos.receive({"invoice_no": "F-1029"})
    print(result.data, result.venue)                      # venue: "user" or "cloud"

Linked workflows in ``token`` mode (CONTRACT.md §11) need a run token your backend mints::

    from usewrit import mint_run_token

    token = mint_run_token(os.environ["WRIT_PUBLICATION_SECRET"], "pub_...", sub=str(user.id))

See the README for modes, login gates (``challenge`` / ``verify``), run tokens, Redis and security
notes.
"""

from ._version import __version__
from .asgi import BridgeASGIApp
from .bridge import BridgeResult, FunctionNamespace, WritBridge, create_writ_bridge
from .canonical import b64url_decode, b64url_encode, canonical_bytes, canonical_json, data_hash, inputs_hash
from .cloud import CloudRunner, CloudTiming
from .contract import (
    MODES,
    CloudMapping,
    ContractFunction,
    ContractInput,
    ContractSetting,
    Mode,
    WritContract,
    check_inputs,
    validate_contract,
)
from .errors import (
    BRIDGE_ERROR_CODES,
    VISITOR_ERROR_CODES,
    WRIT_BRIDGE_ERROR_CODES,
    WritBridgeError,
    WritBridgeErrorCode,
    default_message,
    http_status_of,
    is_writ_bridge_error,
    is_writ_bridge_error_code,
    normalize_visitor_code,
)
from .receipt import kid_of, parse_receipt, receipt_signing_bytes, verify_receipt_signature
from .redis_store import RedisStore
from .run_token import mint_run_token
from .store import Command, CommandOutcome, DeviceCheck, MemoryStore, PendingCommand, Presence, Store
from .tokens import (
    mint_challenge,
    mint_user_token,
    new_nonce,
    open_token,
    read_challenge,
    read_user_token,
    sign_token,
    subject_of,
)
from .verify import UNSET, DevicePolicy, VerifyResult, check_receipt, normalize_origin

__all__ = [
    "BRIDGE_ERROR_CODES",
    "MODES",
    "UNSET",
    "VISITOR_ERROR_CODES",
    "WRIT_BRIDGE_ERROR_CODES",
    "BridgeASGIApp",
    "BridgeResult",
    "CloudMapping",
    "CloudRunner",
    "CloudTiming",
    "Command",
    "CommandOutcome",
    "ContractFunction",
    "ContractInput",
    "ContractSetting",
    "DeviceCheck",
    "DevicePolicy",
    "FunctionNamespace",
    "MemoryStore",
    "Mode",
    "PendingCommand",
    "Presence",
    "RedisStore",
    "Store",
    "VerifyResult",
    "WritBridge",
    "WritBridgeError",
    "WritBridgeErrorCode",
    "WritContract",
    "__version__",
    "b64url_decode",
    "b64url_encode",
    "canonical_bytes",
    "canonical_json",
    "check_inputs",
    "check_receipt",
    "create_writ_bridge",
    "data_hash",
    "inputs_hash",
    "default_message",
    "http_status_of",
    "is_writ_bridge_error",
    "is_writ_bridge_error_code",
    "kid_of",
    "mint_challenge",
    "mint_run_token",
    "mint_user_token",
    "new_nonce",
    "normalize_origin",
    "normalize_visitor_code",
    "open_token",
    "parse_receipt",
    "read_challenge",
    "read_user_token",
    "receipt_signing_bytes",
    "sign_token",
    "subject_of",
    "validate_contract",
    "verify_receipt_signature",
]
