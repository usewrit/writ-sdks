/**
 * Public types.
 *
 * Wire shapes (the provider, `writ_status`, granted functions, raw call events) keep the
 * contract's snake_case field names (docs/browser-extension/CONTRACT.md §1), exactly as the
 * extension sends them. Values this library builds (call results, call-handle events, options)
 * are camelCase. This mirrors `@usewrit/agent-sdk`: wire types as sent, SDK options in camelCase.
 */

import type { WritError } from "./errors.js";

/** A JSON value, as `inputs` and results travel. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------------------------
// Provider (`window.writ`, injected by the extension)
// ---------------------------------------------------------------------------------------------

/** The object the Writ extension injects as `window.writ` (CONTRACT.md §1). */
export interface WritProvider {
  /** Always `true`: tells the Writ provider apart from any other `window.writ`. */
  readonly isWrit: true;
  /** The extension's version. */
  readonly version: string;
  /** The page <-> provider protocol. */
  readonly protocol: 1;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: "call", listener: (payload: CallEvent) => void): void;
  off(event: "call", listener: (payload: CallEvent) => void): void;
}

/** What the provider says about itself. */
export interface WritProviderInfo {
  readonly name: string;
  readonly version: string;
  readonly protocol: number;
}

/** The `detail` of a `writ:announceProvider` event. */
export interface WritProviderAnnouncement {
  readonly provider: WritProvider;
  readonly info: WritProviderInfo;
}

// ---------------------------------------------------------------------------------------------
// Functions and grants
// ---------------------------------------------------------------------------------------------

/** Hints that pre-select one of the user's own functions in the consent window. */
export interface FunctionMatch {
  /** Part of the function or workflow name, e.g. `"Auphan receive"`. */
  name?: string;
  /** A host the function reaches, e.g. `"192.168.1.20"` or `"pos.example.com"`. */
  host?: string;
}

/**
 * One function the site asks for. Without `package`, the user binds it to one of their own
 * functions. With `package`, the user installs the site's workflow in the same click
 * (CONTRACT.md §8).
 */
export interface FunctionRequest {
  /** Site-chosen key: `[a-z0-9][a-z0-9._-]{0,63}`, e.g. `"pos.receive"`. */
  key: string;
  /** Shown in the consent window, at most 200 characters. */
  description: string;
  /** The site expects this function to change data. */
  writes?: boolean;
  /** Hints to pre-select the right function. */
  match?: FunctionMatch;
  /**
   * The workflow to install for this key: a bundled package (build it with `definePackage()`), or
   * a linked one from a contract file Writ Cloud generated (CONTRACT.md §11).
   */
  package?: WritContractPackage;
  /** Which function of `package` this key calls. Required when the package has several. */
  function?: string;
  /**
   * Values you suggest for the package's settings, by setting key, typically what the user
   * typed in your own form (`{ pos_host: "192.168.1.20:8080" }`). Writ's consent window shows
   * them pre-filled; the user confirms or corrects them, and nothing is stored before they do.
   * At most 8, each 1 to 200 characters without control characters. Needs `package`. A value
   * that differs from the installed one reopens consent as an update.
   */
  settings?: WritSettingValues;
}

/** Setting values by setting key, e.g. `{ pos_host: "192.168.1.20:8080" }`. */
export type WritSettingValues = { [settingKey: string]: string };

/**
 * Suggested setting values by contract key, then setting key:
 * `{ "pos.receive": { pos_host: "192.168.1.20:8080" } }`. Settings belong to a package, so a
 * value suggested for one key holds for every key of the same package.
 */
export type WritSettingSuggestions = { [contractKey: string]: WritSettingValues };

// ---------------------------------------------------------------------------------------------
// Installable workflows (CONTRACT.md §8)
// ---------------------------------------------------------------------------------------------

/** One input a package declares. The engine treats it as required unless `required` is false. */
export interface WritPackageInput {
  /** Shown to the user, at most 200 characters. */
  description?: string;
  /** Default `true`. */
  required?: boolean;
}

/**
 * Something the user types once, at install time, in the extension's own window. The workflow
 * reads it as `{{secret:KEY}}`. The value is sealed on the installed workflow and never reaches
 * the website.
 */
export interface WritPackageCredential {
  /** `[A-Za-z0-9_]{1,64}`, unique in the package; the `KEY` of `{{secret:KEY}}`. */
  key: string;
  /** The field's label in the install window, at most 80 characters. */
  label: string;
  /** Masked like a password. Default `true`. */
  secret?: boolean;
  /** The install cannot finish without it. Default `true`. */
  required?: boolean;
  /** Your site gives it with every call, as an input named after `key`: never asked for or stored. Default `false`. */
  per_call?: boolean;
}

/** What a setting holds: free text, or one address on the user's local network. */
export type WritSettingKind = "text" | "lan_host";

/**
 * A value each user gives once, in Writ's consent window: their POS address, a store number
 * (CONTRACT.md §8 "Settings"). The recipe reads it as `{{KEY}}`, and every run reuses the stored
 * value, whoever starts it. It is not an input: a website cannot pass it per call, only suggest
 * it (`FunctionRequest.settings`). It is not a secret either: use a credential for those.
 *
 * A URL whose scheme or host comes from a placeholder must take it from a setting, never from a
 * function input, or a site could aim the visitor's Writ anywhere, call by call.
 */
export interface WritSetting {
  /** `[A-Za-z0-9_]{1,64}`, unique in the package, and not also an input or a credential key. */
  key: string;
  /** The field's label in the consent window, 1 to 80 characters, e.g. `"Your POS address"`. */
  label: string;
  /** Where the user finds the value, at most 200 characters. */
  description?: string;
  /**
   * `lan_host`: one address on the user's local network, `host` or `host:port` (no scheme, path,
   * range or loopback). The confirmed value is approved as one of the workflow's local-network
   * hosts. `text`: at most 200 characters. Default `text`.
   */
  kind?: WritSettingKind;
  /** The field's placeholder, at most 120 characters, e.g. `"192.168.1.20:8080"`. */
  example?: string;
  /** The install cannot finish without it. Default `true`. */
  required?: boolean;
}

/** Local-network hosts the package needs, confirmed by the user in the install click. */
export interface WritPackageLocalNetwork {
  /**
   * At most 8 single hosts, each `host` or `host:port` (`192.168.1.20:8080`, `pos.local`,
   * `[fd12::5]:443`). No ranges, and never this computer itself (loopback, `localhost`).
   */
  hosts: string[];
  /** Why, in the site's words, shown next to the hosts. At most 200 characters. */
  reason?: string;
}

/**
 * A Writ workflow a website ships and the visitor installs with one click (`writ.workflow/v1`).
 *
 * An installed site workflow never reads the owner's vault, local files or personas. It sees
 * only its own declared inputs and the credentials the user typed for it at install time.
 */
export interface WritPackage {
  format: "writ.workflow/v1";
  /** The site's id for it, `[a-z0-9][a-z0-9._-]{0,63}`. (origin, id) names one installed workflow. */
  id: string;
  /** Shown to the user, at most 32 characters. A new version reopens consent as an update. */
  version?: string;
  /** 1 to 120 characters. */
  name: string;
  /** At most 1 000 characters. */
  description?: string;
  /** An http(s) address the workflow starts from. */
  entry_url?: string;
  /** Writ workflow steps, as a saved workflow stores them. 1 to 500. */
  steps: object[];
  /** Function declarations, as a saved workflow stores them. */
  functions?: object[];
  /** API-function map, as a saved workflow stores it. */
  api_functions?: object;
  /** Sign-in recipe (AuthRecipe v1). */
  auth_config?: object;
  /** Declared inputs, by name. */
  inputs?: { [name: string]: WritPackageInput };
  /** What the user types at install time, at most 10. */
  credentials?: WritPackageCredential[];
  /** Values each user gives once, at most 8. */
  settings?: WritSetting[];
  /** Local-network hosts the workflow reaches. */
  local_network?: WritPackageLocalNetwork;
  /** `"hidden"`: the user's Writ runs it but never shows, edits or exports its steps (not encrypted). Default `"visible"`. */
  recipe?: "visible" | "hidden";
}

/** The installed package a granted key is bound to, when the extension reports it. */
export interface GrantedPackage {
  readonly id: string;
  readonly version: string | null;
}

// ---------------------------------------------------------------------------------------------
// Linked workflows (CONTRACT.md §11): the recipe stays in the developer's Writ Cloud
// ---------------------------------------------------------------------------------------------

/** One function a linked workflow's manifest declares. */
export interface WritManifestFunction {
  /** The function's name, or null for a function-less workflow (the whole workflow is one callable). */
  name: string | null;
  inputs: { name: string; required: boolean; description?: string }[];
  outputs: string[];
  writes: boolean;
}

/**
 * What a linked workflow does, as Writ Cloud computed it from the published version: what the
 * visitor approves in consent. Writ re-checks every recipe it fetches against it.
 */
export interface WritManifest {
  format: "writ.manifest/v1";
  /** The publication, `pub_` + 22 letters or digits. */
  publication: string;
  name: string;
  description: string | null;
  publisher: { name: string | null };
  functions: WritManifestFunction[];
  /** Sorted unique `host[:port]` of every literal URL in the recipe. */
  destinations: string[];
  /** The visitors' local-network hosts the developer declared at publish. */
  lan_hosts: string[];
  lan_reason: string | null;
  /** One per `{{secret:K}}` the recipe names. */
  credentials: { key: string; label: string; secret: boolean; required: boolean }[];
  /** Values each visitor gives once (CONTRACT.md §8 "Settings"); empty when none. */
  settings: WritSetting[];
  /** The recipe has a step outside the HTTP set. */
  browser: boolean;
  /** The recipe has an `evaluate` step. */
  scripts: boolean;
}

/**
 * Who may receive a linked workflow's recipe: any page on its allowed origins (`public`), or only
 * calls carrying a run token your backend minted (`token`; pass `getRunToken`).
 */
export type WritLinkedAccess = "public" | "token";

/** Where a linked workflow is published. */
export interface WritPublicationRef {
  /** `pub_` + 22 letters or digits. */
  id: string;
  /** Writ Cloud's address, `https://api.usewrit.app` when absent. https, or http on this computer. */
  base?: string;
  /** Pins one published version; the latest when absent. */
  version?: number;
}

/**
 * A linked workflow (`writ.linked/v1`): the contract carries its manifest and a link, and the
 * visitor's Writ fetches the signed recipe from the developer's Writ Cloud to run each call,
 * keeping it in memory only. Writ Cloud generates it; it is never written by hand.
 */
export interface WritLinkedPackage {
  format: "writ.linked/v1";
  /** The package id, as for a bundled package: `[a-z0-9][a-z0-9._-]{0,63}`. */
  id: string;
  /** 1 to 120 characters. */
  name: string;
  publication: WritPublicationRef;
  /** The publishable key, `wpk_` + 32 letters or digits. Public by design. */
  key: string;
  access: WritLinkedAccess;
  /**
   * What the site says it is. Unverified: the site can write anything here. For display, prefer
   * `manifest.publisher.name`, which Writ Cloud vouches for.
   */
  publisher?: { name?: string };
  /** What Writ Cloud computed and vouches for; its `name` and `publisher` are the ones to show. */
  manifest: WritManifest;
  /** sha256 hex (64 lowercase characters) of the manifest's RFC 8785 canonical JSON. */
  manifest_hash: string;
}

/** A package of a contract: bundled (the recipe ships in the file) or linked (it stays in Writ Cloud). */
export type WritContractPackage = WritPackage | WritLinkedPackage;

/**
 * How long the visitor's Writ keeps a linked workflow's recipe in memory:
 * - `session` (the default): fetched at this page's first call, then reused until the page goes
 *   away or `refreshRecipes()`;
 * - `call`: fetched for every call.
 */
export type WritRecipeCache = "session" | "call";

/** Options for linked workflows, wherever sessions are made (connect, resume, banner, bridge, client). */
export interface WritLinkedOptions {
  /**
   * Resolves with a run token your backend minted (`mintRunToken` in `@usewrit/server`,
   * `mint_run_token` in `usewrit`). Required when the contract has a linked workflow in `token`
   * mode. Called before a call to such a workflow; the token is kept in memory, and only until
   * 60 seconds before it expires.
   */
  getRunToken?: () => Promise<string>;
  /** How long the visitor's Writ keeps a linked recipe. Default `"session"`. */
  recipeCache?: WritRecipeCache;
}

// ---------------------------------------------------------------------------------------------
// Contract file (CONTRACT.md §10)
// ---------------------------------------------------------------------------------------------

/** One declared input or output field of a contract function. */
export interface WritContractInput {
  name: string;
  required: boolean;
  description?: string;
}

/** One setting of a contract function's package: what your own form may ask the user for. */
export interface WritContractSetting {
  /** The setting's key in the package. */
  key: string;
  label: string;
  /** `lan_host`: ask for an address on the user's network; `text`: anything else. */
  kind: WritSettingKind;
}

/**
 * Where a function runs under the Writ Bridge (CONTRACT.md §12), always the developer's choice:
 * - `required`: on the visitor's computer only; the banner blocks until Writ is set up;
 * - `recommended`: on the visitor's computer when their Writ is ready, else on Writ Cloud;
 * - `cloud`: on Writ Cloud, through your server.
 */
export type WritBridgeMode = "required" | "recommended" | "cloud";

/** A contract function's workflow in the developer's Writ Cloud, filled when it is published. */
export interface WritCloudMapping {
  workflow_id: number | string;
  /** The workflow function the key calls; null when the workflow is one callable. */
  function: string | null;
}

/** One callable key of a contract file. */
export interface WritContractFunction {
  /** `[a-z0-9][a-z0-9._-]{0,63}`, unique. Dots make namespaces in the typed client. */
  key: string;
  description: string;
  /** The `id` of one of the contract's `packages`. */
  package: string;
  /** The package function this key calls; null when the package has a single callable. */
  function: string | null;
  inputs: WritContractInput[];
  outputs: string[];
  writes: boolean;
  /** Local-network hosts this function reaches. A function with any is always `required`. */
  local_network: string[];
  /**
   * The package's settings, for your own form: values each user gives once in Writ's consent
   * window, which you may suggest (`bridge.suggestSettings()`). Never call inputs.
   */
  settings?: WritContractSetting[];
  /** Where it runs under the Writ Bridge; absent means the bridge's own `mode`. */
  mode?: WritBridgeMode;
  /** Its workflow in the developer's Writ Cloud (for `recommended` / `cloud`), when published. */
  cloud?: WritCloudMapping | null;
}

/**
 * The file a developer downloads from Writ (`writ-contract.json`) and ships with the site: the
 * packages to install and the functions the site calls.
 */
export interface WritContract {
  format: "writ.contract/v1";
  /** ISO 8601. */
  generated_at: string;
  /** `"writ-desktop/<version>"` or `"writ-cloud"`. */
  generator: string;
  /** What the site says it is, shown in consent (not verified). */
  publisher?: { name?: string };
  functions: WritContractFunction[];
  /** Each id once: bundled packages, linked ones, or both. */
  packages: WritContractPackage[];
}

/**
 * The argument of `writ.connect()`. `getRunToken` and `recipeCache` stay in the page: they shape
 * the session's calls to linked workflows and are never sent to the extension.
 */
export interface ConnectRequest extends WritLinkedOptions {
  /** Your app's name, shown in the consent window, at most 80 characters. */
  app: string;
  /** The functions you need, at least one, keys unique. */
  functions: readonly FunctionRequest[];
}

/**
 * The argument of `writ.resume()`. Give the same `functions` you connect with, so the session
 * knows which keys are linked workflows (their run tokens and recipe cache).
 */
export interface ResumeOptions extends WritLinkedOptions {
  functions?: readonly FunctionRequest[];
}

/** One declared input of a granted function. */
export interface FunctionInput {
  readonly name: string;
  readonly required: boolean;
  readonly description?: string;
}

/** A function the user granted to this origin (wire shape). */
export interface GrantedFunction {
  readonly key: string;
  readonly description: string;
  readonly inputs: readonly FunctionInput[];
  /** The output fields the site receives. */
  readonly outputs: readonly string[];
  /** The bound function changes data. Calls ask the user first under the default policy. */
  readonly writes: boolean;
  /** The bound function reaches the owner's local network. */
  readonly local_network: boolean;
  /**
   * The installed site package this key is bound to: `null` when it is bound to one of the
   * user's own workflows, absent when the extension does not report it.
   */
  readonly package?: GrantedPackage | null;
}

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------

/** Why a run is waiting for the person at the computer. */
export type NeedsUserReason = "twofa" | "captcha" | "vault_locked" | "confirm";

/** Which engine ran the call. */
export type CallEngine = "http" | "browser" | "hybrid";

/**
 * A run's signed receipt (CONTRACT.md §12.1): Writ on the visitor's computer signs what ran, for
 * whom and what it returned, so your server can check a result the page hands it. Verify it on
 * the server (`@usewrit/server` / Python `usewrit`); the page only carries it, untouched.
 */
export interface WritReceipt {
  readonly v: 1;
  readonly origin: string;
  readonly key: string;
  readonly package: string | null;
  readonly function: string | null;
  /** The challenge your server minted and the call carried, else null. */
  readonly challenge: string | null;
  readonly outcome: "success" | "failed" | "error" | "timeout" | "cancelled";
  readonly error_code: string | null;
  /** sha256 hex of the RFC 8785 canonical JSON of the data the page received (null unless success). */
  readonly data_hash: string | null;
  /** sha256 hex of the call's challenge, a newline and the canonical JSON of its inputs (what it ran with). */
  readonly inputs_hash?: string;
  readonly run_id: number;
  /** Unix seconds. */
  readonly started_at: number;
  /** Unix seconds. */
  readonly finished_at: number;
  readonly writ: { readonly version: string };
  /** `public_key` is base64url (32 bytes); `kid` is the first 16 hex of sha256(public_key bytes). */
  readonly device: {
    readonly kid: string;
    readonly alg: "Ed25519";
    readonly public_key: string;
    readonly hardware: boolean;
  };
  /** base64url Ed25519 over the canonical JSON of the receipt without `sig`. */
  readonly sig: string;
}

/** A provider `call` event (wire shape). Progress carries no step labels and no URLs. */
export type CallEvent =
  | { call_id: string; type: "started"; run_id: number }
  | { call_id: string; type: "progress"; index: number; total: number }
  | { call_id: string; type: "needs_user"; reason: NeedsUserReason }
  | {
      call_id: string;
      type: "finished";
      run_id: number;
      data: unknown;
      duration_ms: number;
      engine: CallEngine | null;
      /** Sent by extensions that pass receipts on (null when there is none). */
      receipt?: WritReceipt | null;
    }
  | {
      call_id: string;
      type: "error";
      code: string;
      message: string;
      /** Sent when a run took place and Writ signed its outcome. */
      receipt?: WritReceipt | null;
    };

/** What a successful call resolves with. */
export interface CallResult<TOut = unknown> {
  /** The function's declared outputs. Treat it like user input: the user chose the function. */
  readonly data: TOut;
  /** The run in the user's Writ history. */
  readonly runId: number;
  readonly durationMs: number;
  readonly engine: CallEngine | null;
  readonly callId: string;
  /**
   * The run's signed receipt, when the extension passes receipts on (null when Writ signed none).
   * Absent with an extension from before receipts.
   */
  readonly receipt?: WritReceipt | null;
}

/** Per-call options. */
export interface CallOptions {
  /** Aborting cancels the run (`writ_cancel`) and rejects with `CANCELLED`. */
  signal?: AbortSignal;
  /** The run's time budget. The extension clamps it to [1 000, 900 000] ms; default 120 000. */
  timeoutMs?: number;
  /** Ask the function to run without changing anything, where it supports that. */
  dryRun?: boolean;
  /**
   * A challenge your server minted (`bridge.challenge(...)` in `@usewrit/server`), at most 2 048
   * characters. Writ signs it into the run's receipt, so the server can tell this run answered
   * that challenge. Opaque to the page; sent as is.
   */
  challenge?: string;
  /**
   * The run token for a linked workflow in `token` mode (CONTRACT.md §11), or a function that
   * resolves with one, called just before the call goes out. A function is cached like
   * `getRunToken`, per function: pass the same one every time. Without it, the session's own
   * `getRunToken` answers for the linked workflows it knows.
   */
  token?: string | (() => Promise<string>);
  /** How long the visitor's Writ keeps a linked recipe. Default: the session's, else `"session"`. */
  recipeCache?: WritRecipeCache;
}

/** Where a call is in its life. */
export type CallStatus = "pending" | "running" | "finished" | "failed" | "cancelled";

/** Events of a call handle and their payloads. */
export interface WritCallEvents<TOut = unknown> {
  /** The run started. */
  started: { readonly runId: number };
  /** Step `index` of `total` is done. */
  progress: { readonly index: number; readonly total: number };
  /** The run waits for the person at the computer (a 2FA code, a CAPTCHA, the vault, a write confirmation). */
  needsUser: { readonly reason: NeedsUserReason };
  /** The run finished; same value `call.result` resolves with. */
  finished: CallResult<TOut>;
  /** The call failed; same error `call.result` rejects with. */
  error: WritError;
}

/** The names of call-handle events. */
export type WritCallEventName = keyof WritCallEvents;

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

/** `writ_status` (wire shape). */
export interface WritStatus {
  readonly extension_version: string;
  readonly protocol: number;
  /** Is Writ desktop's native host registered and compatible? */
  readonly host: "ok" | "missing" | "outdated";
  /** Is the Writ engine up? `started` means it was started for this request. */
  readonly daemon: "running" | "started" | "unavailable";
  readonly desktop_version: string | null;
  /** This Writ desktop can reach the owner's local network. */
  readonly lan_capable: boolean;
}

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

/** Which store the visitor's browser installs from. `other` has no Writ extension (Firefox, Safari, mobile). */
export type BrowserKind = "chrome" | "edge" | "chromium" | "other";

/** The parts of `navigator` the library reads. */
export interface WritNavigator {
  readonly userAgent?: string;
  /** Read by the banner to pick its language. */
  readonly language?: string;
  readonly languages?: readonly string[];
  readonly userAgentData?: {
    readonly brands?: readonly { readonly brand?: string; readonly version?: string }[];
    readonly mobile?: boolean;
  } | null;
}

/** The parts of `window` the library uses. A real `window` fits. */
export interface WritWindow {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
  readonly writ?: unknown;
  readonly navigator?: WritNavigator;
  readonly Event?: typeof Event;
}

/** Options of `connectWrit()`. */
export interface ConnectWritOptions {
  /** How long to wait for the extension, in ms. Default 1 500. */
  timeoutMs?: number;
  /** The window to look in. Default: the global `window`. */
  window?: WritWindow;
}

/** What `connectWrit()` answers when Writ cannot be used from this page. */
export interface WritUnavailable {
  readonly available: false;
  /** `NOT_INSTALLED`: no extension. `DESKTOP_OUTDATED`: an extension with another protocol. */
  readonly reason: "NOT_INSTALLED" | "DESKTOP_OUTDATED";
  /** Chrome Web Store or Edge Add-ons, for this browser. */
  readonly installUrl: string;
  readonly browser: BrowserKind;
  readonly error: WritError;
}
