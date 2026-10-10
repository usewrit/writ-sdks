/**
 * The Writ Bridge page channel (CONTRACT.md §12.3): how the developer's server reaches the
 * visitor's Writ through this page, on one route the developer hosts on the page's own origin
 * (`app.all('/writ-bridge', bridge.handler)` with `@usewrit/server`). No Writ server is involved.
 *
 * - `POST {endpoint} { hello }`: the page's readiness, at start, on every change, and every 60 s
 *   while it polls;
 * - `GET {endpoint}?wait=25`: a long poll for commands, only while the visitor's Writ is ready
 *   (the server sends commands only to ready pages), paused once the page has been hidden for
 *   5 minutes and resumed when it is shown again;
 * - `POST {endpoint} { result }`: each command's outcome, with the receipt Writ signed for it.
 *
 * Every request carries `Authorization: Writ <userToken>`. A failed poll backs off from 1 s to
 * 30 s; a refused token (401/403) stops the channel, since the same token cannot succeed later.
 * Which commands run, and how many at once, is the bridge's decision (`run`): it runs only keys
 * the visitor granted, and shares the extension's 4-calls-per-tab budget with the page's own calls.
 */

import {
  BRIDGE_BACKOFF_MAX_MS,
  BRIDGE_BACKOFF_MIN_MS,
  BRIDGE_HELLO_INTERVAL_MS,
  BRIDGE_HIDDEN_PAUSE_MS,
  BRIDGE_MIN_POLL_INTERVAL_MS,
  BRIDGE_POLL_GRACE_MS,
  BRIDGE_POLL_WAIT_SECONDS,
  BRIDGE_RESULT_ATTEMPTS,
  BRIDGE_SEEN_COMMANDS,
  FUNCTION_KEY_PATTERN,
} from "./constants.js";
import { WritError, toWritError } from "./errors.js";
import { isPlainObject } from "./json.js";
import type { JsonObject, WritReceipt } from "./types.js";

/**
 * Where the page channel is:
 * - `off`: no channel (no `userToken`, or no function can run on the visitor's computer);
 * - `idle`: waiting for the visitor's Writ to be ready before polling;
 * - `polling`: long-polling your endpoint for commands;
 * - `retrying`: a poll failed; waiting before the next one (1 s, doubling up to 30 s);
 * - `paused`: the page has been hidden for 5 minutes; it resumes when shown;
 * - `unauthorized`: your server refused the user token; create the bridge again with a fresh one;
 * - `stopped`: `destroy()` was called.
 */
export type WritBridgeChannelState =
  | "off"
  | "idle"
  | "polling"
  | "retrying"
  | "paused"
  | "unauthorized"
  | "stopped";

/** What `hello` reports (wire shape). */
export interface BridgeReadiness {
  readonly ready: boolean;
  readonly granted: readonly string[];
  readonly writ_version: string | null;
}

/** One command from the server, validated. */
export interface BridgeCommand {
  readonly id: string;
  readonly key: string;
  readonly inputs: JsonObject;
  readonly timeoutMs: number | undefined;
  readonly dryRun: boolean | undefined;
  /** The challenge the server minted for this command; the receipt binds to it. */
  readonly challenge: string | null;
  /** Unix seconds; null when the server set none. */
  readonly expiresAt: number | null;
}

/** A command's outcome, as posted back. */
export type CommandOutcome =
  | { readonly ok: true; readonly data: unknown; readonly receipt: WritReceipt | null }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
      readonly receipt: WritReceipt | null;
    };

/** The parts of a fetch `Response` the channel reads. */
export interface FetchAnswer {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** `fetch`, bound to the page's window. */
export type FetchLike = (url: string, init: RequestInit) => Promise<FetchAnswer>;

/** The parts of `document` the channel reads. */
export interface VisibilityDocument {
  readonly hidden?: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** What the bridge gives its channel. */
export interface BridgeChannelOptions {
  /** The endpoint, absolute, already checked to be on the page's origin. */
  readonly endpoint: URL;
  readonly token: string;
  readonly fetch: FetchLike;
  readonly document: VisibilityDocument | null;
  /** The page's current readiness. */
  readiness(): BridgeReadiness;
  /** Run one command on the visitor's computer. Never called for an expired or malformed command. */
  run(command: BridgeCommand, signal: AbortSignal): Promise<CommandOutcome>;
  /** Told on every state change. */
  onState(state: WritBridgeChannelState): void;
}

/** Longest command id accepted from the server. */
const MAX_COMMAND_ID_LENGTH = 128;

type PollAnswer =
  | { readonly kind: "commands"; readonly commands: readonly unknown[] }
  | { readonly kind: "aborted" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "failed" };

/** The page channel. Created by the bridge; `start()` once, `notify()` on readiness changes, `stop()` on destroy. */
export class BridgeChannel {
  readonly #o: BridgeChannelOptions;
  #state: WritBridgeChannelState = "idle";
  #started = false;
  #stopped = false;
  #paused = false;
  #unauthorized = false;
  #looping = false;
  #backoffMs = 0;
  #pollAbort: AbortController | null = null;
  #sleeper: { readonly timer: ReturnType<typeof setTimeout>; readonly resolve: () => void } | null = null;
  #helloTimer: ReturnType<typeof setInterval> | null = null;
  #hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  #lastHello: string | null = null;
  readonly #running = new Map<string, AbortController>();
  readonly #seen = new Set<string>();
  readonly #onVisibility = (): void => this.#visibilityChanged();

  constructor(options: BridgeChannelOptions) {
    this.#o = options;
  }

  get state(): WritBridgeChannelState {
    return this.#state;
  }

  /** Say hello and start polling once the visitor's Writ is ready. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#o.document?.addEventListener("visibilitychange", this.#onVisibility);
    if (this.#isHidden()) this.#armHiddenTimer();
    void this.#hello(true);
    this.#sync();
  }

  /** The page's readiness may have changed: re-send hello if it did, and start or stop polling. */
  notify(): void {
    if (!this.#started || this.#stopped) return;
    void this.#hello(false);
    this.#sync();
  }

  /** Stop for good: no more polls or hellos; running commands are cancelled. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#o.document?.removeEventListener("visibilitychange", this.#onVisibility);
    this.#disarmHello();
    if (this.#hiddenTimer !== null) {
      clearTimeout(this.#hiddenTimer);
      this.#hiddenTimer = null;
    }
    this.#pollAbort?.abort();
    this.#wake();
    for (const controller of this.#running.values()) {
      controller.abort(new WritError("CANCELLED", "The Writ Bridge was destroyed."));
    }
    this.#updateState();
  }

  // ---- polling -----------------------------------------------------------------------------

  #shouldPoll(): boolean {
    return (
      this.#started && !this.#stopped && !this.#paused && !this.#unauthorized && this.#o.readiness().ready
    );
  }

  #sync(): void {
    if (this.#shouldPoll()) {
      if (!this.#looping) void this.#loop();
      this.#armHello();
    } else {
      this.#pollAbort?.abort();
      this.#wake();
      this.#disarmHello();
    }
    this.#updateState();
  }

  async #loop(): Promise<void> {
    this.#looping = true;
    this.#updateState();
    try {
      while (this.#shouldPoll()) {
        const started = Date.now();
        const answer = await this.#poll();
        if (answer.kind === "aborted") continue;
        if (answer.kind === "unauthorized") {
          this.#refused();
          break;
        }
        if (answer.kind === "failed") {
          await this.#backoff();
          continue;
        }
        this.#backoffMs = 0;
        this.#updateState();
        for (const raw of answer.commands) this.#accept(raw);
        // A server that answers at once with nothing must not turn the long poll into a busy loop.
        const elapsed = Date.now() - started;
        if (answer.commands.length === 0 && elapsed < BRIDGE_MIN_POLL_INTERVAL_MS) {
          await this.#sleep(BRIDGE_MIN_POLL_INTERVAL_MS - elapsed);
        }
      }
    } finally {
      this.#looping = false;
      this.#updateState();
    }
  }

  async #poll(): Promise<PollAnswer> {
    const controller = new AbortController();
    this.#pollAbort = controller;
    let timedOut = false;
    const guard = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, BRIDGE_POLL_WAIT_SECONDS * 1_000 + BRIDGE_POLL_GRACE_MS);
    try {
      const url = new URL(this.#o.endpoint.href);
      url.searchParams.set("wait", String(BRIDGE_POLL_WAIT_SECONDS));
      const answer = await this.#o.fetch(url.href, {
        method: "GET",
        headers: this.#headers(false),
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (answer.status === 401 || answer.status === 403) return { kind: "unauthorized" };
      if (answer.status === 204) return { kind: "commands", commands: [] };
      if (!answer.ok) return { kind: "failed" };
      const body = await answer.json();
      if (!isPlainObject(body) || !Array.isArray(body.commands)) return { kind: "failed" };
      return { kind: "commands", commands: body.commands as unknown[] };
    } catch {
      return controller.signal.aborted && !timedOut ? { kind: "aborted" } : { kind: "failed" };
    } finally {
      clearTimeout(guard);
      if (this.#pollAbort === controller) this.#pollAbort = null;
    }
  }

  async #backoff(): Promise<void> {
    this.#backoffMs =
      this.#backoffMs === 0 ? BRIDGE_BACKOFF_MIN_MS : Math.min(this.#backoffMs * 2, BRIDGE_BACKOFF_MAX_MS);
    this.#updateState();
    await this.#sleep(this.#backoffMs);
  }

  /** Resolves after `ms`, or at once when {@link #wake} is called (stop, pause, not ready). */
  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#sleeper = null;
        resolve();
      }, ms);
      this.#sleeper = { timer, resolve };
    });
  }

  #wake(): void {
    const sleeper = this.#sleeper;
    if (sleeper === null) return;
    this.#sleeper = null;
    clearTimeout(sleeper.timer);
    sleeper.resolve();
  }

  /** The server refused the token: the same token cannot succeed later, so stop asking. */
  #refused(): void {
    if (this.#unauthorized) return;
    this.#unauthorized = true;
    this.#pollAbort?.abort();
    this.#wake();
    this.#disarmHello();
    this.#updateState();
  }

  // ---- hello -------------------------------------------------------------------------------

  #armHello(): void {
    if (this.#helloTimer !== null) return;
    this.#helloTimer = setInterval(() => {
      void this.#hello(true);
    }, BRIDGE_HELLO_INTERVAL_MS);
  }

  #disarmHello(): void {
    if (this.#helloTimer === null) return;
    clearInterval(this.#helloTimer);
    this.#helloTimer = null;
  }

  /** Send the page's readiness; unless `force`, only when it changed since the last one sent. */
  async #hello(force: boolean): Promise<void> {
    if (this.#stopped || this.#unauthorized) return;
    const readiness = this.#o.readiness();
    const hello = {
      ready: readiness.ready,
      granted: [...readiness.granted],
      writ_version: readiness.writ_version,
    };
    const text = JSON.stringify(hello);
    if (!force && text === this.#lastHello) return;
    this.#lastHello = text;
    const status = await this.#post({ hello }, false);
    if (status === 401 || status === 403) {
      this.#refused();
      return;
    }
    // Not delivered: forget it, so the next change or tick sends it again.
    if ((status === null || status >= 400) && this.#lastHello === text) this.#lastHello = null;
  }

  // ---- commands ----------------------------------------------------------------------------

  #accept(raw: unknown): void {
    const parsed = parseCommand(raw);
    // Without an id there is nothing to answer.
    if (parsed === null || this.#seen.has(parsed.id)) return;
    this.#remember(parsed.id);
    if (parsed.command === null) {
      void this.#deliver(parsed.id, { ok: false, error: parsed.error, receipt: null }, null);
      return;
    }
    const command = parsed.command;
    if (command.expiresAt !== null && Date.now() / 1_000 >= command.expiresAt) {
      void this.#deliver(
        command.id,
        { ok: false, error: { code: "TIMEOUT", message: "The command expired before this page received it." }, receipt: null },
        null,
      );
      return;
    }
    void this.#execute(command);
  }

  /** Re-delivered commands (a reconnect, a retried poll) never run twice. */
  #remember(id: string): void {
    this.#seen.add(id);
    while (this.#seen.size > BRIDGE_SEEN_COMMANDS) {
      const oldest = this.#seen.values().next();
      if (oldest.done === true) break;
      this.#seen.delete(oldest.value);
    }
  }

  async #execute(command: BridgeCommand): Promise<void> {
    const controller = new AbortController();
    this.#running.set(command.id, controller);
    let outcome: CommandOutcome;
    try {
      outcome = await this.#o.run(command, controller.signal);
    } catch (error) {
      const failure = toWritError(error);
      outcome = { ok: false, error: { code: failure.code, message: failure.message }, receipt: null };
    } finally {
      this.#running.delete(command.id);
    }
    await this.#deliver(command.id, outcome, command.expiresAt);
  }

  /**
   * Post a command's outcome. A network failure or a 5xx is retried with backoff while the
   * command has not expired; any other answer is final (204 accepted; 4xx refused for good, such
   * as `RESULT_UNVERIFIED`). After `stop()`, one last best-effort post tells the server.
   */
  async #deliver(id: string, outcome: CommandOutcome, expiresAt: number | null): Promise<void> {
    const result = outcome.ok
      ? { id, ok: true, data: outcome.data, receipt: outcome.receipt }
      : outcome.receipt === null
        ? { id, ok: false, error: outcome.error }
        : { id, ok: false, error: outcome.error, receipt: outcome.receipt };
    let delay = BRIDGE_BACKOFF_MIN_MS;
    for (let attempt = 1; !this.#unauthorized; attempt += 1) {
      const final = this.#stopped;
      const status = await this.#post({ result }, final);
      if (status === 401 || status === 403) {
        this.#refused();
        return;
      }
      if (status !== null && status < 500 && status !== 408 && status !== 429) return;
      if (final || this.#stopped || attempt >= BRIDGE_RESULT_ATTEMPTS) return;
      if (expiresAt !== null && Date.now() / 1_000 >= expiresAt) return;
      await wait(delay);
      delay = Math.min(delay * 2, BRIDGE_BACKOFF_MAX_MS);
    }
  }

  // ---- visibility --------------------------------------------------------------------------

  #isHidden(): boolean {
    return this.#o.document?.hidden === true;
  }

  #visibilityChanged(): void {
    if (this.#stopped) return;
    if (this.#isHidden()) {
      this.#armHiddenTimer();
      return;
    }
    if (this.#hiddenTimer !== null) {
      clearTimeout(this.#hiddenTimer);
      this.#hiddenTimer = null;
    }
    if (this.#paused) {
      this.#paused = false;
      this.#backoffMs = 0;
      void this.#hello(true);
      this.#sync();
    }
  }

  #armHiddenTimer(): void {
    if (this.#hiddenTimer !== null || this.#paused) return;
    this.#hiddenTimer = setTimeout(() => {
      this.#hiddenTimer = null;
      if (this.#stopped || !this.#isHidden()) return;
      this.#paused = true;
      this.#sync();
    }, BRIDGE_HIDDEN_PAUSE_MS);
  }

  // ---- plumbing ----------------------------------------------------------------------------

  #headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Writ ${this.#o.token}`,
      Accept: "application/json",
    };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  /** POST a JSON body to the endpoint; the HTTP status, or null when the request failed. */
  async #post(body: object, keepalive: boolean): Promise<number | null> {
    try {
      const answer = await this.#o.fetch(this.#o.endpoint.href, {
        method: "POST",
        headers: this.#headers(true),
        body: JSON.stringify(body),
        credentials: "same-origin",
        cache: "no-store",
        keepalive,
      });
      return answer.status;
    } catch {
      return null;
    }
  }

  #updateState(): void {
    const next: WritBridgeChannelState = this.#stopped
      ? "stopped"
      : this.#unauthorized
        ? "unauthorized"
        : this.#paused
          ? "paused"
          : this.#looping
            ? this.#backoffMs > 0
              ? "retrying"
              : "polling"
            : "idle";
    if (next === this.#state) return;
    this.#state = next;
    try {
      this.#o.onState(next);
    } catch {
      // A state listener must not break the channel.
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** A parsed command, or why one that has an id cannot run. */
type ParsedCommand =
  | { readonly id: string; readonly command: BridgeCommand }
  | { readonly id: string; readonly command: null; readonly error: { code: string; message: string } };

/**
 * A command from `GET {endpoint}` (CONTRACT.md §12.3): `{ id, key, inputs, options: { timeout_ms?,
 * dry_run? }, challenge, expires_at }`. Null when it has no usable id; `command: null` with a
 * `BAD_REQUEST` error when it has an id but is malformed (answered, never run).
 */
function parseCommand(raw: unknown): ParsedCommand | null {
  if (!isPlainObject(raw)) return null;
  const id = raw.id;
  if (typeof id !== "string" || id === "" || id.length > MAX_COMMAND_ID_LENGTH) return null;
  const refuse = (message: string): ParsedCommand => ({ id, command: null, error: { code: "BAD_REQUEST", message } });

  const key = raw.key;
  if (typeof key !== "string" || !FUNCTION_KEY_PATTERN.test(key)) return refuse("The command names no valid function key.");
  const inputs = raw.inputs === undefined || raw.inputs === null ? {} : raw.inputs;
  if (!isPlainObject(inputs)) return refuse("The command's inputs must be an object.");
  const options = raw.options === undefined || raw.options === null ? {} : raw.options;
  if (!isPlainObject(options)) return refuse("The command's options must be an object.");
  const timeoutMs = options.timeout_ms;
  if (timeoutMs !== undefined && timeoutMs !== null && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs))) {
    return refuse("options.timeout_ms must be a number of milliseconds.");
  }
  const dryRun = options.dry_run;
  if (dryRun !== undefined && dryRun !== null && typeof dryRun !== "boolean") return refuse("options.dry_run must be true or false.");
  const challenge = raw.challenge;
  if (challenge !== undefined && challenge !== null && typeof challenge !== "string") return refuse("challenge must be a string.");
  const expiresAt = raw.expires_at;
  if (expiresAt !== undefined && expiresAt !== null && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) {
    return refuse("expires_at must be unix seconds.");
  }

  return {
    id,
    command: {
      id,
      key,
      inputs: inputs as JsonObject,
      timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
      dryRun: typeof dryRun === "boolean" ? dryRun : undefined,
      challenge: typeof challenge === "string" ? challenge : null,
      expiresAt: typeof expiresAt === "number" ? expiresAt : null,
    },
  };
}
