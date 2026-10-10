/**
 * Signed receipts and challenges on the plain session API (CONTRACT.md §12.1): a call's
 * `challenge` reaches `writ_call`, and the receipt the extension passes on reaches the result
 * (or the error's details), frozen and untouched.
 */

import { describe, expect, it } from "vitest";
import { MAX_CHALLENGE_LENGTH, isWritError, type WritError, type WritReceipt } from "../src/index.js";
import { connected } from "./fake-provider.js";

function receipt(overrides: Partial<WritReceipt> = {}): WritReceipt {
  return {
    v: 1,
    origin: "https://arrivos.example",
    key: "pos.receive",
    package: "arrivos.pos",
    function: "receive",
    challenge: "srv.challenge",
    outcome: "success",
    error_code: null,
    data_hash: "0f".repeat(32),
    run_id: 41,
    started_at: 1_791_550_000,
    finished_at: 1_791_550_003,
    writ: { version: "1.0.8" },
    device: { kid: "fedcba9876543210", alg: "Ed25519", public_key: "Q".repeat(43), hardware: false },
    sig: "S".repeat(86),
    ...overrides,
  };
}

describe("call options: challenge", () => {
  it("sends the challenge as is in writ_call", async () => {
    const { provider, session } = await connected();
    const challenge = `  ${"c".repeat(MAX_CHALLENGE_LENGTH - 4)}  `;
    const call = session.call("pos.receive", { invoice_no: "F-1" }, { challenge });
    await call.callId;
    expect(provider.sent("writ_call")).toEqual([{ key: "pos.receive", inputs: { invoice_no: "F-1" }, challenge }]);
  });

  it("refuses an empty, too long or non-string challenge without sending anything", async () => {
    const { provider, session } = await connected();
    for (const challenge of ["", "c".repeat(MAX_CHALLENGE_LENGTH + 1), 42, { nonce: "x" }]) {
      const error = (await session.call("pos.receive", {}, { challenge } as never).result.catch((e: unknown) => e)) as WritError;
      expect(isWritError(error, "BAD_REQUEST")).toBe(true);
    }
    expect(provider.sent("writ_call")).toEqual([]);
  });
});

describe("results: receipt", () => {
  it("carries the receipt of a finished run, frozen and equal to what Writ signed", async () => {
    const { provider, session } = await connected();
    const call = session.call("pos.receive", { invoice_no: "F-1" }, { challenge: "srv.challenge" });
    const id = await call.callId;
    const signed = receipt();
    provider.emit({ call_id: id, type: "finished", run_id: 41, data: { received: true }, duration_ms: 9, engine: "http", receipt: signed });
    const result = await call.result;
    expect(result.receipt).toEqual(signed);
    expect(result.receipt).not.toBe(signed);
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(Object.isFrozen(result.receipt?.device)).toBe(true);
  });

  it("is null when the extension said there is none, and absent with an older extension", async () => {
    const { provider, session } = await connected();
    const none = session.call("pos.receive", { invoice_no: "F-1" });
    provider.emit({ call_id: await none.callId, type: "finished", run_id: 1, data: null, duration_ms: 1, engine: null, receipt: null });
    expect((await none.result).receipt).toBeNull();

    const older = session.call("pos.receive", { invoice_no: "F-2" });
    provider.emit({ call_id: await older.callId, type: "finished", run_id: 2, data: null, duration_ms: 1, engine: null });
    expect("receipt" in (await older.result)).toBe(false);
  });

  it("puts a failed run's receipt in the error's details", async () => {
    const { provider, session } = await connected();
    const call = session.call("pos.receive", { invoice_no: "F-1" });
    const id = await call.callId;
    const failed = receipt({ outcome: "failed", error_code: "RUN_FAILED", data_hash: null });
    provider.emit({ call_id: id, type: "error", code: "RUN_FAILED", message: "The run failed.", receipt: failed });
    const error = (await call.result.catch((e: unknown) => e)) as WritError;
    expect(error.code).toBe("RUN_FAILED");
    expect(error.details?.receipt).toEqual(failed);
  });

  it("leaves receipt out of an error when there is none", async () => {
    const { provider, session } = await connected();
    const call = session.call("pos.receive", { invoice_no: "F-1" });
    const id = await call.callId;
    provider.emit({ call_id: id, type: "error", code: "RUN_FAILED", message: "x", receipt: null });
    const error = (await call.result.catch((e: unknown) => e)) as WritError;
    expect(error.details).toEqual({ callId: id });
  });
});
