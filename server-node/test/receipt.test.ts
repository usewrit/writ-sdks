/** Signed receipts (CONTRACT.md §12.1) and bridge.challenge() / bridge.verify(). */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isWritBridgeError, kidOf, verifyReceiptSignature, type WritReceipt, type WritVerifyOptions } from "../src/index.js";
import {
  GOLDEN_SEED_HEX,
  ORIGIN,
  OTHER_SEED_HEX,
  RECEIPT_GOLDEN_COPY,
  RECEIPT_GOLDEN_ENGINE,
  clock,
  deviceKey,
  makeReceipt,
  receiptGolden,
  testBridge,
} from "./fixtures.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** One change per field of the receipt, nested fields included. */
function tamperings(receipt: WritReceipt): [string, Record<string, unknown>][] {
  const changes: [string, (r: Record<string, unknown> & { device: Record<string, unknown>; writ: Record<string, unknown> }) => void][] = [
    ["v", (r) => (r.v = 2)],
    ["origin", (r) => (r.origin = "https://evil.example")],
    ["key", (r) => (r.key = "auth.other")],
    ["package", (r) => (r.package = "app.other")],
    ["package null", (r) => (r.package = null)],
    ["function", (r) => (r.function = "other")],
    ["challenge", (r) => (r.challenge = "other")],
    ["challenge null", (r) => (r.challenge = null)],
    ["outcome", (r) => (r.outcome = "failed")],
    ["error_code", (r) => (r.error_code = "RUN_FAILED")],
    ["data_hash", (r) => (r.data_hash = "0".repeat(64))],
    ["data_hash null", (r) => (r.data_hash = null)],
    ["run_id", (r) => (r.run_id = 43)],
    ["started_at", (r) => (r.started_at = (r.started_at as number) - 1)],
    ["finished_at", (r) => (r.finished_at = (r.finished_at as number) + 1)],
    ["writ.version", (r) => (r.writ.version = "1.0.8")],
    ["device.kid", (r) => (r.device.kid = "0123456789abcdef")],
    ["device.public_key", (r) => (r.device.public_key = deviceKey(OTHER_SEED_HEX).publicKey)],
    [
      "device swap (kid kept consistent)",
      (r) => {
        const other = deviceKey(OTHER_SEED_HEX).publicKey;
        r.device.public_key = other;
        r.device.kid = kidOf(Buffer.from(other, "base64url"));
      },
    ],
    ["device.hardware", (r) => (r.device.hardware = true)],
    ["device.alg", (r) => (r.device.alg = "EdDSA")],
    ["sig", (r) => (r.sig = `${(r.sig as string).slice(0, -2)}AA`)],
    ["sig missing", (r) => delete r.sig],
    ["field added", (r) => (r.extra = 1)],
    ["field removed", (r) => delete r.run_id],
  ];
  return changes.map(([name, change]) => {
    const copy = clone(receipt) as unknown as Record<string, unknown> & { device: Record<string, unknown>; writ: Record<string, unknown> };
    change(copy);
    return [name, copy] as [string, Record<string, unknown>];
  });
}

describe("golden receipt", () => {
  const golden = receiptGolden();

  // The copy is what a checkout of the public repo tests against, so it must not drift from the engine.
  it.skipIf(RECEIPT_GOLDEN_ENGINE === undefined)("ships a byte-for-byte copy of the engine's file", () => {
    expect(readFileSync(RECEIPT_GOLDEN_COPY, "utf8")).toBe(readFileSync(RECEIPT_GOLDEN_ENGINE!, "utf8"));
  });

  it("names the key its seed derives", () => {
    expect(deviceKey(golden.test_seed_hex).publicKey).toBe(golden.public_key);
    expect(golden.test_seed_hex).toBe(GOLDEN_SEED_HEX);
    expect(kidOf(Buffer.from(golden.public_key, "base64url"))).toBe(golden.receipt.device.kid);
  });

  it("verifies", () => {
    const check = verifyReceiptSignature(golden.receipt);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.device).toEqual(golden.receipt.device);
  });

  it("is reproduced byte for byte by the test signer", () => {
    const { sig, ...unsigned } = golden.receipt;
    expect(makeReceipt({ ...unsigned, data: golden.data }).sig).toBe(sig);
  });

  for (const [name, tampered] of tamperings(receiptGolden().receipt)) {
    it(`rejects a change to ${name}`, () => {
      expect(verifyReceiptSignature(tampered).ok).toBe(false);
    });
  }

  it("rejects what is not a receipt", () => {
    for (const value of [null, "receipt", [], 42, {}]) expect(verifyReceiptSignature(value).ok).toBe(false);
  });
});

describe("bridge.challenge() and bridge.verify()", () => {
  const data = { ok: true, user: "Zoé", n: 3 };

  it("accepts a genuine receipt for the challenge, once", async () => {
    const bridge = testBridge();
    const challenge = bridge.challenge({ subject: "login-77", key: "auth.verify_login" });
    const receipt = makeReceipt({ key: "auth.verify_login", challenge, data });

    const first = await bridge.verify(receipt, { challenge, key: "auth.verify_login", origin: ORIGIN, data });
    expect(first).toEqual({ ok: true, outcome: "success", device: receipt.device });

    const second = await bridge.verify(receipt, { challenge, key: "auth.verify_login", origin: ORIGIN, data });
    expect(second).toMatchObject({ ok: false, reason: "the challenge was already used" });
  });

  it("refuses an expired challenge", async () => {
    const time = clock();
    const bridge = testBridge({}, time);
    const challenge = bridge.challenge({ subject: "u1", key: "auth.verify_login", ttlSeconds: 120 });
    const receipt = makeReceipt({ key: "auth.verify_login", challenge, data });
    time.advance(121_000);
    expect(await bridge.verify(receipt, { challenge, key: "auth.verify_login" })).toMatchObject({
      ok: false,
      reason: "the challenge expired",
    });
  });

  it("refuses the golden receipt: its challenge was not minted by this server", async () => {
    const golden = receiptGolden();
    const result = await testBridge().verify(golden.receipt, { challenge: "eyJ2IjoxfQ.c2ln", key: "auth.verify_login" });
    expect(result).toMatchObject({ ok: false, outcome: "success", device: golden.receipt.device });
    expect(result.reason).toBe("the challenge was not minted by this server");
  });

  it("refuses a forged signature with no device", async () => {
    const bridge = testBridge();
    const challenge = bridge.challenge({ subject: "u1", key: "auth.verify_login" });
    const receipt = { ...makeReceipt({ key: "auth.verify_login", challenge, data }), outcome: "success" as const, run_id: 8 };
    expect(await bridge.verify(receipt, { challenge, key: "auth.verify_login" })).toMatchObject({ ok: false, outcome: null, device: null });
  });

  it.each<[string, (challenge: string) => { receipt: WritReceipt; options: Record<string, unknown> }, string]>([
    [
      "another challenge",
      (challenge) => ({ receipt: makeReceipt({ key: "auth.verify_login", challenge: `${challenge}x`, data }), options: {} }),
      "the receipt answers another challenge",
    ],
    [
      "another key",
      (challenge) => ({ receipt: makeReceipt({ key: "orders.list", challenge, data }), options: {} }),
      'the receipt is for "orders.list", not "auth.verify_login"',
    ],
    [
      "another origin",
      (challenge) => ({ receipt: makeReceipt({ key: "auth.verify_login", challenge, data }), options: { origin: "https://evil.example" } }),
      "the receipt comes from https://app.example.com, not https://evil.example",
    ],
    [
      "other data",
      (challenge) => ({ receipt: makeReceipt({ key: "auth.verify_login", challenge, data }), options: { data: { ...data, n: 4 } } }),
      "the data does not match the receipt",
    ],
    [
      "a failed call",
      (challenge) => ({ receipt: makeReceipt({ key: "auth.verify_login", challenge, outcome: "failed", error_code: "RUN_FAILED" }), options: {} }),
      'the call ended "failed" (RUN_FAILED)',
    ],
    [
      "another subject",
      (challenge) => ({ receipt: makeReceipt({ key: "auth.verify_login", challenge, data }), options: { subject: "someone-else" } }),
      "the challenge was minted for another subject",
    ],
  ])("refuses %s", async (_name, build, reason) => {
    const bridge = testBridge();
    const challenge = bridge.challenge({ subject: "u1", key: "auth.verify_login" });
    const { receipt, options } = build(challenge);
    const result = await bridge.verify(receipt, { challenge, key: "auth.verify_login", ...options } as WritVerifyOptions);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(reason);
  });

  it("reports the outcome and device of a genuine failed call", async () => {
    const bridge = testBridge();
    const challenge = bridge.challenge({ subject: "u1", key: "auth.verify_login" });
    const receipt = makeReceipt({ key: "auth.verify_login", challenge, outcome: "timeout", error_code: "TIMEOUT" });
    expect(await bridge.verify(receipt, { challenge, key: "auth.verify_login" })).toMatchObject({
      ok: false,
      outcome: "timeout",
      device: receipt.device,
    });
  });

  it("pins the first device that answers for a user and refuses another until approved", async () => {
    const bridge = testBridge();
    const first = bridge.challenge({ subject: "u1", key: "auth.verify_login" });
    expect((await bridge.verify(makeReceipt({ key: "auth.verify_login", challenge: first, data }), { challenge: first, key: "auth.verify_login", data })).ok).toBe(true);

    // A receipt signed by another key: a second computer, or a forgery made with a fresh key.
    const second = bridge.challenge({ subject: "u1", key: "auth.verify_login" });
    const foreign = makeReceipt({ key: "auth.verify_login", challenge: second, data }, OTHER_SEED_HEX);
    expect(await bridge.verify(foreign, { challenge: second, key: "auth.verify_login", data })).toMatchObject({ ok: false, unknownDevice: true });

    // Another user is a different subject: its own first device pins.
    const otherUser = bridge.challenge({ subject: "u2", key: "auth.verify_login" });
    expect((await bridge.verify(makeReceipt({ key: "auth.verify_login", challenge: otherUser, data }, OTHER_SEED_HEX), { challenge: otherUser, key: "auth.verify_login", data })).ok).toBe(true);

    // Approved by the developer, the second computer verifies.
    await bridge.approveDevice("u1", foreign.device);
    const third = bridge.challenge({ subject: "u1", key: "auth.verify_login" });
    expect((await bridge.verify(makeReceipt({ key: "auth.verify_login", challenge: third, data }, OTHER_SEED_HEX), { challenge: third, key: "auth.verify_login", data })).ok).toBe(true);
    await expect(bridge.approveDevice("u1", "not a key")).rejects.toThrow(/approveDevice/);

    // Forgotten, the next device pins anew.
    await bridge.forgetDevices("u1");
    const fourth = bridge.challenge({ subject: "u1", key: "auth.verify_login" });
    expect((await bridge.verify(makeReceipt({ key: "auth.verify_login", challenge: fourth, data }, OTHER_SEED_HEX), { challenge: fourth, key: "auth.verify_login", data })).ok).toBe(true);
  });

  it("checks what the call ran with when the server says", async () => {
    const bridge = testBridge();
    const signin = { company: "acme", username: "zoe", password: "right" };
    const challenge = bridge.challenge({ subject: "acme/zoe", key: "auth.verify_login" });
    const receipt = makeReceipt({ key: "auth.verify_login", challenge, data, inputs: signin });
    // Run with another account's sign-in, claimed for this one: refused.
    expect(await bridge.verify(receipt, { challenge, key: "auth.verify_login", data, inputs: { ...signin, username: "mallory" } })).toMatchObject({
      ok: false,
      reason: "the call ran with other inputs than these",
    });
    const again = bridge.challenge({ subject: "acme/zoe", key: "auth.verify_login" });
    const good = makeReceipt({ key: "auth.verify_login", challenge: again, data, inputs: signin });
    expect((await bridge.verify(good, { challenge: again, key: "auth.verify_login", data, inputs: signin })).ok).toBe(true);
    // A receipt that doesn't say what it ran with is refused when the server asks.
    const third = bridge.challenge({ subject: "acme/zoe", key: "auth.verify_login" });
    const silent = makeReceipt({ key: "auth.verify_login", challenge: third, data });
    expect((await bridge.verify(silent, { challenge: third, key: "auth.verify_login", data, inputs: signin })).ok).toBe(false);
  });

  it("accepts any signer only when pinning is turned off", async () => {
    const bridge = testBridge({ pinDevices: "off" });
    for (const seed of [GOLDEN_SEED_HEX, OTHER_SEED_HEX]) {
      const challenge = bridge.challenge({ subject: "u1", key: "auth.verify_login" });
      expect((await bridge.verify(makeReceipt({ key: "auth.verify_login", challenge, data }, seed), { challenge, key: "auth.verify_login", data })).ok).toBe(true);
    }
    expect(() => testBridge({ pinDevices: "sometimes" as never })).toThrow(/pinDevices/);
  });

  it("honours pinDevices", async () => {
    const pinned = deviceKey(GOLDEN_SEED_HEX).publicKey;
    const bridge = testBridge({ pinDevices: (_user, device) => device.public_key === pinned });
    const ok = bridge.challenge({ subject: "u1", key: "auth.verify_login" });
    expect((await bridge.verify(makeReceipt({ key: "auth.verify_login", challenge: ok, data }), { challenge: ok, key: "auth.verify_login" })).ok).toBe(true);
    const other = bridge.challenge({ subject: "u1", key: "auth.verify_login" });
    const foreign = makeReceipt({ key: "auth.verify_login", challenge: other, data }, OTHER_SEED_HEX);
    expect(await bridge.verify(foreign, { challenge: other, key: "auth.verify_login" })).toMatchObject({
      ok: false,
      reason: "the receipt was signed by a device this user has not registered",
    });
  });

  it("refuses a challenge for a key the contract does not have", () => {
    expect(() => testBridge().challenge({ subject: "u1", key: "nope" })).toThrow(/no function "nope"/);
  });

  it("refuses bad verify() options", async () => {
    try {
      await testBridge().verify({}, { key: "auth.verify_login" } as never);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isWritBridgeError(error, "BAD_REQUEST")).toBe(true);
    }
  });
});
