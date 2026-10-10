/** Calls: events, buffering, results, errors, cancel, abort, timeout guard, input validation. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_INPUT_BYTES, isWritError, type CallResult, type WritError } from "../src/index.js";
import { FakeProvider, connected, deferred, flush } from "./fake-provider.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("session.call()", () => {
  it("sends writ_call, routes its events, and resolves with the result", async () => {
    const { provider, session } = await connected();
    const call = session.call<{ received: boolean }>("pos.receive", { invoice_no: "F-1029" });
    const seen: string[] = [];
    call
      .on("started", ({ runId }) => seen.push(`started ${runId}`))
      .on("progress", ({ index, total }) => seen.push(`progress ${index}/${total}`))
      .on("needsUser", ({ reason }) => seen.push(`needsUser ${reason}`))
      .on("finished", ({ data }) => seen.push(`finished ${String(data.received)}`));
    expect(call.status).toBe("pending");

    const id = await call.callId;
    expect(id).toBe("call-1");
    expect(provider.sent("writ_call")).toEqual([{ key: "pos.receive", inputs: { invoice_no: "F-1029" } }]);

    provider.emit({ call_id: id, type: "started", run_id: 41 });
    expect(call.status).toBe("running");
    expect(call.runId).toBe(41);
    provider.emit({ call_id: id, type: "progress", index: 1, total: 3 });
    provider.emit({ call_id: "someone-else", type: "progress", index: 9, total: 9 });
    provider.emit({ call_id: id, type: "needs_user", reason: "confirm" });
    provider.emit({
      call_id: id,
      type: "finished",
      run_id: 41,
      data: { received: true },
      duration_ms: 812,
      engine: "http",
    });

    const result: CallResult<{ received: boolean }> = await call.result;
    expect(result).toEqual({ data: { received: true }, runId: 41, durationMs: 812, engine: "http", callId: id });
    expect(seen).toEqual(["started 41", "progress 1/3", "needsUser confirm", "finished true"]);
    expect(call.status).toBe("finished");

    // Events after the end are ignored; the provider listener is gone once nothing runs.
    provider.emit({ call_id: id, type: "error", code: "RUN_FAILED", message: "late" });
    expect(call.status).toBe("finished");
    expect(provider.listenerCount).toBe(0);
  });

  it("holds events that arrive before writ_call answers", async () => {
    const { provider, session } = await connected();
    provider.handlers.set("writ_call", () => {
      provider.emit({ call_id: "early", type: "started", run_id: 7 });
      provider.emit({ call_id: "early", type: "progress", index: 1, total: 2 });
      return { call_id: "early" };
    });

    const call = session.call("pos.receive", { invoice_no: "F-1" });
    await expect(call.callId).resolves.toBe("early");
    expect(call.runId).toBe(7);

    // A listener attached after the fact still hears the lifecycle event and queued progress.
    const started = vi.fn();
    const progress = vi.fn();
    call.on("started", started).on("progress", progress);
    await flush();
    expect(started).toHaveBeenCalledWith({ runId: 7 });
    expect(progress).toHaveBeenCalledWith({ index: 1, total: 2 });

    provider.emit({ call_id: "early", type: "finished", run_id: 7, data: [1, 2], duration_ms: 5, engine: null });
    await expect(call.result).resolves.toMatchObject({ data: [1, 2], runId: 7, engine: null });
  });

  it("resolves a call whose whole run happened before writ_call answered", async () => {
    const { provider, session } = await connected();
    const answer = deferred<unknown>();
    provider.handlers.set("writ_call", () => answer.promise);

    const call = session.call("pos.receive", { invoice_no: "F-2" });
    await flush();
    provider.emit({ call_id: "fast", type: "started", run_id: 3 });
    provider.emit({ call_id: "fast", type: "finished", run_id: 3, data: { ok: true }, duration_ms: 1, engine: "browser" });
    answer.resolve({ call_id: "fast" });

    await expect(call.result).resolves.toMatchObject({ data: { ok: true }, runId: 3, engine: "browser" });
    expect(provider.listenerCount).toBe(0);
  });

  it("rejects with the error event's code and tells error listeners", async () => {
    const { provider, session } = await connected();
    const call = session.call("pos.receive", { invoice_no: "F-3" });
    const onError = vi.fn();
    call.on("error", onError);
    const id = await call.callId;
    provider.emit({ call_id: id, type: "started", run_id: 9 });
    provider.emit({ call_id: id, type: "error", code: "RUN_FAILED", message: "The POS refused the invoice." });

    const error = (await call.result.catch((e: unknown) => e)) as WritError;
    expect(isWritError(error, "RUN_FAILED")).toBe(true);
    expect(error.message).toBe("The POS refused the invoice.");
    expect(error.details).toEqual({ callId: id, runId: 9 });
    expect(onError).toHaveBeenCalledWith(error);
    expect(call.status).toBe("failed");
  });

  it("maps an unknown error code to INTERNAL", async () => {
    const { provider, session } = await connected();
    const call = session.call("pos.receive");
    const id = await call.callId;
    provider.emit({ call_id: id, type: "error", code: "BRAND_NEW", message: "x" });
    await expect(call.result).rejects.toMatchObject({
      code: "INTERNAL",
      details: { callId: id, providerCode: "BRAND_NEW" },
    });
  });

  it("rejects result and callId when writ_call itself fails", async () => {
    const { provider, session } = await connected();
    provider.handlers.set("writ_call", () => {
      throw { code: "NOT_GRANTED", message: "No binding for pos.receive." };
    });
    const call = session.call("pos.receive", { invoice_no: "F-4" });
    await expect(call.result).rejects.toMatchObject({ code: "NOT_GRANTED" });
    await expect(call.callId).rejects.toMatchObject({ code: "NOT_GRANTED" });
    expect(provider.listenerCount).toBe(0);
  });

  it("refuses an answer without a call id", async () => {
    const { provider, session } = await connected();
    provider.handlers.set("writ_call", () => ({}));
    const call = session.call("pos.receive");
    await expect(call.result).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("sends the clamped timeout and dry_run", async () => {
    const { provider, session } = await connected();
    const short = session.call("pos.receive", {}, { timeoutMs: 10, dryRun: true });
    const long = session.call("pos.receive", {}, { timeoutMs: 2_000_000 });
    const settled = Promise.allSettled([short.result, long.result]);
    await Promise.all([short.callId, long.callId]);
    expect(provider.sent("writ_call")).toEqual([
      { key: "pos.receive", inputs: {}, timeout_ms: 1_000, dry_run: true },
      { key: "pos.receive", inputs: {}, timeout_ms: 900_000 },
    ]);
    await Promise.all([short.cancel(), long.cancel()]);
    await settled;
  });

  it("keeps a listener's exception away from the call", async () => {
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
    const { provider, session } = await connected();
    const call = session.call("pos.receive");
    call.on("started", () => {
      throw new Error("listener bug");
    });
    const id = await call.callId;
    provider.emit({ call_id: id, type: "started", run_id: 1 });
    provider.emit({ call_id: id, type: "finished", run_id: 1, data: null, duration_ms: 1, engine: "http" });
    await expect(call.result).resolves.toMatchObject({ runId: 1 });
    expect(reported).toHaveLength(1);
  });

  it("refuses an unknown event name", async () => {
    const { session } = await connected();
    const call = session.call("pos.receive");
    const outcome = call.result.catch((e: unknown) => e);
    expect(() => call.on("done" as never, () => {})).toThrow(/Unknown call event/);
    await call.cancel();
    expect(isWritError(await outcome, "CANCELLED")).toBe(true);
  });
});

describe("cancel and abort", () => {
  it("cancel() rejects with CANCELLED and sends writ_cancel", async () => {
    const { provider, session } = await connected();
    const call = session.call("pos.receive", { invoice_no: "F-5" });
    const outcome = call.result.catch((e: unknown) => e);
    const id = await call.callId;

    await call.cancel();

    expect(isWritError(await outcome, "CANCELLED")).toBe(true);
    expect(call.status).toBe("cancelled");
    expect(provider.sent("writ_cancel")).toEqual([{ call_id: id }]);
    // Idempotent, and later events are ignored.
    await call.cancel();
    provider.emit({ call_id: id, type: "finished", run_id: 1, data: {}, duration_ms: 1, engine: "http" });
    expect(provider.sent("writ_cancel")).toHaveLength(1);
    expect(call.status).toBe("cancelled");
  });

  it("cancel() after the call finished sends nothing", async () => {
    const { provider, session } = await connected();
    const call = session.call("pos.receive");
    const id = await call.callId;
    provider.emit({ call_id: id, type: "finished", run_id: 2, data: {}, duration_ms: 1, engine: "http" });
    await call.result;
    await call.cancel();
    expect(provider.sent("writ_cancel")).toEqual([]);
  });

  it("aborting the signal cancels the run", async () => {
    const { provider, session } = await connected();
    const controller = new AbortController();
    const call = session.call("pos.receive", { invoice_no: "F-6" }, { signal: controller.signal });
    const outcome = call.result.catch((e: unknown) => e);
    const id = await call.callId;

    controller.abort(new Error("user left the page"));

    const error = (await outcome) as WritError;
    expect(error.code).toBe("CANCELLED");
    expect((error.cause as Error).message).toBe("user left the page");
    await flush();
    expect(provider.sent("writ_cancel")).toEqual([{ call_id: id }]);
  });

  it("aborting before writ_call answered cancels the id that comes back", async () => {
    const { provider, session } = await connected();
    const answer = deferred<unknown>();
    provider.handlers.set("writ_call", () => answer.promise);
    const controller = new AbortController();
    const call = session.call("pos.receive", {}, { signal: controller.signal });
    const outcome = call.result.catch((e: unknown) => e);
    await flush();

    controller.abort();
    expect(isWritError(await outcome, "CANCELLED")).toBe(true);
    expect(provider.sent("writ_cancel")).toEqual([]);

    const cancelled = call.cancel();
    answer.resolve({ call_id: "late-1" });
    await cancelled;
    expect(provider.sent("writ_cancel")).toEqual([{ call_id: "late-1" }]);
    expect(provider.listenerCount).toBe(0);
  });

  it("an already aborted signal sends nothing", async () => {
    const { provider, session } = await connected();
    const controller = new AbortController();
    controller.abort();
    const call = session.call("pos.receive", {}, { signal: controller.signal });
    await expect(call.result).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(call.callId).rejects.toMatchObject({ code: "CANCELLED" });
    expect(provider.sent("writ_call")).toEqual([]);
  });
});

describe("timeout guard", () => {
  it("gives up timeoutMs + 5 s after the call, with TIMEOUT, and cancels the run", async () => {
    vi.useFakeTimers();
    const { provider, session } = await connected();
    const call = session.call("pos.receive", {}, { timeoutMs: 1_000 });
    const outcome = call.result.catch((e: unknown) => e);
    const id = await call.callId;

    await vi.advanceTimersByTimeAsync(5_999);
    expect(call.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    const error = (await outcome) as WritError;
    expect(error.code).toBe("TIMEOUT");
    expect(error.details).toEqual({ timeoutMs: 1_000 });
    expect(provider.sent("writ_cancel")).toEqual([{ call_id: id }]);
  });

  it("uses the extension default (120 s) when no timeout is given", async () => {
    vi.useFakeTimers();
    const { session } = await connected();
    const call = session.call("pos.receive");
    const outcome = call.result.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(124_999);
    expect(call.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(isWritError(await outcome, "TIMEOUT")).toBe(true);
  });

  it("does not hang callId or cancel() when writ_call never answers", async () => {
    vi.useFakeTimers();
    const { provider, session } = await connected();
    provider.handlers.set("writ_call", () => new Promise(() => {}));
    const call = session.call("pos.receive", {}, { timeoutMs: 1_000 });
    const outcome = call.result.catch((e: unknown) => e);
    const cancelled = call.cancel();
    expect(isWritError(await outcome, "CANCELLED")).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(cancelled).resolves.toBeUndefined();
    await expect(call.callId).rejects.toMatchObject({ code: "CANCELLED" });
    expect(provider.listenerCount).toBe(0);
  });
});

describe("input validation", () => {
  class Invoice {
    constructor(readonly number: string) {}
  }
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;

  const refused: [string, unknown][] = [
    ["an array", ["F-1029"]],
    ["a string", "F-1029"],
    ["a class instance", new Invoice("F-1029")],
    ["a Date", new Date()],
    ["a nested Date", { when: new Date() }],
    ["a nested Map", { lines: new Map() }],
    ["NaN", { qty: Number.NaN }],
    ["Infinity", { qty: Number.POSITIVE_INFINITY }],
    ["a function", { cb: () => 1 }],
    ["a bigint", { id: 10n }],
    ["a symbol", { tag: Symbol("x") }],
    ["undefined inside an array", { lines: [1, undefined] }],
    ["a cycle", cyclic],
    ["a secret: name", { "secret:password": "hunter2" }],
    ["a file: name", { "file:invoice": "f_1" }],
    ["persona_id", { persona_id: 3 }],
    ["function_name", { function_name: "other" }],
    ["auth_policy", { auth_policy: "none" }],
    ["more than 1 MB", { blob: "x".repeat(MAX_INPUT_BYTES) }],
  ];

  it.each(refused)("refuses %s with INPUT_INVALID before sending", async (_label, inputs) => {
    const { provider, session } = await connected();
    const call = session.call("pos.receive", inputs as object);
    const onError = vi.fn();
    call.on("error", onError);
    await expect(call.result).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(call.callId).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(provider.sent("writ_call")).toEqual([]);
  });

  it("counts the 1 MB limit in UTF-8 bytes", async () => {
    const { provider, session } = await connected();
    // 400 000 three-byte characters: 1.2 MB as UTF-8, 400 000 as string length.
    const call = session.call("pos.receive", { note: String.fromCharCode(0x20ac).repeat(400_000) });
    await expect(call.result).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(provider.sent("writ_call")).toEqual([]);
  });

  it("sends a clean JSON copy: undefined dropped, nesting kept, __proto__ kept as data", async () => {
    const { provider, session } = await connected();
    const inputs = {
      invoice_no: "F-1029",
      note: undefined,
      lines: [{ sku: "A1", qty: 2, extra: null }],
      ...(JSON.parse('{"__proto__": {"x": 1}}') as object),
    };
    const call = session.call("pos.receive", inputs);
    const outcome = call.result.catch((e: unknown) => e);
    await call.callId;
    const sent = provider.sent("writ_call")[0] as { inputs: Record<string, unknown> };
    expect(sent.inputs).not.toBe(inputs);
    expect(Object.keys(sent.inputs)).toEqual(["invoice_no", "lines", "__proto__"]);
    expect(sent.inputs.lines).toEqual([{ sku: "A1", qty: 2, extra: null }]);
    expect(Object.getPrototypeOf(sent.inputs)).toBe(Object.prototype);
    await call.cancel();
    expect(isWritError(await outcome, "CANCELLED")).toBe(true);
  });

  const badRequests: [string, unknown, unknown][] = [
    ["an uppercase key", "POS.receive", undefined],
    ["an empty key", "", undefined],
    ["a 65-character key", "a".repeat(65), undefined],
    ["a negative timeout", "pos.receive", { timeoutMs: -5 }],
    ["a NaN timeout", "pos.receive", { timeoutMs: Number.NaN }],
    ["a non-boolean dryRun", "pos.receive", { dryRun: "yes" }],
    ["a fake signal", "pos.receive", { signal: { aborted: false } }],
  ];

  it.each(badRequests)("refuses %s with BAD_REQUEST before sending", async (_label, key, options) => {
    const { provider, session } = await connected();
    const call = session.call(key as string, {}, options as never);
    await expect(call.result).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(provider.sent("writ_call")).toEqual([]);
  });

  it("lets an error listener attached right after call() hear a validation failure", async () => {
    const { session } = await connected();
    const errors: string[] = [];
    session.call("pos.receive", [] as never).on("error", (error) => errors.push(error.code));
    await flush();
    expect(errors).toEqual(["INPUT_INVALID"]);
  });
});

describe("several calls", () => {
  it("routes each call's events to its own handle", async () => {
    const provider = new FakeProvider();
    const { session } = await connected(provider);
    const first = session.call<string>("pos.receive", { invoice_no: "A" });
    const second = session.call<string>("pos.receive", { invoice_no: "B" });
    const [a, b] = await Promise.all([first.callId, second.callId]);
    expect(a).not.toBe(b);

    provider.emit({ call_id: b, type: "finished", run_id: 2, data: "second", duration_ms: 1, engine: "http" });
    provider.emit({ call_id: a, type: "finished", run_id: 1, data: "first", duration_ms: 1, engine: "http" });

    await expect(first.result).resolves.toMatchObject({ data: "first", runId: 1 });
    await expect(second.result).resolves.toMatchObject({ data: "second", runId: 2 });
    expect(provider.listenerCount).toBe(0);
  });
});
