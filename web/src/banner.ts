/**
 * `mountWritBanner()`: a drop-in banner that gets a visitor from "no Writ" to a connected
 * session (CONTRACT.md §9 "SDK banner").
 *
 * It walks the visitor through what is missing, in order:
 * 1. the extension (a store button for this browser, then "I installed it");
 * 2. Writ desktop (`DESKTOP_MISSING` / `DESKTOP_OUTDATED`, https://usewrit.app/desktop);
 * 3. the engine (`daemon: "unavailable"`: "Open Writ on this computer, then retry");
 * 4. "Install <workflow> (one click)" or "Connect", which calls `connect()` and opens the
 *    consent window; a decline shows a quiet "Not now" with a retry button;
 * 5. connected: the banner hides and calls `onReady(session)`.
 *
 * Before showing anything it tries `resume()`: a visitor who is already connected never sees
 * it. It polls nothing in the background; it re-checks on its buttons and when the window gets
 * focus back.
 *
 * With linked workflows (CONTRACT.md §11) it keeps an eye on the session it handed over: a call
 * that finds the published workflow changed beyond what the visitor approved (`GRANT_STALE`)
 * brings it back with "Update", which reopens consent; a workflow the site withdrew
 * (`PUBLICATION_REVOKED`) or that Writ cannot fetch (`RECIPE_UNAVAILABLE`, with Retry) shows
 * "Unavailable".
 */

import { BannerView, type BannerAction, type BannerModel } from "./banner-view.js";
import {
  bannerStrings,
  isBannerLocale,
  resolveBannerLocale,
  type BannerStrings,
  type WritBannerLocale,
} from "./banner-strings.js";
import { connectWrit, type WritClient, type WritSession } from "./client.js";
import {
  BANNER_DISMISSED_KEY_PREFIX,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  WRIT_DESKTOP_URL,
} from "./constants.js";
import { contractFunctions } from "./contract.js";
import { WritError, toWritError, type WritErrorCode } from "./errors.js";
import {
  isLinkedPackage,
  linkedAccessOfRequests,
  packageDisplayName,
  requireRunTokens,
  validateLinkedOptions,
} from "./linked.js";
import type {
  BrowserKind,
  ConnectRequest,
  FunctionRequest,
  WritContract,
  WritLinkedOptions,
  WritRecipeCache,
  WritWindow,
} from "./types.js";
import { validateConnectRequest, validateDiscoveryTimeout, type CleanConnectRequest } from "./validate.js";

/** The parts of `window` the banner uses. A real `window` fits. */
export interface WritBannerWindow extends WritWindow {
  readonly document?: Document;
  readonly sessionStorage?: Pick<Storage, "getItem" | "setItem">;
  readonly location?: { reload(): void };
  /** Used for adopted stylesheets when present. */
  readonly CSSStyleSheet?: unknown;
}

/**
 * Options of {@link mountWritBanner}. Pass exactly one of `functions` and `contract`.
 *
 * `getRunToken` is required when they hold a linked workflow in `token` mode; the session the
 * banner hands over then gets a run token before each call to it. `recipeCache` sets that
 * session's recipe policy (default `"session"`).
 */
export interface WritBannerOptions extends WritLinkedOptions {
  /** Your app's name, shown in the banner and the consent window, at most 80 characters. */
  app: string;
  /** The functions to connect, usually with packages to install. */
  functions?: readonly FunctionRequest[];
  /** The contract file Writ generated (`writ-contract.json`), instead of `functions`. */
  contract?: WritContract;
  /** Called once, with the session, when the visitor is connected (at once if they already were). */
  onReady(session: WritSession): void;
  /** Where the fixed banner sits. Default `"top"`. Ignored with `container`. */
  position?: "top" | "bottom";
  /** Default: the visitor's browser language when it is English, French or Spanish, else English. */
  locale?: WritBannerLocale;
  /** Render inside this element instead of fixed to the viewport. */
  container?: HTMLElement;
  /** How long to wait for the extension on each check, in ms. Default 1 500. */
  timeoutMs?: number;
  /** The window to work in. Default: the global `window`. */
  window?: WritBannerWindow;
}

/** What {@link mountWritBanner} returns. */
export interface WritBanner {
  /** Remove the banner. `session` rejects with `CANCELLED` if the visitor was not connected yet. */
  destroy(): void;
  /**
   * Resolves with the session once the visitor is connected (with the same session `onReady`
   * gets). Rejects with `CONSENT_DENIED` when the visitor dismisses the banner (or dismissed it
   * earlier in this page session), and `CANCELLED` after `destroy()`.
   */
  readonly session: Promise<WritSession>;
}

const noop = (): void => {};

/**
 * Mount the drop-in banner. Throws `BAD_REQUEST` for invalid options and `INPUT_INVALID` for an
 * invalid package or contract, before anything is shown.
 *
 * ```ts
 * mountWritBanner({
 *   app: "Arrivos",
 *   contract,
 *   onReady(session) { enableReceiveButtons(session); },
 * });
 * ```
 */
export function mountWritBanner(options: WritBannerOptions): WritBanner {
  return startBanner(options, DEFAULT_BEHAVIOR);
}

/**
 * @internal How the Writ Bridge (`createWritBridge`) runs the banner, on top of the public options.
 */
export interface BannerBehavior {
  /**
   * False: no dismiss control, and a dismissal remembered from earlier in the page session is
   * ignored. The site requires Writ (`required`), so the banner stays until the visitor is set up.
   */
  readonly dismissible: boolean;
  /**
   * True: never render anything. Only find an existing connection, at start and each time the
   * window gets focus back (the site connects the visitor itself).
   */
  readonly headless: boolean;
  /** A line under the body saying why the banner is there, by bridge mode. */
  readonly note: "required" | "recommended" | null;
  /** Told once the extension is found on the page. */
  readonly onClient?: (client: WritClient) => void;
  /** Told the first time a check finds the visitor not ready (the banner shows, or would). */
  readonly onPending?: () => void;
  /**
   * The request to send when the visitor clicks to connect, read at that moment: the bridge's
   * suggested settings may change after the banner mounts. Default: the options' own request.
   */
  readonly connectRequest?: () => CleanConnectRequest;
}

const DEFAULT_BEHAVIOR: BannerBehavior = Object.freeze({ dismissible: true, headless: false, note: null });

/** @internal {@link mountWritBanner} with a {@link BannerBehavior}. */
export function startBanner(options: WritBannerOptions, behavior: BannerBehavior): WritBanner {
  const config = validateBannerOptions(options);
  const win = options.window ?? globalWindow();
  const doc = win?.document ?? null;
  if (win === undefined || (doc === null && !behavior.headless)) {
    const session = Promise.reject<WritSession>(
      new WritError("NOT_INSTALLED", "No browser window: the Writ banner runs in the page, not on the server."),
    );
    session.catch(noop);
    return Object.freeze({ destroy: noop, session });
  }
  const controller = new BannerController(win, doc, config, behavior);
  controller.start();
  return Object.freeze({
    destroy: (): void => controller.destroy(),
    session: controller.session,
  });
}

interface BannerConfig {
  readonly request: CleanConnectRequest;
  readonly getRunToken: (() => Promise<string>) | null;
  readonly recipeCache: WritRecipeCache | undefined;
  /** The request has a linked workflow: watch the handed-over session's calls to it. */
  readonly watchLinked: boolean;
  readonly onReady: (session: WritSession) => void;
  readonly position: "top" | "bottom";
  readonly locale: WritBannerLocale | undefined;
  readonly container: HTMLElement | null;
  readonly timeoutMs: number;
  /** The first package's name, for "Install <name> (one click)"; null when nothing is installed. */
  readonly installName: string | null;
}

function badRequest(message: string): WritError {
  return new WritError("BAD_REQUEST", message);
}

function validateBannerOptions(options: WritBannerOptions): BannerConfig {
  if (typeof options !== "object" || options === null) {
    throw badRequest("mountWritBanner() takes { app, functions | contract, onReady }.");
  }
  const hasFunctions = options.functions !== undefined;
  const hasContract = options.contract !== undefined;
  if (hasFunctions === hasContract) {
    throw badRequest(
      hasFunctions
        ? "mountWritBanner() takes `functions` or `contract`, not both."
        : "mountWritBanner() needs `contract` (your writ-contract.json) or `functions`.",
    );
  }
  const functions = hasContract ? contractFunctions(options.contract as WritContract) : options.functions;
  const request = validateConnectRequest({ app: options.app, functions: functions as readonly FunctionRequest[] });
  const linked = validateLinkedOptions(options, "mountWritBanner()");
  const access = linkedAccessOfRequests(request.functions);
  requireRunTokens(access, linked.getRunToken !== null, "mountWritBanner()");

  if (typeof options.onReady !== "function") {
    throw badRequest("mountWritBanner() needs onReady(session): it is called once the visitor is connected.");
  }
  const position = options.position ?? "top";
  if (position !== "top" && position !== "bottom") throw badRequest('`position` must be "top" or "bottom".');
  if (options.locale !== undefined && !isBannerLocale(options.locale)) {
    throw badRequest('`locale` must be "en", "fr" or "es".');
  }
  const container = options.container ?? null;
  if (container !== null && (typeof container !== "object" || typeof container.append !== "function")) {
    throw badRequest("`container` must be an element of this page.");
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
  const timeoutMs = validateDiscoveryTimeout(options.timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS);
  const packaged = request.functions.find((fn) => fn.package !== undefined);

  return {
    request,
    getRunToken: linked.getRunToken,
    recipeCache: linked.recipeCache,
    watchLinked: access.size > 0,
    onReady: options.onReady,
    position,
    locale: options.locale,
    container,
    timeoutMs,
    installName: packaged?.package === undefined ? null : packageDisplayName(packaged.package),
  };
}

function globalWindow(): WritBannerWindow | undefined {
  return typeof window === "undefined" ? undefined : window;
}

// ---------------------------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------------------------

/** What the banner is showing. */
type BannerState =
  | { readonly kind: "extension"; readonly browser: BrowserKind; readonly installUrl: string; readonly outdated: boolean }
  | { readonly kind: "unsupported" }
  | { readonly kind: "desktop"; readonly outdated: boolean }
  | { readonly kind: "engine" }
  | { readonly kind: "vault" }
  | { readonly kind: "connect"; readonly update: boolean }
  | { readonly kind: "declined" }
  | { readonly kind: "error"; readonly code: WritErrorCode }
  /** A linked workflow: withdrawn by the site (no retry), or Writ cannot fetch it (retry). */
  | { readonly kind: "unavailable"; readonly retry: boolean; readonly name: string };

/** What a check found: a state to show, a connected session, or "stay hidden". */
type Assessment = BannerState | { readonly kind: "ready"; readonly session: WritSession } | { readonly kind: "hidden" };

type Trigger = "initial" | "click" | "focus";

function sameState(a: BannerState, b: BannerState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function browserLabel(browser: BrowserKind): string {
  return browser === "edge" ? "Edge" : "Chrome";
}

class BannerController {
  readonly session: Promise<WritSession>;
  readonly #win: WritBannerWindow;
  readonly #doc: Document | null;
  readonly #config: BannerConfig;
  readonly #behavior: BannerBehavior;
  readonly #strings: BannerStrings;
  readonly #app: string;
  #resolve: (session: WritSession) => void = noop;
  #reject: (error: WritError) => void = noop;
  #client: WritClient | null = null;
  #view: BannerView | null = null;
  #state: BannerState | null = null;
  #note = "";
  /** The visitor said "I installed it" and the extension is still not on this page. */
  #offerReload = false;
  #generation = 0;
  #checks = 0;
  #consenting = false;
  #done = false;
  #pendingTold = false;
  /** `onReady` was called: the banner shows again only for the session's linked workflows. */
  #handedOver = false;
  /** The session handed over, while the banner watches its linked calls. */
  #watched: WritSession | null = null;
  #unwatch: (() => void) | null = null;
  /** Keys whose linked workflow changed beyond what the visitor approved (`GRANT_STALE`). */
  readonly #stale = new Set<string>();
  readonly #onFocus = (): void => {
    void this.#evaluate("focus");
  };

  constructor(win: WritBannerWindow, doc: Document | null, config: BannerConfig, behavior: BannerBehavior) {
    this.#win = win;
    this.#doc = doc;
    this.#config = config;
    this.#behavior = behavior;
    this.#app = config.request.app;
    this.#strings = bannerStrings(resolveBannerLocale(config.locale, win.navigator));
    this.session = new Promise<WritSession>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // A page that only uses onReady must not see an unhandled rejection on dismiss.
    this.session.catch(noop);
  }

  start(): void {
    this.#win.addEventListener("focus", this.#onFocus);
    void this.#evaluate("initial");
  }

  destroy(): void {
    this.#close(new WritError("CANCELLED", "The Writ banner was removed before the visitor was connected."));
  }

  // ---- checks ------------------------------------------------------------------------------

  async #evaluate(trigger: Trigger): Promise<void> {
    if (this.#done || this.#consenting) return;
    // Focus re-checks only refresh a banner that is showing, and never pile up.
    if (trigger === "focus" && (this.#checks > 0 || this.#state === null)) return;
    // An "Unavailable" notice stays until the visitor acts on it.
    if (trigger === "focus" && this.#state?.kind === "unavailable") return;
    this.#generation += 1;
    const generation = this.#generation;
    this.#checks += 1;
    if (trigger === "click") this.#render({ busy: true, note: this.#strings.checking });

    let next: Assessment;
    try {
      next = await this.#assess(trigger === "initial" && this.#remembersDismissal() && this.#wasDismissed());
    } catch (error) {
      next = this.#stateForError(toWritError(error));
    } finally {
      this.#checks -= 1;
    }
    if (this.#done || generation !== this.#generation) return;
    this.#apply(next, trigger);
  }

  /** Find what is missing. With `silentOnly`, stop after the silent resume (nothing to show). */
  async #assess(silentOnly: boolean): Promise<Assessment> {
    let client = this.#client;
    if (client === null) {
      const found = await connectWrit({ window: this.#win, timeoutMs: this.#config.timeoutMs });
      if (!found.available) {
        if (silentOnly) return { kind: "hidden" };
        if (found.reason === "NOT_INSTALLED" && found.browser === "other") return { kind: "unsupported" };
        return {
          kind: "extension",
          browser: found.browser,
          installUrl: found.installUrl,
          outdated: found.reason === "DESKTOP_OUTDATED",
        };
      }
      client = found;
      this.#client = found;
      if (this.#behavior.onClient !== undefined) {
        try {
          this.#behavior.onClient(found);
        } catch (error) {
          reportError(error);
        }
      }
    }

    let update = false;
    try {
      const existing = await client.resume({ functions: this.#config.request.functions, ...this.#linkedOptions() });
      if (existing !== null) {
        const coverage = this.#coverage(existing);
        if (coverage === "current") return { kind: "ready", session: existing };
        update = coverage === "update";
      }
    } catch {
      // Not connected, or Writ is not ready: writ_status below says which.
    }
    if (silentOnly) return { kind: "hidden" };

    const status = await client.status();
    if (status.host === "missing") return { kind: "desktop", outdated: false };
    if (status.host === "outdated") return { kind: "desktop", outdated: true };
    if (status.daemon === "unavailable") return { kind: "engine" };
    return { kind: "connect", update };
  }

  /**
   * Does an existing session cover every requested key, with the requested package versions?
   * A package the extension does not report on counts as current: `connect()` would offer an
   * update itself.
   */
  #coverage(session: WritSession): "current" | "update" | "missing" {
    let update = false;
    for (const fn of this.#config.request.functions) {
      const granted = session.function(fn.key);
      if (granted === undefined) return "missing";
      // A linked workflow a call found changed: the grant is listed, but needs the visitor again.
      if (this.#stale.has(fn.key)) update = true;
      if (fn.package === undefined || granted.package === undefined) continue;
      if (granted.package === null || granted.package.id !== fn.package.id) return "missing";
      // A linked workflow has no version to compare: Writ checks its manifest on every call.
      if (isLinkedPackage(fn.package)) continue;
      if (granted.package.version !== (fn.package.version ?? null)) update = true;
    }
    return update ? "update" : "current";
  }

  #stateForError(error: WritError): BannerState {
    switch (error.code) {
      case "DESKTOP_MISSING":
        return { kind: "desktop", outdated: false };
      case "DESKTOP_OUTDATED":
        return { kind: "desktop", outdated: true };
      case "DAEMON_UNAVAILABLE":
        return { kind: "engine" };
      case "VAULT_LOCKED":
        return { kind: "vault" };
      case "RECIPE_UNAVAILABLE":
        return { kind: "unavailable", retry: true, name: this.#workflowName(null) };
      case "PUBLICATION_REVOKED":
        return { kind: "unavailable", retry: false, name: this.#workflowName(null) };
      default:
        return { kind: "error", code: error.code };
    }
  }

  /** The name of the package `key` installs, else the first package's, else the app's. */
  #workflowName(key: string | null): string {
    const fn = key === null ? undefined : this.#config.request.functions.find((entry) => entry.key === key);
    const name = fn?.package === undefined ? "" : packageDisplayName(fn.package);
    return name !== "" ? name : (this.#config.installName ?? this.#app);
  }

  #apply(next: Assessment, trigger: Trigger): void {
    if (next.kind === "ready") {
      this.#ready(next.session);
      return;
    }
    if (next.kind === "hidden") {
      this.#close(new WritError("CONSENT_DENIED", "The visitor dismissed the Writ banner in this page session."));
      return;
    }
    this.#tellPending();
    const previous = this.#state;
    const unchanged = previous !== null && previous.kind === next.kind;
    if (trigger === "focus" && previous !== null && sameState(previous, next)) return;

    if (next.kind === "extension") this.#offerReload = trigger === "click" && unchanged;
    this.#state = next;
    this.#note = trigger === "click" && unchanged ? this.#stillMissing(next) : "";
    this.#render({ busy: false, note: this.#note });
  }

  /** The visitor is not ready: tell the bridge once, so its calls stop waiting for this check. */
  #tellPending(): void {
    if (this.#pendingTold || this.#behavior.onPending === undefined) return;
    this.#pendingTold = true;
    try {
      this.#behavior.onPending();
    } catch (error) {
      reportError(error);
    }
  }

  #stillMissing(state: BannerState): string {
    const s = this.#strings;
    switch (state.kind) {
      case "extension":
        return s.extensionStillMissing(browserLabel(state.browser));
      case "desktop":
        return s.desktopStillMissing;
      case "engine":
        return s.engineStillMissing;
      case "vault":
        return s.vaultStillLocked;
      default:
        return "";
    }
  }

  // ---- actions -----------------------------------------------------------------------------

  #onAction(action: BannerAction): void {
    if (this.#done) return;
    if (action === "dismiss") {
      if (!this.#behavior.dismissible) return;
      // After hand-over, closing a notice only hides it: the visitor stays connected.
      if (this.#handedOver) this.#hide();
      else this.#dismiss();
      return;
    }
    const state = this.#state;
    if (state === null) return;
    switch (state.kind) {
      case "unavailable":
        if (action === "primary" && state.retry) void this.#retryUnavailable();
        return;
      case "extension":
        if (action === "secondary" && this.#offerReload) this.#reload();
        else if (action === "secondary") void this.#evaluate("click");
        return;
      case "desktop":
        if (action === "secondary") void this.#evaluate("click");
        return;
      case "engine":
      case "vault":
      case "error":
        void this.#evaluate("click");
        return;
      case "connect":
      case "declined":
        void this.#connect();
        return;
      case "unsupported":
      default:
        return;
    }
  }

  async #connect(): Promise<void> {
    const client = this.#client;
    if (this.#done || this.#consenting || client === null) return;
    this.#consenting = true;
    // A focus check still in flight must not overwrite what consent decides.
    this.#generation += 1;
    this.#render({ busy: true, note: this.#strings.waitingForConsent });
    try {
      const request: ConnectRequest = {
        ...(this.#behavior.connectRequest?.() ?? this.#config.request),
        ...this.#linkedOptions(),
      };
      const session = await client.connect(request);
      if (!this.#done) this.#ready(session);
    } catch (error) {
      if (this.#done) return;
      const failure = toWritError(error);
      this.#state = failure.code === "CONSENT_DENIED" ? { kind: "declined" } : this.#stateForError(failure);
      this.#note = "";
      this.#render({ busy: false, note: "" });
    } finally {
      this.#consenting = false;
    }
  }

  /**
   * Retry after `RECIPE_UNAVAILABLE`. Before hand-over the connect failed (Writ could not fetch
   * the manifest), so connect again. After it, drop the page's cached recipes so the next call
   * fetches afresh, and hide: the visitor retries what they were doing.
   */
  async #retryUnavailable(): Promise<void> {
    if (!this.#handedOver) {
      await this.#connect();
      return;
    }
    const generation = (this.#generation += 1);
    this.#render({ busy: true, note: this.#strings.checking });
    try {
      await this.#client?.refreshRecipes();
    } catch {
      // Nothing was cached, or an older extension: the next call fetches anyway.
    }
    if (!this.#done && generation === this.#generation && this.#state?.kind === "unavailable") this.#hide();
  }

  /** `getRunToken` and `recipeCache`, for the sessions the banner makes. */
  #linkedOptions(): WritLinkedOptions {
    const out: WritLinkedOptions = {};
    if (this.#config.getRunToken !== null) out.getRunToken = this.#config.getRunToken;
    if (this.#config.recipeCache !== undefined) out.recipeCache = this.#config.recipeCache;
    return out;
  }

  #dismiss(): void {
    try {
      this.#win.sessionStorage?.setItem(this.#storageKey(), "1");
    } catch {
      // Storage blocked: the banner still hides for this page view.
    }
    this.#close(new WritError("CONSENT_DENIED", "The visitor dismissed the Writ banner."));
  }

  /** Only a banner the visitor can close remembers that they closed it. */
  #remembersDismissal(): boolean {
    return this.#behavior.dismissible && !this.#behavior.headless;
  }

  #wasDismissed(): boolean {
    try {
      return this.#win.sessionStorage?.getItem(this.#storageKey()) === "1";
    } catch {
      return false;
    }
  }

  #storageKey(): string {
    return `${BANNER_DISMISSED_KEY_PREFIX}${this.#app}`;
  }

  #reload(): void {
    try {
      this.#win.location?.reload();
    } catch {
      // Nothing else to do: the status line already says to reload.
    }
  }

  // ---- endings -----------------------------------------------------------------------------

  #ready(session: WritSession): void {
    if (this.#done) return;
    if (this.#handedOver) {
      // The visitor updated (or retried) after hand-over: hide, and keep watching the session
      // the page holds. Its grant changed, so re-read it.
      this.#hide();
      const watched = this.#watched;
      if (watched !== null && watched !== session) watched.refresh().catch(noop);
      return;
    }
    this.#handedOver = true;
    if (this.#config.watchLinked && !this.#behavior.headless && typeof session.onLinkedFailure === "function") {
      this.#watched = session;
      this.#unwatch = session.onLinkedFailure((key, error) => this.#onLinkedFailure(key, error));
      this.#hide();
    } else {
      this.#teardown();
    }
    this.#resolve(session);
    try {
      this.#config.onReady(session);
    } catch (error) {
      reportError(error);
    }
  }

  /**
   * A call to a linked workflow of the handed-over session failed. A changed workflow brings the
   * banner back with "Update" (it reopens consent); a withdrawn or unreachable one shows
   * "Unavailable". Anything else is the page's to handle.
   */
  #onLinkedFailure(key: string, error: WritError): void {
    if (this.#done || this.#consenting) return;
    let next: BannerState;
    switch (error.code) {
      case "GRANT_STALE":
        this.#stale.add(key);
        next = { kind: "connect", update: true };
        break;
      case "PUBLICATION_REVOKED":
        next = { kind: "unavailable", retry: false, name: this.#workflowName(key) };
        break;
      case "RECIPE_UNAVAILABLE":
        next = { kind: "unavailable", retry: true, name: this.#workflowName(key) };
        break;
      default:
        return;
    }
    // A focus check still in flight must not overwrite this.
    this.#generation += 1;
    this.#state = next;
    this.#note = "";
    this.#offerReload = false;
    this.#render({ busy: false, note: "" });
  }

  /** After hand-over: nothing to show until the session's linked calls need the visitor again. */
  #hide(): void {
    this.#state = null;
    this.#note = "";
    this.#offerReload = false;
    this.#stale.clear();
    this.#view?.destroy();
    this.#view = null;
  }

  #close(error: WritError): void {
    if (this.#done) return;
    this.#teardown();
    this.#reject(error);
  }

  #teardown(): void {
    this.#done = true;
    this.#win.removeEventListener("focus", this.#onFocus);
    this.#unwatch?.();
    this.#unwatch = null;
    this.#watched = null;
    this.#view?.destroy();
    this.#view = null;
  }

  // ---- rendering ---------------------------------------------------------------------------

  #render(overlay: { busy: boolean; note: string }): void {
    const state = this.#state;
    if (state === null || this.#done || this.#behavior.headless || this.#doc === null) return;
    if (this.#view === null) {
      this.#view = new BannerView(this.#doc, {
        container: this.#config.container,
        position: this.#config.position,
        label: this.#strings.region(this.#app),
        dismissLabel: this.#strings.dismiss,
        dismissible: this.#behavior.dismissible,
        styleSheetConstructor: this.#win.CSSStyleSheet,
        onAction: (action) => this.#onAction(action),
      });
    }
    this.#view.render(this.#model(state, overlay.busy, overlay.note));
  }

  #modeNote(): string {
    switch (this.#behavior.note) {
      case "required":
        return this.#strings.requiredNote(this.#app);
      case "recommended":
        return this.#strings.recommendedNote(this.#app);
      default:
        return "";
    }
  }

  #model(state: BannerState, busy: boolean, note: string): BannerModel {
    const s = this.#strings;
    const app = this.#app;
    // Once the visitor is set up, why the banner was there no longer applies.
    const base = { state: state.kind, busy, status: note, quiet: false, note: this.#handedOver ? "" : this.#modeNote() };
    switch (state.kind) {
      case "extension": {
        const browser = browserLabel(state.browser);
        const secondaryLabel = this.#offerReload
          ? s.reload
          : state.outdated
            ? s.extensionUpdated
            : s.extensionInstalled;
        return {
          ...base,
          icon: "extension",
          title: state.outdated ? s.extensionUpdateTitle(browser) : s.extensionTitle(browser),
          body: state.outdated ? s.extensionUpdateBody(app) : s.extensionBody(app),
          primary: {
            label: state.outdated ? s.extensionUpdateButton(browser) : s.extensionButton(browser),
            href: state.installUrl,
          },
          secondary: { label: secondaryLabel },
        };
      }
      case "unsupported":
        return { ...base, icon: "info", title: s.unsupportedTitle, body: s.unsupportedBody(app) };
      case "desktop":
        return {
          ...base,
          icon: "desktop",
          title: state.outdated ? s.desktopUpdateTitle : s.desktopTitle,
          body: state.outdated ? s.desktopUpdateBody(app) : s.desktopBody(app),
          primary: { label: state.outdated ? s.desktopUpdateButton : s.desktopButton, href: WRIT_DESKTOP_URL },
          secondary: { label: state.outdated ? s.desktopUpdated : s.desktopInstalled },
        };
      case "engine":
        return { ...base, icon: "power", title: s.engineTitle, body: s.engineBody, primary: { label: s.retry } };
      case "vault":
        return { ...base, icon: "lock", title: s.vaultTitle, body: s.vaultBody, primary: { label: s.retry } };
      case "connect": {
        const name = this.#config.installName;
        if (name === null) {
          return {
            ...base,
            icon: "connect",
            title: s.connectTitle(app),
            body: s.connectBody(app),
            primary: { label: s.connectButton },
          };
        }
        return {
          ...base,
          icon: "install",
          title: state.update ? s.updateTitle(name) : s.installTitle(name),
          body: state.update ? s.updateBody(app) : s.installBody(app),
          primary: { label: state.update ? s.updateButton(name) : s.installButton(name) },
        };
      }
      case "declined":
        return {
          ...base,
          quiet: true,
          icon: "pause",
          title: s.declinedTitle,
          body: s.declinedBody(app),
          secondary: { label: s.tryAgain },
        };
      case "unavailable":
        return state.retry
          ? { ...base, icon: "alert", title: s.unavailableTitle(state.name), body: s.unavailableBody(app), primary: { label: s.retry } }
          : { ...base, icon: "info", title: s.unavailableTitle(state.name), body: s.withdrawnBody(app) };
      case "error":
      default:
        return {
          ...base,
          icon: "alert",
          title: s.errorTitle,
          body: state.kind === "error" && state.code === "RATE_LIMITED" ? s.rateLimitedBody : s.errorBody,
          primary: { label: s.retry },
        };
    }
  }
}

/** Surface an exception thrown by the page's onReady without breaking the banner. */
function reportError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof report === "function") {
    report(error);
    return;
  }
  setTimeout(() => {
    throw error;
  }, 0);
}
