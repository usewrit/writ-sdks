/**
 * Every constant the library ships, in one file (docs/browser-extension/CONTRACT.md §12).
 */

/** Library version. Keep in sync with package.json. */
export const VERSION = "0.1.0";

/** The only contract format this library reads (CONTRACT.md §10). */
export const CONTRACT_FORMAT = "writ.contract/v1";

/** A contract function key: lowercase letters, digits, `.`, `_`, `-`, at most 64 characters. */
export const FUNCTION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A package setting key (CONTRACT.md §8 "Settings"): ASCII letters, digits, `_`, at most 64. */
export const SETTING_KEY_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/** Most settings one package declares. */
export const MAX_PACKAGE_SETTINGS = 8;

/** Longest setting label, in characters. */
export const MAX_SETTING_LABEL_LENGTH = 80;

/** Where Writ Cloud answers by default. */
export const DEFAULT_CLOUD_BASE = "https://api.usewrit.app";

/** The page channel's longest long-poll, in seconds, unless `pollSeconds` says otherwise. */
export const DEFAULT_POLL_SECONDS = 25;

/** The range `pollSeconds` accepts. */
export const MIN_POLL_SECONDS = 1;
export const MAX_POLL_SECONDS = 120;

/** A page counts as connected this long after its last hello or poll (CONTRACT.md §12.3). */
export const PRESENCE_TTL_MS = 90_000;

/**
 * How long the store keeps a user's last presence once the page went away. It is how the bridge
 * tells a user who never reported Writ ready (`WRIT_REQUIRED`) from one who is offline
 * (`USER_OFFLINE`).
 */
export const PRESENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** `bridge.userToken()` default lifetime, in seconds. */
export const DEFAULT_USER_TOKEN_TTL_SECONDS = 3_600;

/** `bridge.challenge()` default lifetime, in seconds. */
export const DEFAULT_CHALLENGE_TTL_SECONDS = 120;

/** The longest lifetime a minted token or challenge may ask for (30 days), in seconds. */
export const MAX_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** `WRIT_BRIDGE_SECRET` must be at least this many bytes (CONTRACT.md §12.2). */
export const MIN_SECRET_BYTES = 32;

/** The longest challenge the Writ engine accepts (it is opaque to Writ). */
export const MAX_CHALLENGE_CHARS = 2_048;

/** The longest token the page channel reads. */
export const MAX_TOKEN_CHARS = 4_096;

/** The longest user id or challenge subject, in characters. */
export const MAX_SUBJECT_LENGTH = 256;

/** `mintRunToken()` default lifetime, in seconds (CONTRACT.md §11 "Token mode"). */
export const DEFAULT_RUN_TOKEN_TTL_SECONDS = 600;

/** The longest lifetime a run token may have: Writ Cloud refuses `exp` past `iat + 3600`. */
export const MAX_RUN_TOKEN_TTL_SECONDS = 3_600;

/** A publication's secret key starts with this (`wsk_` + 40 characters). */
export const SECRET_KEY_PREFIX = "wsk_";

/** A publication id: `pub_` + 22 ASCII letters or digits. */
export const PUBLICATION_ID_PATTERN = /^pub_[A-Za-z0-9]{22}$/;

/** A call's default timeout, on the visitor's computer or on Writ Cloud. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** `timeoutMs` is accepted in this range (the extension clamps to the same). */
export const MIN_CALL_TIMEOUT_MS = 1_000;
export const MAX_CALL_TIMEOUT_MS = 900_000;

/** The longest `waitForUserMs`. */
export const MAX_WAIT_FOR_USER_MS = 900_000;

/**
 * A caller waits this long past a command's own timeout for the page to post its result: the
 * extension owns the timeout and answers `TIMEOUT` itself, the grace covers the trip back.
 */
export const RESULT_GRACE_MS = 5_000;

/**
 * A command still queued this long after it was sent was never picked up: the page went away
 * without saying so (a closed tab). The bridge takes it back and treats the user as offline.
 */
export const PICKUP_TIMEOUT_MS = 15_000;

/** How often a caller waiting for the user (`waitForUserMs`) re-reads their presence. */
export const PRESENCE_RECHECK_MS = 250;

/** Most commands one poll answers. */
export const MAX_COMMANDS_PER_POLL = 16;

/** Largest `inputs`, as UTF-8 JSON (1 MB), as the extension enforces. */
export const MAX_INPUT_BYTES = 1_048_576;

/** Deepest nesting accepted inside `inputs` and results. */
export const MAX_JSON_DEPTH = 128;

/** Largest page channel request body: a 25 MB result plus its receipt. */
export const DEFAULT_MAX_BODY_BYTES = 26 * 1024 * 1024;

/** Most keys a hello may report as granted. */
export const MAX_GRANTED_KEYS = 512;

/** Most page `run` calls one user may have in flight on one server instance. */
export const MAX_PAGE_RUNS_PER_USER = 4;

/** Writ Cloud result polling: first wait, growth, cap and jitter (the Arrivos driver's values). */
export const CLOUD_POLL_INITIAL_MS = 1_000;
export const CLOUD_POLL_GROWTH = 1.5;
export const CLOUD_POLL_MAX_MS = 5_000;
export const CLOUD_POLL_JITTER = 0.2;

/** One Writ Cloud request (the dispatch, or one result read) never waits longer than this. */
export const CLOUD_REQUEST_TIMEOUT_MS = 30_000;

/** An unknown task status read this many times in a row ends the wait as `RUN_FAILED`. */
export const CLOUD_UNRECOGNISED_READS = 3;

/** Ed25519 SubjectPublicKeyInfo DER prefix: prepend it to a raw 32-byte public key. */
export const ED25519_SPKI_PREFIX_HEX = "302a300506032b6570032100";

/**
 * Names on the bridge object itself. A contract key's first segment may not use one: the typed
 * functions live on the same object (`bridge.pos.receive(...)`).
 */
export const BRIDGE_MEMBER_NAMES: readonly string[] = Object.freeze([
  "handler",
  "express",
  "next",
  "userToken",
  "user",
  "challenge",
  "verify",
  "online",
  "approveDevice",
  "forgetDevices",
  "modeOf",
  "contract",
  "close",
]);
