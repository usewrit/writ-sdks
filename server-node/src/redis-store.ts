/**
 * A {@link WritBridgeStore} on Redis, for several server instances (or serverless hosts) sharing
 * one bridge. No Redis library is bundled: pass the client you already use.
 *
 * ```ts
 * // ioredis
 * import Redis from "ioredis";
 * const redis = new Redis(process.env.REDIS_URL);
 * const sub = redis.duplicate();
 * const store = redisStore(redis, {
 *   subscribe: async (channel, onMessage) => {
 *     sub.on("message", (from, message) => { if (from === channel) onMessage(message); });
 *     await sub.subscribe(channel);
 *   },
 * });
 *
 * // node-redis (v4 or later)
 * import { createClient } from "redis";
 * const client = await createClient({ url: process.env.REDIS_URL }).connect();
 * const sub = await client.duplicate().connect();
 * const store = redisStore(client, { subscribe: (channel, onMessage) => sub.subscribe(channel, onMessage) });
 * ```
 *
 * Layout (every key under `prefix`, default `writ:bridge:`):
 * - `presence:<user>`: the user's presence, JSON, with a TTL;
 * - `queue:<user>`: a list of commands for the user's pages (`RPUSH`, `LPOP key count`);
 * - `pending:<id>`: a command waiting for its result; `DEL` decides which result wins;
 * - `result:<id>`: a one-item list holding the outcome for the caller;
 * - `nonce:<nonce>`: a spent challenge nonce (`SET NX PX`);
 * - `devices:<subject>`: the public keys of the devices pinned for a user (a set, no TTL; the
 *   first-use pin is one atomic script);
 * - channel `wake`: `q:<user>` when a command is queued, `r:<id>` when a result is in.
 *
 * Waiting: with `subscribe`, a waiting poll or caller wakes on the `wake` message and re-reads
 * at least every 2 s in case a message was lost. Without it, it re-reads every `pollIntervalMs`
 * (default 250 ms). Nothing ever blocks the connection you pass (no `BLPOP`), so it can stay
 * shared with the rest of your app. Needs Redis 6.2 or later (`LPOP` with a count).
 */

import { performance } from "node:perf_hooks";

import { DEFAULT_TAKE_MAX, type WritBridgeStore, type WritCommand, type WritCommandOutcome, type WritPendingCommand, type WritPresence } from "./store.js";

/** The Redis client: ioredis (`call`), node-redis v4+ (`sendCommand`), or a function. */
export type WritRedisClient =
  | { call(command: string, ...args: string[]): Promise<unknown> }
  | { sendCommand(args: string[]): Promise<unknown> }
  | ((args: string[]) => Promise<unknown>);

/** Options of {@link redisStore}. */
export interface RedisStoreOptions {
  /** Key and channel prefix. Default `"writ:bridge:"`. */
  prefix?: string;
  /**
   * Subscribe to a channel on a SEPARATE connection (a subscribed connection cannot run other
   * commands). Called once, on first use. Without it, waits re-read on a timer.
   */
  subscribe?: (channel: string, onMessage: (message: string) => void) => unknown;
  /** How often a wait re-reads without `subscribe`, in ms. Default 250. */
  pollIntervalMs?: number;
}

/**
 * The first-use pin, in one step so two first receipts racing cannot both pin: 1 = known,
 * 2 = pinned now (nothing was pinned), 0 = unknown.
 */
const CHECK_DEVICE_SCRIPT = [
  "if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 1 end",
  "if ARGV[2] == '1' and redis.call('SCARD', KEYS[1]) == 0 then redis.call('SADD', KEYS[1], ARGV[1]) return 2 end",
  "return 0",
].join("\n");

/** How long an outcome waits for its caller to collect it. */
const RESULT_TTL_MS = 10 * 60 * 1000;
/** With pub/sub, a wait still re-reads this often in case a message was lost. */
const SAFETY_POLL_MS = 2_000;

type Wake = () => void;

/** A Redis-backed store. See the module documentation for wiring and layout. */
export function redisStore(client: WritRedisClient, options: RedisStoreOptions = {}): WritBridgeStore {
  const prefix = options.prefix ?? "writ:bridge:";
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 250);
  const send = commandSender(client);
  const channel = `${prefix}wake`;
  const waiters = new Map<string, Set<Wake>>();
  let subscribed: Promise<void> | null = null;
  let closed = false;

  const key = {
    presence: (user: string) => `${prefix}presence:${user}`,
    queue: (user: string) => `${prefix}queue:${user}`,
    pending: (id: string) => `${prefix}pending:${id}`,
    result: (id: string) => `${prefix}result:${id}`,
    nonce: (nonce: string) => `${prefix}nonce:${nonce}`,
    devices: (subject: string) => `${prefix}devices:${subject}`,
  };

  function wake(token: string): void {
    const set = waiters.get(token);
    if (set === undefined) return;
    waiters.delete(token);
    for (const fn of set) fn();
  }

  function ensureSubscribed(): Promise<void> {
    if (options.subscribe === undefined) return Promise.resolve();
    if (subscribed === null) {
      subscribed = Promise.resolve(options.subscribe(channel, (message) => wake(String(message)))).then(
        () => undefined,
        (error: unknown) => {
          subscribed = null;
          throw error;
        },
      );
    }
    return subscribed;
  }

  async function publish(token: string): Promise<void> {
    wake(token); // same-process waiters, at once
    await send(["PUBLISH", channel, token]);
  }

  /** Wait for `token`, at most `ms`, or until `signal` aborts. */
  async function park(token: string, ms: number, signal?: AbortSignal): Promise<void> {
    await ensureSubscribed();
    const cap = options.subscribe === undefined ? pollIntervalMs : SAFETY_POLL_MS;
    await new Promise<void>((resolvePromise) => {
      let set = waiters.get(token);
      if (set === undefined) {
        set = new Set();
        waiters.set(token, set);
      }
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        const current = waiters.get(token);
        if (current !== undefined) {
          current.delete(done);
          if (current.size === 0) waiters.delete(token);
        }
        resolvePromise();
      };
      const timer = setTimeout(done, Math.max(0, Math.min(ms, cap)));
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  function ttl(ms: number): string {
    return String(Math.max(1, Math.ceil(ms)));
  }

  return {
    async getPresence(userId) {
      const raw = asText(await send(["GET", key.presence(userId)]));
      return raw === null ? null : (JSON.parse(raw) as WritPresence);
    },

    async setPresence(userId, presence, ttlMs) {
      await send(["SET", key.presence(userId), JSON.stringify(presence), "PX", ttl(ttlMs)]);
    },

    async enqueue(userId, command, pending, ttlMs) {
      await send(["SET", key.pending(pending.id), JSON.stringify(pending), "PX", ttl(ttlMs)]);
      await send(["RPUSH", key.queue(userId), JSON.stringify(command)]);
      await send(["PEXPIRE", key.queue(userId), ttl(ttlMs)]);
      await publish(`q:${userId}`);
    },

    async take(userId, waitMs, takeOptions = {}) {
      const max = takeOptions.max ?? DEFAULT_TAKE_MAX;
      const signal = takeOptions.signal;
      const deadline = performance.now() + Math.max(0, waitMs);
      for (;;) {
        const reply = await send(["LPOP", key.queue(userId), String(Math.max(1, max))]);
        const items = asList(reply);
        if (items.length > 0) return items.map((item) => JSON.parse(item) as WritCommand);
        const left = deadline - performance.now();
        if (left <= 0 || closed || signal?.aborted === true) return [];
        await park(`q:${userId}`, left, signal);
      }
    },

    async requeue(userId, commands) {
      if (commands.length === 0) return;
      // LPUSH inserts each value at the head in turn: push in reverse to keep their order.
      const values = [...commands].reverse().map((command) => JSON.stringify(command));
      await send(["LPUSH", key.queue(userId), ...values]);
      await publish(`q:${userId}`);
    },

    async withdraw(userId, command) {
      const removed = await send(["LREM", key.queue(userId), "1", JSON.stringify(command)]);
      return Number(removed) > 0;
    },

    async pending(commandId) {
      const raw = asText(await send(["GET", key.pending(commandId)]));
      return raw === null ? null : (JSON.parse(raw) as WritPendingCommand);
    },

    async resolve(commandId, outcome) {
      const removed = await send(["DEL", key.pending(commandId)]);
      if (Number(removed) <= 0) return false;
      await send(["RPUSH", key.result(commandId), JSON.stringify(outcome)]);
      await send(["PEXPIRE", key.result(commandId), String(RESULT_TTL_MS)]);
      await publish(`r:${commandId}`);
      return true;
    },

    async awaitResult(commandId, timeoutMs) {
      const deadline = performance.now() + Math.max(0, timeoutMs);
      for (;;) {
        const raw = asText(await send(["LPOP", key.result(commandId)]));
        if (raw !== null) return JSON.parse(raw) as WritCommandOutcome;
        const left = deadline - performance.now();
        if (left <= 0 || closed) return null;
        await park(`r:${commandId}`, left);
      }
    },

    async cancel(commandId) {
      await send(["DEL", key.pending(commandId), key.result(commandId)]);
    },

    async spendNonce(nonce, ttlMs) {
      const reply = await send(["SET", key.nonce(nonce), "1", "PX", ttl(ttlMs), "NX"]);
      return reply !== null && reply !== undefined;
    },

    async checkDevice(subject, publicKey, firstUse) {
      const reply = await send(["EVAL", CHECK_DEVICE_SCRIPT, "1", key.devices(subject), publicKey, firstUse ? "1" : "0"]);
      const code = Number(reply);
      return code === 1 ? "known" : code === 2 ? "pinned" : "unknown";
    },

    async pinDevice(subject, publicKey) {
      await send(["SADD", key.devices(subject), publicKey]);
    },

    async forgetDevices(subject) {
      await send(["DEL", key.devices(subject)]);
    },

    async close() {
      closed = true;
      for (const set of waiters.values()) for (const fn of set) fn();
      waiters.clear();
    },
  };
}

function commandSender(client: WritRedisClient): (args: string[]) => Promise<unknown> {
  if (typeof client === "function") return (args) => client(args);
  if (typeof (client as { call?: unknown }).call === "function") {
    const ioredis = client as { call(command: string, ...args: string[]): Promise<unknown> };
    return (args) => ioredis.call(args[0] as string, ...args.slice(1));
  }
  if (typeof (client as { sendCommand?: unknown }).sendCommand === "function") {
    const nodeRedis = client as { sendCommand(args: string[]): Promise<unknown> };
    return (args) => nodeRedis.sendCommand(args);
  }
  throw new TypeError("redisStore() needs an ioredis client, a node-redis client, or a function (args) => Promise<reply>.");
}

function asText(reply: unknown): string | null {
  if (reply === null || reply === undefined) return null;
  if (typeof reply === "string") return reply;
  if (reply instanceof Uint8Array) return Buffer.from(reply).toString("utf8");
  return String(reply);
}

function asList(reply: unknown): string[] {
  if (reply === null || reply === undefined) return [];
  if (Array.isArray(reply)) return reply.map((item) => asText(item)).filter((item): item is string => item !== null);
  const one = asText(reply);
  return one === null ? [] : [one];
}
