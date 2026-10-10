/**
 * Call handles and event routing.
 *
 * The provider emits every `call` event of the page on one channel. {@link CallRouter} listens
 * BEFORE a `writ_call` goes out, so an event that arrives before the `writ_call` answer (the
 * provider may emit `started` at once) is held under its call id and handed over when the call
 * learns its id. {@link WritCall} then replays lifecycle events to listeners attached late.
 */

import { CALL_TIMEOUT_GRACE_MS, DEFAULT_CALL_TIMEOUT_MS } from "./constants.js";
import { WritError, normalizeErrorCode, toWritError } from "./errors.js";
import { parseReceipt } from "./receipt.js";
import type { RunTokenCache } from "./run-token.js";
import type {
  CallEngine,
  CallEvent,
  CallResult,
  CallStatus,
  JsonObject,
  WritCallEventName,
  WritCallEvents,
  WritProvider,
  WritRecipeCache,
} from "./types.js";

const noop = (): void => {};

const CALL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "started",
  "progress",
  "needs_user",
  "finished",
  "error",
]);

const EVENT_NAMES: ReadonlySet<string> = new Set<WritCallEventName>([
  "started",
  "progress",
  "needsUser",
  "finished",
  "error",
]);

const ENGINES: ReadonlySet<string> = new Set<CallEngine>(["http", "browser", "hybrid"]);

/** Events for call ids not claimed yet are kept this long, at most this many ids and events. */
const HOLD_MS = 30_000;
const MAX_HELD_CALLS = 32;
const MAX_HELD_EVENTS_PER_CALL = 64;

/** Transient events (progress, needsUser) kept for a listener that is not attached yet. */
const MAX_QUEUED_TRANSIENT = 50;

/**
 * One listener on the provider's `call` channel per client, shared by every call. It is
 * attached while a call is pending or running and detached when none is.
 */
export class CallRouter {
  readonly #provider: WritProvider;
  readonly #routes = new Map<string, (event: CallEvent) => void>();
  readonly #held = new Map<string, { at: number; events: CallEvent[] }>();
  #expecting = 0;
  #attached = false;
  readonly #onProviderEvent = (payload: unknown): void => {
    this.#dispatch(payload);
  };

  constructor(provider: WritProvider) {
    this.#provider = provider;
  }

  /** A `writ_call` is about to go out. Pair with exactly one {@link unexpect}. */
  expect(): void {
    if (!this.#attached) {
      this.#provider.on("call", this.#onProviderEvent);
      this.#attached = true;
    }
    this.#expecting += 1;
  }

  /** That `writ_call` answered, failed, or is no longer waited for. Call after {@link claim}. */
  unexpect(): void {
    this.#expecting = Math.max(0, this.#expecting - 1);
    this.#maybeDetach();
  }

  /** A `writ_call` answered with `callId`: route its events here, held ones first. */
  claim(callId: string, handler: (event: CallEvent) => void): void {
    this.#routes.set(callId, handler);
    const held = this.#held.get(callId);
    if (held === undefined) return;
    this.#held.delete(callId);
    for (const event of held.events) {
      if (this.#routes.get(callId) !== handler) break;
      handler(event);
    }
  }

  /** The call settled: stop routing its events. */
  release(callId: string): void {
    this.#routes.delete(callId);
    this.#held.delete(callId);
    this.#maybeDetach();
  }

  /** Whether the provider listener is attached (for tests and diagnostics). */
  get attached(): boolean {
    return this.#attached;
  }

  #dispatch(payload: unknown): void {
    const event = parseCallEvent(payload);
    if (event === null) return;
    const route = this.#routes.get(event.call_id);
    if (route !== undefined) {
      route(event);
      return;
    }
    // Only a call still waiting for its `writ_call` answer can own an unknown id.
    if (this.#expecting > 0) this.#hold(event);
  }

  #hold(event: CallEvent): void {
    const now = Date.now();
    for (const [id, entry] of this.#held) {
      if (now - entry.at > HOLD_MS) this.#held.delete(id);
    }
    let entry = this.#held.get(event.call_id);
    if (entry === undefined) {
      while (this.#held.size >= MAX_HELD_CALLS) {
        const oldest = this.#held.keys().next();
        if (oldest.done === true) break;
        this.#held.delete(oldest.value);
      }
      entry = { at: now, events: [] };
      this.#held.set(event.call_id, entry);
    }
    if (entry.events.length < MAX_HELD_EVENTS_PER_CALL) entry.events.push(event);
  }

  #maybeDetach(): void {
    if (!this.#attached || this.#expecting > 0 || this.#routes.size > 0) return;
    this.#held.clear();
    this.#attached = false;
    try {
      this.#provider.off("call", this.#onProviderEvent);
    } catch {
      // A provider that cannot unsubscribe: the routes are empty, so its events are dropped.
    }
  }
}

function parseCallEvent(payload: unknown): CallEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as { call_id?: unknown; type?: unknown };
  if (typeof record.call_id !== "string" || record.call_id === "") return null;
  if (typeof record.type !== "string" || !CALL_EVENT_TYPES.has(record.type)) return null;
  return payload as CallEvent;
}

/** What a session hands a new call. */
export interface CallInit {
  readonly provider: WritProvider;
  readonly router: CallRouter;
  readonly key: string;
  /** `writ_call` params, already validated. Absent when `error` is set. */
  readonly params?: {
    key: string;
    inputs?: JsonObject;
    timeout_ms?: number;
    dry_run?: boolean;
    /** Signed into the run's receipt (CONTRACT.md §12.1). */
    challenge?: string;
    /** A linked workflow in token mode: the run token (CONTRACT.md §11). */
    token?: string;
    /** A linked workflow: how long the visitor's Writ keeps its recipe. */
    recipe_cache?: WritRecipeCache;
  };
  /**
   * Where the run token comes from, when the call needs one it was not given: asked before
   * `writ_call` goes out, and told when Writ Cloud refused the token (`NOT_GRANTED`).
   */
  readonly runToken?: RunTokenCache;
  /** The run's timeout as sent; the extension default when none was sent. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** A validation error: the call fails without sending anything. */
  readonly error?: WritError;
  /** Told once, when the call settles. */
  readonly onSettle?: () => void;
  /** Told once, with the error, when the call fails. */
  readonly onFailure?: (error: WritError) => void;
}

type AnyListener = (payload: unknown) => void;

/**
 * One function call: a promise for its result, its call id, events, and cancel.
 *
 * ```ts
 * const call = session.call<{ received: boolean }>("pos.receive", { invoice_no: "F-1029" });
 * call.on("progress", ({ index, total }) => setProgress(index / total));
 * call.on("needsUser", ({ reason }) => showWaitingFor(reason));
 * const { data } = await call.result;
 * ```
 *
 * Created by `session.call()`; never constructed directly.
 */
export class WritCall<TOut = unknown> {
  /** The function key this call runs. */
  readonly key: string;
  /**
   * The id the extension assigned to the call. Rejects with the call's error when the call
   * settled before it got one (refused, cancelled or timed out before it started).
   */
  readonly callId: Promise<string>;
  /** Resolves with the run's result; rejects with a {@link WritError}. */
  readonly result: Promise<CallResult<TOut>>;

  readonly #provider: WritProvider;
  readonly #router: CallRouter;
  readonly #onSettle: (() => void) | undefined;
  readonly #onFailure: ((error: WritError) => void) | undefined;
  readonly #runToken: RunTokenCache | undefined;
  /** The run token this call went out with, when it got one from {@link #runToken}. */
  #token: string | null = null;
  /** `getRunToken` is being asked; `writ_call` has not gone out yet. */
  #awaitingToken = false;
  readonly #listeners = new Map<WritCallEventName, Set<AnyListener>>();
  readonly #sticky = new Map<WritCallEventName, unknown>();
  readonly #queued = new Map<WritCallEventName, unknown[]>();

  #resolveId: (id: string) => void = noop;
  #rejectId: (error: WritError) => void = noop;
  #resolveResult: (result: CallResult<TOut>) => void = noop;
  #rejectResult: (error: WritError) => void = noop;

  #status: CallStatus = "pending";
  #runId: number | null = null;
  #id: string | null = null;
  #settled = false;
  /** A `writ_call` is out and its answer is still awaited. */
  #awaitingId = false;
  #answered: Promise<void> = Promise.resolve();
  #markAnswered: () => void = noop;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #signal: AbortSignal | undefined;
  #cancelAck: Promise<void> | null = null;
  readonly #onAbort = (): void => {
    const reason: unknown = this.#signal?.reason;
    this.#abandon(new WritError("CANCELLED", "The call was aborted.", { cause: reason }));
  };

  constructor(init: CallInit) {
    this.key = init.key;
    this.#provider = init.provider;
    this.#router = init.router;
    this.#onSettle = init.onSettle;
    this.#onFailure = init.onFailure;
    this.#runToken = init.runToken;

    this.callId = new Promise<string>((resolve, reject) => {
      this.#resolveId = resolve;
      this.#rejectId = reject;
    });
    // `callId` is secondary: a page that only awaits `result` must not see it as unhandled.
    this.callId.catch(noop);
    this.result = new Promise<CallResult<TOut>>((resolve, reject) => {
      this.#resolveResult = resolve;
      this.#rejectResult = reject;
    });

    if (init.error !== undefined || init.params === undefined) {
      const error = init.error ?? new WritError("INTERNAL", "The call has no parameters.");
      // Deferred, so listeners attached right after `session.call()` still hear it.
      queueMicrotask(() => this.#fail(error));
      return;
    }

    const signal = init.signal;
    if (signal !== undefined && signal.aborted) {
      const reason: unknown = signal.reason;
      queueMicrotask(() =>
        this.#fail(new WritError("CANCELLED", "The call was aborted before it started.", { cause: reason })),
      );
      return;
    }
    if (signal !== undefined) {
      this.#signal = signal;
      signal.addEventListener("abort", this.#onAbort, { once: true });
    }

    const guardMs = (init.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS) + CALL_TIMEOUT_GRACE_MS;
    if (init.runToken === undefined) {
      this.#send(init.params, guardMs);
      return;
    }
    // A linked workflow in token mode: get the run token first. The guard covers the wait.
    const params = init.params;
    this.#timer = setTimeout(() => this.#onGuardTimeout(guardMs), guardMs);
    this.#awaitingToken = true;
    init.runToken.get().then(
      (token) => {
        this.#awaitingToken = false;
        if (this.#settled) return;
        this.#token = token;
        this.#send({ ...params, token }, guardMs);
      },
      (error: unknown) => {
        this.#awaitingToken = false;
        this.#fail(toWritError(error));
      },
    );
  }

  /** Where the call is: `pending` until the run starts, then `running`, then a final state. */
  get status(): CallStatus {
    return this.#status;
  }

  /** The run id once the run started, else null. */
  get runId(): number | null {
    return this.#runId;
  }

  /**
   * Listen to an event. `started`, `finished` and `error` happen once and are replayed to a
   * listener attached after they happened. `progress` and `needsUser` events that arrive while
   * no listener of their kind is attached are queued for the first one.
   */
  on<E extends WritCallEventName>(event: E, listener: (payload: WritCallEvents<TOut>[E]) => void): this {
    if (!EVENT_NAMES.has(event)) {
      throw new WritError(
        "BAD_REQUEST",
        `Unknown call event "${String(event)}"; use started, progress, needsUser, finished or error.`,
      );
    }
    if (typeof listener !== "function") {
      throw new WritError("BAD_REQUEST", "A call listener must be a function.");
    }
    const fn = listener as AnyListener;
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    if (set.has(fn)) return this;
    set.add(fn);

    if (this.#sticky.has(event)) {
      const payload = this.#sticky.get(event);
      queueMicrotask(() => {
        if (this.#listeners.get(event)?.has(fn) === true) invoke(fn, payload);
      });
    }
    const queued = this.#queued.get(event);
    if (queued !== undefined) {
      this.#queued.delete(event);
      queueMicrotask(() => {
        for (const payload of queued) {
          for (const current of [...(this.#listeners.get(event) ?? [])]) invoke(current, payload);
        }
      });
    }
    return this;
  }

  /** Stop listening. */
  off<E extends WritCallEventName>(event: E, listener: (payload: WritCallEvents<TOut>[E]) => void): this {
    this.#listeners.get(event)?.delete(listener as AnyListener);
    return this;
  }

  /**
   * Cancel the call. `result` rejects with `CANCELLED` at once and `writ_cancel` is sent to stop
   * the run. Resolves once the extension acknowledged, or could not be reached (the extension
   * also cancels a page's calls when the page goes away). Never rejects; a no-op on a call that
   * already settled.
   */
  cancel(): Promise<void> {
    if (!this.#settled) {
      // The page asked for this end, so it is handled: a page that never awaits `result` must not
      // see its CANCELLED rejection reported as unhandled (one awaiting it still gets it).
      this.result.catch(noop);
      this.#abandon(new WritError("CANCELLED", "The call was cancelled by the page."));
    }
    if (this.#cancelAck !== null) return this.#cancelAck;
    if (this.#awaitingId) return this.#answered.then(() => this.#cancelAck ?? undefined);
    return Promise.resolve();
  }

  #send(params: NonNullable<CallInit["params"]>, guardMs: number): void {
    try {
      this.#router.expect();
    } catch (error) {
      queueMicrotask(() => this.#fail(toWritError(error)));
      return;
    }
    this.#awaitingId = true;
    this.#answered = new Promise<void>((resolve) => {
      this.#markAnswered = resolve;
    });
    // Already running when the call first waited for its run token.
    if (this.#timer === undefined) this.#timer = setTimeout(() => this.#onGuardTimeout(guardMs), guardMs);

    let request: Promise<unknown>;
    try {
      request = Promise.resolve(this.#provider.request({ method: "writ_call", params }));
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      (answer) => this.#onAnswer(answer),
      (error: unknown) => this.#onRequestError(error),
    );
  }

  #onAnswer(answer: unknown): void {
    const id = readCallId(answer);
    if (!this.#awaitingId) {
      // The guard gave up on this answer; the run it names may still be going.
      if (id !== null) void this.#sendCancel(id);
      return;
    }
    if (id === null) {
      this.#stopAwaiting();
      this.#fail(new WritError("INTERNAL", "The Writ extension started the call without a call id."));
      return;
    }

    this.#id = id;
    this.#resolveId(id);
    if (this.#settled) {
      // Cancelled or aborted while `writ_call` was in flight: stop the run it started.
      void this.#sendCancel(id);
      this.#stopAwaiting();
      return;
    }
    // Claim before un-expecting, so events held for this id are not dropped by a detach.
    this.#router.claim(id, (event) => this.#onEvent(event));
    this.#stopAwaiting();
  }

  #onRequestError(error: unknown): void {
    if (!this.#awaitingId) return;
    this.#stopAwaiting();
    this.#fail(toWritError(error));
  }

  #onGuardTimeout(guardMs: number): void {
    this.#timer = undefined;
    const waited = this.#awaitingToken ? "getRunToken() did not answer" : "Writ did not answer";
    this.#abandon(
      new WritError("TIMEOUT", `${waited} within ${guardMs} ms.`, {
        details: { timeoutMs: guardMs - CALL_TIMEOUT_GRACE_MS },
      }),
    );
    // Give up on a `writ_call` answer that never came; a late id is still cancelled.
    this.#stopAwaiting();
  }

  #stopAwaiting(): void {
    if (!this.#awaitingId) return;
    this.#awaitingId = false;
    this.#router.unexpect();
    this.#markAnswered();
    this.#clearTimerWhenDone();
  }

  #onEvent(event: CallEvent): void {
    if (this.#settled) return;
    switch (event.type) {
      case "started": {
        if (isFiniteNumber(event.run_id)) this.#runId = event.run_id;
        this.#status = "running";
        if (this.#runId !== null) this.#emit("started", Object.freeze({ runId: this.#runId }));
        return;
      }
      case "progress": {
        if (this.#status === "pending") this.#status = "running";
        if (!isFiniteNumber(event.index) || !isFiniteNumber(event.total)) return;
        this.#emit("progress", Object.freeze({ index: event.index, total: event.total }));
        return;
      }
      case "needs_user": {
        if (typeof event.reason !== "string") return;
        this.#emit("needsUser", Object.freeze({ reason: event.reason }));
        return;
      }
      case "finished": {
        this.#finish(event);
        return;
      }
      case "error": {
        const raw = typeof event.code === "string" && event.code !== "" ? event.code : "INTERNAL";
        const code = normalizeErrorCode(raw);
        const details: Record<string, unknown> = { callId: this.#id };
        if (this.#runId !== null) details.runId = this.#runId;
        if (code !== raw) details.providerCode = raw;
        // A run that took place and failed is signed too: the site's server can verify the failure.
        const receipt = parseReceipt(event.receipt);
        if (receipt !== null) details.receipt = receipt;
        const message = typeof event.message === "string" ? event.message : undefined;
        this.#fail(new WritError(code, message, { details }));
        return;
      }
      default:
        return;
    }
  }

  #finish(event: Extract<CallEvent, { type: "finished" }>): void {
    if (isFiniteNumber(event.run_id)) this.#runId = event.run_id;
    const engine =
      typeof event.engine === "string" && ENGINES.has(event.engine) ? event.engine : null;
    const fields: { -readonly [K in keyof CallResult<TOut>]: CallResult<TOut>[K] } = {
      data: event.data as TOut,
      runId: this.#runId ?? 0,
      durationMs: isFiniteNumber(event.duration_ms) ? event.duration_ms : 0,
      engine,
      callId: this.#id ?? "",
    };
    // Only extensions that pass receipts on send the field; an older one leaves it out.
    if ("receipt" in event) fields.receipt = parseReceipt(event.receipt);
    const result: CallResult<TOut> = Object.freeze(fields);
    this.#settled = true;
    this.#status = "finished";
    this.#cleanup();
    this.#emit("finished", result);
    this.#resolveResult(result);
  }

  /** Settle locally, then stop the run that may still be going. */
  #abandon(error: WritError): void {
    if (this.#settled) return;
    this.#fail(error);
    if (this.#id !== null) void this.#sendCancel(this.#id);
  }

  #fail(error: WritError): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#status = error.code === "CANCELLED" ? "cancelled" : "failed";
    this.#cleanup();
    // Writ Cloud refused the run token (expired, revoked): the next call gets a fresh one.
    if (error.code === "NOT_GRANTED" && this.#token !== null) this.#runToken?.refused(this.#token);
    if (this.#onFailure !== undefined) {
      try {
        this.#onFailure(error);
      } catch (failure) {
        reportListenerError(failure);
      }
    }
    if (this.#id === null) this.#rejectId(error);
    // A page that listens for `error` handled it; don't also report an unhandled rejection.
    if ((this.#listeners.get("error")?.size ?? 0) > 0) this.result.catch(noop);
    this.#emit("error", error);
    this.#rejectResult(error);
  }

  #cleanup(): void {
    this.#clearTimerWhenDone();
    if (this.#signal !== undefined) {
      this.#signal.removeEventListener("abort", this.#onAbort);
      this.#signal = undefined;
    }
    if (this.#id !== null) this.#router.release(this.#id);
    if (this.#onSettle !== undefined) {
      try {
        this.#onSettle();
      } catch (error) {
        reportListenerError(error);
      }
    }
  }

  /** The guard timer outlives a settled call only while a `writ_call` answer is still awaited. */
  #clearTimerWhenDone(): void {
    if (this.#timer === undefined || !this.#settled || this.#awaitingId) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #sendCancel(id: string): Promise<void> {
    if (this.#cancelAck === null) {
      this.#cancelAck = Promise.resolve()
        .then(() => this.#provider.request({ method: "writ_cancel", params: { call_id: id } }))
        .then(noop, noop);
    }
    return this.#cancelAck;
  }

  #emit(event: WritCallEventName, payload: unknown): void {
    const lifecycle = event === "started" || event === "finished" || event === "error";
    if (lifecycle) this.#sticky.set(event, payload);
    const listeners = this.#listeners.get(event);
    if (listeners === undefined || listeners.size === 0) {
      if (!lifecycle) {
        let queue = this.#queued.get(event);
        if (queue === undefined) {
          queue = [];
          this.#queued.set(event, queue);
        }
        if (queue.length >= MAX_QUEUED_TRANSIENT) queue.shift();
        queue.push(payload);
      }
      return;
    }
    for (const listener of [...listeners]) invoke(listener, payload);
  }
}

function readCallId(answer: unknown): string | null {
  if (typeof answer !== "object" || answer === null) return null;
  const id = (answer as { call_id?: unknown }).call_id;
  return typeof id === "string" && id !== "" ? id : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function invoke(listener: AnyListener, payload: unknown): void {
  try {
    listener(payload);
  } catch (error) {
    reportListenerError(error);
  }
}

/** A throwing listener must not break the call; report it the way the browser reports errors. */
function reportListenerError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof report === "function") {
    report.call(globalThis, error);
    return;
  }
  setTimeout(() => {
    throw error;
  }, 0);
}
