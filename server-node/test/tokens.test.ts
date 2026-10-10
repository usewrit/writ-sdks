/** Server-minted values (CONTRACT.md §12.2) against the shared golden file. */

import { describe, expect, it } from "vitest";

import { canonicalJson, mintChallenge, mintUserToken, openToken, readChallenge, readUserToken } from "../src/index.js";
import { SECRET, clock, testBridge, tokensGolden } from "./fixtures.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Every one-character change of `token`. */
function oneCharChanges(token: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < token.length; i += 1) {
    const current = token[i] as string;
    const replacement = current === "A" ? "B" : "A";
    out.push(token.slice(0, i) + replacement + token.slice(i + 1));
  }
  return out;
}

describe("user token golden vector", () => {
  const golden = tokensGolden();

  it("uses the golden secret", () => {
    expect(golden.secret).toBe(SECRET);
  });

  it("canonicalizes the payload byte for byte", () => {
    expect(canonicalJson(golden.user_token.payload)).toBe(golden.user_token.payload_canonical);
  });

  it("mints the exact token", () => {
    expect(mintUserToken(SECRET, "user-42", 1_791_553_600)).toBe(golden.user_token.token);
  });

  it("bridge.userToken() mints the same bytes for the same clock", () => {
    const time = clock((1_791_553_600 - 3_600) * 1000);
    expect(testBridge({}, time).userToken("user-42")).toBe(golden.user_token.token);
    expect(testBridge({}, time).userToken("user-42", { ttlSeconds: 3_600 })).toBe(golden.user_token.token);
  });

  it("reads it back before expiry", () => {
    expect(readUserToken(SECRET, golden.user_token.token, 1_791_553_599)).toEqual(golden.user_token.payload);
  });

  it("refuses it at and after expiry", () => {
    expect(readUserToken(SECRET, golden.user_token.token, 1_791_553_600)).toBeNull();
    expect(readUserToken(SECRET, golden.user_token.token, 1_791_560_000)).toBeNull();
  });

  it("refuses any altered character", () => {
    for (const altered of oneCharChanges(golden.user_token.token)) {
      expect(openToken(SECRET, altered), altered).toBeNull();
    }
  });

  it("refuses another secret, extra segments, and a challenge used as a user token", () => {
    expect(openToken(`${SECRET}x`, golden.user_token.token)).toBeNull();
    expect(openToken(SECRET, `${golden.user_token.token}.x`)).toBeNull();
    expect(openToken(SECRET, "")).toBeNull();
    expect(openToken(SECRET, 42)).toBeNull();
    expect(readUserToken(SECRET, golden.challenge.token, 1_791_550_000)).toBeNull();
  });
});

describe("challenge golden vector", () => {
  const golden = tokensGolden();
  const fields = golden.challenge.payload as { sub: string; key: string; nonce: string; exp: number };

  it("canonicalizes the payload byte for byte", () => {
    expect(canonicalJson(golden.challenge.payload)).toBe(golden.challenge.payload_canonical);
  });

  it("mints the exact token", () => {
    expect(mintChallenge(SECRET, fields)).toBe(golden.challenge.token);
  });

  it("reads it back before expiry", () => {
    const reading = readChallenge(SECRET, golden.challenge.token, fields.exp - 1);
    expect(reading).toEqual({ ok: true, payload: golden.challenge.payload });
  });

  it("refuses it once expired", () => {
    expect(readChallenge(SECRET, golden.challenge.token, fields.exp)).toEqual({ ok: false, reason: "the challenge expired" });
  });

  it("refuses a user token as a challenge", () => {
    const reading = readChallenge(SECRET, golden.user_token.token, 1_791_550_000);
    expect(reading.ok).toBe(false);
  });

  it("refuses any altered character", () => {
    for (const altered of oneCharChanges(golden.challenge.token)) {
      expect(readChallenge(SECRET, altered, fields.exp - 1).ok, altered).toBe(false);
    }
  });

  it("mints a fresh 16-byte nonce when none is given", () => {
    const a = readChallenge(SECRET, mintChallenge(SECRET, { sub: "u", key: "auth.verify_login", exp: fields.exp }), fields.exp - 1);
    const b = readChallenge(SECRET, mintChallenge(SECRET, { sub: "u", key: "auth.verify_login", exp: fields.exp }), fields.exp - 1);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(Buffer.from(a.payload.nonce, "base64url")).toHaveLength(16);
      expect(a.payload.nonce).not.toBe(b.payload.nonce);
    }
  });

  it("only uses characters of the base64url alphabet", () => {
    for (const char of golden.challenge.token.replace(".", "")) expect(ALPHABET).toContain(char);
  });
});
