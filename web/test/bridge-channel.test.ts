/**
 * The Writ Bridge page channel (CONTRACT.md §12.3): hello, the long poll, commands run on the
 * visitor's computer with the server's challenge, results with their receipts, NOT_GRANTED for
 * keys the visitor did not grant, the per-tab limit, backoff, pause while hidden, and stop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WritContract } from "../src/index.js";
import {
  PORTAL_KEYS,
  finishCall,
  makeReceipt,
  settle,
  setupBridge,
} from "./bridge-helpers.js";
import { ENDPOINT_URL } from "./fake-server.js";
import type { FakeProvider } from "./fake-provider.js";
import { bridgeContract } from "./fixtures.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const TOKEN = "eyJzdWIiOiJ1c2VyLTQyIn0.c2lnbmF0dXJl";
const LOGIN = { company: "ACME", username: "ana" };

function command(id: string, key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    key,
    inputs: {},
    options: {},
    challenge: null,
    expires_at: Math.floor(Date.now() / 1_000) + 120,
    ...extra,
  };
}

/** A bridge whose visitor is set up, polling. */
async function polling(overrides: Parameters<typeof setupBridge>[0] = {}) {
  const setup = setupBridge({ userToken: TOKEN, granted: PORTAL_KEYS, ...overrides });
  await settle();
  return { ...setup, provider: setup.provider as FakeProvider };
}

describe("page channel: hello and the long poll", () => {
  it("says hello at start, then ready with the granted keys and Writ version, and long-polls", async () => {
    const { win, bridge } = await polling();
    expect(win.server.hellos[0]).toEqual({ ready: false, granted: [], writ_version: null });
    expect(win.server.hellos.at(-1)).toEqual({
      ready: true,
      granted: ["auth.verify_login", "orders.list"],
      writ_version: "1.0.7",
    });
    const hello = win.server.requests.find((request) => request.body !== undefined && "hello" in request.body);
    expect(hello).toMatchObject({
      method: "POST",
      url: ENDPOINT_URL,
      headers: { Authorization: `Writ ${TOKEN}`, "Content-Type": "application/json" },
    });

    expect(win.server.gets).toHaveLength(1);
    expect(win.server.gets[0]).toMatchObject({ url: `${ENDPOINT_URL}?wait=25`, headers: { Authorization: `Writ ${TOKEN}` } });
    expect(win.server.pendingPolls).toBe(1);
    expect(bridge.status().channel).toBe("polling");
  });

  it("does not poll while the visitor's Writ is not ready", async () => {
    const { win, bridge } = setupBridge({ userToken: TOKEN });
    await settle();
    expect(win.server.hellos).toEqual([{ ready: false, granted: [], writ_version: null }]);
    expect(win.server.gets).toEqual([]);
    expect(bridge.status().channel).toBe("idle");
  });

  it("re-sends hello every 60 s while polling, and polls again after each answer", async () => {
    const { win } = await polling();
    const hellos = win.server.hellos.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(win.server.hellos.length).toBe(hellos + 1);
    // The server held each poll 25 s and answered nothing: the page polled again each time.
    expect(win.server.gets.length).toBe(3);
    expect(win.server.pendingPolls).toBe(1);
  });

  it("has no channel without a user token", async () => {
    const { win, bridge } = setupBridge({ granted: PORTAL_KEYS });
    await settle();
    expect(win.server.requests).toEqual([]);
    expect(bridge.status().channel).toBe("off");
  });
});

describe("page channel: commands", () => {
  it("runs a granted command locally with the server's challenge, and posts the data and receipt", async () => {
    const { win, provider } = await polling();
    win.server.sendCommands([
      command("cmd-1", "auth.verify_login", { inputs: LOGIN, options: { timeout_ms: 20_000 }, challenge: "srv.challenge" }),
    ]);
    await settle();
    expect(provider.sent("writ_call")).toEqual([
      { key: "auth.verify_login", inputs: LOGIN, timeout_ms: 20_000, challenge: "srv.challenge" },
    ]);
    // Still listening for the next command while this one runs.
    expect(win.server.pendingPolls).toBe(1);

    const signed = makeReceipt({ challenge: "srv.challenge" });
    finishCall(provider, "call-1", { ok: true }, signed);
    await settle();
    expect(win.server.results).toEqual([{ id: "cmd-1", ok: true, data: { ok: true }, receipt: signed }]);
    const posted = win.server.requests.find((request) => request.body !== undefined && "result" in request.body);
    expect(posted?.headers).toMatchObject({ Authorization: `Writ ${TOKEN}` });
  });

  it("posts a failed run with its error and receipt", async () => {
    const { win, provider } = await polling();
    win.server.sendCommands([command("cmd-1", "orders.list", { challenge: "srv.challenge" })]);
    await settle();
    const failed = makeReceipt({ key: "orders.list", challenge: "srv.challenge", outcome: "failed", error_code: "RUN_FAILED", data_hash: null });
    provider.emit({ call_id: "call-1", type: "error", code: "RUN_FAILED", message: "The run failed.", receipt: failed });
    await settle();
    expect(win.server.results).toEqual([
      { id: "cmd-1", ok: false, error: { code: "RUN_FAILED", message: "The run failed." }, receipt: failed },
    ]);
  });

  it("answers NOT_GRANTED for a key the visitor did not grant, without running it", async () => {
    const contract: WritContract = bridgeContract();
    const orders = contract.functions.find((fn) => fn.key === "orders.list");
    if (orders !== undefined) orders.mode = "cloud";
    const { win, provider } = await polling({ contract, granted: ["auth.verify_login"] });
    expect(win.server.hellos.at(-1)).toMatchObject({ ready: true, granted: ["auth.verify_login"] });

    win.server.sendCommands([command("cmd-1", "orders.list"), command("cmd-2", "pos.void")]);
    await settle();
    expect(provider.sent("writ_call")).toEqual([]);
    expect(win.server.results).toEqual([
      { id: "cmd-1", ok: false, error: { code: "NOT_GRANTED", message: expect.stringContaining("orders.list") as unknown } },
      { id: "cmd-2", ok: false, error: { code: "NOT_GRANTED", message: expect.stringContaining("pos.void") as unknown } },
    ]);
  });

  it("refuses bad inputs, expired and malformed commands, and never runs a command twice", async () => {
    const { win, provider } = await polling();
    win.server.sendCommands([
      command("cmd-1", "auth.verify_login", { inputs: { company: "ACME" } }),
      command("cmd-2", "orders.list", { expires_at: Math.floor(Date.now() / 1_000) - 1 }),
      command("cmd-3", "orders.list", { options: "fast" }),
      { key: "orders.list" },
      command("cmd-4", "orders.list"),
    ]);
    await settle();
    win.server.sendCommands([command("cmd-4", "orders.list")]);
    await settle();

    expect(provider.sent("writ_call")).toEqual([{ key: "orders.list", inputs: {} }]);
    const byId = new Map(win.server.results.map((result) => [result.id, result]));
    expect(byId.get("cmd-1")).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
    expect(byId.get("cmd-2")).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(byId.get("cmd-3")).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    expect(byId.has("cmd-4")).toBe(false);
  });

  it("runs at most 4 local calls at once per tab and queues the rest, the page's own calls included", async () => {
    const { win, provider, bridge } = await polling();
    win.server.sendCommands(Array.from({ length: 5 }, (_, index) => command(`cmd-${index}`, "orders.list")));
    await settle();
    expect(provider.sent("writ_call")).toHaveLength(4);

    const own = bridge.orders.list();
    await settle();
    expect(provider.sent("writ_call")).toHaveLength(4);

    finishCall(provider, "call-1", { orders: ["a"] });
    await settle();
    expect(provider.sent("writ_call")).toHaveLength(5);
    expect(win.server.results).toEqual([{ id: "cmd-0", ok: true, data: { orders: ["a"] }, receipt: null }]);

    finishCall(provider, "call-2", { orders: ["b"] });
    await settle();
    expect(provider.sent("writ_call")).toHaveLength(6);
    finishCall(provider, "call-6", { orders: ["mine"] });
    await expect(own).resolves.toMatchObject({ data: { orders: ["mine"] }, venue: "user" });
  });

  it("retries posting a result after a network failure", async () => {
    const { win, provider } = await polling();
    win.server.sendCommands([command("cmd-1", "orders.list")]);
    await settle();
    win.server.resultStatus = 502;
    finishCall(provider, "call-1", { orders: [] });
    await settle();
    expect(win.server.results).toHaveLength(1);
    win.server.resultStatus = 204;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(win.server.results).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(win.server.results).toHaveLength(2);
  });
});

describe("page channel: failures, visibility and stop", () => {
  it("backs off from 1 s to 30 s on network errors, then recovers", async () => {
    const { win, bridge } = setupBridge({ userToken: TOKEN, granted: PORTAL_KEYS });
    win.server.pollsFail = true;
    await settle();
    expect(win.server.gets).toHaveLength(1);
    expect(bridge.status().channel).toBe("retrying");

    for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) await vi.advanceTimersByTimeAsync(wait);
    const times = win.server.gets.map((request) => request.at);
    const gaps = times.slice(1).map((at, index) => at - (times[index] as number));
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);

    win.server.pollsFail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(win.server.pendingPolls).toBe(1);
    win.server.sendCommands([]);
    await settle();
    expect(bridge.status().channel).toBe("polling");
  });

  it("stops for good when the server refuses the user token", async () => {
    const { win, bridge } = setupBridge({ userToken: TOKEN, granted: PORTAL_KEYS });
    win.server.pollStatus = 401;
    await settle();
    expect(bridge.status().channel).toBe("unauthorized");
    const requests = win.server.requests.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(win.server.requests.length).toBe(requests);
  });

  it("pauses after 5 minutes hidden and resumes when shown", async () => {
    const { win, bridge } = await polling();
    win.setHidden(true);
    await vi.advanceTimersByTimeAsync(299_000);
    expect(bridge.status().channel).toBe("polling");
    expect(win.server.pendingPolls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(bridge.status().channel).toBe("paused");
    expect(win.server.pendingPolls).toBe(0);
    const gets = win.server.gets.length;
    const hellos = win.server.hellos.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(win.server.gets.length).toBe(gets);
    expect(win.server.hellos.length).toBe(hellos);

    win.setHidden(false);
    await settle();
    expect(bridge.status().channel).toBe("polling");
    expect(win.server.pendingPolls).toBe(1);
    expect(win.server.gets.length).toBe(gets + 1);
    expect(win.server.hellos.length).toBe(hellos + 1);
  });

  it("keeps polling when the page is shown again within 5 minutes", async () => {
    const { win, bridge } = await polling();
    win.setHidden(true);
    await vi.advanceTimersByTimeAsync(200_000);
    win.setHidden(false);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(bridge.status().channel).toBe("polling");
    expect(win.server.pendingPolls).toBe(1);
  });

  it("destroy(): stops polling and tells the server its running commands were cancelled", async () => {
    const { win, provider, bridge } = await polling();
    win.server.sendCommands([command("cmd-1", "orders.list")]);
    await settle();
    expect(provider.sent("writ_call")).toHaveLength(1);

    bridge.destroy();
    await settle();
    expect(bridge.status().channel).toBe("stopped");
    expect(win.server.pendingPolls).toBe(0);
    expect(provider.sent("writ_cancel")).toEqual([{ call_id: "call-1" }]);
    const last = win.server.requests.at(-1);
    expect(last?.keepalive).toBe(true);
    expect(win.server.results).toEqual([{ id: "cmd-1", ok: false, error: { code: "CANCELLED", message: expect.any(String) as unknown } }]);

    const requests = win.server.requests.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(win.server.requests.length).toBe(requests);
  });
});
