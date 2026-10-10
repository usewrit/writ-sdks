/**
 * `connectWrit()`, the client it returns, and sessions.
 *
 * ```ts
 * const writ = await connectWrit();
 * if (!writ.available) return showInstall(writ.installUrl);
 * const session = await writ.connect({ app: "Arrivos", functions: [{ key: "pos.receive", description: "Receive an invoice in the POS", writes: true }] });
 * const { data } = await session.call("pos.receive", { invoice_no: "F-1029" }).result;
 * ```
 *
 * A session made with linked workflows (CONTRACT.md §11) in its `functions` sends each of their
 * calls the recipe cache policy and, in `token` mode, a run token from `getRunToken`.
 */

import { WritCall, CallRouter, type CallInit } from "./call.js";
import { DEFAULT_DISCOVERY_TIMEOUT_MS, WRIT_PROTOCOL } from "./constants.js";
import { detectBrowser, findProvider, installUrlFor } from "./discovery.js";
import { WritError, toWritError } from "./errors.js";
import { NO_LINKED_WORKFLOWS, linkedSessionConfig, type LinkedSessionConfig } from "./linked.js";
import { runTokensFor, type RunTokenCache } from "./run-token.js";
import type {
  BrowserKind,
  CallOptions,
  ConnectRequest,
  ConnectWritOptions,
  FunctionInput,
  FunctionRequest,
  GrantedFunction,
  GrantedPackage,
  ResumeOptions,
  WritNavigator,
  WritProvider,
  WritProviderInfo,
  WritStatus,
  WritUnavailable,
  WritWindow,
} from "./types.js";
import {
  sanitizeInputs,
  validateCallOptions,
  validateConnectRequest,
  validateDiscoveryTimeout,
  validateFunctionKey,
  validateFunctionRequests,
} from "./validate.js";

/**
 * Find the Writ extension on this page.
 *
 * Answers a {@link WritClient} (`available: true`) when the extension is there, else a
 * {@link WritUnavailable} (`available: false`) with the store link for this browser. Never
 * opens anything and never prompts the user. Safe to call during server rendering: without a
 * `window` it answers "not installed".
 *
 * Rejects only with `BAD_REQUEST` for an invalid `timeoutMs`.
 */
export async function connectWrit(options: ConnectWritOptions = {}): Promise<WritClient | WritUnavailable> {
  const timeoutMs = validateDiscoveryTimeout(options.timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS);
  const win = options.window ?? globalWindow();
  const browser = detectBrowser(win?.navigator ?? globalNavigator());
  const installUrl = installUrlFor(browser);

  if (win === undefined) {
    return unavailable("NOT_INSTALLED", browser, installUrl, "No browser window: Writ runs in the page, not on the server.");
  }

  const outcome = await findProvider(win, timeoutMs);
  switch (outcome.kind) {
    case "found":
      return new WritClient(outcome.provider, outcome.info, browser);
    case "outdated":
      return unavailable(
        "DESKTOP_OUTDATED",
        browser,
        installUrl,
        `The Writ extension${outcome.version === null ? "" : ` ${outcome.version}`} speaks protocol ${String(outcome.protocol)}; this page speaks protocol ${WRIT_PROTOCOL}. Update the Writ extension, or the site's @usewrit/web.`,
        { extensionVersion: outcome.version, extensionProtocol: outcome.protocol },
      );
    case "missing":
    default:
      return unavailable("NOT_INSTALLED", browser, installUrl, undefined);
  }
}

function unavailable(
  reason: WritUnavailable["reason"],
  browser: BrowserKind,
  installUrl: string,
  message: string | undefined,
  details?: Record<string, unknown>,
): WritUnavailable {
  return Object.freeze({
    available: false as const,
    reason,
    installUrl,
    browser,
    error: new WritError(reason, message, { details: { ...details, browser, installUrl } }),
  });
}

function globalWindow(): WritWindow | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function globalNavigator(): WritNavigator | undefined {
  return typeof navigator === "undefined" ? undefined : navigator;
}

/**
 * Writ, found on this page. Get one from {@link connectWrit}.
 */
export class WritClient {
  readonly available = true as const;
  /** The store page for this browser, for an "update the extension" link. */
  readonly installUrl: string;
  readonly browser: BrowserKind;
  /** The raw provider (`window.writ`). */
  readonly provider: WritProvider;
  /** The extension's name, version and protocol. */
  readonly providerInfo: WritProviderInfo;
  readonly #router: CallRouter;

  /** @internal Use {@link connectWrit}. */
  constructor(provider: WritProvider, info: WritProviderInfo, browser: BrowserKind) {
    this.provider = provider;
    this.providerInfo = info;
    this.browser = browser;
    this.installUrl = installUrlFor(browser);
    this.#router = new CallRouter(provider);
  }

  /**
   * Is Writ desktop installed and its engine up? Does not prompt the user. A `host` other than
   * `ok` means Writ desktop must be installed or updated; calls would fail with
   * `DESKTOP_MISSING` / `DESKTOP_OUTDATED`.
   */
  async status(): Promise<WritStatus> {
    const answer = await request(this.provider, "writ_status");
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
      throw new WritError("INTERNAL", "The Writ extension sent an unexpected answer to writ_status.");
    }
    return Object.freeze({ ...(answer as WritStatus) });
  }

  /**
   * Ask for functions. The user binds each requested key to one of their own Writ functions in
   * the extension's consent window; keys already bound answer without a window. A key that
   * carries a `package` installs the site's workflow in the same click ("Install and allow").
   *
   * A linked workflow (CONTRACT.md §11) installs the same way; Writ fetches its manifest from the
   * developer's Writ Cloud first. In `token` mode, pass `getRunToken`: the session gets a run
   * token before each call to it. `recipeCache` sets the session's recipe policy.
   *
   * Rejects with `CONSENT_DENIED` when the user declines, `BAD_REQUEST` for an invalid request
   * (a token-mode linked workflow without `getRunToken` included), `INPUT_INVALID` for a package
   * the Writ engine would refuse (nothing is sent), `DESKTOP_MISSING` / `DAEMON_UNAVAILABLE` /
   * `VAULT_LOCKED` when Writ is not ready, and `RECIPE_UNAVAILABLE` / `PUBLICATION_REVOKED` when a
   * linked workflow's manifest cannot be had.
   */
  async connect(connectRequest: ConnectRequest): Promise<WritSession> {
    const clean = validateConnectRequest(connectRequest);
    const linked = linkedSessionConfig(connectRequest, clean.functions, "connect()");
    const answer = await request(this.provider, "writ_connect", clean);
    const grant = parseGrantSet(answer, "writ_connect");
    return new WritSession(this.provider, this.#router, grant.origin, grant.functions, linked);
  }

  /**
   * The session this origin already has, without opening any window: for showing "connected"
   * on page load. Null when the user has not connected this site (or revoked it).
   *
   * Pass the `functions` you connect with (and `getRunToken` / `recipeCache`) so the session
   * handles your linked workflows' calls the way a session from `connect()` does. Rejects with
   * `BAD_REQUEST` / `INPUT_INVALID` for invalid options, as `connect()` would.
   */
  async resume(options: ResumeOptions = {}): Promise<WritSession | null> {
    if (typeof options !== "object" || options === null) {
      throw new WritError("BAD_REQUEST", "resume() takes { functions?, getRunToken?, recipeCache? }.");
    }
    const functions: FunctionRequest[] =
      options.functions === undefined ? [] : validateFunctionRequests(options.functions, "resume()");
    const linked = linkedSessionConfig(options, functions, "resume()");
    const answer = await request(this.provider, "writ_functions");
    const grant = parseGrantSet(answer, "writ_functions");
    if (grant.functions.length === 0) return null;
    return new WritSession(this.provider, this.#router, grant.origin, grant.functions, linked);
  }

  /**
   * Drop the linked workflows' recipes the visitor's Writ holds for this page (CONTRACT.md §11):
   * the next call to each fetches its recipe from Writ Cloud again. Rejects with a `WritError`
   * when the extension refuses (an extension from before linked workflows: `BAD_REQUEST`).
   */
  refreshRecipes(): Promise<void> {
    return refreshProviderRecipes(this.provider);
  }
}

/**
 * This origin's grant: the functions the user bound, and calls to them. Get one from
 * `writ.connect()` or `writ.resume()`.
 */
export class WritSession {
  readonly #provider: WritProvider;
  readonly #router: CallRouter;
  readonly #inFlight = new Set<{ cancel(): Promise<void> }>();
  readonly #linked: LinkedSessionConfig;
  readonly #linkedFailureListeners = new Set<(key: string, error: WritError) => void>();
  #origin: string;
  #functions: readonly GrantedFunction[];
  #disconnected = false;

  /** @internal Use `writ.connect()` or `writ.resume()`. */
  constructor(
    provider: WritProvider,
    router: CallRouter,
    origin: string,
    functions: readonly GrantedFunction[],
    linked: LinkedSessionConfig = NO_LINKED_WORKFLOWS,
  ) {
    this.#provider = provider;
    this.#router = router;
    this.#origin = origin;
    this.#functions = functions;
    this.#linked = linked;
  }

  /** The origin the grant belongs to, as the browser reported it. */
  get origin(): string {
    return this.#origin;
  }

  /** The granted functions, as of `connect()` or the last {@link refresh}. */
  get functions(): readonly GrantedFunction[] {
    return this.#functions;
  }

  /** One granted function by key, or undefined. */
  function(key: string): GrantedFunction | undefined {
    return this.#functions.find((fn) => fn.key === key);
  }

  /**
   * Call a granted function. Returns at once; await `call.result` for the data.
   *
   * `inputs` must be a plain JSON object of the function's declared inputs. Invalid inputs
   * reject `result` with `INPUT_INVALID` (and an invalid key or option with `BAD_REQUEST`)
   * without anything being sent.
   *
   * With `options.challenge`, Writ signs that challenge into the run's receipt
   * (`result.receipt`, or `error.details.receipt` on a failure) for your server to verify.
   *
   * A call to a linked workflow the session knows carries the recipe cache policy
   * (`options.recipeCache`, else the session's) and, in `token` mode, a run token
   * (`options.token`, else one from the session's `getRunToken`, fetched before the call goes
   * out). `options.token` and `options.recipeCache` are sent on any call they are given to.
   */
  call<TOut = unknown>(key: string, inputs?: object, options?: CallOptions): WritCall<TOut> {
    let error: WritError | undefined;
    let params: CallInit["params"];
    let timeoutMs: number | undefined;
    let signal: AbortSignal | undefined;
    let runToken: RunTokenCache | undefined;
    let linkedKey: string | null = null;
    try {
      const validKey = validateFunctionKey(key);
      const opts = validateCallOptions(options);
      const clean = sanitizeInputs(inputs);
      if (this.#disconnected) {
        throw new WritError("NOT_GRANTED", "This session was disconnected. Call writ.connect() again.");
      }
      const built: NonNullable<CallInit["params"]> = { key: validKey };
      if (clean !== undefined) built.inputs = clean;
      if (opts.timeoutMs !== undefined) built.timeout_ms = opts.timeoutMs;
      if (opts.dryRun !== undefined) built.dry_run = opts.dryRun;
      if (opts.challenge !== undefined) built.challenge = opts.challenge;

      const access = this.#linked.access.get(validKey);
      const recipeCache = opts.recipeCache ?? (access === undefined ? undefined : this.#linked.recipeCache);
      if (recipeCache !== undefined) built.recipe_cache = recipeCache;
      if (typeof opts.token === "string") built.token = opts.token;
      else if (typeof opts.token === "function") runToken = runTokensFor(opts.token);
      else if (access === "token") {
        const getRunToken = this.#linked.getRunToken;
        if (getRunToken === null) {
          throw new WritError(
            "BAD_REQUEST",
            `"${validKey}" is a linked workflow in token mode: pass getRunToken when you connect, or a token in the call's options.`,
          );
        }
        runToken = runTokensFor(getRunToken);
      }
      if (access !== undefined) linkedKey = validKey;

      params = built;
      timeoutMs = opts.timeoutMs;
      signal = opts.signal;
    } catch (caught) {
      error = toWritError(caught);
      params = undefined;
      runToken = undefined;
    }

    const handle: { cancel(): Promise<void> } = { cancel: () => call.cancel() };
    const failedKey = linkedKey;
    const call: WritCall<TOut> = new WritCall<TOut>({
      provider: this.#provider,
      router: this.#router,
      key: typeof key === "string" ? key : String(key),
      params,
      runToken,
      timeoutMs,
      signal,
      error,
      onSettle: () => this.#inFlight.delete(handle),
      onFailure: failedKey === null ? undefined : (failure) => this.#tellLinkedFailure(failedKey, failure),
    });
    // Every settle path is asynchronous, so the handle is in the set before it can leave it.
    if (error === undefined) this.#inFlight.add(handle);
    return call;
  }

  /**
   * Drop the linked workflows' recipes the visitor's Writ holds for this page (CONTRACT.md §11),
   * so the next call to each fetches its recipe again: after you published a new version, say.
   * The same as `writ.refreshRecipes()`.
   */
  refreshRecipes(): Promise<void> {
    return refreshProviderRecipes(this.#provider);
  }

  /**
   * @internal Told when a call to one of the session's linked workflows fails, with its key and
   * error (the banner offers "Update" on `GRANT_STALE`, "Unavailable" on `PUBLICATION_REVOKED` and
   * `RECIPE_UNAVAILABLE`). Answers the function that stops telling.
   */
  onLinkedFailure(listener: (key: string, error: WritError) => void): () => void {
    this.#linkedFailureListeners.add(listener);
    return () => {
      this.#linkedFailureListeners.delete(listener);
    };
  }

  /** @internal The session's `getRunToken`, for a typed client given none of its own. */
  runTokenSource(): (() => Promise<string>) | null {
    return this.#linked.getRunToken;
  }

  #tellLinkedFailure(key: string, error: WritError): void {
    for (const listener of [...this.#linkedFailureListeners]) {
      try {
        listener(key, error);
      } catch (failure) {
        setTimeout(() => {
          throw failure;
        }, 0);
      }
    }
  }

  /** Re-read this origin's grant (`writ_functions`), e.g. after the user changed a binding. */
  async refresh(): Promise<readonly GrantedFunction[]> {
    const answer = await request(this.#provider, "writ_functions");
    const grant = parseGrantSet(answer, "writ_functions");
    this.#origin = grant.origin;
    this.#functions = this.#disconnected ? Object.freeze([]) : grant.functions;
    return this.#functions;
  }

  /**
   * Revoke this site's grant (`writ_disconnect`). Calls still running are cancelled first. The
   * session stays closed: later calls reject with `NOT_GRANTED`; `writ.connect()` again for a
   * new one. Safe to retry when it rejects.
   */
  async disconnect(): Promise<void> {
    this.#disconnected = true;
    const running = [...this.#inFlight];
    this.#inFlight.clear();
    await Promise.all(running.map((call) => call.cancel()));
    await request(this.#provider, "writ_disconnect");
    this.#functions = Object.freeze([]);
  }
}

/**
 * The page method `writ_refresh_recipes` (CONTRACT.md §11 "Wire additions"): it answers
 * `{ ok: true }` once the host dropped this page's cached recipes. Failures become WritErrors.
 */
async function refreshProviderRecipes(provider: WritProvider): Promise<void> {
  await request(provider, "writ_refresh_recipes");
}

/** One provider request, with every failure turned into a {@link WritError}. */
async function request(provider: WritProvider, method: string, params?: unknown): Promise<unknown> {
  try {
    return await provider.request(params === undefined ? { method } : { method, params });
  } catch (error) {
    throw toWritError(error, { method });
  }
}

function parseGrantSet(
  answer: unknown,
  method: string,
): { origin: string; functions: readonly GrantedFunction[] } {
  if (typeof answer !== "object" || answer === null) {
    throw new WritError("INTERNAL", `The Writ extension sent an unexpected answer to ${method}.`);
  }
  const record = answer as { origin?: unknown; functions?: unknown };
  if (typeof record.origin !== "string" || !Array.isArray(record.functions)) {
    throw new WritError("INTERNAL", `The Writ extension sent an unexpected answer to ${method}.`);
  }
  const functions: GrantedFunction[] = [];
  for (const raw of record.functions as unknown[]) {
    const fn = parseGrantedFunction(raw);
    if (fn !== null) functions.push(fn);
  }
  return { origin: record.origin, functions: Object.freeze(functions) };
}

function parseGrantedFunction(raw: unknown): GrantedFunction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.key !== "string" || record.key === "") return null;
  const inputs: FunctionInput[] = [];
  if (Array.isArray(record.inputs)) {
    for (const entry of record.inputs as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const input = entry as { name?: unknown; required?: unknown; description?: unknown };
      if (typeof input.name !== "string" || input.name === "") continue;
      inputs.push(
        Object.freeze(
          typeof input.description === "string"
            ? { name: input.name, required: input.required === true, description: input.description }
            : { name: input.name, required: input.required === true },
        ),
      );
    }
  }
  const outputs = Array.isArray(record.outputs)
    ? (record.outputs as unknown[]).filter((name): name is string => typeof name === "string")
    : [];
  const granted: GrantedFunction = {
    key: record.key,
    description: typeof record.description === "string" ? record.description : "",
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
    writes: record.writes === true,
    local_network: record.local_network === true,
  };
  const pkg = parseGrantedPackage(record.package);
  return Object.freeze(pkg === undefined ? granted : { ...granted, package: pkg });
}

/** The binding's installed package (CONTRACT.md §8 `Grant.bindings[].package`), when reported. */
function parseGrantedPackage(raw: unknown): GrantedPackage | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object") return undefined;
  const record = raw as { id?: unknown; version?: unknown };
  if (typeof record.id !== "string" || record.id === "") return undefined;
  return Object.freeze({ id: record.id, version: typeof record.version === "string" ? record.version : null });
}
