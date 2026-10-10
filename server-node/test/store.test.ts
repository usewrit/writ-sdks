/** The memory store and the Redis store (against an in-memory Redis double). */

import { describe, expect, it } from "vitest";

import { memoryStore, redisStore, type WritBridgeStore, type WritCommand, type WritPendingCommand } from "../src/index.js";
import { contract, fakePage, makeReceipt, testBridge } from "./fixtures.js";

/** Just enough Redis for the store: strings, lists, PX/NX, PUBLISH to one subscriber per channel. */
function fakeRedis() {
  const values = new Map<string, string | string[]>();
  const expiries = new Map<string, number>();
  const subscribers = new Map<string, (message: string) => void>();
  const sets = new Map<string, Set<string>>();
  const seen: string[] = [];

  function live(key: string): string | string[] | undefined {
    const until = expiries.get(key);
    if (until !== undefined && until <= Date.now()) {
      values.delete(key);
      expiries.delete(key);
    }
    return values.get(key);
  }
  function list(key: string): string[] {
    const value = live(key);
    if (value === undefined) {
      const fresh: string[] = [];
      values.set(key, fresh);
      return fresh;
    }
    if (!Array.isArray(value)) throw new Error("WRONGTYPE");
    return value;
  }
  function dropIfEmpty(key: string): void {
    const value = values.get(key);
    if (Array.isArray(value) && value.length === 0) {
      values.delete(key);
      expiries.delete(key);
    }
  }

  async function call(command: string, ...args: string[]): Promise<unknown> {
    seen.push(command);
    const [key = ""] = args;
    switch (command) {
      case "GET": {
        const value = live(key);
        return typeof value === "string" ? value : null;
      }
      case "SET": {
        const nx = args.includes("NX");
        if (nx && live(key) !== undefined) return null;
        values.set(key, args[1] as string);
        const px = args.indexOf("PX");
        if (px >= 0) expiries.set(key, Date.now() + Number(args[px + 1]));
        else expiries.delete(key);
        return "OK";
      }
      case "DEL": {
        let removed = 0;
        for (const name of args) {
          if (live(name) !== undefined || sets.has(name)) removed += 1;
          values.delete(name);
          expiries.delete(name);
          sets.delete(name);
        }
        return removed;
      }
      case "SADD": {
        const set = sets.get(key) ?? new Set<string>();
        const before = set.size;
        for (const member of args.slice(1)) set.add(member);
        sets.set(key, set);
        return set.size - before;
      }
      case "EVAL": {
        // The store's one script, the first-use device pin: KEYS[1] = devices set, ARGV = key, firstUse.
        const [script = "", , setKey = "", member = "", firstUse = "0"] = args;
        if (!script.includes("SISMEMBER") || !script.includes("SCARD")) throw new Error("unexpected script");
        const set = sets.get(setKey) ?? new Set<string>();
        if (set.has(member)) return 1;
        if (firstUse === "1" && set.size === 0) {
          sets.set(setKey, new Set([member]));
          return 2;
        }
        return 0;
      }
      case "RPUSH":
        list(key).push(...args.slice(1));
        return list(key).length;
      case "LPUSH": {
        const items = list(key);
        for (const value of args.slice(1)) items.unshift(value);
        return items.length;
      }
      case "LPOP": {
        const items = live(key);
        if (!Array.isArray(items) || items.length === 0) return null;
        if (args[1] === undefined) {
          const one = items.shift() ?? null;
          dropIfEmpty(key);
          return one;
        }
        const many = items.splice(0, Number(args[1]));
        dropIfEmpty(key);
        return many;
      }
      case "LREM": {
        const items = live(key);
        if (!Array.isArray(items)) return 0;
        const index = items.indexOf(args[2] as string);
        if (index < 0) return 0;
        items.splice(index, 1);
        dropIfEmpty(key);
        return 1;
      }
      case "PEXPIRE":
        if (live(key) === undefined) return 0;
        expiries.set(key, Date.now() + Number(args[1]));
        return 1;
      case "PUBLISH":
        subscribers.get(key)?.(args[1] as string);
        return subscribers.has(key) ? 1 : 0;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  }

  return {
    client: { call },
    subscribe: (channel: string, onMessage: (message: string) => void) => {
      subscribers.set(channel, onMessage);
    },
    values,
    seen,
  };
}

function command(id: string, key = "auth.verify_login"): WritCommand {
  return { id, key, inputs: { company: "acme" }, options: { timeout_ms: 10_000 }, challenge: `challenge-${id}`, expires_at: 9_999_999_999 };
}

function pending(id: string, user = "u1"): WritPendingCommand {
  return { id, user, key: "auth.verify_login", challenge: `challenge-${id}`, expires_at: 9_999_999_999 };
}

const stores: [string, () => WritBridgeStore][] = [
  ["memoryStore", () => memoryStore()],
  ["redisStore (polling)", () => redisStore(fakeRedis().client, { pollIntervalMs: 20 })],
  [
    "redisStore (pub/sub)",
    () => {
      const redis = fakeRedis();
      return redisStore(redis.client, { subscribe: redis.subscribe, prefix: "test:" });
    },
  ],
];

for (const [name, make] of stores) {
  describe(name, () => {
    it("pins the first device of a subject, atomically, and approved ones after it", async () => {
      const store = make();
      expect(await store.checkDevice("u1", "key-a", false)).toBe("unknown");
      expect(await store.checkDevice("u1", "key-a", true)).toBe("pinned");
      expect(await store.checkDevice("u1", "key-a", true)).toBe("known");
      expect(await store.checkDevice("u1", "key-b", true)).toBe("unknown");
      expect(await store.checkDevice("u2", "key-b", true)).toBe("pinned");
      await store.pinDevice("u1", "key-b");
      expect(await store.checkDevice("u1", "key-b", false)).toBe("known");
      await store.forgetDevices("u1");
      expect(await store.checkDevice("u1", "key-a", false)).toBe("unknown");
      expect(await store.checkDevice("u1", "key-c", true)).toBe("pinned");
      expect(await store.checkDevice("u2", "key-b", false)).toBe("known");
    });

    it("pins one of two first devices racing", async () => {
      const store = make();
      const answers = await Promise.all([store.checkDevice("u9", "key-a", true), store.checkDevice("u9", "key-b", true)]);
      expect(answers.filter((a) => a === "pinned")).toHaveLength(1);
      expect(answers.filter((a) => a === "unknown")).toHaveLength(1);
    });

    it("keeps presence", async () => {
      const store = make();
      expect(await store.getPresence("u1")).toBeNull();
      const presence = { ready: true, granted: ["a"], writ_version: "1.0.7", last_seen: 5, ever_ready: true };
      await store.setPresence("u1", presence, 60_000);
      expect(await store.getPresence("u1")).toEqual(presence);
    });

    it("queues commands in order and hands them to one taker", async () => {
      const store = make();
      await store.enqueue("u1", command("a"), pending("a"), 60_000);
      await store.enqueue("u1", command("b"), pending("b"), 60_000);
      expect((await store.take("u1", 0)).map((c) => c.id)).toEqual(["a", "b"]);
      expect(await store.take("u1", 0)).toEqual([]);
      expect(await store.take("u2", 0)).toEqual([]);
    });

    it("wakes a waiting taker", async () => {
      const store = make();
      const taking = store.take("u1", 3_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await store.enqueue("u1", command("a"), pending("a"), 60_000);
      expect((await taking).map((c) => c.id)).toEqual(["a"]);
    });

    it("stops waiting on abort", async () => {
      const store = make();
      const controller = new AbortController();
      const taking = store.take("u1", 10_000, { signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      const started = Date.now();
      expect(await taking).toEqual([]);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("requeues at the front", async () => {
      const store = make();
      await store.enqueue("u1", command("a"), pending("a"), 60_000);
      await store.enqueue("u1", command("b"), pending("b"), 60_000);
      const taken = await store.take("u1", 0, { max: 1 });
      await store.requeue("u1", taken);
      expect((await store.take("u1", 0)).map((c) => c.id)).toEqual(["a", "b"]);
    });

    it("withdraws a command nobody took", async () => {
      const store = make();
      const a = command("a");
      await store.enqueue("u1", a, pending("a"), 60_000);
      expect(await store.withdraw("u1", a)).toBe(true);
      expect(await store.withdraw("u1", a)).toBe(false);
      expect(await store.take("u1", 0)).toEqual([]);
    });

    it("resolves a pending command exactly once and delivers the outcome", async () => {
      const store = make();
      await store.enqueue("u1", command("a"), pending("a"), 60_000);
      expect(await store.pending("a")).toEqual(pending("a"));
      const waiting = store.awaitResult("a", 3_000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const outcome = { ok: false as const, error: { code: "RUN_FAILED", message: "no" }, receipt: null };
      expect(await store.resolve("a", outcome)).toBe(true);
      expect(await store.resolve("a", outcome)).toBe(false);
      expect(await waiting).toEqual(outcome);
      expect(await store.pending("a")).toBeNull();
    });

    it("keeps an outcome that arrives before anyone waits", async () => {
      const store = make();
      await store.enqueue("u1", command("a"), pending("a"), 60_000);
      const outcome = { ok: false as const, error: { code: "TIMEOUT", message: "late" } };
      await store.resolve("a", outcome);
      expect(await store.awaitResult("a", 100)).toEqual(outcome);
    });

    it("times out a wait with null, and cancel forgets the command", async () => {
      const store = make();
      await store.enqueue("u1", command("a"), pending("a"), 60_000);
      expect(await store.awaitResult("a", 50)).toBeNull();
      await store.cancel("a");
      expect(await store.pending("a")).toBeNull();
      expect(await store.resolve("a", { ok: false, error: { code: "X", message: "x" } })).toBe(false);
    });

    it("spends a nonce once", async () => {
      const store = make();
      expect(await store.spendNonce("n1", 60_000)).toBe(true);
      expect(await store.spendNonce("n1", 60_000)).toBe(false);
      expect(await store.spendNonce("n2", 60_000)).toBe(true);
    });

    it("carries a whole bridge round trip", async () => {
      const bridge = testBridge({ store: make() });
      const page = fakePage(bridge, bridge.userToken("u1"));
      await page.hello({ ready: true, granted: ["auth.verify_login"] });
      const call = bridge.user("u1").auth.verify_login({ company: "acme", username: "zoe" });
      const next = await page.nextCommand();
      const data = { ok: true, user: "zoe" };
      await page.post({ result: { id: next.id, ok: true, data, receipt: makeReceipt({ key: next.key, challenge: next.challenge, inputs: next.inputs, data }) } });
      await expect(call).resolves.toMatchObject({ venue: "user", data });
      await bridge.close();
    });
  });
}

describe("redisStore wiring", () => {
  it("prefixes every key and never blocks the connection", async () => {
    const redis = fakeRedis();
    const store = redisStore(redis.client, { prefix: "app1:" });
    await store.enqueue("u1", command("a"), pending("a"), 60_000);
    await store.setPresence("u1", { ready: true, granted: [], writ_version: null, last_seen: 1, ever_ready: true }, 60_000);
    expect([...redis.values.keys()].every((key) => key.startsWith("app1:"))).toBe(true);
    await store.take("u1", 0);
    expect(redis.seen.some((name) => name.startsWith("B"))).toBe(false);
  });

  it("accepts a node-redis style client and a plain function", async () => {
    const redis = fakeRedis();
    const nodeRedis = { sendCommand: (args: string[]) => redis.client.call(args[0] as string, ...args.slice(1)) };
    const viaNodeRedis = redisStore(nodeRedis);
    expect(await viaNodeRedis.spendNonce("n", 1_000)).toBe(true);
    const viaFunction = redisStore((args: string[]) => redis.client.call(args[0] as string, ...args.slice(1)));
    expect(await viaFunction.spendNonce("n", 1_000)).toBe(false);
  });

  it("refuses something that is not a client", () => {
    expect(() => redisStore({} as never)).toThrow(TypeError);
  });

  it("serves a contract's bridge", () => {
    expect(() => testBridge({ store: redisStore(fakeRedis().client), contract: contract() })).not.toThrow();
  });
});
