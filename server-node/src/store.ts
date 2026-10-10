/**
 * Where the bridge keeps what several requests share: each user's presence, the commands queued
 * for their pages, the commands waiting for a result, the results on their way back, and the
 * challenge nonces already spent.
 *
 * {@link memoryStore} serves one server process. Behind a load balancer, or on serverless hosts
 * where the page's poll and your call land on different instances, use `redisStore()`.
 *
 * Every time-to-live is relative (milliseconds from now), so a store never compares clocks.
 */

import { performance } from "node:perf_hooks";

import type { JsonObject } from "./json.js";
import type { WritReceipt, WritReceiptDevice } from "./receipt.js";

/** What the user's pages last reported (CONTRACT.md §12.3 `hello`), plus when. */
export interface WritPresence {
  /** Writ is installed, running and connected to this site. */
  ready: boolean;
  /** The contract keys the user granted to this site. */
  granted: string[];
  /** The Writ version the page reported. */
  writ_version: string | null;
  /** Unix milliseconds of the last hello or poll. */
  last_seen: number;
  /** The user reported Writ ready at least once while this record lived. */
  ever_ready: boolean;
}

/** A command for one of the user's pages (CONTRACT.md §12.3, `GET` answer). */
export interface WritCommand {
  /** 16 random bytes, base64url; also the nonce of its challenge. */
  id: string;
  key: string;
  inputs: JsonObject;
  options: { timeout_ms?: number; dry_run?: boolean };
  /** Minted for this command's id and key; the receipt must carry it back. */
  challenge: string;
  /** Unix seconds after which the page must not start it. */
  expires_at: number;
}

/** What the bridge remembers about a command until its result arrives. */
export interface WritPendingCommand {
  id: string;
  /** The user the command was sent to; only their pages may answer it. */
  user: string;
  key: string;
  challenge: string;
  /** Unix seconds. */
  expires_at: number;
  /** `inputsHash(challenge, inputs)` of what the command was sent with: its receipt must carry it. */
  inputs_hash?: string;
}

/** A command's outcome, as handed to the caller waiting for it. */
export type WritCommandOutcome =
  | { ok: true; data: unknown; receipt: WritReceipt }
  | {
      ok: false;
      error: { code: string; message: string };
      receipt?: WritReceipt | null;
      /** A genuine receipt refused only because its signer is not pinned for the user. */
      unknownDevice?: WritReceiptDevice;
    };

/** Options of {@link WritBridgeStore.take}. */
export interface WritTakeOptions {
  /** Most commands to answer. Default 16. */
  max?: number;
  /** Stop waiting when it aborts (the page went away). */
  signal?: AbortSignal;
}

/** How many commands `take` answers when `max` is not given. */
export const DEFAULT_TAKE_MAX = 16;

/**
 * The storage the bridge needs. Implement it to put the bridge on any shared store; every method
 * may be called concurrently from many requests.
 */
/** What {@link WritBridgeStore.checkDevice} answers. */
export type WritDeviceCheck = "known" | "pinned" | "unknown";

export interface WritBridgeStore {
  /** The user's last presence, or `null`. */
  getPresence(userId: string): Promise<WritPresence | null>;
  /** Replace the user's presence, kept `ttlMs`. */
  setPresence(userId: string, presence: WritPresence, ttlMs: number): Promise<void>;

  /**
   * Remember `pending` (until it is resolved, cancelled, or `ttlMs` passes) and queue `command`
   * for the user's pages, waking a page waiting in {@link take}.
   */
  enqueue(userId: string, command: WritCommand, pending: WritPendingCommand, ttlMs: number): Promise<void>;
  /**
   * Remove and answer the user's queued commands, oldest first, at most `max` (default 16). When
   * none is queued, wait up to `waitMs` for one; answer `[]` when none came or `signal` aborted.
   */
  take(userId: string, waitMs: number, options?: WritTakeOptions): Promise<WritCommand[]>;
  /** Put commands a page took but never received back at the front of the queue. */
  requeue(userId: string, commands: readonly WritCommand[]): Promise<void>;
  /** Remove `command` from the user's queue if no page took it yet; `true` when it was removed. */
  withdraw(userId: string, command: WritCommand): Promise<boolean>;

  /** The pending command with this id, or `null` once it was resolved, cancelled or expired. */
  pending(commandId: string): Promise<WritPendingCommand | null>;
  /**
   * Hand `outcome` to the caller waiting in {@link awaitResult}, and forget the pending command.
   * Exactly one resolve wins: `false` when the command was no longer pending.
   */
  resolve(commandId: string, outcome: WritCommandOutcome): Promise<boolean>;
  /** Wait up to `timeoutMs` for the command's outcome; `null` on timeout. */
  awaitResult(commandId: string, timeoutMs: number): Promise<WritCommandOutcome | null>;
  /** Forget a pending command and any outcome not collected yet. */
  cancel(commandId: string): Promise<void>;

  /** Record `nonce` as spent for `ttlMs`; `false` when it was already spent. */
  spendNonce(nonce: string, ttlMs: number): Promise<boolean>;

  /**
   * The device pin check of a receipt's signer, atomic: `"known"` when `publicKey` is pinned for
   * `subject`; when nothing is pinned for `subject` yet and `firstUse`, pin it and answer
   * `"pinned"`; otherwise `"unknown"`. Pins never expire.
   */
  checkDevice(subject: string, publicKey: string, firstUse: boolean): Promise<WritDeviceCheck>;
  /** Pin `publicKey` for `subject` (a further device you approved). Idempotent. */
  pinDevice(subject: string, publicKey: string): Promise<void>;
  /** Forget every device pinned for `subject`. */
  forgetDevices(subject: string): Promise<void>;

  /** Release timers and connections the store opened itself. */
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// memoryStore
// ---------------------------------------------------------------------------------------------

/** Options of {@link memoryStore}. */
export interface MemoryStoreOptions {
  /** Clock in unix milliseconds that times entries out, for tests. Waits always use real time. */
  now?: () => number;
}

interface Expiring<T> {
  value: T;
  expiresAt: number;
}

interface QueueEntry {
  command: WritCommand;
  expiresAt: number;
}

/** A waiter parked until something it watches changes. */
type Wake = () => void;

/** How often expired entries are swept, at most. */
const SWEEP_EVERY_MS = 30_000;

/**
 * The default store: everything in this process's memory. Right for one server process (and for
 * development); state is lost on restart, and other instances cannot see it.
 */
export function memoryStore(options: MemoryStoreOptions = {}): WritBridgeStore {
  const now = options.now ?? Date.now;
  const presence = new Map<string, Expiring<WritPresence>>();
  const queues = new Map<string, QueueEntry[]>();
  const pendings = new Map<string, Expiring<WritPendingCommand>>();
  const results = new Map<string, Expiring<WritCommandOutcome>>();
  const nonces = new Map<string, number>();
  /** Pinned device public keys per subject; never expire (a process restart forgets them). */
  const devices = new Map<string, Set<string>>();
  const queueWaiters = new Map<string, Set<Wake>>();
  const resultWaiters = new Map<string, Set<Wake>>();
  let lastSweep = now();

  function sweep(): void {
    const t = now();
    if (t - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = t;
    for (const [k, v] of presence) if (v.expiresAt <= t) presence.delete(k);
    for (const [k, v] of pendings) if (v.expiresAt <= t) pendings.delete(k);
    for (const [k, v] of results) if (v.expiresAt <= t) results.delete(k);
    for (const [k, v] of nonces) if (v <= t) nonces.delete(k);
    for (const [user, queue] of queues) {
      const live = queue.filter((entry) => entry.expiresAt > t);
      if (live.length === 0) queues.delete(user);
      else queues.set(user, live);
    }
  }

  function wakeAll(waiters: Map<string, Set<Wake>>, id: string): void {
    const set = waiters.get(id);
    if (set === undefined) return;
    waiters.delete(id);
    for (const wake of set) wake();
  }

  /** Wait until woken, `ms` passes, or `signal` aborts. */
  function park(waiters: Map<string, Set<Wake>>, id: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolvePromise) => {
      let set = waiters.get(id);
      if (set === undefined) {
        set = new Set();
        waiters.set(id, set);
      }
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        const current = waiters.get(id);
        if (current !== undefined) {
          current.delete(done);
          if (current.size === 0) waiters.delete(id);
        }
        resolvePromise();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  function takeNow(userId: string, max: number): WritCommand[] {
    const queue = queues.get(userId);
    if (queue === undefined) return [];
    const t = now();
    const live = queue.filter((entry) => entry.expiresAt > t);
    const taken = live.splice(0, Math.max(1, max));
    if (live.length === 0) queues.delete(userId);
    else queues.set(userId, live);
    return taken.map((entry) => entry.command);
  }

  function takeResult(commandId: string): WritCommandOutcome | null {
    const entry = results.get(commandId);
    if (entry === undefined) return null;
    results.delete(commandId);
    return entry.expiresAt > now() ? entry.value : null;
  }

  return {
    async getPresence(userId) {
      sweep();
      const entry = presence.get(userId);
      if (entry === undefined) return null;
      if (entry.expiresAt <= now()) {
        presence.delete(userId);
        return null;
      }
      return { ...entry.value, granted: [...entry.value.granted] };
    },

    async setPresence(userId, value, ttlMs) {
      sweep();
      presence.set(userId, { value: { ...value, granted: [...value.granted] }, expiresAt: now() + ttlMs });
    },

    async enqueue(userId, command, pending, ttlMs) {
      sweep();
      const expiresAt = now() + ttlMs;
      pendings.set(pending.id, { value: { ...pending }, expiresAt });
      const queue = queues.get(userId) ?? [];
      queue.push({ command, expiresAt });
      queues.set(userId, queue);
      wakeAll(queueWaiters, userId);
    },

    async take(userId, waitMs, takeOptions = {}) {
      const max = takeOptions.max ?? DEFAULT_TAKE_MAX;
      const signal = takeOptions.signal;
      sweep();
      const deadline = performance.now() + Math.max(0, waitMs);
      for (;;) {
        const taken = takeNow(userId, max);
        if (taken.length > 0) return taken;
        const left = deadline - performance.now();
        if (left <= 0 || signal?.aborted === true) return [];
        await park(queueWaiters, userId, left, signal);
      }
    },

    async requeue(userId, commands) {
      if (commands.length === 0) return;
      const t = now();
      const back = commands
        .map((command) => ({ command, expiresAt: pendings.get(command.id)?.expiresAt ?? 0 }))
        .filter((entry) => entry.expiresAt > t);
      if (back.length === 0) return;
      queues.set(userId, [...back, ...(queues.get(userId) ?? [])]);
      wakeAll(queueWaiters, userId);
    },

    async withdraw(userId, command) {
      const queue = queues.get(userId);
      if (queue === undefined) return false;
      const index = queue.findIndex((entry) => entry.command.id === command.id);
      if (index < 0) return false;
      queue.splice(index, 1);
      if (queue.length === 0) queues.delete(userId);
      return true;
    },

    async pending(commandId) {
      const entry = pendings.get(commandId);
      if (entry === undefined) return null;
      if (entry.expiresAt <= now()) {
        pendings.delete(commandId);
        return null;
      }
      return { ...entry.value };
    },

    async resolve(commandId, outcome) {
      const entry = pendings.get(commandId);
      if (entry === undefined || entry.expiresAt <= now()) {
        pendings.delete(commandId);
        return false;
      }
      pendings.delete(commandId);
      results.set(commandId, { value: outcome, expiresAt: entry.expiresAt });
      wakeAll(resultWaiters, commandId);
      return true;
    },

    async awaitResult(commandId, timeoutMs) {
      const deadline = performance.now() + Math.max(0, timeoutMs);
      for (;;) {
        const outcome = takeResult(commandId);
        if (outcome !== null) return outcome;
        const left = deadline - performance.now();
        if (left <= 0) return null;
        await park(resultWaiters, commandId, left);
      }
    },

    async cancel(commandId) {
      pendings.delete(commandId);
      results.delete(commandId);
    },

    async spendNonce(nonce, ttlMs) {
      sweep();
      const t = now();
      const until = nonces.get(nonce);
      if (until !== undefined && until > t) return false;
      nonces.set(nonce, t + Math.max(1, ttlMs));
      return true;
    },

    async checkDevice(subject, publicKey, firstUse) {
      const pinned = devices.get(subject);
      if (pinned?.has(publicKey)) return "known";
      if (firstUse && (pinned === undefined || pinned.size === 0)) {
        devices.set(subject, new Set([publicKey]));
        return "pinned";
      }
      return "unknown";
    },

    async pinDevice(subject, publicKey) {
      const pinned = devices.get(subject) ?? new Set<string>();
      pinned.add(publicKey);
      devices.set(subject, pinned);
    },

    async forgetDevices(subject) {
      devices.delete(subject);
    },

    async close() {
      for (const waiters of [queueWaiters, resultWaiters]) {
        for (const set of waiters.values()) for (const wake of set) wake();
        waiters.clear();
      }
    },
  };
}
