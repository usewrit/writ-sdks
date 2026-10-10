/** Run tokens for linked workflows in token mode (CONTRACT.md §11): the in-memory cache. */

import { describe, expect, it } from "vitest";
import { RUN_TOKEN_REFRESH_MARGIN_MS, WritError, isWritError } from "../src/index.js";
import { RunTokenCache, checkRunToken, runTokenExpiry, runTokensFor } from "../src/run-token.js";
import { deferred } from "./fake-provider.js";
import { runTokenWith } from "./fixtures.js";

/** Unix seconds the tests start at. */
const NOW_S = 1_791_550_000;

/** A movable clock in unix milliseconds. */
function clock(): { now: () => number; set(seconds: number): void } {
  let ms = NOW_S * 1000;
  return {
    now: () => ms,
    set(seconds: number) {
      ms = seconds * 1000;
    },
  };
}

/** A getRunToken that hands out the given tokens in order, counting its calls. */
function minting(...tokens: string[]): { getRunToken: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    getRunToken: async () => {
      const token = tokens[Math.min(calls, tokens.length - 1)] as string;
      calls += 1;
      return token;
    },
    calls: () => calls,
  };
}

describe("RunTokenCache", () => {
  it("reuses a token until a minute before its exp, then fetches a new one", async () => {
    const time = clock();
    const first = runTokenWith({ pub: "pub_0123456789abcdefABCDEF", iat: NOW_S, exp: NOW_S + 600 });
    const second = runTokenWith({ pub: "pub_0123456789abcdefABCDEF", iat: NOW_S + 540, exp: NOW_S + 1140 });
    const source = minting(first, second);
    const cache = new RunTokenCache(source.getRunToken, time.now);

    await expect(cache.get()).resolves.toBe(first);
    await expect(cache.get()).resolves.toBe(first);
    expect(source.calls()).toBe(1);

    // One millisecond before the refresh margin: still reused.
    time.set(NOW_S + 600 - RUN_TOKEN_REFRESH_MARGIN_MS / 1000 - 0.001);
    await expect(cache.get()).resolves.toBe(first);
    expect(source.calls()).toBe(1);

    // At exp - 60 s: fetched again.
    time.set(NOW_S + 600 - RUN_TOKEN_REFRESH_MARGIN_MS / 1000);
    await expect(cache.get()).resolves.toBe(second);
    expect(source.calls()).toBe(2);
    await expect(cache.get()).resolves.toBe(second);
    expect(source.calls()).toBe(2);
  });

  it("never keeps a token with a minute or less left, nor one without exp", async () => {
    const time = clock();
    const short = runTokenWith({ pub: "pub_0123456789abcdefABCDEF", exp: NOW_S + 60 });
    const shortSource = minting(short);
    const shortCache = new RunTokenCache(shortSource.getRunToken, time.now);
    await expect(shortCache.get()).resolves.toBe(short);
    await expect(shortCache.get()).resolves.toBe(short);
    expect(shortSource.calls()).toBe(2);

    const opaque = runTokenWith({ pub: "pub_0123456789abcdefABCDEF" });
    const opaqueSource = minting(opaque);
    const opaqueCache = new RunTokenCache(opaqueSource.getRunToken, time.now);
    await opaqueCache.get();
    await opaqueCache.get();
    expect(opaqueSource.calls()).toBe(2);
  });

  it("shares one request between calls made at once", async () => {
    const pending = deferred<string>();
    let calls = 0;
    const cache = new RunTokenCache(() => {
      calls += 1;
      return pending.promise;
    }, clock().now);
    const a = cache.get();
    const b = cache.get();
    const token = runTokenWith({ exp: NOW_S + 600 });
    pending.resolve(token);
    await expect(Promise.all([a, b])).resolves.toEqual([token, token]);
    expect(calls).toBe(1);
  });

  it("never caches a failure: a plain error is NOT_GRANTED, a WritError keeps its code", async () => {
    let fail: unknown = new Error("session expired");
    const token = runTokenWith({ exp: NOW_S + 600 });
    const cache = new RunTokenCache(async () => {
      if (fail !== null) throw fail;
      return token;
    }, clock().now);

    const plain = await cache.get().catch((error: unknown) => error);
    expect(isWritError(plain, "NOT_GRANTED")).toBe(true);
    expect((plain as WritError).message).toContain("session expired");

    fail = new WritError("CONSENT_DENIED", "The user is signed out.");
    const kept = await cache.get().catch((error: unknown) => error);
    expect(isWritError(kept, "CONSENT_DENIED")).toBe(true);

    fail = null;
    await expect(cache.get()).resolves.toBe(token);
  });

  it("refuses an answer that is not a run token with BAD_REQUEST, and trims a trailing newline", async () => {
    for (const answer of [undefined, 42, "", "not-a-jwt", "a.b", "a.b.c.d", "x".repeat(5_000)]) {
      const cache = new RunTokenCache(async () => answer as string, clock().now);
      const error = await cache.get().catch((caught: unknown) => caught);
      expect(isWritError(error, "BAD_REQUEST"), String(answer)).toBe(true);
    }
    const token = runTokenWith({ exp: NOW_S + 600 });
    await expect(new RunTokenCache(async () => `${token}\n`, clock().now).get()).resolves.toBe(token);
  });

  it("drops a token Writ Cloud refused, and only that one", async () => {
    const first = runTokenWith({ exp: NOW_S + 600, n: 1 });
    const second = runTokenWith({ exp: NOW_S + 600, n: 2 });
    const source = minting(first, second);
    const cache = new RunTokenCache(source.getRunToken, clock().now);
    await cache.get();
    cache.refused("some.other.token");
    await expect(cache.get()).resolves.toBe(first);
    cache.refused(first);
    await expect(cache.get()).resolves.toBe(second);
    expect(source.calls()).toBe(2);
  });

  it("is shared per getRunToken function", () => {
    const getRunToken = async (): Promise<string> => runTokenWith({});
    expect(runTokensFor(getRunToken)).toBe(runTokensFor(getRunToken));
    expect(runTokensFor(async () => runTokenWith({}))).not.toBe(runTokensFor(getRunToken));
  });
});

describe("run token parsing", () => {
  it("reads exp from the payload without verifying, UTF-8 claims included", () => {
    expect(runTokenExpiry(runTokenWith({ pub: "pub_x", sub: "Zoë 東京", exp: 1_791_550_600 }))).toBe(1_791_550_600);
    expect(runTokenExpiry(runTokenWith({ sub: "u42" }))).toBeNull();
    expect(runTokenExpiry(runTokenWith({ exp: "soon" }))).toBeNull();
    expect(runTokenExpiry("a.%%%.c")).toBeNull();
    expect(runTokenExpiry("a.bm90IGpzb24.c")).toBeNull();
    expect(runTokenExpiry("only.two")).toBeNull();
  });

  it("accepts the golden token shape of the server SDKs", () => {
    const golden =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwdWIiOiJwdWJfMDEyMzQ1Njc4OWFiY2RlZkFCQ0RFRiIsImlhdCI6MTc5MTU1MDAwMCwiZXhwIjoxNzkxNTUwNjAwLCJzdWIiOiJ1NDIifQ.PtFpzHp1-YdsYPZ6RPNNPLF5MLz0jNgEVcIKLs1InXk";
    expect(checkRunToken(golden)).toBe(golden);
    expect(runTokenExpiry(golden)).toBe(1_791_550_600);
  });
});
