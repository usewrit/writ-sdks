"""Every constant the library ships, in one file (docs/browser-extension/CONTRACT.md §12).

The values match the Node twin, ``@usewrit/server`` (``server-node/src/constants.ts``).
"""

from __future__ import annotations

import re
from typing import Final

from ._version import __version__

VERSION: Final = __version__

#: The only contract format this library reads (CONTRACT.md §10).
CONTRACT_FORMAT: Final = "writ.contract/v1"

#: A contract function key: lowercase letters, digits, ``.``, ``_``, ``-``, at most 64 characters.
FUNCTION_KEY_PATTERN: Final = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")

#: A package setting key (CONTRACT.md §8 "Settings"): ASCII letters, digits, ``_``, at most 64.
SETTING_KEY_PATTERN: Final = re.compile(r"[A-Za-z0-9_]{1,64}")

#: Most settings one package declares.
MAX_PACKAGE_SETTINGS: Final = 8

#: Longest setting label, in characters.
MAX_SETTING_LABEL_LENGTH: Final = 80

#: Where Writ Cloud answers by default.
DEFAULT_CLOUD_BASE: Final = "https://api.usewrit.app"

#: The page channel's longest long-poll, in seconds, unless ``poll_seconds`` says otherwise.
DEFAULT_POLL_SECONDS: Final = 25

#: The range ``poll_seconds`` accepts.
MIN_POLL_SECONDS: Final = 1
MAX_POLL_SECONDS: Final = 120

#: A page counts as connected this long after its last hello or poll (CONTRACT.md §12.3).
PRESENCE_TTL_MS: Final = 90_000

#: How long the store keeps a user's last presence once the page went away. It is how the bridge
#: tells a user who never reported Writ ready (``WRIT_REQUIRED``) from one who is offline
#: (``USER_OFFLINE``).
PRESENCE_RETENTION_MS: Final = 30 * 24 * 60 * 60 * 1000

#: ``bridge.user_token()`` default lifetime, in seconds.
DEFAULT_USER_TOKEN_TTL_SECONDS: Final = 3_600

#: ``bridge.challenge()`` default lifetime, in seconds.
DEFAULT_CHALLENGE_TTL_SECONDS: Final = 120

#: The longest lifetime a minted token or challenge may ask for (30 days), in seconds.
MAX_TOKEN_TTL_SECONDS: Final = 30 * 24 * 60 * 60

#: ``WRIT_BRIDGE_SECRET`` must be at least this many bytes (CONTRACT.md §12.2).
MIN_SECRET_BYTES: Final = 32

#: The longest challenge the Writ engine accepts (it is opaque to Writ).
MAX_CHALLENGE_CHARS: Final = 2_048

#: The longest token the page channel reads.
MAX_TOKEN_CHARS: Final = 4_096

#: The longest user id or challenge subject, in characters.
MAX_SUBJECT_LENGTH: Final = 256

#: ``mint_run_token()`` default lifetime, in seconds (CONTRACT.md §11 "Token mode").
DEFAULT_RUN_TOKEN_TTL_SECONDS: Final = 600

#: The longest lifetime a run token may have: Writ Cloud refuses ``exp`` past ``iat + 3600``.
MAX_RUN_TOKEN_TTL_SECONDS: Final = 3_600

#: A publication's secret key starts with this (``wsk_`` + 40 characters).
SECRET_KEY_PREFIX: Final = "wsk_"

#: A publication id: ``pub_`` + 22 ASCII letters or digits.
PUBLICATION_ID_PATTERN: Final = re.compile(r"pub_[A-Za-z0-9]{22}")

#: A call's default timeout, on the visitor's computer or on Writ Cloud.
DEFAULT_CALL_TIMEOUT_MS: Final = 120_000

#: ``timeout_ms`` is accepted in this range (the extension clamps to the same).
MIN_CALL_TIMEOUT_MS: Final = 1_000
MAX_CALL_TIMEOUT_MS: Final = 900_000

#: The longest ``wait_for_user_ms``.
MAX_WAIT_FOR_USER_MS: Final = 900_000

#: A caller waits this long past a command's own timeout for the page to post its result: the
#: extension owns the timeout and answers ``TIMEOUT`` itself, the grace covers the trip back.
RESULT_GRACE_MS: Final = 5_000

#: A command still queued this long after it was sent was never picked up: the page went away
#: without saying so (a closed tab). The bridge takes it back and treats the user as offline.
PICKUP_TIMEOUT_MS: Final = 15_000

#: How often a caller waiting for the user (``wait_for_user_ms``) re-reads their presence.
PRESENCE_RECHECK_MS: Final = 250

#: Most commands one poll answers.
MAX_COMMANDS_PER_POLL: Final = 16

#: Largest ``inputs``, as UTF-8 JSON (1 MB), as the extension enforces.
MAX_INPUT_BYTES: Final = 1_048_576

#: Deepest nesting accepted inside ``inputs``, results and canonical documents.
MAX_JSON_DEPTH: Final = 128

#: Largest page channel request body: a 25 MB result plus its receipt.
DEFAULT_MAX_BODY_BYTES: Final = 26 * 1024 * 1024

#: Most keys a hello may report as granted.
MAX_GRANTED_KEYS: Final = 512

#: Most page ``run`` calls one user may have in flight on one server instance.
MAX_PAGE_RUNS_PER_USER: Final = 4

#: Writ Cloud result polling: first wait, growth, cap and jitter (the Arrivos driver's values).
CLOUD_POLL_INITIAL_MS: Final = 1_000
CLOUD_POLL_GROWTH: Final = 1.5
CLOUD_POLL_MAX_MS: Final = 5_000
CLOUD_POLL_JITTER: Final = 0.2

#: One Writ Cloud request (the dispatch, or one result read) never waits longer than this.
CLOUD_REQUEST_TIMEOUT_MS: Final = 30_000

#: An unknown task status read this many times in a row ends the wait as ``RUN_FAILED``.
CLOUD_UNRECOGNISED_READS: Final = 3

#: Names on the bridge object itself. A contract key's first segment may not use one: the typed
#: functions live on the same object (``bridge.pos.receive(...)``). The Python names, plus the
#: Node twin's lowercase ones, so a contract one SDK accepts the other accepts too.
BRIDGE_MEMBER_NAMES: Final[tuple[str, ...]] = (
    "asgi",
    "fastapi_router",
    "handle",
    "handler",
    "express",
    "next",
    "user_token",
    "user",
    "challenge",
    "verify",
    "online",
    "approve_device",
    "forget_devices",
    "mode_of",
    "contract",
    "close",
    "aclose",
)
