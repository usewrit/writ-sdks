/**
 * `createWritBridge()`: the server side of the Writ Bridge (docs/browser-extension/CONTRACT.md §12.4,
 * WRIT_BRIDGE_DESIGN.md).
 *
 * ```ts
 * import { createWritBridge } from "@usewrit/server";
 * import contract from "./writ-contract.json" with { type: "json" };
 * import type { WritFunctions } from "./writ-functions";
 *
 * const bridge = createWritBridge<WritFunctions>({ contract, mode: "recommended" });
 * app.all("/writ-bridge", bridge.express());                  // the one route to mount
 * const { data, venue } = await bridge.user(userId).pos.receive({ invoice_no: "F-1029" });
 * ```
 */

import { performance } from "node:perf_hooks";

import { expressAdapter, isNodeCall, nextAdapter, type WritBridgeHandler, type WritExpressMiddleware, type WritNextHandlers } from "./adapters.js";
import { inputsHash } from "./canonical.js";
import { handleChannel, type ChannelContext } from "./channel.js";
import { runOnCloud, type CloudPollTiming } from "./cloud.js";
import {
  BRIDGE_MEMBER_NAMES,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_CHALLENGE_TTL_SECONDS,
  DEFAULT_CLOUD_BASE,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_POLL_SECONDS,
  DEFAULT_USER_TOKEN_TTL_SECONDS,
  MAX_CALL_TIMEOUT_MS,
  MAX_POLL_SECONDS,
  MAX_TOKEN_TTL_SECONDS,
  MAX_WAIT_FOR_USER_MS,
  MIN_CALL_TIMEOUT_MS,
  MIN_POLL_SECONDS,
  MIN_SECRET_BYTES,
  PICKUP_TIMEOUT_MS,
  PRESENCE_RECHECK_MS,
  PRESENCE_TTL_MS,
  RESULT_GRACE_MS,
} from "./constants.js";
import {
  WRIT_BRIDGE_MODES,
  buildTree,
  checkInputs,
  validateContract,
  type WritBridgeMode,
  type WritCallResult,
  type WritContract,
  type WritContractFunction,
  type WritFunctionMap,
  type WritFunctionSpec,
  type WritFunctionsFor,
} from "./contract.js";
import { WritBridgeError, normalizeVisitorCode, type WritBridgeErrorCode } from "./errors.js";
import { describeValue, isPlainObject, type JsonObject } from "./json.js";
import type { WritReceiptDevice } from "./receipt.js";
import { memoryStore, type WritBridgeStore, type WritCommand, type WritPendingCommand } from "./store.js";
import { mintChallenge, mintUserToken, newNonce, secretBytes, subjectOf } from "./tokens.js";
import { checkReceipt, type ReceiptExpectations, type WritDevicePolicy, type WritVerifyResult } from "./verify.js";

/** Options of {@link createWritBridge}. */
export interface WritBridgeOptions {
  /** The contract file (`writ-contract.json`), parsed or as text. */
  contract: unknown;
  /** Where functions run unless the contract or `functionModes` says otherwise. Default `"required"`. */
  mode?: WritBridgeMode;
  /** Per-key modes, over the contract's own `functions[].mode`. */
  functionModes?: Readonly<Record<string, WritBridgeMode>>;
  /** HMAC secret for user tokens and challenges, at least 32 bytes. Default `process.env.WRIT_BRIDGE_SECRET`. */
  secret?: string | Uint8Array;
  /** Writ Cloud API key, for `recommended` / `cloud`. Default `process.env.WRIT_API_KEY`. */
  apiKey?: string;
  /** Shared state. Default {@link memoryStore} (one process); use `redisStore()` for several. */
  store?: WritBridgeStore;
  /** Longest page long-poll, in seconds. Default 25. */
  pollSeconds?: number;
  /** Writ Cloud base URL. Default `https://api.usewrit.app`. */
  cloudBase?: string;
  /**
   * Which Writ installs may sign a user's receipts. Default `"first-use"`: the first device that
   * answers for a user is pinned to them, and another is refused (`unknownDevice`) until you
   * {@link WritBridgeCore.approveDevice approve} it. A function makes your own registry decide;
   * `"off"` accepts any signer (no protection against forged results). See {@link WritDevicePolicy}.
   */
  pinDevices?: WritDevicePolicy;
  /**
   * Gate for page calls routed to Writ Cloud (`POST { run }`), which spend your plan: answer
   * `true` to allow. Without it, any signed-in user may run any `recommended` / `cloud` function.
   */
  authorizeRun?: (userId: string, key: string, inputs: JsonObject) => boolean | Promise<boolean>;
  /** Writ Cloud result polling backoff. Default 1 s growing to 5 s. */
  cloudPoll?: CloudPollTiming;
  /** Largest page channel body, in bytes. Default 26 MB (a 25 MB result plus its receipt). */
  maxBodyBytes?: number;
  /** `fetch` for Writ Cloud calls. Default the global `fetch`. */
  fetch?: typeof fetch;
  /** Clock in unix milliseconds, for tests. */
  now?: () => number;
}

/** Options of a call through `bridge.user(id)`. */
export interface WritUserCallOptions {
  /** How long the call may take once started, in ms (1000 to 900000). Default 120000. */
  timeoutMs?: number;
  /**
   * In `required` mode, how long to wait for one of the user's pages to connect with Writ ready
   * and the function granted, before failing. Default 0. Not counted in `timeoutMs`.
   */
  waitForUserMs?: number;
  /** Preview a function that writes, without sending its changes, where it supports it. */
  dryRun?: boolean;
}

/** Options of a call without a user (Writ Cloud). */
export interface WritCloudCallOptions {
  /** How long the run may take, in ms (1000 to 900000). Default 120000. */
  timeoutMs?: number;
  /** Preview a function that writes (`mutation_mode: "dry_run"`). */
  dryRun?: boolean;
}

/** Options of `bridge.challenge()`. */
export interface WritChallengeOptions {
  /** Who or what the challenge is for: a user id, a login attempt... */
  subject: string | number;
  /** The contract key the visitor's computer must run. */
  key: string;
  /** Lifetime in seconds. Default 120. */
  ttlSeconds?: number;
}

/** Options of `bridge.verify()`. */
export interface WritVerifyOptions {
  /** The challenge from `bridge.challenge()`, exactly as minted. */
  challenge: string;
  /** The contract key the call was for. */
  key: string;
  /** The origin the call must come from, e.g. `"https://app.example.com"`. */
  origin?: string;
  /** The data the page reported; its hash must equal the receipt's. */
  data?: unknown;
  /** The subject the challenge must have been minted for. */
  subject?: string | number;
  /**
   * The inputs the call must have run with (say, the username and password your sign-in form got):
   * the receipt's `inputs_hash` must be theirs, so a page can't run the function with other ones.
   */
  inputs?: unknown;
}

/** The bridge's own members. */
export interface WritBridgeCore<F> {
  /** The validated contract. */
  readonly contract: WritContract;
  /** The page channel, as a fetch-API handler (also usable directly as Express middleware). */
  readonly handler: WritBridgeHandler;
  /** The page channel as Express middleware: `app.all("/writ-bridge", bridge.express())`. */
  express(): WritExpressMiddleware;
  /** The page channel as Next.js App Router handlers: `export const { GET, POST } = bridge.next()`. */
  next(): WritNextHandlers;
  /** The token your page passes to its bridge, for `userId`. */
  userToken(userId: string | number, options?: { ttlSeconds?: number }): string;
  /** The contract's functions, run for this user: on their computer, or by mode on Writ Cloud. */
  user(userId: string | number): WritFunctionsFor<F, WritUserCallOptions>;
  /** A single-use challenge for a page call you will check with {@link verify}. */
  challenge(options: WritChallengeOptions): string;
  /** Check a receipt the page relayed against your challenge. Never throws for a bad receipt. */
  verify(receipt: unknown, options: WritVerifyOptions): Promise<WritVerifyResult>;
  /** Whether one of the user's pages is connected with Writ ready. */
  online(userId: string | number): Promise<boolean>;
  /**
   * Pin a further device for a user (or challenge subject): a computer whose receipt came back
   * `unknownDevice`, once you have confirmed it is theirs.
   */
  approveDevice(userId: string | number, device: WritReceiptDevice | string): Promise<void>;
  /** Forget every device pinned for a user; their next receipt pins anew under `"first-use"`. */
  forgetDevices(userId: string | number): Promise<void>;
  /** Where a function runs, after the contract, `functionModes` and the local-network rule. */
  modeOf(key: string): WritBridgeMode;
  /** Release the store's resources and wake every waiting poll. */
  close(): Promise<void>;
}

/** The bridge: its members, plus the contract's functions on Writ Cloud (`bridge.pos.lookup(...)`). */
export type WritBridge<F = Record<string, WritFunctionSpec>> = WritBridgeCore<F> & WritFunctionsFor<F, WritCloudCallOptions>;

/** Why a user cannot take a call right now. */
type AwayCode = Extract<WritBridgeErrorCode, "WRIT_REQUIRED" | "USER_OFFLINE" | "NOT_GRANTED">;
type Route = { kind: "user" } | { kind: "away"; code: AwayCode };

/**
 * Where on the visitor's local network a function goes: the hosts its package names, and the
 * address each visitor gives once as a `lan_host` setting (CONTRACT.md §8 "Settings"). Writ Cloud
 * can reach neither, so such a function always runs on the visitor's computer.
 */
function localNetworkOf(fn: WritContractFunction): string[] {
  const settings = (fn.settings ?? []).filter((s) => s.kind === "lan_host").map((s) => `{{${s.key}}}`);
  return [...fn.local_network, ...settings];
}

function configInvalid(message: string): WritBridgeError {
  return new WritBridgeError("CONFIG_INVALID", message);
}

function env(name: string): string | undefined {
  const value = typeof process === "undefined" ? undefined : process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function isMode(value: unknown): value is WritBridgeMode {
  return typeof value === "string" && (WRIT_BRIDGE_MODES as readonly string[]).includes(value);
}

function cloudBaseOf(raw: unknown): string {
  if (typeof raw !== "string") throw configInvalid(`cloudBase must be a URL; got ${describeValue(raw)}.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configInvalid(`cloudBase ${describeValue(raw)} is not a URL.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw configInvalid("cloudBase must use https (http only for localhost): it carries WRIT_API_KEY.");
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw configInvalid("cloudBase must be a plain base URL, without credentials, query or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

/**
 * Build the server bridge. Refuses, at creation, anything that would fail later:
 * - an invalid contract (`INPUT_INVALID`);
 * - a `recommended` or `cloud` function without a `cloud: { workflow_id, function }` mapping, or
 *   without `WRIT_API_KEY` (`CLOUD_NOT_CONFIGURED`);
 * - a function with `local_network` hosts explicitly set to a mode other than `required`, a
 *   secret shorter than 32 bytes, or no secret while any function can run on a user's computer
 *   (`CONFIG_INVALID`).
 *
 * A function with `local_network` hosts that only inherits the bridge's mode is run as `required`:
 * Writ Cloud cannot reach the visitor's network.
 */
export function createWritBridge<F extends WritFunctionMap<F> = Record<string, WritFunctionSpec>>(
  options: WritBridgeOptions,
): WritBridge<F> {
  if (!isPlainObject(options)) throw configInvalid("createWritBridge() takes an options object { contract, mode, ... }.");
  const contract = validateContract(options.contract);
  const functions = new Map(contract.functions.map((fn) => [fn.key, fn] as const));

  const bridgeMode = options.mode ?? "required";
  if (!isMode(bridgeMode)) throw configInvalid(`mode must be "required", "recommended" or "cloud"; got ${describeValue(bridgeMode)}.`);

  const overrides = new Map<string, WritBridgeMode>();
  if (options.functionModes !== undefined) {
    if (!isPlainObject(options.functionModes)) throw configInvalid("functionModes must be an object { key: mode }.");
    for (const [key, value] of Object.entries(options.functionModes)) {
      if (!functions.has(key)) throw configInvalid(`functionModes names "${key}", which is not a function of the contract.`);
      if (!isMode(value)) throw configInvalid(`functionModes["${key}"] must be "required", "recommended" or "cloud".`);
      overrides.set(key, value);
    }
  }

  const rawSecret = options.secret ?? env("WRIT_BRIDGE_SECRET");
  let secret: Buffer | null = null;
  if (rawSecret !== undefined) {
    if (typeof rawSecret !== "string" && !(rawSecret instanceof Uint8Array)) {
      throw configInvalid("secret must be a string or bytes.");
    }
    const bytes = secretBytes(rawSecret);
    // An empty value (`secret: process.env.X` with X set to "") means no secret.
    if (bytes.length > 0) {
      if (bytes.length < MIN_SECRET_BYTES) {
        throw configInvalid(`WRIT_BRIDGE_SECRET must be at least ${MIN_SECRET_BYTES} bytes; it is ${bytes.length}. Generate one with: openssl rand -base64 48`);
      }
      secret = bytes;
    }
  }

  const rawApiKey = options.apiKey ?? env("WRIT_API_KEY");
  if (rawApiKey !== undefined && typeof rawApiKey !== "string") throw configInvalid("apiKey must be a string.");
  const apiKey = rawApiKey !== undefined && rawApiKey.trim() !== "" ? rawApiKey.trim() : null;

  const pollSeconds = options.pollSeconds ?? DEFAULT_POLL_SECONDS;
  if (!Number.isInteger(pollSeconds) || pollSeconds < MIN_POLL_SECONDS || pollSeconds > MAX_POLL_SECONDS) {
    throw configInvalid(`pollSeconds must be a whole number from ${MIN_POLL_SECONDS} to ${MAX_POLL_SECONDS}.`);
  }
  const cloudBase = cloudBaseOf(options.cloudBase ?? DEFAULT_CLOUD_BASE);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1_024) throw configInvalid("maxBodyBytes must be a whole number of at least 1024.");
  const devices: WritDevicePolicy = options.pinDevices ?? "first-use";
  if (devices !== "first-use" && devices !== "off" && typeof devices !== "function") {
    throw configInvalid('pinDevices must be "first-use", "off" or a function.');
  }
  for (const hook of ["authorizeRun", "fetch", "now"] as const) {
    if (options[hook] !== undefined && typeof options[hook] !== "function") throw configInvalid(`${hook} must be a function.`);
  }
  const now = options.now ?? Date.now;
  const store = options.store ?? memoryStore(options.now !== undefined ? { now: options.now } : {});

  // Effective modes, and the refusals that must happen now rather than on a user's first call.
  const modes = new Map<string, WritBridgeMode>();
  for (const fn of contract.functions) {
    const explicit = overrides.get(fn.key) ?? fn.mode;
    let mode: WritBridgeMode;
    const lan = localNetworkOf(fn);
    if (lan.length > 0) {
      if (explicit !== undefined && explicit !== "required") {
        throw configInvalid(
          `"${fn.key}" reaches the visitor's local network (${lan.join(", ")}), which Writ Cloud cannot reach; its mode must be "required", not "${explicit}".`,
        );
      }
      mode = "required";
    } else {
      mode = explicit ?? bridgeMode;
    }
    if (mode !== "required") {
      if (fn.cloud === undefined) {
        throw new WritBridgeError(
          "CLOUD_NOT_CONFIGURED",
          `"${fn.key}" is "${mode}" but the contract maps it to no Writ Cloud workflow; publish it from Writ Cloud, or make it "required".`,
        );
      }
      if (apiKey === null) {
        throw new WritBridgeError("CLOUD_NOT_CONFIGURED", `"${fn.key}" is "${mode}": set WRIT_API_KEY (or pass apiKey) to run it on Writ Cloud.`);
      }
    }
    modes.set(fn.key, mode);
  }
  const userSide = [...modes.values()].some((mode) => mode !== "cloud");
  if (userSide && secret === null) {
    throw configInvalid(
      `Set WRIT_BRIDGE_SECRET (at least ${MIN_SECRET_BYTES} bytes, e.g. openssl rand -base64 48): functions can run on your users' computers, and their pages authenticate with it.`,
    );
  }
  for (const fn of contract.functions) {
    const head = fn.key.split(".")[0] as string;
    if (BRIDGE_MEMBER_NAMES.includes(head)) {
      throw configInvalid(`The contract key "${fn.key}" starts with "${head}", a member of the bridge itself; rename it.`);
    }
  }
  const fetcher: typeof fetch | undefined = options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
  if (fetcher === undefined && apiKey !== null) throw configInvalid("No global fetch (Node 18 or later): pass options.fetch.");

  const modeOf = (key: string): WritBridgeMode => {
    const mode = modes.get(key);
    if (mode === undefined) throw new WritBridgeError("INPUT_INVALID", `The contract has no function "${key}".`);
    return mode;
  };

  const requireSecret = (what: string): Buffer => {
    if (secret === null) throw configInvalid(`${what} needs WRIT_BRIDGE_SECRET (at least ${MIN_SECRET_BYTES} bytes).`);
    return secret;
  };

  const ttlOf = (value: unknown, fallback: number, name: string): number => {
    const ttl = value ?? fallback;
    if (!Number.isSafeInteger(ttl) || (ttl as number) < 1 || (ttl as number) > MAX_TOKEN_TTL_SECONDS) {
      throw new WritBridgeError("BAD_REQUEST", `${name} must be a whole number of seconds from 1 to ${MAX_TOKEN_TTL_SECONDS}.`);
    }
    return ttl as number;
  };

  const userOf = (userId: unknown): string => {
    const sub = subjectOf(userId);
    if (sub === null) {
      throw new WritBridgeError("INPUT_INVALID", `A user id is a non-empty string of at most 256 characters, or a safe integer; got ${describeValue(userId)}.`);
    }
    return sub;
  };

  // -------------------------------------------------------------------------------------------
  // Writ Cloud
  // -------------------------------------------------------------------------------------------

  const runCloud = async (
    fn: WritContractFunction,
    inputs: JsonObject,
    call: { timeoutMs: number; dryRun: boolean },
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (fn.cloud === undefined || apiKey === null || fetcher === undefined) {
      throw new WritBridgeError("CLOUD_NOT_CONFIGURED", `"${fn.key}" has no Writ Cloud workflow mapped, or WRIT_API_KEY is not set.`);
    }
    return runOnCloud({
      base: cloudBase,
      apiKey,
      fetch: fetcher,
      mapping: fn.cloud,
      key: fn.key,
      inputs,
      timeoutMs: call.timeoutMs,
      dryRun: call.dryRun,
      ...(signal !== undefined ? { signal } : {}),
      ...(options.cloudPoll !== undefined ? { timing: options.cloudPoll } : {}),
    });
  };

  // -------------------------------------------------------------------------------------------
  // The user's computer
  // -------------------------------------------------------------------------------------------

  const routeFor = async (userId: string, key: string): Promise<Route> => {
    const presence = await store.getPresence(userId);
    const online = presence !== null && now() - presence.last_seen <= PRESENCE_TTL_MS;
    if (online && presence.ready && presence.granted.includes(key)) return { kind: "user" };
    if (online && presence.ready) return { kind: "away", code: "NOT_GRANTED" };
    if (online) return { kind: "away", code: "WRIT_REQUIRED" };
    if (presence?.ever_ready === true) return { kind: "away", code: "USER_OFFLINE" };
    return { kind: "away", code: "WRIT_REQUIRED" };
  };

  const waitForUser = async (userId: string, key: string, waitMs: number): Promise<Route> => {
    const deadline = performance.now() + waitMs;
    let route = await routeFor(userId, key);
    while (route.kind !== "user") {
      const left = deadline - performance.now();
      if (left <= 0) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(PRESENCE_RECHECK_MS, left)));
      route = await routeFor(userId, key);
    }
    return route;
  };

  type UserAttempt = { kind: "done"; result: WritCallResult<unknown> } | { kind: "away"; code: AwayCode };

  const runOnUser = async (
    userId: string,
    fn: WritContractFunction,
    inputs: JsonObject,
    call: { timeoutMs: number; dryRun: boolean },
  ): Promise<UserAttempt> => {
    const secretKey = requireSecret("Running a function on a user's computer");
    const id = newNonce();
    const sentAt = now();
    const expiresAt = Math.ceil((sentAt + call.timeoutMs) / 1000);
    const challengeExp = Math.ceil((sentAt + call.timeoutMs + RESULT_GRACE_MS) / 1000) + 1;
    const challenge = mintChallenge(secretKey, { sub: userId, key: fn.key, nonce: id, exp: challengeExp });
    const command: WritCommand = {
      id,
      key: fn.key,
      inputs,
      options: call.dryRun ? { timeout_ms: call.timeoutMs, dry_run: true } : { timeout_ms: call.timeoutMs },
      challenge,
      expires_at: expiresAt,
    };
    const pending: WritPendingCommand = {
      id,
      user: userId,
      key: fn.key,
      challenge,
      expires_at: challengeExp,
      inputs_hash: inputsHash(challenge, inputs),
    };
    const budget = call.timeoutMs + RESULT_GRACE_MS;
    await store.enqueue(userId, command, pending, budget + 1_000);

    const started = performance.now();
    let outcome = await store.awaitResult(id, Math.min(PICKUP_TIMEOUT_MS, budget));
    if (outcome === null && (await store.withdraw(userId, command))) {
      // No page took it: the user's pages went away without saying so.
      await store.cancel(id);
      return { kind: "away", code: "USER_OFFLINE" };
    }
    if (outcome === null) outcome = await store.awaitResult(id, Math.max(0, budget - (performance.now() - started)));
    if (outcome === null) {
      await store.cancel(id);
      throw new WritBridgeError("TIMEOUT", `${fn.key} did not answer from the user's computer within ${Math.round(call.timeoutMs / 1000)} s.`, {
        details: { commandId: id },
      });
    }
    if (outcome.ok) return { kind: "done", result: { data: outcome.data, venue: "user", receipt: outcome.receipt } };

    const code = normalizeVisitorCode(outcome.error.code);
    if (code === "NOT_GRANTED" && (outcome.receipt === undefined || outcome.receipt === null)) {
      // The page has not granted the key (its last hello was stale): nothing ran there.
      return { kind: "away", code: "NOT_GRANTED" };
    }
    const details: Record<string, unknown> = { commandId: id };
    if (outcome.receipt !== undefined && outcome.receipt !== null) details.receipt = outcome.receipt;
    if (code !== outcome.error.code) details.visitorCode = outcome.error.code;
    if (outcome.unknownDevice !== undefined) {
      details.unknownDevice = true;
      details.device = outcome.unknownDevice;
    }
    throw new WritBridgeError(code, outcome.error.message, { details });
  };

  const awayError = (code: AwayCode, key: string): WritBridgeError => {
    switch (code) {
      case "NOT_GRANTED":
        return new WritBridgeError("NOT_GRANTED", `The user has not granted "${key}" to this site in Writ.`);
      case "USER_OFFLINE":
        return new WritBridgeError("USER_OFFLINE", `"${key}" runs on the user's computer, and none of their pages is connected.`);
      default:
        return new WritBridgeError("WRIT_REQUIRED", `"${key}" runs on the user's computer, and the user has not reported Writ ready for this site.`);
    }
  };

  const callForUser = async (userId: string, fn: WritContractFunction, inputs: unknown, rawOptions: unknown): Promise<WritCallResult<unknown>> => {
    const clean = checkInputs(fn, inputs);
    const call = userCallOptions(rawOptions);
    const mode = modeOf(fn.key);
    if (mode === "cloud") return { data: await runCloud(fn, clean, call), venue: "cloud" };

    let route = await routeFor(userId, fn.key);
    if (route.kind !== "user" && mode === "required" && call.waitForUserMs > 0) {
      route = await waitForUser(userId, fn.key, call.waitForUserMs);
    }
    if (route.kind === "user") {
      const attempt = await runOnUser(userId, fn, clean, call);
      if (attempt.kind === "done") return attempt.result;
      route = attempt;
    }
    if (mode === "recommended") return { data: await runCloud(fn, clean, call), venue: "cloud" };
    throw awayError(route.code, fn.key);
  };

  const callOnCloud = async (fn: WritContractFunction, inputs: unknown, rawOptions: unknown): Promise<WritCallResult<unknown>> => {
    const clean = checkInputs(fn, inputs);
    const call = cloudCallOptions(rawOptions);
    if (modeOf(fn.key) === "required") {
      throw new WritBridgeError(
        "WRIT_REQUIRED",
        `"${fn.key}" runs only on a user's computer: call bridge.user(userId).${fn.key}(...) instead.`,
      );
    }
    return { data: await runCloud(fn, clean, call), venue: "cloud" };
  };

  // -------------------------------------------------------------------------------------------
  // Page channel
  // -------------------------------------------------------------------------------------------

  const pageRuns = new Map<string, number>();
  const channel: ChannelContext = {
    secret,
    store,
    pollSeconds,
    maxBodyBytes,
    now,
    functions,
    modeOf,
    runCloud,
    pageRuns,
    devices,
    ...(options.authorizeRun !== undefined ? { authorizeRun: options.authorizeRun } : {}),
  };
  const fetchHandler = (request: Request): Promise<Response> => handleChannel(channel, request);
  const middleware = expressAdapter(fetchHandler, maxBodyBytes);
  const handler = ((first: unknown, res?: unknown, next?: unknown): Promise<unknown> => {
    if (isNodeCall(first, res)) {
      return middleware(first as never, res as never, typeof next === "function" ? (next as (error?: unknown) => void) : undefined);
    }
    return fetchHandler(first as Request);
  }) as unknown as WritBridgeHandler;

  // -------------------------------------------------------------------------------------------
  // The object
  // -------------------------------------------------------------------------------------------

  const core: WritBridgeCore<F> = {
    contract,
    handler,
    express: () => middleware,
    next: () => nextAdapter(fetchHandler),

    userToken(userId, tokenOptions) {
      const sub = userOf(userId);
      if (tokenOptions !== undefined && !isPlainObject(tokenOptions)) throw new WritBridgeError("BAD_REQUEST", "userToken() options must be { ttlSeconds? }.");
      const ttl = ttlOf(tokenOptions?.ttlSeconds, DEFAULT_USER_TOKEN_TTL_SECONDS, "ttlSeconds");
      return mintUserToken(requireSecret("userToken()"), sub, Math.floor(now() / 1000) + ttl);
    },

    user(userId) {
      const sub = userOf(userId);
      return buildTree(contract.functions, (fn) => (inputs?: unknown, callOptions?: unknown) => callForUser(sub, fn, inputs, callOptions)) as unknown as WritFunctionsFor<F, WritUserCallOptions>;
    },

    challenge(challengeOptions) {
      if (!isPlainObject(challengeOptions)) throw new WritBridgeError("BAD_REQUEST", "challenge() takes { subject, key, ttlSeconds? }.");
      const sub = subjectOf(challengeOptions.subject);
      if (sub === null) throw new WritBridgeError("INPUT_INVALID", `challenge() subject must be a non-empty string of at most 256 characters, or a safe integer.`);
      modeOf(challengeOptions.key as string);
      const ttl = ttlOf(challengeOptions.ttlSeconds, DEFAULT_CHALLENGE_TTL_SECONDS, "ttlSeconds");
      return mintChallenge(requireSecret("challenge()"), { sub, key: challengeOptions.key, exp: Math.floor(now() / 1000) + ttl });
    },

    async verify(receipt, verifyOptions) {
      if (!isPlainObject(verifyOptions) || typeof verifyOptions.challenge !== "string" || typeof verifyOptions.key !== "string") {
        throw new WritBridgeError("BAD_REQUEST", "verify() takes (receipt, { challenge, key, origin?, data?, subject? }).");
      }
      const expect: ReceiptExpectations = {
        secret: requireSecret("verify()"),
        nowSeconds: Math.floor(now() / 1000),
        challenge: verifyOptions.challenge,
        key: verifyOptions.key,
        requireSuccess: true,
        spendNonce: (nonce, ttlMs) => store.spendNonce(nonce, ttlMs),
        devices,
        checkDevice: (subject, publicKey, firstUse) => store.checkDevice(subject, publicKey, firstUse),
      };
      if (verifyOptions.subject !== undefined) {
        const sub = subjectOf(verifyOptions.subject);
        if (sub === null) throw new WritBridgeError("BAD_REQUEST", "verify() subject must be a user id.");
        expect.subject = sub;
      }
      if (verifyOptions.origin !== undefined) {
        if (typeof verifyOptions.origin !== "string") throw new WritBridgeError("BAD_REQUEST", "verify() origin must be a string.");
        expect.origin = verifyOptions.origin;
      }
      if ("data" in verifyOptions && verifyOptions.data !== undefined) expect.data = { value: verifyOptions.data };
      if ("inputs" in verifyOptions && verifyOptions.inputs !== undefined) expect.inputs = { value: verifyOptions.inputs };
      const verdict = await checkReceipt(receipt, expect);
      const answer: WritVerifyResult = { ok: verdict.ok, outcome: verdict.outcome, device: verdict.device };
      if (verdict.reason !== undefined) answer.reason = verdict.reason;
      if (verdict.unknownDevice === true) answer.unknownDevice = true;
      return answer;
    },

    async approveDevice(userId, device) {
      const publicKey = typeof device === "string" ? device : isPlainObject(device) ? device.public_key : undefined;
      if (typeof publicKey !== "string" || !/^[A-Za-z0-9+/_-]{43}=?$/.test(publicKey)) {
        throw new WritBridgeError("BAD_REQUEST", "approveDevice() takes the user id and the receipt's device (or its public_key).");
      }
      await store.pinDevice(userOf(userId), publicKey);
    },

    async forgetDevices(userId) {
      await store.forgetDevices(userOf(userId));
    },

    async online(userId) {
      const presence = await store.getPresence(userOf(userId));
      return presence !== null && presence.ready && now() - presence.last_seen <= PRESENCE_TTL_MS;
    },

    modeOf,

    async close() {
      await store.close?.();
    },
  };

  const cloudTree = buildTree(contract.functions, (fn) => (inputs?: unknown, callOptions?: unknown) => callOnCloud(fn, inputs, callOptions));
  const bridge: Record<string, unknown> = { ...core };
  for (const name of Object.keys(cloudTree)) bridge[name] = cloudTree[name];
  return Object.freeze(bridge) as unknown as WritBridge<F>;
}

// ---------------------------------------------------------------------------------------------
// Call options
// ---------------------------------------------------------------------------------------------

function timeoutOf(value: unknown): number {
  if (value === undefined) return DEFAULT_CALL_TIMEOUT_MS;
  if (!Number.isInteger(value) || (value as number) < MIN_CALL_TIMEOUT_MS || (value as number) > MAX_CALL_TIMEOUT_MS) {
    throw new WritBridgeError("BAD_REQUEST", `timeoutMs must be a whole number of milliseconds from ${MIN_CALL_TIMEOUT_MS} to ${MAX_CALL_TIMEOUT_MS}.`);
  }
  return value as number;
}

function dryRunOf(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new WritBridgeError("BAD_REQUEST", "dryRun must be true or false.");
  return value;
}

function userCallOptions(raw: unknown): { timeoutMs: number; waitForUserMs: number; dryRun: boolean } {
  if (raw !== undefined && !isPlainObject(raw)) throw new WritBridgeError("BAD_REQUEST", "Call options must be { timeoutMs?, waitForUserMs?, dryRun? }.");
  const options: Record<string, unknown> = raw === undefined ? {} : (raw as Record<string, unknown>);
  const wait = options.waitForUserMs ?? 0;
  if (!Number.isInteger(wait) || (wait as number) < 0 || (wait as number) > MAX_WAIT_FOR_USER_MS) {
    throw new WritBridgeError("BAD_REQUEST", `waitForUserMs must be a whole number of milliseconds from 0 to ${MAX_WAIT_FOR_USER_MS}.`);
  }
  return { timeoutMs: timeoutOf(options.timeoutMs), waitForUserMs: wait as number, dryRun: dryRunOf(options.dryRun) };
}

function cloudCallOptions(raw: unknown): { timeoutMs: number; dryRun: boolean } {
  if (raw !== undefined && !isPlainObject(raw)) throw new WritBridgeError("BAD_REQUEST", "Call options must be { timeoutMs?, dryRun? }.");
  const options: Record<string, unknown> = raw === undefined ? {} : (raw as Record<string, unknown>);
  return { timeoutMs: timeoutOf(options.timeoutMs), dryRun: dryRunOf(options.dryRun) };
}
