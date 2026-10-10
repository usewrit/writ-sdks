/** The page channel (CONTRACT.md §12.3) through bridge.handler. */

import { describe, expect, it } from "vitest";

import { isWritBridgeError, mintUserToken, type WritBridgeOptions, type WritCommand } from "../src/index.js";
import {
  ENDPOINT,
  OTHER_SEED_HEX,
  SECRET,
  T0,
  clock,
  contract,
  fakePage,
  jsonResponse,
  makeReceipt,
  mockFetch,
  rejectionOf,
  testBridge,
} from "./fixtures.js";

/** The token with its last character changed (to another valid base64url ending). */
function tampered(token: string): string {
  return `${token.slice(0, -1)}${token.endsWith("A") ? "E" : "A"}`;
}

async function errorBody(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return body.error;
}

describe("authentication", () => {
  const bridge = testBridge();

  it.each<[string, Record<string, string>]>([
    ["no header", {}],
    ["another scheme", { authorization: `Bearer ${bridge.userToken("u1")}` }],
    ["a tampered token", { authorization: `Writ ${tampered(bridge.userToken("u1"))}` }],
    ["a token from another secret", { authorization: `Writ ${mintUserToken("another-secret-of-at-least-32-bytes!!", "u1", Math.floor(T0 / 1000) + 60)}` }],
    ["a challenge", { authorization: `Writ ${bridge.challenge({ subject: "u1", key: "auth.verify_login" })}` }],
  ])("answers 401 to %s", async (_name, headers) => {
    const response = await bridge.handler(new Request(`${ENDPOINT}?wait=0`, { headers }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Writ");
    expect((await errorBody(response)).code).toBe("NOT_GRANTED");
  });

  it("answers 401 to an expired token", async () => {
    const time = clock();
    const timed = testBridge({}, time);
    const token = timed.userToken("u1", { ttlSeconds: 60 });
    time.advance(60_000);
    const response = await fakePage(timed, token).poll(0);
    expect(response.status).toBe(401);
  });

  it("accepts the scheme in any case", async () => {
    const response = await bridge.handler(new Request(`${ENDPOINT}?wait=0`, { headers: { authorization: `writ ${bridge.userToken("u1")}` } }));
    expect(response.status).toBe(200);
  });

  it("answers 405 to other methods", async () => {
    const response = await bridge.handler(new Request(ENDPOINT, { method: "PUT", headers: { authorization: `Writ ${bridge.userToken("u1")}` } }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });
});

describe("hello and polling", () => {
  it("records readiness per user and reports it through online()", async () => {
    const time = clock();
    const bridge = testBridge({}, time);
    const page = fakePage(bridge, bridge.userToken("u1"));
    expect(await bridge.online("u1")).toBe(false);

    const response = await page.hello({ ready: true, granted: ["auth.verify_login", "not.in.contract"] });
    expect(response.status).toBe(204);
    expect(await bridge.online("u1")).toBe(true);
    expect(await bridge.online("u2")).toBe(false);

    time.advance(89_000);
    expect(await bridge.online("u1")).toBe(true);
    time.advance(2_000);
    expect(await bridge.online("u1")).toBe(false);

    // A poll keeps the page connected.
    expect((await page.poll(0)).status).toBe(200);
    expect(await bridge.online("u1")).toBe(true);
  });

  it("a page whose Writ is not ready is connected but not online", async () => {
    const bridge = testBridge();
    const page = fakePage(bridge, bridge.userToken("u1"));
    await page.hello({ ready: false, granted: [] });
    expect(await bridge.online("u1")).toBe(false);
  });

  it("answers an empty list when nothing is queued", async () => {
    const bridge = testBridge();
    const response = await fakePage(bridge, bridge.userToken("u1")).poll(0);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ commands: [] });
  });

  it("long-polls until a command arrives", async () => {
    const bridge = testBridge();
    const page = fakePage(bridge, bridge.userToken("u1"));
    await page.hello({ ready: true, granted: ["auth.verify_login"] });
    const polling = page.poll(5);
    const call = bridge.user("u1").auth.verify_login({ company: "acme", username: "zoe" }, { timeoutMs: 30_000 });
    const response = await polling;
    const { commands } = (await response.json()) as { commands: WritCommand[] };
    expect(commands).toHaveLength(1);
    const command = commands[0] as WritCommand;
    expect(command).toMatchObject({ key: "auth.verify_login", inputs: { company: "acme", username: "zoe" }, options: { timeout_ms: 30_000 } });
    expect(command.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(command.expires_at).toBe(Math.ceil((T0 + 30_000) / 1000));
    await page.answer(command, { ok: true, user: "zoe" });
    await expect(call).resolves.toMatchObject({ venue: "user", data: { ok: true, user: "zoe" } });
  });

  it("caps the wait at pollSeconds and refuses a malformed one", async () => {
    const bridge = testBridge({ pollSeconds: 1 });
    const page = fakePage(bridge, bridge.userToken("u1"));
    const started = Date.now();
    expect((await page.poll(30)).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await page.poll("soon")).status).toBe(400);
  });

  it("refuses malformed bodies", async () => {
    const bridge = testBridge();
    const page = fakePage(bridge, bridge.userToken("u1"));
    const token = bridge.userToken("u1");
    const raw = await bridge.handler(new Request(ENDPOINT, { method: "POST", headers: { authorization: `Writ ${token}` }, body: "{not json" }));
    expect(raw.status).toBe(400);
    expect((await page.post({ hello: { ready: true, granted: [] }, run: { key: "orders.list" } })).status).toBe(400);
    expect((await page.post({ other: 1 })).status).toBe(400);
    expect((await page.post({ hello: { ready: "yes", granted: [] } })).status).toBe(400);
    expect((await page.post({ hello: { ready: true, granted: "auth.verify_login" } })).status).toBe(400);
  });

  it("answers 413 to a body over the limit", async () => {
    const bridge = testBridge({ maxBodyBytes: 1_024 });
    const page = fakePage(bridge, bridge.userToken("u1"));
    const response = await page.post({ hello: { ready: true, granted: ["x".repeat(2_000)] } });
    expect(response.status).toBe(413);
  });
});

describe("results", () => {
  /** A bridge, a ready user page, a call in flight and the command it produced. */
  async function inFlight(overrides: Partial<WritBridgeOptions> = {}) {
    const bridge = testBridge(overrides);
    const page = fakePage(bridge, bridge.userToken("u1"));
    await page.hello({ ready: true, granted: ["auth.verify_login"] });
    const call = bridge.user("u1").auth.verify_login({ company: "acme", username: "zoe" }, { timeoutMs: 30_000 });
    // Marked handled now: some tests expect it to reject while they are still posting the result.
    call.catch(() => undefined);
    const command = await page.nextCommand();
    return { bridge, page, call, command };
  }

  const data = { ok: true, user: "Zoé", n: 3 };

  it("resolves the call with the data and its verified receipt", async () => {
    const { page, call, command } = await inFlight();
    expect((await page.answer(command, data)).status).toBe(204);
    const result = await call;
    expect(result.venue).toBe("user");
    expect(result.data).toEqual(data);
    expect(result.receipt?.challenge).toBe(command.challenge);
  });

  it("refuses a second result for the same command", async () => {
    const { page, call, command } = await inFlight();
    await page.answer(command, data);
    await call;
    expect((await page.answer(command, data)).status).toBe(404);
  });

  type Forgery = [string, (command: WritCommand) => unknown];
  const forgeries: Forgery[] = [
    ["no receipt", (command) => ({ id: command.id, ok: true, data })],
    [
      "an unsigned receipt",
      (command) => {
        const { sig: _sig, ...unsigned } = makeReceipt({ key: command.key, challenge: command.challenge, inputs: command.inputs, data });
        return { id: command.id, ok: true, data, receipt: unsigned };
      },
    ],
    [
      "a forged signature",
      (command) => ({ id: command.id, ok: true, data, receipt: { ...makeReceipt({ key: command.key, challenge: command.challenge, inputs: command.inputs, data }), run_id: 99 } }),
    ],
    ["altered data", (command) => ({ id: command.id, ok: true, data: { ...data, n: 4 }, receipt: makeReceipt({ key: command.key, challenge: command.challenge, inputs: command.inputs, data }) })],
    ["no data", (command) => ({ id: command.id, ok: true, receipt: makeReceipt({ key: command.key, challenge: command.challenge, inputs: command.inputs, data }) })],
    ["another challenge", (command) => ({ id: command.id, ok: true, data, receipt: makeReceipt({ key: command.key, challenge: `${command.challenge}x`, data }) })],
    ["a challenge-less receipt", (command) => ({ id: command.id, ok: true, data, receipt: makeReceipt({ key: command.key, challenge: null, data }) })],
    ["another key", (command) => ({ id: command.id, ok: true, data, receipt: makeReceipt({ key: "orders.list", challenge: command.challenge, inputs: command.inputs, data }) })],
    [
      "a failed outcome posted as success",
      (command) => ({ id: command.id, ok: true, data, receipt: makeReceipt({ key: command.key, challenge: command.challenge, inputs: command.inputs, outcome: "failed", error_code: "RUN_FAILED" }) }),
    ],
    [
      "an error with a forged receipt",
      (command) => ({
        id: command.id,
        ok: false,
        error: { code: "RUN_FAILED", message: "nope" },
        receipt: { ...makeReceipt({ key: command.key, challenge: command.challenge, inputs: command.inputs, outcome: "failed", error_code: "RUN_FAILED" }), run_id: 1 },
      }),
    ],
  ];

  for (const [name, forge] of forgeries) {
    it(`answers RESULT_UNVERIFIED for ${name}`, async () => {
      const { page, call, command } = await inFlight();
      expect((await page.post({ result: forge(command) })).status).toBe(204);
      const error = await rejectionOf(call);
      expect(isWritBridgeError(error, "RESULT_UNVERIFIED")).toBe(true);
    });
  }

  it("refuses a receipt replayed from another command", async () => {
    const bridge = testBridge();
    const page = fakePage(bridge, bridge.userToken("u1"));
    await page.hello({ ready: true, granted: ["auth.verify_login"] });
    const first = bridge.user("u1").auth.verify_login({ company: "acme", username: "zoe" });
    const firstCommand = await page.nextCommand();
    const receipt = makeReceipt({ key: firstCommand.key, challenge: firstCommand.challenge, inputs: firstCommand.inputs, data });
    await page.post({ result: { id: firstCommand.id, ok: true, data, receipt } });
    await first;

    const second = bridge.user("u1").auth.verify_login({ company: "acme", username: "zoe" });
    second.catch(() => undefined);
    const secondCommand = await page.nextCommand();
    await page.post({ result: { id: secondCommand.id, ok: true, data, receipt } });
    expect(isWritBridgeError(await rejectionOf(second), "RESULT_UNVERIFIED")).toBe(true);
  });

  it("pins the first device under first-use and hands back another one to approve", async () => {
    const { bridge, page, call, command } = await inFlight();
    await page.answer(command, data);
    await expect(call).resolves.toMatchObject({ venue: "user" });

    const second = bridge.user("u1").auth.verify_login({ company: "acme", username: "zoe" });
    second.catch(() => undefined);
    const next = await page.nextCommand();
    const foreign = makeReceipt({ key: "auth.verify_login", challenge: next.challenge, inputs: next.inputs, data }, OTHER_SEED_HEX);
    await page.post({ result: { id: next.id, ok: true, data, receipt: foreign } });
    const error = await rejectionOf(second);
    expect(isWritBridgeError(error, "RESULT_UNVERIFIED")).toBe(true);
    expect((error as { details?: Record<string, unknown> }).details).toMatchObject({ unknownDevice: true, device: foreign.device });
  });

  it("refuses a device the developer did not pin", async () => {
    const { page, call, command } = await inFlight({ pinDevices: () => false });
    await page.answer(command, data);
    expect(isWritBridgeError(await rejectionOf(call), "RESULT_UNVERIFIED")).toBe(true);
  });

  it("accepts a pinned device", async () => {
    const seen: string[] = [];
    const { page, call, command } = await inFlight({
      pinDevices: (user: string, device: { kid: string }) => {
        seen.push(`${user}:${device.kid}`);
        return true;
      },
    });
    await page.answer(command, data);
    await expect(call).resolves.toMatchObject({ venue: "user" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^u1:[0-9a-f]{16}$/);
  });

  it("ignores a result posted by another user", async () => {
    const { bridge, page, call, command } = await inFlight();
    const intruder = fakePage(bridge, bridge.userToken("u2"));
    expect((await intruder.answer(command, { ok: true, user: "mallory" })).status).toBe(404);
    await page.answer(command, data);
    await expect(call).resolves.toMatchObject({ data });
  });

  it("passes the visitor's error through, with its receipt", async () => {
    const { page, call, command } = await inFlight();
    const receipt = makeReceipt({ key: command.key, challenge: command.challenge, inputs: command.inputs, outcome: "failed", error_code: "LAN_NOT_ALLOWED" }, OTHER_SEED_HEX);
    await page.post({ result: { id: command.id, ok: false, error: { code: "LAN_NOT_ALLOWED", message: "Approve the POS in Writ." }, receipt } });
    const error = await rejectionOf(call);
    expect(isWritBridgeError(error, "LAN_NOT_ALLOWED")).toBe(true);
    expect((error as Error).message).toBe("Approve the POS in Writ.");
    expect((error as { details?: { receipt?: unknown } }).details?.receipt).toEqual(receipt);
  });

  it("passes an error without a receipt through (nothing ran)", async () => {
    const { page, call, command } = await inFlight();
    await page.post({ result: { id: command.id, ok: false, error: { code: "VAULT_LOCKED", message: "Unlock Writ." } } });
    expect(isWritBridgeError(await rejectionOf(call), "VAULT_LOCKED")).toBe(true);
  });

  it("maps an unknown visitor code to INTERNAL and keeps it", async () => {
    const { page, call, command } = await inFlight();
    await page.post({ result: { id: command.id, ok: false, error: { code: "SOMETHING_NEW", message: "?" } } });
    const error = await rejectionOf(call);
    expect(isWritBridgeError(error, "INTERNAL")).toBe(true);
    expect((error as { details?: { visitorCode?: string } }).details?.visitorCode).toBe("SOMETHING_NEW");
  });
});

describe("page calls routed to Writ Cloud ({ run })", () => {
  function cloudDouble() {
    return mockFetch((url) => {
      if (url.endsWith("/run")) return jsonResponse(200, { task_id: 501, status: "queued" });
      return jsonResponse(200, { status: "completed", success: true, extracted_data: { orders: 3 }, result_data: { steps_completed: 2 } });
    });
  }

  it("runs a recommended function on Writ Cloud", async () => {
    const double = cloudDouble();
    const bridge = testBridge({ fetch: double.fetch });
    const page = fakePage(bridge, bridge.userToken("u1"));
    const response = await page.post({ run: { key: "orders.list", inputs: { status: "open" }, options: { timeout_ms: 10_000 } } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { orders: 3 }, venue: "cloud" });
    expect(double.calls[0]).toMatchObject({
      url: "https://cloud.test/api/automation/workflows/12/run",
      method: "POST",
      body: { function_name: "list_orders", form_data: { status: "open" } },
    });
  });

  it("refuses a required function", async () => {
    const bridge = testBridge();
    const response = await fakePage(bridge, bridge.userToken("u1")).post({ run: { key: "auth.verify_login", inputs: { company: "a", username: "b" } } });
    expect(response.status).toBe(403);
    expect((await errorBody(response)).code).toBe("WRIT_REQUIRED");
  });

  it("checks inputs first", async () => {
    const bridge = testBridge();
    const response = await fakePage(bridge, bridge.userToken("u1")).post({ run: { key: "reports.export", inputs: { year: "2026" } } });
    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe("INPUT_INVALID");
  });

  it("asks authorizeRun", async () => {
    const double = cloudDouble();
    const bridge = testBridge({ fetch: double.fetch, authorizeRun: (user: string) => user === "admin" });
    const denied = await fakePage(bridge, bridge.userToken("u1")).post({ run: { key: "orders.list", inputs: {} } });
    expect(denied.status).toBe(403);
    expect(double.calls).toHaveLength(0);
    const allowed = await fakePage(bridge, bridge.userToken("admin")).post({ run: { key: "orders.list", inputs: {} } });
    expect(allowed.status).toBe(200);
  });

  it("answers Writ Cloud failures with their code", async () => {
    const double = mockFetch(() => jsonResponse(402, { detail: "Plan limit reached" }));
    const bridge = testBridge({ fetch: double.fetch });
    const response = await fakePage(bridge, bridge.userToken("u1")).post({ run: { key: "orders.list", inputs: {} } });
    expect(response.status).toBe(402);
    expect((await errorBody(response)).code).toBe("QUOTA_EXCEEDED");
  });

  it("never leaks an unexpected failure", async () => {
    const bridge = testBridge({
      fetch: (async () => {
        throw new TypeError("socket at 10.0.0.7:5432 refused");
      }) as unknown as typeof fetch,
    });
    const response = await fakePage(bridge, bridge.userToken("u1")).post({ run: { key: "orders.list", inputs: {} } });
    const error = await errorBody(response);
    expect(error.code).toBe("CLOUD_UNAVAILABLE");
    expect(error.message).not.toContain("10.0.0.7");
  });
});

describe("a bridge without a secret", () => {
  it("answers 503 on the channel when every function is cloud-only", async () => {
    const cloudOnly = contract();
    cloudOnly.functions = cloudOnly.functions
      .filter((fn) => fn.key === "orders.list" || fn.key === "reports.export")
      .map((fn) => ({ ...fn, mode: "cloud" as const }));
    const bridge = testBridge({ secret: "", contract: cloudOnly });
    const response = await bridge.handler(
      new Request(`${ENDPOINT}?wait=0`, { headers: { authorization: `Writ ${mintUserToken(SECRET, "u1", Math.floor(T0 / 1000) + 60)}` } }),
    );
    expect(response.status).toBe(503);
    expect((await errorBody(response)).code).toBe("CONFIG_INVALID");
    expect(() => bridge.userToken("u1")).toThrow(/WRIT_BRIDGE_SECRET/);
  });
});
