/** Where a call runs, per mode (WRIT_BRIDGE_DESIGN.md §2, §3). */

import { describe, expect, it } from "vitest";

import { isWritBridgeError } from "../src/index.js";
import { clock, contract, fakePage, jsonResponse, mockFetch, rejectionOf, testBridge } from "./fixtures.js";

/** Writ Cloud answering every run with `data`. */
function cloud(data: unknown) {
  return mockFetch((url) =>
    url.endsWith("/run")
      ? jsonResponse(200, { task_id: 9, status: "queued" })
      : jsonResponse(200, { status: "success", success: true, extracted_data: data }),
  );
}

describe("required", () => {
  const inputs = { company: "acme", username: "zoe" };

  it("WRIT_REQUIRED for a user who never connected", async () => {
    const error = await rejectionOf(testBridge().user("u1").auth.verify_login(inputs));
    expect(isWritBridgeError(error, "WRIT_REQUIRED")).toBe(true);
  });

  it("WRIT_REQUIRED for a connected page whose Writ is not ready", async () => {
    const bridge = testBridge();
    await fakePage(bridge, bridge.userToken("u1")).hello({ ready: false, granted: [] });
    expect(isWritBridgeError(await rejectionOf(bridge.user("u1").auth.verify_login(inputs)), "WRIT_REQUIRED")).toBe(true);
  });

  it("NOT_GRANTED when Writ is ready but the function is not granted", async () => {
    const bridge = testBridge();
    await fakePage(bridge, bridge.userToken("u1")).hello({ ready: true, granted: ["pos.receive"] });
    expect(isWritBridgeError(await rejectionOf(bridge.user("u1").auth.verify_login(inputs)), "NOT_GRANTED")).toBe(true);
  });

  it("USER_OFFLINE once a ready user's pages stop for 90 s", async () => {
    const time = clock();
    const bridge = testBridge({}, time);
    await fakePage(bridge, bridge.userToken("u1", { ttlSeconds: 3_600 })).hello({ ready: true, granted: ["auth.verify_login"] });
    time.advance(91_000);
    expect(isWritBridgeError(await rejectionOf(bridge.user("u1").auth.verify_login(inputs)), "USER_OFFLINE")).toBe(true);
  });

  it("runs on the user's computer when ready and granted", async () => {
    const bridge = testBridge();
    const page = fakePage(bridge, bridge.userToken("u1"));
    await page.hello({ ready: true, granted: ["auth.verify_login"] });
    const call = bridge.user("u1").auth.verify_login(inputs);
    await page.answer(await page.nextCommand(), { ok: true, user: "zoe" });
    await expect(call).resolves.toMatchObject({ venue: "user", data: { ok: true, user: "zoe" } });
  });

  it("waits up to waitForUserMs for the user to connect", async () => {
    const bridge = testBridge();
    const page = fakePage(bridge, bridge.userToken("u1"));
    const call = bridge.user("u1").auth.verify_login(inputs, { waitForUserMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.hello({ ready: true, granted: ["auth.verify_login"] });
    await page.answer(await page.nextCommand(), { ok: true, user: "zoe" });
    await expect(call).resolves.toMatchObject({ venue: "user" });
  });

  it("gives up after waitForUserMs", async () => {
    const started = Date.now();
    const error = await rejectionOf(testBridge().user("u1").auth.verify_login(inputs, { waitForUserMs: 600 }));
    expect(isWritBridgeError(error, "WRIT_REQUIRED")).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  });

  it("a function reaching the local network is required even on a recommended bridge", async () => {
    const double = cloud({ received: true });
    // Every other function of this contract has a Writ Cloud mapping, as a recommended bridge needs.
    const mapped = contract();
    mapped.functions = mapped.functions.filter((fn) => fn.key === "pos.receive" || fn.cloud !== undefined);
    const bridge = testBridge({ mode: "recommended", fetch: double.fetch, contract: mapped });
    expect(bridge.modeOf("pos.receive")).toBe("required");
    expect(isWritBridgeError(await rejectionOf(bridge.user("u1").pos.receive({ invoice_no: "F-1" })), "WRIT_REQUIRED")).toBe(true);
    expect(double.calls).toHaveLength(0);
  });

  it("a function reaching a lan_host setting is required too, and can't be sent to Writ Cloud", async () => {
    // No local_network in the contract: the address is each visitor's own setting.
    const viaSetting = contract();
    viaSetting.functions = viaSetting.functions
      .filter((fn) => fn.key === "pos.receive" || fn.cloud !== undefined)
      .map((fn) => (fn.key === "pos.receive" ? { ...fn, local_network: [], settings: [{ key: "pos_host", label: "Your POS address", kind: "lan_host" as const }] } : fn));
    const double = cloud({ received: true });
    const bridge = testBridge({ mode: "recommended", fetch: double.fetch, contract: viaSetting });
    expect(bridge.modeOf("pos.receive")).toBe("required");
    expect(double.calls).toHaveLength(0);
    const forced = { ...viaSetting, functions: viaSetting.functions.map((fn) => (fn.key === "pos.receive" ? { ...fn, mode: "cloud" as const, cloud: { workflow_id: 9, function: null } } : fn)) };
    expect(() => testBridge({ contract: forced })).toThrow(/\{\{pos_host\}\}/);
  });

  it("TIMEOUT when the page takes the command and never answers", async () => {
    const bridge = testBridge();
    const page = fakePage(bridge, bridge.userToken("u1"));
    await page.hello({ ready: true, granted: ["auth.verify_login"] });
    const call = bridge.user("u1").auth.verify_login(inputs, { timeoutMs: 1_000 });
    await page.nextCommand();
    expect(isWritBridgeError(await rejectionOf(call), "TIMEOUT")).toBe(true);
  }, 20_000);
});

describe("recommended", () => {
  it("runs on the user's computer when it can", async () => {
    const double = cloud({ orders: 1 });
    const bridge = testBridge({ fetch: double.fetch });
    const page = fakePage(bridge, bridge.userToken("u1"));
    await page.hello({ ready: true, granted: ["orders.list"] });
    const call = bridge.user("u1").orders.list({ status: "open" });
    const command = await page.nextCommand();
    expect(command.key).toBe("orders.list");
    await page.answer(command, { orders: 2 }, { package: "app.orders", function: "list_orders" });
    await expect(call).resolves.toMatchObject({ venue: "user", data: { orders: 2 } });
    expect(double.calls).toHaveLength(0);
  });

  it("runs on Writ Cloud when the user is offline", async () => {
    const double = cloud({ orders: 7 });
    const bridge = testBridge({ fetch: double.fetch });
    await expect(bridge.user("u1").orders.list({})).resolves.toEqual({ data: { orders: 7 }, venue: "cloud" });
    expect(double.calls[0]?.url).toBe("https://cloud.test/api/automation/workflows/12/run");
  });

  it("runs on Writ Cloud when the page says the function is not granted after all", async () => {
    const double = cloud({ orders: 5 });
    const bridge = testBridge({ fetch: double.fetch });
    const page = fakePage(bridge, bridge.userToken("u1"));
    await page.hello({ ready: true, granted: ["orders.list"] });
    const call = bridge.user("u1").orders.list({});
    const command = await page.nextCommand();
    await page.post({ result: { id: command.id, ok: false, error: { code: "NOT_GRANTED", message: "Not granted." } } });
    await expect(call).resolves.toEqual({ data: { orders: 5 }, venue: "cloud" });
  });

  it("runs on Writ Cloud when the user's page went away without taking the command", async () => {
    const double = cloud({ orders: 4 });
    const bridge = testBridge({ fetch: double.fetch });
    await fakePage(bridge, bridge.userToken("u1")).hello({ ready: true, granted: ["orders.list"] });
    // Nobody polls: after the pickup window (timeout + grace here), the command is withdrawn.
    await expect(bridge.user("u1").orders.list({}, { timeoutMs: 1_000 })).resolves.toEqual({ data: { orders: 4 }, venue: "cloud" });
  }, 20_000);
});

describe("cloud", () => {
  it("always runs on Writ Cloud, even for a ready user", async () => {
    const double = cloud({ url: "https://files.example/report.csv" });
    const bridge = testBridge({ fetch: double.fetch });
    await fakePage(bridge, bridge.userToken("u1")).hello({ ready: true, granted: ["reports.export"] });
    await expect(bridge.user("u1").reports.export({ month: "2026-09" })).resolves.toEqual({
      data: { url: "https://files.example/report.csv" },
      venue: "cloud",
    });
    expect(double.calls[0]).toMatchObject({ url: "https://cloud.test/api/automation/workflows/13/run", body: { form_data: { month: "2026-09" } } });
    expect((double.calls[0]?.body as Record<string, unknown>).function_name).toBeUndefined();
  });
});

describe("calls without a user", () => {
  it("run recommended and cloud functions on Writ Cloud", async () => {
    const double = cloud({ orders: 3 });
    const bridge = testBridge({ fetch: double.fetch });
    await expect(bridge.orders.list()).resolves.toEqual({ data: { orders: 3 }, venue: "cloud" });
    await expect(bridge.reports.export({ month: "2026-09" })).resolves.toMatchObject({ venue: "cloud" });
  });

  it("refuse required functions with WRIT_REQUIRED", async () => {
    const bridge = testBridge();
    expect(isWritBridgeError(await rejectionOf(bridge.auth.verify_login({ company: "a", username: "b" })), "WRIT_REQUIRED")).toBe(true);
    expect(isWritBridgeError(await rejectionOf(bridge.pos.receive({ invoice_no: "F-1" })), "WRIT_REQUIRED")).toBe(true);
  });

  it("pass dryRun to Writ Cloud as mutation_mode", async () => {
    const double = cloud({ orders: 0 });
    const bridge = testBridge({ fetch: double.fetch });
    await bridge.orders.list({}, { dryRun: true });
    expect(double.calls[0]?.body).toMatchObject({ mutation_mode: "dry_run" });
  });
});

describe("dryRun on the user's computer", () => {
  it("reaches the page as options.dry_run", async () => {
    const bridge = testBridge();
    const page = fakePage(bridge, bridge.userToken("u1"));
    await page.hello({ ready: true, granted: ["pos.receive"] });
    const call = bridge.user("u1").pos.receive({ invoice_no: "F-1" }, { dryRun: true, timeoutMs: 5_000 });
    const command = await page.nextCommand();
    expect(command.options).toEqual({ timeout_ms: 5_000, dry_run: true });
    await page.answer(command, { received: false, lines: 0 }, { package: "app.pos", function: "receive" });
    await expect(call).resolves.toMatchObject({ venue: "user" });
  });
});
