/**
 * `createWritBridge()`: the Writ Bridge in the page (CONTRACT.md §12,
 * docs/browser-extension/WRIT_BRIDGE_DESIGN.md). One object with the same calls the server
 * bridge (`@usewrit/server`, Python `usewrit`) has, routed by a mode the developer chooses:
 *
 * ```ts
 * import { createWritBridge } from "@usewrit/web";
 * import contract from "./writ-contract.json";
 * import type { WritFunctions } from "./writ-functions";
 *
 * const bridge = createWritBridge<WritFunctions>({ contract, app: "Arrivos", mode: "required", userToken });
 * const { data, venue, receipt } = await bridge.pos.receive({ invoice_no: "F-1029" });
 * ```
 *
 * Where a page call runs (never an automatic fallback):
 * - `required`: on the visitor's computer. Until Writ is set up and the site granted, a blocking
 *   banner guides the visitor and the call waits for it.
 * - `recommended`: on the visitor's computer when their Writ is ready and the function granted;
 *   otherwise `POST {endpoint} { run }` to your server, which runs it on Writ Cloud. The banner
 *   suggests Writ and can be closed.
 * - `cloud`: always `POST {endpoint} { run }`. No banner.
 *
 * With a `userToken` (minted by your server), the page also serves your server's calls for this
 * user over the page channel (bridge-channel.ts).
 *
 * Package settings (CONTRACT.md §8), values each user gives once such as their POS address, can
 * be suggested with `settings` (on connect) or `bridge.suggestSettings()` (later): Writ's consent
 * window shows them pre-filled, and the user confirms them there.
 *
 * Linked workflows (CONTRACT.md §11) need nothing else: the contract decides. One in `token` mode
 * needs `getRunToken`; `recipeCache` and `bridge.refreshRecipes()` set how long the visitor's Writ
 * keeps their recipes. A linked contract from a Writ Cloud workflow carries `cloud` mappings, so
 * `recommended` and `cloud` work as for bundled ones.
 */

import { startBanner, type BannerBehavior, type WritBanner, type WritBannerWindow } from "./banner.js";
import { isBannerLocale, type WritBannerLocale } from "./banner-strings.js";
import {
  BridgeChannel,
  type BridgeCommand,
  type BridgeReadiness,
  type CommandOutcome,
  type FetchLike,
  type WritBridgeChannelState,
} from "./bridge-channel.js";
import type { WritClient, WritSession } from "./client.js";
import {
  BRIDGE_CLOUD_GRACE_MS,
  BRIDGE_RESERVED_NAMES,
  DEFAULT_BRIDGE_ENDPOINT,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  MAX_APP_NAME_LENGTH,
  MAX_LOCAL_CALLS_IN_FLIGHT,
  MAX_USER_TOKEN_LENGTH,
} from "./constants.js";
import {
  contractInputChecker,
  contractRequests,
  deepFreezeTree,
  isBridgeMode,
  suggestionsByPackage,
  validateContract,
  type FirstSegment,
  type LeafKey,
  type Subtree,
  type WritFunctionMap,
  type WritFunctionSpec,
} from "./contract.js";
import { WritError, isWritError, toWritError } from "./errors.js";
import { describeValue, isPlainObject } from "./json.js";
import { linkedAccessOfContract, requireRunTokens, validateLinkedOptions } from "./linked.js";
import { parseReceipt } from "./receipt.js";
import type {
  CallOptions,
  FunctionRequest,
  JsonObject,
  WritBridgeMode,
  WritContract,
  WritContractFunction,
  WritLinkedAccess,
  WritLinkedOptions,
  WritReceipt,
  WritRecipeCache,
  WritSettingSuggestions,
  WritSettingValues,
} from "./types.js";
import {
  sanitizeInputs,
  validateCallOptions,
  validateConnectRequest,
  type CleanCallOptions,
  type CleanConnectRequest,
} from "./validate.js";

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

/** Where a call ran: on the visitor's computer, or on Writ Cloud through your server. */
export type WritBridgeVenue = "user" | "cloud";

/** What a bridge call resolves with. */
export interface WritBridgeResult<TOut = unknown> {
  /** The function's declared outputs. Treat it like user input. */
  readonly data: TOut;
  readonly venue: WritBridgeVenue;
  /**
   * The receipt Writ signed for a run on the visitor's computer (null for `cloud`, or when the
   * visitor's Writ signed none). Send it to your server to verify (`bridge.verify(receipt, ...)`).
   */
  readonly receipt: WritReceipt | null;
  /** The run in the visitor's Writ history; null for `cloud`. */
  readonly runId: number | null;
  /** The extension's call id; null for `cloud`. */
  readonly callId: string | null;
}

/** Where the banner sits and which language it speaks. */
export interface WritBridgeBannerOptions {
  /** Render inside this element instead of fixed to the viewport. */
  container?: HTMLElement;
  /** Where the fixed banner sits. Default `"top"`. */
  position?: "top" | "bottom";
  /** Default: the visitor's browser language when it is English, French or Spanish, else English. */
  locale?: WritBannerLocale;
}

/** The parts of `window` the bridge uses. A real `window` fits. */
export interface WritBridgeWindow extends WritBannerWindow {
  readonly location?: { readonly href: string; readonly origin: string; reload(): void };
  fetch?(input: string, init?: RequestInit): Promise<Response>;
}

/**
 * Options of {@link createWritBridge}. `getRunToken` is required when a function that may run on
 * the visitor's computer (any mode but `cloud`) calls a linked workflow in `token` mode;
 * `recipeCache` (default `"session"`) is sent on every call to a linked workflow.
 */
export interface WritBridgeOptions extends WritLinkedOptions {
  /** The contract file Writ generated (`writ-contract.json`). */
  contract: WritContract;
  /** Your app's name, shown in the banner and the consent window, at most 80 characters. */
  app: string;
  /**
   * Where functions run unless the contract sets a function's own `mode`. Default `"required"`.
   * A function that reaches the local network is always `required`.
   */
  mode?: WritBridgeMode;
  /** Your server bridge's route, on this page's origin. Default `"/writ-bridge"`. */
  endpoint?: string;
  /**
   * The token your server minted for the signed-in user (`bridge.userToken(userId)`). With it,
   * your server can run functions on this visitor's computer through this page.
   */
  userToken?: string;
  /** `false`: no banner (you connect the visitor yourself). An object places it. Default `true`. */
  banner?: boolean | WritBridgeBannerOptions;
  /**
   * Values to suggest for the packages' settings when the visitor connects, by contract key then
   * setting key: `{ "pos.receive": { pos_host: "192.168.1.20:8080" } }`. Writ's consent window
   * shows them pre-filled for the user to confirm. A value suggested for one key holds for every
   * key of the same package. To suggest later (after your own form asked), use
   * `bridge.suggestSettings()`.
   */
  settings?: WritSettingSuggestions;
  /** How long to wait for the Writ extension on each check, in ms. Default 1 500. */
  timeoutMs?: number;
  /** The window to work in. Default: the global `window`. */
  window?: WritBridgeWindow;
}

/** What {@link WritBridgeControls.status} reports. */
export interface WritBridgeStatus {
  readonly mode: WritBridgeMode;
  /** `ready()` has resolved: every function can run where its mode says. */
  readonly ready: boolean;
  /** The visitor's Writ is connected to this site with at least one function granted. */
  readonly local: boolean;
  /** The contract keys the visitor granted, sorted. */
  readonly granted: readonly string[];
  /** The visitor's Writ desktop version, once known. */
  readonly writVersion: string | null;
  /** The page channel (`off` without a `userToken`). */
  readonly channel: WritBridgeChannelState;
  readonly destroyed: boolean;
}

/** The bridge's own methods, next to the contract's functions. */
export interface WritBridgeControls {
  /**
   * Resolves once every function can run where its mode says: with any `required` function,
   * once the visitor's Writ is set up and granted (the banner guides them); otherwise once the
   * bridge has checked for the visitor's Writ. Rejects with `CANCELLED` after `destroy()`.
   */
  ready(): Promise<void>;
  /** Where the bridge is, right now. */
  status(): WritBridgeStatus;
  /** Remove the banner, stop the page channel, and cancel every call still running or waiting. */
  destroy(): void;
  /**
   * Where a call to `key` would run now: `"user"`, `"cloud"`, or null while it would wait for
   * the visitor (`required`) or for the first check. Throws `BAD_REQUEST` for a key the contract
   * does not have.
   */
  venue(key: string): WritBridgeVenue | null;
  /**
   * Suggest values for the packages' settings, by contract key then setting key, typically
   * after your own form asked (`{ "pos.receive": { pos_host } }`). The values are kept for every
   * later connect, and Writ's consent window shows them pre-filled for the user to confirm or
   * correct; nothing is stored before they do.
   *
   * - Connected visitor: re-runs the connect for those keys, which opens the consent window as
   *   an update. Resolves once the user confirmed (at once when the values are already stored),
   *   and rejects with `CONSENT_DENIED` when they decline.
   * - Not connected yet: the banner's install window carries the values. Resolves once the
   *   visitor is connected; rejects with what ended the setup (`CONSENT_DENIED` when they closed
   *   a `recommended` banner).
   *
   * Rejects with `BAD_REQUEST` for a key the contract does not have or that runs on Writ Cloud,
   * `INPUT_INVALID` for a value (at most 8 per key, 1 to 200 characters, no control
   * characters, only settings the key's package declares), and `CANCELLED` after `destroy()`.
   */
  suggestSettings(values: WritSettingSuggestions): Promise<void>;
  /**
   * Drop the linked workflows' recipes the visitor's Writ holds for this page (CONTRACT.md §11):
   * the next call to each fetches its recipe from Writ Cloud again. Resolves at once when the
   * visitor's Writ is not on the page (nothing is held). Rejects with `CANCELLED` after
   * `destroy()`.
   */
  refreshRecipes(): Promise<void>;
}

/** One function of the bridge. Inputs may be left out when every input is optional. */
export type WritBridgeMethod<Fn extends WritFunctionSpec> = {} extends Fn["inputs"]
  ? (inputs?: Fn["inputs"], options?: CallOptions) => Promise<WritBridgeResult<Fn["outputs"]>>
  : (inputs: Fn["inputs"], options?: CallOptions) => Promise<WritBridgeResult<Fn["outputs"]>>;

type BridgeMethodOf<S> = S extends WritFunctionSpec ? WritBridgeMethod<S> : never;

/** The typed functions for a flat function map: `"pos.receive"` becomes `bridge.pos.receive(...)`. */
export type WritTypedBridge<F> = {
  readonly [K in keyof F as LeafKey<K>]: BridgeMethodOf<F[K]>;
} & {
  readonly [Head in FirstSegment<keyof F>]: WritTypedBridge<Subtree<F, Head & string>>;
};

/** The functions when no `WritFunctions` type is given: any path, untyped inputs and outputs. */
export interface WritDynamicBridge {
  readonly [segment: string]: WritDynamicBridge &
    ((inputs?: JsonObject, options?: CallOptions) => Promise<WritBridgeResult<unknown>>);
}

/** {@link WritTypedBridge} for a generated map, {@link WritDynamicBridge} without one. */
export type WritBridgeFor<F> = string extends keyof F ? WritDynamicBridge : WritTypedBridge<F>;

/** What {@link createWritBridge} returns: its controls, and one method per contract key. */
export type WritBridge<F = Record<string, WritFunctionSpec>> = WritBridgeControls & WritBridgeFor<F>;

// ---------------------------------------------------------------------------------------------
// createWritBridge
// ---------------------------------------------------------------------------------------------

/**
 * The Writ Bridge for this page. Throws `INPUT_INVALID` for an invalid contract, or a function
 * that reaches the local network under a mode other than `required`; `BAD_REQUEST` for invalid
 * options, or an endpoint that is not on this page's origin.
 *
 * `F` is the `WritFunctions` interface Writ generates next to the contract (`writ-functions.d.ts`).
 */
export function createWritBridge<F extends WritFunctionMap<F> = Record<string, WritFunctionSpec>>(
  options: WritBridgeOptions,
): WritBridge<F> {
  const config = validateBridgeOptions(options);
  const win = options.window ?? globalWindow() ?? null;
  const runtime = new BridgeRuntime(config, win);

  const root: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const entry of config.functions.values()) {
    const segments = entry.key.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node[segment] as Record<string, unknown> | undefined;
      if (next === undefined) {
        next = Object.create(null) as Record<string, unknown>;
        node[segment] = next;
      }
      node = next;
    }
    node[segments[segments.length - 1] as string] = bridgeMethod(runtime, entry);
  }
  root.ready = Object.freeze((): Promise<void> => runtime.ready());
  root.status = Object.freeze((): WritBridgeStatus => runtime.status());
  root.destroy = Object.freeze((): void => runtime.destroy());
  root.venue = Object.freeze((key: string): WritBridgeVenue | null => runtime.venue(key));
  root.suggestSettings = Object.freeze(
    (values: WritSettingSuggestions): Promise<void> => runtime.suggestSettings(values),
  );
  root.refreshRecipes = Object.freeze((): Promise<void> => runtime.refreshRecipes());

  runtime.start();
  return deepFreezeTree(root) as unknown as WritBridge<F>;
}

function bridgeMethod(
  runtime: BridgeRuntime,
  entry: BridgeFunction,
): (inputs?: object, options?: CallOptions) => Promise<WritBridgeResult<unknown>> {
  const method = (inputs?: object, options?: CallOptions): Promise<WritBridgeResult<unknown>> =>
    runtime.call(entry, inputs, options);
  Object.defineProperty(method, "name", { value: entry.key });
  return Object.freeze(method);
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

/** One contract function with its resolved mode. */
interface BridgeFunction {
  readonly key: string;
  readonly fn: WritContractFunction;
  readonly mode: WritBridgeMode;
  readonly check: (inputs: unknown) => void;
  /** Its package's access mode when the package is linked (CONTRACT.md §11), else null. */
  readonly linked: WritLinkedAccess | null;
}

interface BridgeConfig {
  readonly app: string;
  readonly contract: WritContract;
  readonly mode: WritBridgeMode;
  readonly functions: ReadonlyMap<string, BridgeFunction>;
  readonly endpoint: string;
  readonly userToken: string | null;
  /** False: no banner (headless checks only). */
  readonly banner: false | WritBridgeBannerOptions;
  readonly timeoutMs: number;
  /** The `settings` option: suggested setting values, by package id. */
  readonly settings: ReadonlyMap<string, WritSettingValues>;
  readonly getRunToken: (() => Promise<string>) | null;
  /** Sent on every call to a linked workflow, unless the call sets its own. */
  readonly recipeCache: WritRecipeCache;
}

function badRequest(message: string): WritError {
  return new WritError("BAD_REQUEST", message);
}

/** A user token travels in a header: printable ASCII without spaces. */
const USER_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

function validateBridgeOptions(options: WritBridgeOptions): BridgeConfig {
  if (!isPlainObject(options)) {
    throw badRequest(
      "createWritBridge() takes { contract, app, mode?, endpoint?, userToken?, banner?, getRunToken?, recipeCache? }.",
    );
  }

  const rawApp = options.app;
  if (typeof rawApp !== "string" || rawApp.trim() === "") {
    throw badRequest("createWritBridge() needs `app`: your app's name, shown in the banner and the consent window.");
  }
  const app = rawApp.trim();
  if (app.length > MAX_APP_NAME_LENGTH) {
    throw badRequest(`\`app\` is ${app.length} characters; at most ${MAX_APP_NAME_LENGTH} are allowed.`);
  }

  if (options.contract === undefined || options.contract === null) {
    throw badRequest("createWritBridge() needs `contract`: your writ-contract.json.");
  }
  const contract = validateContract(options.contract);

  const mode = options.mode ?? "required";
  if (!isBridgeMode(mode)) {
    throw badRequest(`\`mode\` must be "required", "recommended" or "cloud"; got ${describeValue(mode)}.`);
  }

  const endpoint = options.endpoint ?? DEFAULT_BRIDGE_ENDPOINT;
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw badRequest("`endpoint` must be the path of your server bridge's route, such as \"/writ-bridge\".");
  }

  let userToken: string | null = null;
  if (options.userToken !== undefined && options.userToken !== null) {
    const token = options.userToken;
    if (typeof token !== "string" || token.length > MAX_USER_TOKEN_LENGTH || !USER_TOKEN_PATTERN.test(token)) {
      throw badRequest("`userToken` must be the token your server minted (bridge.userToken(userId)), as is.");
    }
    userToken = token;
  }

  const banner = validateBannerChoice(options.banner);

  let timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS;
  if (options.timeoutMs !== undefined) {
    const value = options.timeoutMs;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw badRequest("`timeoutMs` must be a non-negative number of milliseconds.");
    }
    timeoutMs = Math.round(value);
  }

  const win = options.window;
  if (
    win !== undefined &&
    (typeof win !== "object" ||
      win === null ||
      typeof win.addEventListener !== "function" ||
      typeof win.removeEventListener !== "function")
  ) {
    throw badRequest("`window` must be a browser window.");
  }

  const linked = validateLinkedOptions(options, "createWritBridge()");
  const access = linkedAccessOfContract(contract);

  const functions = new Map<string, BridgeFunction>();
  for (const fn of contract.functions) {
    const head = fn.key.split(".")[0] as string;
    if (BRIDGE_RESERVED_NAMES.includes(head)) {
      throw new WritError(
        "INPUT_INVALID",
        `contract key "${fn.key}" starts with "${head}", which the bridge itself uses (${BRIDGE_RESERVED_NAMES.join(", ")}). Rename the key.`,
      );
    }
    const resolved = fn.mode ?? mode;
    // The hosts the package names, and each visitor's own `lan_host` setting: Writ Cloud reaches neither.
    const lan = [...fn.local_network, ...(fn.settings ?? []).filter((s) => s.kind === "lan_host").map((s) => `{{${s.key}}}`)];
    if (lan.length > 0 && resolved !== "required") {
      throw new WritError(
        "INPUT_INVALID",
        `"${fn.key}" reaches the visitor's local network (${lan.join(", ")}), which Writ Cloud cannot reach, so it is always "required"; ${fn.mode === undefined ? "the bridge's" : "its"} mode says "${resolved}".`,
      );
    }
    functions.set(fn.key, {
      key: fn.key,
      fn,
      mode: resolved,
      check: contractInputChecker(fn),
      linked: access.get(fn.key) ?? null,
    });
  }
  // A function that only runs on Writ Cloud never calls the visitor's Writ, so needs no run token.
  const local = new Map([...access].filter(([key]) => functions.get(key)?.mode !== "cloud"));
  requireRunTokens(local, linked.getRunToken !== null, "createWritBridge()");

  const settings =
    options.settings === undefined || options.settings === null
      ? new Map<string, WritSettingValues>()
      : suggestionsByPackage(contract, options.settings, "settings", installedOnly(functions)).byPackage;

  return {
    app,
    contract,
    mode,
    functions,
    endpoint: endpoint.trim(),
    userToken,
    banner,
    timeoutMs,
    settings,
    getRunToken: linked.getRunToken,
    recipeCache: linked.recipeCache ?? "session",
  };
}

/**
 * Settings are values the visitor's Writ stores on the workflow it installs: a key that always
 * runs on Writ Cloud installs nothing, so it has none to suggest (BAD_REQUEST).
 */
function installedOnly(functions: ReadonlyMap<string, BridgeFunction>): (fn: WritContractFunction) => void {
  return (fn) => {
    if (functions.get(fn.key)?.mode !== "cloud") return;
    throw badRequest(
      `"${fn.key}" runs on Writ Cloud (mode "cloud"), which installs nothing on the visitor's computer, so it has no settings to suggest.`,
    );
  };
}

function validateBannerChoice(banner: WritBridgeOptions["banner"]): false | WritBridgeBannerOptions {
  if (banner === undefined || banner === true) return {};
  if (banner === false) return false;
  if (!isPlainObject(banner)) throw badRequest("`banner` must be true, false or { container?, position?, locale? }.");
  const out: WritBridgeBannerOptions = {};
  if (banner.position !== undefined) {
    if (banner.position !== "top" && banner.position !== "bottom") throw badRequest('`banner.position` must be "top" or "bottom".');
    out.position = banner.position;
  }
  if (banner.locale !== undefined) {
    if (!isBannerLocale(banner.locale)) throw badRequest('`banner.locale` must be "en", "fr" or "es".');
    out.locale = banner.locale;
  }
  if (banner.container !== undefined && banner.container !== null) {
    const container = banner.container as unknown;
    if (typeof container !== "object" || typeof (container as { append?: unknown }).append !== "function") {
      throw badRequest("`banner.container` must be an element of this page.");
    }
    out.container = container as HTMLElement;
  }
  return out;
}

function globalWindow(): WritBridgeWindow | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as WritBridgeWindow);
}

/**
 * The endpoint as an absolute URL on the page's own origin (CONTRACT.md §12.3: the page bridge
 * refuses any other). BAD_REQUEST otherwise.
 */
function resolveEndpoint(endpoint: string, win: WritBridgeWindow): URL {
  const location = win.location;
  if (location === undefined || typeof location.href !== "string" || typeof location.origin !== "string") {
    throw badRequest("The Writ Bridge needs the page's location to reach your endpoint.");
  }
  if (location.origin === "null" || location.origin === "") {
    throw badRequest("The Writ Bridge needs a page with a real origin (https), not a sandboxed or file page.");
  }
  let url: URL;
  try {
    url = new URL(endpoint, location.href);
  } catch {
    throw badRequest(`\`endpoint\` ${describeValue(endpoint)} is not a valid URL or path.`);
  }
  if (url.origin !== location.origin) {
    throw badRequest(
      `\`endpoint\` must be on this page's origin (${location.origin}); ${url.origin} is not. Mount the server bridge on your own site, e.g. "/writ-bridge".`,
    );
  }
  url.hash = "";
  return url;
}

// ---------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------

const noop = (): void => {};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = noop;
  let reject: (error: unknown) => void = noop;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nobody has to listen: ready() may never be called.
  promise.catch(noop);
  return { promise, resolve, reject };
}

/** The error a call ends with when its signal aborts: the destroy error, or CANCELLED. */
function abortedBy(signal: AbortSignal): WritError {
  const reason: unknown = signal.reason;
  if (isWritError(reason, "CANCELLED")) return reason;
  return new WritError("CANCELLED", "The call was aborted.", { cause: reason });
}

/** Add where the call ran to an error's details. */
function withVenue(error: WritError, venue: WritBridgeVenue): WritError {
  if (error.details?.venue === venue) return error;
  return new WritError(error.code, error.message, { details: { ...error.details, venue }, cause: error });
}

/** The receipt a failed local call carried, if any. */
function receiptOf(error: WritError): WritReceipt | null {
  return parseReceipt(error.details?.receipt);
}

/**
 * The extension runs at most 4 calls per tab at once. Every local call of this page, its own and
 * the server's commands, takes a slot first; the rest wait in order.
 */
class Slots {
  #free: number;
  readonly #queue: (() => void)[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortedBy(signal));
    if (this.#free > 0) {
      this.#free -= 1;
      return Promise.resolve(this.#releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve(this.#releaser());
      };
      const onAbort = (): void => {
        const index = this.#queue.indexOf(grant);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(abortedBy(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(grant);
    });
  }

  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next !== undefined) next();
      else this.#free += 1;
    };
  }
}

/** A promise that settles with `work`, or rejects when `signal` aborts first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedBy(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortedBy(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

class BridgeRuntime {
  readonly #config: BridgeConfig;
  readonly #win: WritBridgeWindow | null;
  readonly #endpoint: URL | null;
  readonly #fetch: FetchLike | null;
  /** Keys that may run on the visitor's computer (every mode but `cloud`). */
  readonly #localKeys: readonly string[];
  readonly #requiredKeys: readonly string[];
  readonly #slots = new Slots(MAX_LOCAL_CALLS_IN_FLIGHT);
  /** One controller per call in progress, aborted by destroy(). */
  readonly #live = new Set<AbortController>();
  readonly #channel: BridgeChannel | null;

  #destroyed = false;
  #generation = 0;
  #starter: WritBanner | null = null;
  #client: WritClient | null = null;
  #session: WritSession | null = null;
  #granted: readonly string[] = Object.freeze([]);
  #writVersion: string | null = null;
  /** Set when the visitor's Writ can no longer become ready on this page (no document, dismissed). */
  #localEnded: WritError | null = null;
  #refreshing = false;
  /** The first check for the visitor's Writ is done. */
  readonly #checked = deferred<void>();
  #isChecked = false;
  #sessionReady = deferred<WritSession>();
  #ready = deferred<void>();
  #isReady = false;
  #channelState: WritBridgeChannelState = "off";
  /** Suggested setting values by package id: the `settings` option, then each suggestSettings(). */
  readonly #suggestions: Map<string, WritSettingValues>;
  /** Bumped by each suggestSettings(). */
  #revision = 0;
  /** The revision the banner's last connect carried. */
  #bannerRevision = 0;

  constructor(config: BridgeConfig, win: WritBridgeWindow | null) {
    this.#config = config;
    this.#win = win;
    this.#suggestions = new Map([...config.settings].map(([id, values]) => [id, { ...values }] as const));
    const entries = [...config.functions.values()];
    this.#localKeys = Object.freeze(entries.filter((entry) => entry.mode !== "cloud").map((entry) => entry.key));
    this.#requiredKeys = Object.freeze(entries.filter((entry) => entry.mode === "required").map((entry) => entry.key));

    const needsEndpoint = config.userToken !== null || entries.some((entry) => entry.mode !== "required");
    this.#endpoint = win !== null && needsEndpoint ? resolveEndpoint(config.endpoint, win) : null;
    this.#fetch = win === null ? null : resolveFetch(win);

    const document = win?.document ?? null;
    this.#channel =
      config.userToken !== null && this.#localKeys.length > 0 && this.#endpoint !== null && this.#fetch !== null
        ? new BridgeChannel({
            endpoint: this.#endpoint,
            token: config.userToken,
            fetch: this.#fetch,
            document,
            readiness: () => this.#readiness(),
            run: (command, signal) => this.#runCommand(command, signal),
            onState: (state) => {
              this.#channelState = state;
            },
          })
        : null;
    if (this.#channel !== null) this.#channelState = this.#channel.state;
  }

  start(): void {
    if (this.#win === null) {
      // Server rendering: nothing can run from here, in any mode.
      const error = new WritError("NOT_INSTALLED", "No browser window: the Writ Bridge runs in the page, not on the server.");
      this.#localEnded = error;
      this.#sessionReady.reject(error);
      this.#ready.reject(error);
      return;
    }
    if (this.#localKeys.length === 0) {
      this.#markChecked();
      return;
    }
    this.#startLocal();
    this.#channel?.start();
  }

  // ---- public ------------------------------------------------------------------------------

  ready(): Promise<void> {
    return this.#ready.promise;
  }

  status(): WritBridgeStatus {
    return Object.freeze({
      mode: this.#config.mode,
      ready: this.#isReady,
      local: this.#session !== null && this.#granted.length > 0,
      granted: this.#granted,
      writVersion: this.#writVersion,
      channel: this.#channelState,
      destroyed: this.#destroyed,
    });
  }

  venue(key: string): WritBridgeVenue | null {
    const entry = this.#config.functions.get(key);
    if (entry === undefined) throw badRequest(`"${String(key)}" is not a function of this bridge's contract.`);
    if (this.#destroyed || this.#win === null) return null;
    if (entry.mode === "cloud") return "cloud";
    if (this.#sessionFor(key) !== null) return "user";
    if (entry.mode === "recommended" && (this.#isChecked || this.#localEnded !== null)) return "cloud";
    return null;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#generation += 1;
    const error = new WritError("CANCELLED", "The Writ Bridge was destroyed.");
    this.#starter?.destroy();
    this.#starter = null;
    this.#channel?.stop();
    if (this.#channel !== null) this.#channelState = this.#channel.state;
    for (const controller of [...this.#live]) controller.abort(error);
    this.#live.clear();
    this.#sessionReady.reject(error);
    if (this.#isReady) {
      this.#isReady = false;
      this.#ready = deferred<void>();
    }
    this.#ready.reject(error);
  }

  call(entry: BridgeFunction, inputs: unknown, options: unknown): Promise<WritBridgeResult<unknown>> {
    return this.#call(entry, inputs, options);
  }

  async suggestSettings(values: unknown): Promise<void> {
    if (this.#destroyed) throw new WritError("CANCELLED", "The Writ Bridge was destroyed.");
    const accept = installedOnly(this.#config.functions);
    const { byPackage, keys } = suggestionsByPackage(this.#config.contract, values, "settings", accept);
    if (keys.length === 0) return;
    if (this.#win === null) {
      throw new WritError("NOT_INSTALLED", "No browser window: the Writ Bridge runs in the page, not on the server.");
    }
    // Kept for every later connect, the banner's included.
    for (const [id, suggested] of byPackage) this.#suggestions.set(id, { ...this.#suggestions.get(id), ...suggested });
    const revision = (this.#revision += 1);

    const link = this.#link(undefined);
    try {
      if (this.#session === null) {
        // Not connected yet: the banner's install window shows the values pre-filled.
        await untilAborted(this.#sessionReady.promise, link.signal);
        if (this.#bannerRevision >= revision) return;
      }
      // Connected (or connected without these values): ask again, as an update.
      const client = this.#client;
      if (client === null) throw new WritError("NOT_INSTALLED", "The Writ extension is not on this page.");
      const request = { app: this.#config.app, functions: this.#requests(new Set(keys)), ...this.#linkedOptions() };
      const session = await untilAborted(client.connect(request), link.signal);
      this.#replaceSession(session);
    } finally {
      link.dispose();
    }
  }

  async refreshRecipes(): Promise<void> {
    if (this.#destroyed) throw new WritError("CANCELLED", "The Writ Bridge was destroyed.");
    // No extension found (yet): the visitor's Writ holds nothing for this page.
    const client = this.#client;
    if (client === null) return;
    await client.refreshRecipes();
  }

  // ---- routing -----------------------------------------------------------------------------

  async #call(entry: BridgeFunction, inputs: unknown, options: unknown): Promise<WritBridgeResult<unknown>> {
    if (this.#destroyed) throw new WritError("CANCELLED", "The Writ Bridge was destroyed.");
    entry.check(inputs);
    const opts = validateCallOptions(options);
    const clean = sanitizeInputs(inputs) ?? {};
    if (this.#win === null) {
      throw new WritError("NOT_INSTALLED", "No browser window: the Writ Bridge runs in the page, not on the server.");
    }

    const link = this.#link(opts.signal);
    try {
      switch (entry.mode) {
        case "cloud":
          return await this.#cloud(entry, clean, opts, link.signal);
        case "recommended": {
          await this.#waitChecked(link.signal);
          const session = this.#sessionFor(entry.key);
          return session !== null
            ? await this.#local(session, entry, clean, opts, link.signal)
            : await this.#cloud(entry, clean, opts, link.signal);
        }
        case "required":
        default: {
          const session = this.#sessionFor(entry.key) ?? (await this.#waitForGrant(entry.key, link.signal));
          return await this.#local(session, entry, clean, opts, link.signal);
        }
      }
    } finally {
      link.dispose();
    }
  }

  /** A signal for one call: aborted by the page's own signal, or by destroy(). */
  #link(external: AbortSignal | undefined): { readonly signal: AbortSignal; dispose(): void } {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(external?.reason);
    if (external !== undefined) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener("abort", onAbort, { once: true });
    }
    this.#live.add(controller);
    return {
      signal: controller.signal,
      dispose: () => {
        external?.removeEventListener("abort", onAbort);
        this.#live.delete(controller);
      },
    };
  }

  #sessionFor(key: string): WritSession | null {
    const session = this.#session;
    return session !== null && this.#granted.includes(key) ? session : null;
  }

  /** `recommended` calls wait for the first check, so a visitor with Writ never runs on the cloud by a race. */
  async #waitChecked(signal: AbortSignal): Promise<void> {
    if (this.#isChecked || this.#localEnded !== null) return;
    await untilAborted(this.#checked.promise, signal);
  }

  /** `required` calls wait for the visitor's Writ (the banner guides them). */
  async #waitForGrant(key: string, signal: AbortSignal): Promise<WritSession> {
    if (this.#localEnded !== null) throw this.#localEnded;
    const session = await untilAborted(this.#sessionReady.promise, signal);
    const current = this.#sessionFor(key);
    if (current !== null) return current;
    throw new WritError("NOT_GRANTED", `The visitor's Writ does not grant "${key}" to this site.`, {
      details: { origin: session.origin },
    });
  }

  async #local(
    session: WritSession,
    entry: BridgeFunction,
    inputs: JsonObject,
    opts: CleanCallOptions,
    signal: AbortSignal,
  ): Promise<WritBridgeResult<unknown>> {
    const release = await this.#slots.acquire(signal);
    try {
      const call = session.call<unknown>(entry.key, inputs, {
        signal,
        timeoutMs: opts.timeoutMs,
        dryRun: opts.dryRun,
        challenge: opts.challenge,
        ...this.#linkedCallOptions(entry, opts.token, opts.recipeCache),
      });
      const result = await call.result;
      return Object.freeze({
        data: result.data,
        venue: "user" as const,
        receipt: result.receipt ?? null,
        runId: result.runId,
        callId: result.callId,
      });
    } catch (error) {
      const failure = toWritError(error);
      if (failure.code === "NOT_GRANTED" || failure.code === "GRANT_STALE") void this.#refreshGrants(session);
      throw withVenue(failure, "user");
    } finally {
      release();
    }
  }

  /** `POST {endpoint} { run: { key, inputs, options } }`: your server runs it on Writ Cloud. */
  async #cloud(
    entry: BridgeFunction,
    inputs: JsonObject,
    opts: CleanCallOptions,
    signal: AbortSignal,
  ): Promise<WritBridgeResult<unknown>> {
    const endpoint = this.#endpoint;
    const fetchFn = this.#fetch;
    if (endpoint === null || fetchFn === null) {
      throw new WritError("INTERNAL", "This page cannot reach your endpoint: no fetch.", { details: { venue: "cloud" } });
    }
    const runOptions: JsonObject = {};
    if (opts.timeoutMs !== undefined) runOptions.timeout_ms = opts.timeoutMs;
    if (opts.dryRun !== undefined) runOptions.dry_run = opts.dryRun;
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.#config.userToken !== null) headers.Authorization = `Writ ${this.#config.userToken}`;

    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
    const guardMs = (opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS) + BRIDGE_CLOUD_GRACE_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, guardMs);

    const where = { venue: "cloud" as const };
    /** Why the request or its body failed: our timeout, the caller's abort, or the network. */
    const failure = (error: unknown): WritError => {
      if (timedOut) return new WritError("TIMEOUT", `Your server did not answer within ${guardMs} ms.`, { details: where });
      if (signal.aborted) return withVenue(abortedBy(signal), "cloud");
      return new WritError("INTERNAL", `Could not reach ${endpoint.pathname}.`, { details: where, cause: error });
    };
    try {
      const answer = await fetchFn(endpoint.href, {
        method: "POST",
        headers,
        body: JSON.stringify({ run: { key: entry.key, inputs, options: runOptions } }),
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      }).catch((error: unknown) => {
        throw failure(error);
      });
      let payload: unknown;
      try {
        payload = await answer.json();
      } catch (error) {
        if (timedOut || signal.aborted) throw failure(error);
        payload = undefined;
      }

      if (!answer.ok) throw cloudError(answer.status, payload, endpoint);
      if (!isPlainObject(payload) || !("data" in payload)) {
        throw new WritError("INTERNAL", `${endpoint.pathname} answered without { data }.`, {
          details: { ...where, status: answer.status },
        });
      }
      return Object.freeze({ data: payload.data, venue: "cloud" as const, receipt: null, runId: null, callId: null });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * What a call to a linked workflow carries (CONTRACT.md §11): the recipe policy, and in token
   * mode a run token from `getRunToken`, unless the call brought its own. Nothing for the rest.
   */
  #linkedCallOptions(
    entry: BridgeFunction,
    token: CleanCallOptions["token"],
    recipeCache: WritRecipeCache | undefined,
  ): Pick<CallOptions, "token" | "recipeCache"> {
    if (entry.linked === null) return {};
    const out: Pick<CallOptions, "token" | "recipeCache"> = { recipeCache: recipeCache ?? this.#config.recipeCache };
    const source = token ?? (entry.linked === "token" ? this.#config.getRunToken ?? undefined : undefined);
    if (source !== undefined) out.token = source;
    return out;
  }

  /** `getRunToken` and `recipeCache`, for the connects and sessions the bridge makes. */
  #linkedOptions(): WritLinkedOptions {
    const out: WritLinkedOptions = { recipeCache: this.#config.recipeCache };
    if (this.#config.getRunToken !== null) out.getRunToken = this.#config.getRunToken;
    return out;
  }

  // ---- the visitor's Writ ------------------------------------------------------------------

  /** The connect requests for `keys`, each with its package's suggested settings. */
  #requests(keys: ReadonlySet<string>): FunctionRequest[] {
    return contractRequests(this.#config.contract, this.#suggestions).filter((request) => keys.has(request.key));
  }

  /** Find (or, with the banner, set up) the visitor's Writ for the local keys. */
  #startLocal(): void {
    const generation = (this.#generation += 1);
    const win = this.#win as WritBridgeWindow;
    const banner = this.#config.banner;
    const local = new Set(this.#localKeys);
    const behavior: BannerBehavior = {
      dismissible: this.#requiredKeys.length === 0,
      headless: banner === false,
      note: this.#requiredKeys.length > 0 ? "required" : "recommended",
      onClient: (client) => {
        if (generation === this.#generation) this.#client = client;
      },
      onPending: () => {
        if (generation === this.#generation) this.#markChecked();
      },
      // Read at the click: suggestSettings() may have added values since the banner mounted.
      connectRequest: (): CleanConnectRequest => {
        const request = validateConnectRequest({ app: this.#config.app, functions: this.#requests(local) });
        if (generation === this.#generation) this.#bannerRevision = this.#revision;
        return request;
      },
    };
    // A banner still watching an earlier session's linked calls gives way to the new one.
    this.#starter?.destroy();
    this.#starter = null;
    try {
      const handle = startBanner(
        {
          app: this.#config.app,
          functions: this.#requests(local),
          onReady: (session) => {
            if (generation === this.#generation) this.#adopt(session);
          },
          timeoutMs: this.#config.timeoutMs,
          window: win,
          ...this.#linkedOptions(),
          ...(banner === false ? {} : banner),
        },
        behavior,
      );
      this.#starter = handle;
      handle.session.catch((error: unknown) => {
        if (generation === this.#generation) this.#onLocalClosed(toWritError(error));
      });
    } catch (error) {
      this.#endLocal(toWritError(error));
    }
  }

  #adopt(session: WritSession): void {
    if (this.#destroyed) return;
    // The banner stays: with linked workflows it watches this session's calls ("Update",
    // "Unavailable"); otherwise it is already gone. destroy() removes it either way.
    this.#session = session;
    this.#granted = this.#grantedBy(session);
    this.#markChecked();
    this.#sessionReady.resolve(session);
    this.#updateReady();
    this.#channel?.notify();
    void this.#loadVersion(this.#generation);
  }

  /** The contract keys a session grants, sorted. */
  #grantedBy(session: WritSession): readonly string[] {
    return Object.freeze([...this.#config.functions.keys()].filter((key) => session.function(key) !== undefined).sort());
  }

  async #loadVersion(generation: number): Promise<void> {
    const client = this.#client;
    if (client === null) return;
    try {
      const status = await client.status();
      if (generation !== this.#generation || this.#destroyed) return;
      this.#writVersion = typeof status.desktop_version === "string" ? status.desktop_version : null;
      this.#channel?.notify();
    } catch {
      // Unknown version: hello says null.
    }
  }

  /** The banner closed without a session: dismissed (`recommended`), or no page to show it on. */
  #onLocalClosed(error: WritError): void {
    this.#starter = null;
    if (this.#destroyed) return;
    this.#endLocal(error);
  }

  #endLocal(error: WritError): void {
    this.#localEnded = error;
    this.#markChecked();
    this.#sessionReady.reject(error);
    if (this.#requiredKeys.length > 0 && !this.#isReady) this.#ready.reject(error);
    else this.#updateReady();
  }

  #markChecked(): void {
    if (this.#isChecked) return;
    this.#isChecked = true;
    this.#checked.resolve();
    this.#updateReady();
  }

  #updateReady(): void {
    if (this.#destroyed) return;
    const ok =
      this.#requiredKeys.length > 0
        ? this.#session !== null && this.#requiredKeys.every((key) => this.#granted.includes(key))
        : this.#isChecked;
    if (ok && !this.#isReady) {
      this.#isReady = true;
      this.#ready.resolve();
    } else if (!ok && this.#isReady) {
      this.#isReady = false;
      this.#ready = deferred<void>();
    }
  }

  /**
   * A local call said the grant is gone or stale: re-read it. When a local key is no longer
   * granted, the bridge goes back to setting the visitor up (the banner shows again).
   */
  async #refreshGrants(session: WritSession): Promise<void> {
    if (this.#refreshing || session !== this.#session || this.#destroyed) return;
    this.#refreshing = true;
    try {
      await session.refresh();
    } catch {
      // Writ unreachable: keep what we have; the next failure tries again.
      return;
    } finally {
      this.#refreshing = false;
    }
    if (session !== this.#session || this.#destroyed) return;
    const granted = this.#grantedBy(session);
    this.#granted = granted;
    if (this.#localKeys.every((key) => granted.includes(key))) {
      this.#channel?.notify();
      return;
    }
    this.#resetLocal();
  }

  /** A local key is no longer granted: drop the session and set the visitor up again (the banner shows). */
  #resetLocal(): void {
    this.#session = null;
    this.#granted = Object.freeze([]);
    this.#sessionReady = deferred<WritSession>();
    this.#updateReady();
    this.#channel?.notify();
    this.#startLocal();
  }

  /**
   * The grant suggestSettings() got from its own connect (the origin's whole grant): it replaces
   * the session. When it lost a local key (an update drops stale bindings), the visitor is set
   * up again.
   */
  #replaceSession(session: WritSession): void {
    if (this.#destroyed) return;
    const granted = this.#grantedBy(session);
    const complete = this.#localKeys.every((key) => granted.includes(key));
    if (this.#session === null) {
      // The banner was setting the visitor up again: this connect did it, so it goes away.
      if (!complete) return;
      this.#generation += 1;
      this.#starter?.destroy();
      this.#starter = null;
      this.#adopt(session);
      return;
    }
    if (!complete) {
      this.#resetLocal();
      return;
    }
    this.#session = session;
    this.#granted = granted;
    this.#updateReady();
    this.#channel?.notify();
  }

  // ---- page channel ------------------------------------------------------------------------

  #readiness(): BridgeReadiness {
    const ready = !this.#destroyed && this.#session !== null && this.#granted.length > 0;
    return { ready, granted: ready ? this.#granted : [], writ_version: this.#writVersion };
  }

  /** A server command: run it on the visitor's computer only when its key is granted. */
  async #runCommand(command: BridgeCommand, signal: AbortSignal): Promise<CommandOutcome> {
    const entry = this.#config.functions.get(command.key);
    const session = entry === undefined ? null : this.#sessionFor(command.key);
    if (entry === undefined || session === null) {
      return {
        ok: false,
        error: { code: "NOT_GRANTED", message: `This page's visitor has not granted "${command.key}" to this site.` },
        receipt: null,
      };
    }
    const link = this.#link(signal);
    try {
      entry.check(command.inputs);
      const release = await this.#slots.acquire(link.signal);
      try {
        const call = session.call<unknown>(command.key, command.inputs, {
          signal: link.signal,
          timeoutMs: command.timeoutMs,
          dryRun: command.dryRun,
          challenge: command.challenge ?? undefined,
          ...this.#linkedCallOptions(entry, undefined, undefined),
        });
        const result = await call.result;
        return { ok: true, data: result.data, receipt: result.receipt ?? null };
      } finally {
        release();
      }
    } catch (error) {
      const failure = toWritError(error);
      if (failure.code === "NOT_GRANTED" || failure.code === "GRANT_STALE") void this.#refreshGrants(session);
      return { ok: false, error: { code: failure.code, message: failure.message }, receipt: receiptOf(failure) };
    } finally {
      link.dispose();
    }
  }
}

function resolveFetch(win: WritBridgeWindow): FetchLike | null {
  if (typeof win.fetch === "function") {
    return (url, init) => (win.fetch as NonNullable<WritBridgeWindow["fetch"]>).call(win, url, init);
  }
  const globalFetch = (globalThis as { fetch?: (url: string, init?: RequestInit) => Promise<Response> }).fetch;
  if (typeof globalFetch === "function") return (url, init) => globalFetch.call(globalThis, url, init);
  return null;
}

/** A refused cloud call: the server's `{ error: { code, message } }`, else a code from the status. */
function cloudError(status: number, payload: unknown, endpoint: URL): WritError {
  const details = { venue: "cloud" as const, status };
  const raw = isPlainObject(payload) ? (isPlainObject(payload.error) ? payload.error : payload) : null;
  if (raw !== null && typeof raw.code === "string" && raw.code !== "") {
    return toWritError({ code: raw.code, message: typeof raw.message === "string" ? raw.message : undefined }, details);
  }
  switch (status) {
    case 400:
      return new WritError("BAD_REQUEST", undefined, { details });
    case 401:
    case 403:
      return new WritError("NOT_GRANTED", `${endpoint.pathname} refused this page (HTTP ${status}).`, { details });
    case 404:
    case 405:
      return new WritError(
        "BAD_REQUEST",
        `No Writ Bridge answered at ${endpoint.pathname} (HTTP ${status}). Mount the server bridge's handler there.`,
        { details },
      );
    case 408:
    case 504:
      return new WritError("TIMEOUT", undefined, { details });
    case 413:
      return new WritError("INPUT_INVALID", "The inputs are larger than your server accepts.", { details });
    case 429:
      return new WritError("RATE_LIMITED", undefined, { details });
    default:
      return new WritError("INTERNAL", `${endpoint.pathname} answered HTTP ${status}.`, { details });
  }
}
