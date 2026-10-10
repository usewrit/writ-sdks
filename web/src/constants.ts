/**
 * Every constant the library ships, in one file.
 *
 * The store URLs name the Writ extension's listings (contract §7). Edge visitors use the Chrome Web
 * Store listing until the Edge Add-ons one exists.
 */

/** Library version. Keep in sync with package.json. */
export const VERSION = "0.2.0";

/** The page <-> provider protocol this library speaks (CONTRACT.md §1). */
export const WRIT_PROTOCOL = 1;

/**
 * The Writ extension on the Chrome Web Store. Also used for Chromium browsers
 * (Brave, Opera, Vivaldi), which install from the Chrome Web Store.
 */
export const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/writ/aphpglonnlgemfbgjopfkbdellmfljhg";

/**
 * Where Edge visitors install the Writ extension. Edge installs Chrome Web Store extensions (after
 * its "allow extensions from other stores" prompt), with the same extension id Writ desktop allows,
 * so this is the Chrome Web Store listing until the Edge Add-ons listing exists.
 */
export const EDGE_ADDONS_URL = CHROME_WEB_STORE_URL;

/** Dispatched by the provider at injection and in answer to {@link REQUEST_PROVIDER_EVENT}. */
export const ANNOUNCE_PROVIDER_EVENT = "writ:announceProvider";

/** Dispatched by the library to ask an already injected provider to announce itself again. */
export const REQUEST_PROVIDER_EVENT = "writ:requestProvider";

/** How long `connectWrit()` waits for the provider before answering "not installed". */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_500;

/** The extension's default call timeout when the page sends none (CONTRACT.md §1). */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** The extension clamps `timeout_ms` to this range; the library sends the clamped value. */
export const MIN_CALL_TIMEOUT_MS = 1_000;
export const MAX_CALL_TIMEOUT_MS = 900_000;

/**
 * The extension owns call timeouts. The library only guards against an extension that never
 * answers: it gives up `CALL_TIMEOUT_GRACE_MS` after the call's own timeout.
 */
export const CALL_TIMEOUT_GRACE_MS = 5_000;

/** Largest `inputs` payload, as UTF-8 JSON, the extension accepts (1 MB). */
export const MAX_INPUT_BYTES = 1_048_576;

/** Longest `app` name shown in the consent window. */
export const MAX_APP_NAME_LENGTH = 80;

/** Longest function `description` shown in the consent window. */
export const MAX_DESCRIPTION_LENGTH = 200;

/** A site-chosen function key: lowercase letters, digits, `.`, `_`, `-`, at most 64 characters. */
export const FUNCTION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Input names a website may never set: the user chose the persona and the function when
 * binding, and the auth policy belongs to the owner (CONTRACT.md §5).
 */
export const RESERVED_INPUT_NAMES: readonly string[] = Object.freeze([
  "persona_id",
  "function_name",
  "auth_policy",
]);

/** Input name prefixes that address the owner's vault or files; never accepted from a site. */
export const FORBIDDEN_INPUT_PREFIXES: readonly string[] = Object.freeze(["secret:", "file:"]);

/** Deepest nesting accepted inside `inputs`. */
export const MAX_INPUT_DEPTH = 64;

// ---------------------------------------------------------------------------------------------
// Installable workflows (CONTRACT.md §8). The Writ engine enforces the same limits
// (`site_package::parse`); the library checks them first to fail fast with a precise message.
// ---------------------------------------------------------------------------------------------

/** The only package format this library writes and the engine reads. */
export const PACKAGE_FORMAT = "writ.workflow/v1";

/** A package id: lowercase letters, digits, `.`, `_`, `-`, at most 64 characters. */
export const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Largest package, as UTF-8 JSON (512 KB). */
export const MAX_PACKAGE_BYTES = 524_288;

/** Most steps in one package. */
export const MAX_PACKAGE_STEPS = 500;

/** Longest package `name`, in characters. */
export const MAX_PACKAGE_NAME_LENGTH = 120;

/** Longest package `description`, in characters. */
export const MAX_PACKAGE_DESCRIPTION_LENGTH = 1_000;

/** Longest package `version`, in characters. */
export const MAX_PACKAGE_VERSION_LENGTH = 32;

/** Longest package `entry_url`, in characters. */
export const MAX_PACKAGE_ENTRY_URL_LENGTH = 2_048;

/** Most declared inputs in one package. */
export const MAX_PACKAGE_INPUTS = 64;

/** A declared input name: ASCII letters, digits, `_`, `.`, `-`, at most 64 characters. */
export const PACKAGE_INPUT_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Longest declared input `description`, in characters. */
export const MAX_PACKAGE_INPUT_DESCRIPTION_LENGTH = 200;

/** Most credentials one package may ask the user for. */
export const MAX_PACKAGE_CREDENTIALS = 10;

/** A credential key, as `{{secret:KEY}}` names it: ASCII letters, digits, `_`, at most 64. */
export const CREDENTIAL_KEY_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/** Longest credential `label`, in characters. */
export const MAX_CREDENTIAL_LABEL_LENGTH = 80;

/** Most local-network hosts one package may ask for. */
export const MAX_LOCAL_NETWORK_HOSTS = 8;

/** Longest `local_network.reason`, in characters. */
export const MAX_LOCAL_NETWORK_REASON_LENGTH = 200;

/** Most settings one package may declare: values each user gives once (CONTRACT.md §8). */
export const MAX_PACKAGE_SETTINGS = 8;

/** A setting key, as the recipe's `{{KEY}}` names it: ASCII letters, digits, `_`, at most 64. */
export const SETTING_KEY_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/** The kinds of setting: free text, or one address on the user's local network. */
export const SETTING_KINDS: readonly ("text" | "lan_host")[] = Object.freeze(["text", "lan_host"]);

/** Longest setting `label`, in characters. */
export const MAX_SETTING_LABEL_LENGTH = 80;

/** Longest setting `description`, in characters. */
export const MAX_SETTING_DESCRIPTION_LENGTH = 200;

/** Longest setting `example` (the field's placeholder), in characters. */
export const MAX_SETTING_EXAMPLE_LENGTH = 120;

/** Most suggested setting values one `FunctionRequest.settings` may carry. */
export const MAX_SUGGESTED_SETTINGS = 8;

/** Longest suggested setting value, in characters (UTF-16 units, as the extension counts). */
export const MAX_SETTING_VALUE_LENGTH = 200;

/**
 * Text a suggested setting value may not hold, as the extension refuses it: C0/C1 controls and
 * bidirectional overrides (which could make a value read like another in the consent window).
 */
export const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

/** Deepest nesting accepted inside a package (the engine's JSON reader stops at 128). */
export const MAX_PACKAGE_DEPTH = 128;

/** Step types a package may not carry: local files, the owner's AI key, generated code. */
export const REFUSED_PACKAGE_STEP_TYPES: readonly string[] = Object.freeze([
  "upload",
  "wait_for_download",
  "ai_fill_form",
  "ai_fill",
  "ai_continue",
  "ai_navigate",
  "codegen",
]);

// ---------------------------------------------------------------------------------------------
// Linked workflows (CONTRACT.md §11): the recipe stays in the developer's Writ Cloud
// ---------------------------------------------------------------------------------------------

/** A linked contract entry. */
export const LINKED_PACKAGE_FORMAT = "writ.linked/v1";

/** The manifest a linked contract entry carries. */
export const MANIFEST_FORMAT = "writ.manifest/v1";

/** Where publications live unless the contract names another base. */
export const DEFAULT_PUBLICATION_BASE = "https://api.usewrit.app";

/** A publication id: `pub_` + 22 ASCII letters or digits. */
export const PUBLICATION_ID_PATTERN = /^pub_[A-Za-z0-9]{22}$/;

/** A publishable key: `wpk_` + 32 ASCII letters or digits. Public by design. */
export const PUBLISHABLE_KEY_PATTERN = /^wpk_[A-Za-z0-9]{32}$/;

/** `manifest_hash`: sha256, 64 lowercase hex characters. */
export const MANIFEST_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Who may receive a linked recipe. */
export const LINKED_ACCESS_MODES: readonly ("public" | "token")[] = Object.freeze(["public", "token"]);

/** How long the visitor's Writ keeps a linked recipe in memory. */
export const RECIPE_CACHE_MODES: readonly ("session" | "call")[] = Object.freeze(["session", "call"]);

/** A run token is reused until this long before its `exp`, then fetched again. */
export const RUN_TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Longest run token the library sends (a JWT: header, claims and signature, base64url). */
export const MAX_RUN_TOKEN_LENGTH = 4_096;

// ---------------------------------------------------------------------------------------------
// Contract file and banner (CONTRACT.md §9, §10)
// ---------------------------------------------------------------------------------------------

/** The only contract format this library reads. */
export const CONTRACT_FORMAT = "writ.contract/v1";

/** Where the banner sends a visitor who needs Writ desktop. */
export const WRIT_DESKTOP_URL = "https://usewrit.app/desktop";

/** `sessionStorage` key prefix remembering that the visitor dismissed the banner. */
export const BANNER_DISMISSED_KEY_PREFIX = "writ:banner:dismissed:";

// ---------------------------------------------------------------------------------------------
// Writ Bridge (CONTRACT.md §12, docs/browser-extension/WRIT_BRIDGE_DESIGN.md)
// ---------------------------------------------------------------------------------------------

/** Where each function runs, in order of strictness. */
export const WRIT_BRIDGE_MODES: readonly ("required" | "recommended" | "cloud")[] = Object.freeze([
  "required",
  "recommended",
  "cloud",
]);

/** The route the server bridge mounts (`app.all('/writ-bridge', bridge.handler)`). */
export const DEFAULT_BRIDGE_ENDPOINT = "/writ-bridge";

/** Longest `challenge` a call may carry; the extension and the Writ engine refuse longer ones. */
export const MAX_CHALLENGE_LENGTH = 2_048;

/** Longest user token the page bridge sends in `Authorization: Writ <token>`. */
export const MAX_USER_TOKEN_LENGTH = 4_096;

/**
 * Names the bridge object itself uses. A contract key cannot start with one of them: it would
 * hide the method (`bridge.status.check` would make `bridge.status` a namespace).
 */
export const BRIDGE_RESERVED_NAMES: readonly string[] = Object.freeze([
  "ready",
  "status",
  "destroy",
  "venue",
  "suggestSettings",
  "refreshRecipes",
]);

/** How long the server may hold the page's long poll (`GET {endpoint}?wait=25`), in seconds. */
export const BRIDGE_POLL_WAIT_SECONDS = 25;

/** A long poll that has not answered this long after `wait` is given up and retried. */
export const BRIDGE_POLL_GRACE_MS = 10_000;

/** A poll that answered "no commands" faster than this waits the rest before polling again. */
export const BRIDGE_MIN_POLL_INTERVAL_MS = 1_000;

/** The page's readiness is re-sent this often while it polls. */
export const BRIDGE_HELLO_INTERVAL_MS = 60_000;

/** The page stops polling once it has been hidden this long, and resumes when it is shown. */
export const BRIDGE_HIDDEN_PAUSE_MS = 300_000;

/** Backoff after a failed poll: from this, doubling... */
export const BRIDGE_BACKOFF_MIN_MS = 1_000;

/** ...up to this. */
export const BRIDGE_BACKOFF_MAX_MS = 30_000;

/** Tries for posting one command's result (the first plus retries with backoff). */
export const BRIDGE_RESULT_ATTEMPTS = 4;

/** The extension runs at most this many calls at once per tab; the bridge queues the rest. */
export const MAX_LOCAL_CALLS_IN_FLIGHT = 4;

/** Command ids remembered so a re-delivered command is never run twice. */
export const BRIDGE_SEEN_COMMANDS = 256;

/**
 * A cloud call (`POST {endpoint} { run }`) is given up this long after its own timeout: your
 * server waits for Writ Cloud, which may queue the run first.
 */
export const BRIDGE_CLOUD_GRACE_MS = 30_000;
