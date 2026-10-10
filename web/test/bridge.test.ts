/**
 * The Writ Bridge in the page (CONTRACT.md §12, WRIT_BRIDGE_DESIGN.md §2-§3): creation rules,
 * where each call runs per mode (never an automatic fallback), and the banner each mode shows.
 * The page channel has its own file (bridge-channel.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWritBridge,
  isWritError,
  validateContract,
  type WritContract,
  type WritError,
  type WritPackage,
} from "../src/index.js";
import {
  PORTAL_KEYS,
  done,
  finishCall,
  grantKeys,
  isSettled,
  makeReceipt,
  settle,
  setupBridge,
  type PortalFunctions,
} from "./bridge-helpers.js";
import { BridgeWindow, ENDPOINT_URL, PAGE_ORIGIN, reply } from "./fake-server.js";
import { FakeProvider, deferred, grantFor, installDirect } from "./fake-provider.js";
import { bridgeContract, posSettingsPackage, settingsContract } from "./fixtures.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const LOGIN = { company: "ACME", username: "ana" };

function thrown(run: () => unknown): WritError | undefined {
  try {
    run();
  } catch (error) {
    return error as WritError;
  }
  return undefined;
}

/** The bridge contract with the POS function (local network) set to `mode`. */
function withPos(mode?: "required" | "recommended" | "cloud"): WritContract {
  const contract = bridgeContract({ withPos: true });
  const pos = contract.functions.find((fn) => fn.key === "pos.receive");
  if (pos === undefined) throw new Error("fixture has pos.receive");
  if (mode !== undefined) pos.mode = mode;
  return contract;
}

// ---------------------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------------------

describe("createWritBridge(): creation rules", () => {
  it("keeps the contract's mode and cloud mapping, and refuses an unknown mode", () => {
    const contract = bridgeContract();
    (contract.functions[0] as { mode?: string }).mode = "recommended";
    const clean = validateContract(contract);
    expect(clean.functions[0]).toMatchObject({ mode: "recommended", cloud: { workflow_id: 812, function: "verify_login" } });
    expect(clean.functions[1]).not.toHaveProperty("mode");

    (contract.functions[0] as { mode?: string }).mode = "sometimes";
    expect(thrown(() => validateContract(contract))?.code).toBe("INPUT_INVALID");
  });

  it("forces a function that reaches the local network to `required`", () => {
    const win = new BridgeWindow();
    const recommended = thrown(() => createWritBridge({ contract: withPos(), app: "Arrivos", mode: "recommended", window: win as never }));
    expect(recommended?.code).toBe("INPUT_INVALID");
    expect(recommended?.message).toContain("pos.receive");
    expect(recommended?.message).toContain("192.168.1.20:8080");

    const cloudFn = thrown(() => createWritBridge({ contract: withPos("cloud"), app: "Arrivos", mode: "required", window: win as never }));
    expect(cloudFn?.code).toBe("INPUT_INVALID");

    // Said by the contract itself: allowed, next to recommended functions.
    const bridge = createWritBridge({ contract: withPos("required"), app: "Arrivos", mode: "recommended", timeoutMs: 0, window: win as never });
    expect(bridge.venue("pos.receive")).toBeNull();
    bridge.destroy();
  });

  it("forces a function whose address is a lan_host setting to `required` as well", () => {
    // The package names no host: each visitor gives their POS address once, as a setting.
    const contract = withPos();
    const pkg = contract.packages.find((p) => p.id === "arrivos.pos") as WritPackage;
    delete (pkg as { local_network?: unknown }).local_network;
    pkg.settings = [{ key: "pos_host", label: "Your POS address", kind: "lan_host" }];
    pkg.steps = pkg.steps.map((step) => JSON.parse(JSON.stringify(step).split("192.168.1.20:8080").join("{{pos_host}}")));
    const pos = contract.functions.find((fn) => fn.key === "pos.receive");
    if (pos === undefined) throw new Error("fixture has pos.receive");
    pos.local_network = [];
    pos.settings = [{ key: "pos_host", label: "Your POS address", kind: "lan_host" }];
    const win = new BridgeWindow();
    const refused = thrown(() => createWritBridge({ contract, app: "Arrivos", mode: "recommended", window: win as never }));
    expect(refused?.code).toBe("INPUT_INVALID");
    expect(refused?.message).toContain("{{pos_host}}");
  });

  it("refuses keys that would hide the bridge's own methods", () => {
    const contract = bridgeContract();
    (contract.functions[1] as { key: string }).key = "status.check";
    const error = thrown(() => createWritBridge({ contract, app: "Arrivos", window: new BridgeWindow() as never }));
    expect(error?.code).toBe("INPUT_INVALID");
    expect(error?.message).toContain("status");
  });

  it("refuses bad options with BAD_REQUEST", () => {
    const win = new BridgeWindow();
    const base = { contract: bridgeContract(), app: "Arrivos", window: win as never };
    expect(thrown(() => createWritBridge({ ...base, mode: "sometimes" as never }))?.code).toBe("BAD_REQUEST");
    expect(thrown(() => createWritBridge({ ...base, app: " " }))?.code).toBe("BAD_REQUEST");
    expect(thrown(() => createWritBridge({ ...base, userToken: "has spaces in it" }))?.code).toBe("BAD_REQUEST");
    expect(thrown(() => createWritBridge({ ...base, banner: { position: "left" as never } }))?.code).toBe("BAD_REQUEST");
    expect(thrown(() => createWritBridge({ ...base, banner: { locale: "de" as never } }))?.code).toBe("BAD_REQUEST");
    expect(thrown(() => createWritBridge({ ...base, timeoutMs: -1 }))?.code).toBe("BAD_REQUEST");
    expect(thrown(() => createWritBridge({ ...base, contract: { format: "nope" } as never }))?.code).toBe("INPUT_INVALID");
  });

  it("refuses an endpoint on another origin, and accepts this origin's", () => {
    const win = new BridgeWindow();
    const base = { contract: bridgeContract(), app: "Arrivos", window: win as never, userToken: "tok.sig", timeoutMs: 0 };
    const error = thrown(() => createWritBridge({ ...base, endpoint: "https://evil.example/writ-bridge" }));
    expect(error?.code).toBe("BAD_REQUEST");
    expect(error?.message).toContain("https://arrivos.example");
    expect(thrown(() => createWritBridge({ ...base, mode: "cloud", userToken: undefined, endpoint: "//evil.example/x" }))?.code).toBe(
      "BAD_REQUEST",
    );
    createWritBridge({ ...base, endpoint: "https://arrivos.example/api/writ" }).destroy();
    createWritBridge({ ...base, endpoint: "api/writ" }).destroy();
  });

  it("has one typed method per key, nested by dots, next to its controls", () => {
    const { bridge } = setupBridge({ granted: PORTAL_KEYS });
    expect(typeof bridge.auth.verify_login).toBe("function");
    expect(bridge.auth.verify_login.name).toBe("auth.verify_login");
    expect(typeof bridge.orders.list).toBe("function");
    expect(typeof bridge.ready).toBe("function");
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.isFrozen(bridge.auth)).toBe(true);
    expect(thrown(() => bridge.venue("pos.void"))?.code).toBe("BAD_REQUEST");
    bridge.destroy();
  });
});

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

describe("createWritBridge(): where calls run", () => {
  it("required + Writ ready and granted: runs on the visitor's computer, with the challenge and receipt", async () => {
    const { win, provider, bridge } = setupBridge({ granted: PORTAL_KEYS });
    await settle();
    await expect(bridge.ready()).resolves.toBeUndefined();
    expect(win.document.created).toBe(0);
    expect(bridge.venue("auth.verify_login")).toBe("user");

    const pending = bridge.auth.verify_login(LOGIN, { challenge: "srv.challenge" });
    await settle();
    expect(provider?.sent("writ_call")).toEqual([{ key: "auth.verify_login", inputs: LOGIN, challenge: "srv.challenge" }]);

    const signed = makeReceipt({ challenge: "srv.challenge" });
    finishCall(provider as FakeProvider, "call-1", { ok: true }, signed);
    const result = await done(pending);
    expect(result).toEqual({ data: { ok: true }, venue: "user", receipt: signed, runId: 41, callId: "call-1" });
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(win.server.requests).toEqual([]);
    expect(bridge.status()).toMatchObject({
      mode: "required",
      ready: true,
      local: true,
      granted: ["auth.verify_login", "orders.list"],
      writVersion: "1.0.7",
      channel: "off",
    });
  });

  it("required + not set up: the call waits for the banner, then runs locally (never on the cloud)", async () => {
    const { win, provider, bridge } = setupBridge();
    await settle();
    expect(win.state()).toBe("connect");
    expect(bridge.status().ready).toBe(false);
    expect(bridge.venue("orders.list")).toBeNull();

    const pending = bridge.orders.list();
    expect(await isSettled(pending)).toBe(false);
    expect(await isSettled(bridge.ready())).toBe(false);
    expect(provider?.sent("writ_call")).toEqual([]);

    win.control("primary")?.click();
    await settle();
    expect(provider?.sent("writ_connect")).toHaveLength(1);
    expect(win.state()).toBeNull();
    await expect(bridge.ready()).resolves.toBeUndefined();
    expect(provider?.sent("writ_call")).toEqual([{ key: "orders.list", inputs: {} }]);

    finishCall(provider as FakeProvider, "call-1", { orders: ["PO-1"] });
    await expect(done(pending)).resolves.toMatchObject({ data: { orders: ["PO-1"] }, venue: "user", receipt: null });
    expect(win.server.runs).toEqual([]);
  });

  it("required: an aborted wait rejects with CANCELLED and sends nothing", async () => {
    const { provider, bridge } = setupBridge();
    await settle();
    const controller = new AbortController();
    const pending = bridge.orders.list({}, { signal: controller.signal });
    controller.abort();
    const error = (await done(pending).catch((e: unknown) => e)) as WritError;
    expect(isWritError(error, "CANCELLED")).toBe(true);
    expect(provider?.sent("writ_call")).toEqual([]);
  });

  it("recommended + no Writ: runs on Writ Cloud through the endpoint", async () => {
    const { win, bridge } = setupBridge({ mode: "recommended", extension: false, userToken: "tok.sig" });
    win.server.onRun = () => reply(200, { data: { orders: ["PO-7"] }, venue: "cloud" });
    const result = await done(bridge.orders.list({}, { timeoutMs: 30_000, dryRun: true }));
    expect(result).toEqual({ data: { orders: ["PO-7"] }, venue: "cloud", receipt: null, runId: null, callId: null });

    const run = win.server.requests.find((request) => request.body !== undefined && "run" in request.body);
    expect(run).toMatchObject({
      method: "POST",
      url: ENDPOINT_URL,
      headers: { Authorization: "Writ tok.sig", "Content-Type": "application/json" },
      body: { run: { key: "orders.list", inputs: {}, options: { timeout_ms: 30_000, dry_run: true } } },
    });
    expect(bridge.venue("orders.list")).toBe("cloud");
    await expect(bridge.ready()).resolves.toBeUndefined();
  });

  it("recommended without a user token: no Authorization header", async () => {
    const { win, bridge } = setupBridge({ mode: "recommended", extension: false });
    win.server.onRun = () => reply(200, { data: 1, venue: "cloud" });
    await done(bridge.orders.list());
    expect(win.server.requests).toHaveLength(1);
    expect(win.server.requests[0]?.headers).not.toHaveProperty("Authorization");
  });

  it("recommended + Writ ready and granted: runs locally, never on the cloud", async () => {
    const { win, provider, bridge } = setupBridge({ mode: "recommended", granted: PORTAL_KEYS });
    // Called before the first check finished: it waits for it instead of racing to the cloud.
    const pending = bridge.orders.list();
    await settle();
    expect(provider?.sent("writ_call")).toEqual([{ key: "orders.list", inputs: {} }]);
    finishCall(provider as FakeProvider, "call-1", { orders: [] });
    await expect(done(pending)).resolves.toMatchObject({ venue: "user" });
    expect(win.server.runs).toEqual([]);
    expect(bridge.venue("orders.list")).toBe("user");
  });

  it("never falls back: a failed local run rejects with its code, its receipt and venue 'user'", async () => {
    const { win, provider, bridge } = setupBridge({ mode: "recommended", granted: PORTAL_KEYS });
    await settle();
    const caught = bridge.auth.verify_login(LOGIN).catch((e: unknown) => e as WritError);
    await settle();
    const failed = makeReceipt({ outcome: "failed", error_code: "RUN_FAILED", data_hash: null });
    provider?.emit({ call_id: "call-1", type: "error", code: "RUN_FAILED", message: "The run failed.", receipt: failed });
    const error = (await done(caught)) as WritError;
    expect(isWritError(error, "RUN_FAILED")).toBe(true);
    expect(error.details).toMatchObject({ venue: "user", receipt: failed, callId: "call-1" });
    expect(win.server.runs).toEqual([]);
  });

  it("cloud: always the endpoint, even when the visitor's Writ grants the key; no banner, no extension traffic", async () => {
    const { win, provider, bridge } = setupBridge({ mode: "cloud", granted: PORTAL_KEYS });
    win.server.onRun = (run) => reply(200, { data: { key: run.key }, venue: "cloud" });
    const result = await done(bridge.auth.verify_login(LOGIN, { challenge: "ignored.by.cloud" }));
    expect(result).toMatchObject({ data: { key: "auth.verify_login" }, venue: "cloud", receipt: null });
    expect(win.server.runs).toEqual([{ key: "auth.verify_login", inputs: LOGIN, options: {} }]);
    expect(provider?.requests).toEqual([]);
    expect(win.document.created).toBe(0);
    await expect(bridge.ready()).resolves.toBeUndefined();
    expect(bridge.status()).toMatchObject({ mode: "cloud", ready: true, local: false, channel: "off" });
  });

  it("maps the server's refusal to its code, with venue and status", async () => {
    const { win, bridge } = setupBridge({ mode: "cloud" });
    win.server.onRun = () => reply(503, { error: { code: "CLOUD_NOT_CONFIGURED", message: "WRIT_API_KEY is not set." } });
    const error = (await done(bridge.orders.list()).catch((e: unknown) => e)) as WritError;
    expect(isWritError(error, "CLOUD_NOT_CONFIGURED")).toBe(true);
    expect(error.message).toBe("WRIT_API_KEY is not set.");
    expect(error.details).toMatchObject({ venue: "cloud", status: 503 });

    win.server.onRun = () => reply(404);
    const missing = (await done(bridge.orders.list()).catch((e: unknown) => e)) as WritError;
    expect(missing.code).toBe("BAD_REQUEST");
    expect(missing.message).toContain("/writ-bridge");

    win.server.onRun = () => Promise.reject(new TypeError("Failed to fetch"));
    const offline = (await done(bridge.orders.list()).catch((e: unknown) => e)) as WritError;
    expect(offline.code).toBe("INTERNAL");
    expect(offline.details).toMatchObject({ venue: "cloud" });
  });

  it("checks inputs and options against the contract before anything is sent", async () => {
    const { win, provider, bridge } = setupBridge({ granted: PORTAL_KEYS });
    await settle();
    const missing = (await bridge.auth.verify_login({ company: "ACME" } as never).catch((e: unknown) => e)) as WritError;
    expect(missing.code).toBe("INPUT_INVALID");
    expect(missing.message).toContain('"username"');
    const extra = (await bridge.orders.list({ page: 2 } as never).catch((e: unknown) => e)) as WritError;
    expect(extra.code).toBe("INPUT_INVALID");
    const longChallenge = (await bridge.orders.list({}, { challenge: "c".repeat(2_049) }).catch((e: unknown) => e)) as WritError;
    expect(longChallenge.code).toBe("BAD_REQUEST");
    expect(provider?.sent("writ_call")).toEqual([]);
    expect(win.server.requests).toEqual([]);
  });

  it("refreshes the grant after NOT_GRANTED and sets the visitor up again", async () => {
    const { win, provider, bridge } = setupBridge({ granted: PORTAL_KEYS });
    await settle();
    expect(bridge.status().ready).toBe(true);

    const caught = bridge.orders.list().catch((e: unknown) => e as WritError);
    await settle();
    grantKeys(provider as FakeProvider, []);
    provider?.emit({ call_id: "call-1", type: "error", code: "NOT_GRANTED", message: "Revoked." });
    expect(((await done(caught)) as WritError).code).toBe("NOT_GRANTED");
    await settle();

    expect(bridge.status()).toMatchObject({ ready: false, local: false, granted: [] });
    expect(win.state()).toBe("connect");
  });

  it("destroy(): cancels waiting calls and rejects ready()", async () => {
    const { win, bridge } = setupBridge();
    await settle();
    const pending = bridge.orders.list().catch((e: unknown) => e as WritError);
    bridge.destroy();
    expect(((await done(pending)) as WritError).code).toBe("CANCELLED");
    await expect(bridge.ready()).rejects.toMatchObject({ code: "CANCELLED" });
    expect(win.state()).toBeNull();
    expect(bridge.status().destroyed).toBe(true);
    await expect(bridge.orders.list()).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("without a window (server rendering): calls and ready() reject with NOT_INSTALLED", async () => {
    const bridge = createWritBridge<PortalFunctions>({ contract: bridgeContract(), app: "Arrivos", mode: "recommended" });
    await expect(bridge.ready()).rejects.toMatchObject({ code: "NOT_INSTALLED" });
    await expect(bridge.orders.list()).rejects.toMatchObject({ code: "NOT_INSTALLED" });
    expect(bridge.venue("orders.list")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Banner per mode
// ---------------------------------------------------------------------------------------------

describe("createWritBridge(): the banner by mode", () => {
  it("required: blocking (no dismiss), says why, and ignores an earlier dismissal", async () => {
    const win = new BridgeWindow();
    win.sessionStorage.setItem("writ:banner:dismissed:Arrivos", "1");
    installDirect(win, new FakeProvider());
    const bridge = createWritBridge<PortalFunctions>({ contract: bridgeContract(), app: "Arrivos", timeoutMs: 0, window: win as never });
    await settle();
    expect(win.state()).toBe("connect");
    expect(win.control("dismiss")).toBeNull();
    expect(win.bar()?.hasAttribute("data-required")).toBe(true);
    expect(win.part("note")?.textContent).toBe("Arrivos needs Writ on this computer to continue.");
    expect(win.control("primary")?.textContent).toBe("Install Arrivos supplier portal (one click)");
    bridge.destroy();
  });

  it("a required function makes the banner blocking even in a recommended bridge", async () => {
    const win = new BridgeWindow();
    installDirect(win, new FakeProvider());
    const bridge = createWritBridge({ contract: withPos("required"), app: "Arrivos", mode: "recommended", timeoutMs: 0, window: win as never });
    await settle();
    expect(win.state()).toBe("connect");
    expect(win.control("dismiss")).toBeNull();
    // The recommended keys do not wait for the visitor: they run on the cloud meanwhile.
    expect(bridge.venue("orders.list")).toBe("cloud");
    expect(bridge.venue("pos.receive")).toBeNull();
    bridge.destroy();
  });

  it("recommended: dismissible; closing it keeps calls on Writ Cloud", async () => {
    const { win, bridge } = setupBridge({ mode: "recommended", extension: false });
    await settle();
    expect(win.state()).toBe("extension");
    expect(win.part("note")?.textContent).toBe("Optional. If you close this, Arrivos keeps working without Writ.");
    expect(win.bar()?.hasAttribute("data-required")).toBe(false);

    win.control("dismiss")?.click();
    await settle();
    expect(win.state()).toBeNull();
    expect(win.sessionStorage.getItem("writ:banner:dismissed:Arrivos")).toBe("1");
    expect(bridge.venue("orders.list")).toBe("cloud");
    expect(bridge.status()).toMatchObject({ ready: true, local: false });
    win.server.onRun = () => reply(200, { data: [], venue: "cloud" });
    await expect(done(bridge.orders.list())).resolves.toMatchObject({ venue: "cloud" });
  });

  it("cloud: no banner at all", async () => {
    const { win } = setupBridge({ mode: "cloud", extension: false });
    await settle();
    expect(win.document.created).toBe(0);
    expect(win.host()).toBeNull();
  });

  it("banner: false renders nothing, and picks up a connection when the window gets focus back", async () => {
    const { win, provider, bridge } = setupBridge({ banner: false });
    await settle();
    expect(win.document.created).toBe(0);
    const pending = bridge.orders.list();
    expect(await isSettled(pending)).toBe(false);

    // The site connected the visitor its own way; the bridge notices on focus.
    grantKeys(provider as FakeProvider, PORTAL_KEYS);
    win.focusWindow();
    await settle();
    expect(provider?.sent("writ_call")).toEqual([{ key: "orders.list", inputs: {} }]);
    finishCall(provider as FakeProvider, "call-1", { orders: [] });
    await expect(done(pending)).resolves.toMatchObject({ venue: "user" });
    expect(win.document.created).toBe(0);
  });

  it("banner options place it and pick its language", async () => {
    const win = new BridgeWindow();
    installDirect(win, new FakeProvider());
    const container = win.document.createElement("div");
    win.document.body.append(container);
    const bridge = createWritBridge({
      contract: bridgeContract(),
      app: "Arrivos",
      timeoutMs: 0,
      window: win as never,
      banner: { container: container as never, locale: "fr" },
    });
    await settle();
    expect(win.host()?.parent).toBe(container);
    expect(win.part("note")?.textContent).toBe("Arrivos a besoin de Writ sur cet ordinateur pour continuer.");
    bridge.destroy();
  });

  it("speaks Spanish for a recommended bridge", async () => {
    const win = new BridgeWindow({ userAgent: "Mozilla/5.0 Chrome/141.0.0.0", language: "es-ES" });
    const bridge = createWritBridge({ contract: bridgeContract(), app: "Arrivos", mode: "recommended", timeoutMs: 0, window: win as never });
    await settle();
    expect(win.part("note")?.textContent).toBe("Opcional. Si cierras este aviso, Arrivos sigue funcionando sin Writ.");
    bridge.destroy();
  });
});

// ---------------------------------------------------------------------------------------------
// Settings: suggested values (CONTRACT.md §8)
// ---------------------------------------------------------------------------------------------

const POS_KEYS = ["pos.receive", "pos.lookup"];

/** The connect request the bridge sends for `pos.receive`, with `settings`. */
function receiveRequest(settings: Record<string, string>) {
  return {
    key: "pos.receive",
    description: "Receive a supplier invoice in your POS",
    writes: true,
    package: posSettingsPackage(),
    function: "receive",
    settings,
  };
}

/** The extension's answer to writ_connect: the origin's whole grant, as the real one sends. */
function wholeGrant(keys: readonly string[]) {
  return { origin: PAGE_ORIGIN, functions: keys.map((key) => grantFor({ key, description: key })) };
}

describe("createWritBridge(): settings", () => {
  it("merges the `settings` option into the connect of every key of the package", async () => {
    const { win, provider } = setupBridge({
      contract: settingsContract(),
      settings: { "pos.receive": { pos_host: "192.168.1.20:8080" } },
    });
    await settle();
    expect(win.state()).toBe("connect");
    win.control("primary")?.click();
    await settle();

    const [sent] = provider?.sent("writ_connect") as { functions: { key: string; settings?: unknown }[] }[];
    expect(sent?.functions.map((fn) => [fn.key, fn.settings])).toEqual([
      ["pos.receive", { pos_host: "192.168.1.20:8080" }],
      ["pos.lookup", { pos_host: "192.168.1.20:8080" }],
    ]);
  });

  it("refuses invalid `settings` when the bridge is created", () => {
    const win = new BridgeWindow();
    const base = { contract: settingsContract(), app: "Arrivos", window: win as never };
    expect(thrown(() => createWritBridge({ ...base, settings: "pos.local" as never }))?.code).toBe("BAD_REQUEST");
    expect(thrown(() => createWritBridge({ ...base, settings: { "pos.void": { pos_host: "x" } } }))?.code).toBe("BAD_REQUEST");
    expect(thrown(() => createWritBridge({ ...base, settings: { "pos.receive": { pos_host: " " } } }))?.code).toBe("INPUT_INVALID");
    expect(thrown(() => createWritBridge({ ...base, settings: { "pos.receive": { pos_ip: "x" } } }))?.code).toBe("INPUT_INVALID");
    const conflict = thrown(() =>
      createWritBridge({ ...base, settings: { "pos.receive": { pos_host: "a.local" }, "pos.lookup": { pos_host: "b.local" } } }),
    );
    expect(conflict?.code).toBe("INPUT_INVALID");

    // A key that runs on Writ Cloud (its address isn't a lan_host setting, or it couldn't) takes no suggestion.
    const contract = settingsContract();
    contract.functions[1]!.settings = [{ key: "store_no", label: "Store number", kind: "text" }];
    (contract.functions[1] as { mode?: string }).mode = "cloud";
    const cloud = thrown(() => createWritBridge({ ...base, contract, settings: { "pos.lookup": { store_no: "12" } } }));
    expect(cloud?.code).toBe("BAD_REQUEST");
    expect(cloud?.message).toContain('"pos.lookup" runs on Writ Cloud');
  });

  it("suggestSettings is one of the bridge's own frozen methods", () => {
    const { bridge } = setupBridge({ contract: settingsContract(), granted: POS_KEYS });
    expect(typeof bridge.suggestSettings).toBe("function");
    expect(Object.isFrozen(bridge.suggestSettings)).toBe(true);
    bridge.destroy();
  });

  it("suggestSettings(), connected: re-runs the connect for those keys and resolves once the user confirms", async () => {
    const { provider, bridge } = setupBridge({ contract: settingsContract(), granted: POS_KEYS });
    await settle();
    await expect(bridge.ready()).resolves.toBeUndefined();

    const consent = deferred<unknown>();
    provider?.handlers.set("writ_connect", () => consent.promise);
    const pending = bridge.suggestSettings({ "pos.receive": { pos_host: " 10.0.0.5:8080 " } });
    await settle();
    expect(provider?.sent("writ_connect")).toEqual([
      { app: "Arrivos", functions: [receiveRequest({ pos_host: "10.0.0.5:8080" })] },
    ]);
    expect(await isSettled(pending)).toBe(false);

    consent.resolve(wholeGrant(POS_KEYS));
    await expect(done(pending)).resolves.toBeUndefined();
    expect(bridge.status()).toMatchObject({ ready: true, local: true, granted: ["pos.lookup", "pos.receive"] });
  });

  it("suggestSettings(), connected: rejects with CONSENT_DENIED when the user declines, and stays connected", async () => {
    const { provider, bridge } = setupBridge({ contract: settingsContract(), granted: POS_KEYS });
    await settle();
    provider?.handlers.set("writ_connect", () => {
      throw { code: "CONSENT_DENIED", message: "The user declined." };
    });
    const error = (await done(bridge.suggestSettings({ "pos.lookup": { store_no: "12" } })).catch((e: unknown) => e)) as WritError;
    expect(isWritError(error, "CONSENT_DENIED")).toBe(true);
    expect(provider?.sent("writ_connect")).toHaveLength(1);
    expect(bridge.status()).toMatchObject({ ready: true, local: true });
  });

  it("suggestSettings(), not connected yet: the banner's install carries the values, and it resolves once connected", async () => {
    const { win, provider, bridge } = setupBridge({ contract: settingsContract() });
    await settle();
    expect(win.state()).toBe("connect");

    const pending = bridge.suggestSettings({ "pos.lookup": { store_no: "12" } });
    await settle();
    expect(provider?.sent("writ_connect")).toEqual([]);
    expect(await isSettled(pending)).toBe(false);

    win.control("primary")?.click();
    await expect(done(pending)).resolves.toBeUndefined();
    const sent = provider?.sent("writ_connect") as { functions: { key: string; settings?: unknown }[] }[];
    expect(sent).toHaveLength(1);
    expect(sent[0]?.functions.map((fn) => [fn.key, fn.settings])).toEqual([
      ["pos.receive", { store_no: "12" }],
      ["pos.lookup", { store_no: "12" }],
    ]);
    expect(bridge.status().ready).toBe(true);
  });

  it("suggestSettings(), not connected yet: rejects with CONSENT_DENIED when the visitor closes a recommended banner", async () => {
    // Only functions that don't reach the visitor's network can be recommended: here, a store number.
    const contract = settingsContract();
    for (const fn of contract.functions) fn.settings = [{ key: "store_no", label: "Store number", kind: "text" }];
    const { win, bridge } = setupBridge({ mode: "recommended", contract, extension: false });
    await settle();
    expect(win.state()).toBe("extension");
    const pending = bridge.suggestSettings({ "pos.receive": { store_no: "12" } }).catch((e: unknown) => e as WritError);
    win.control("dismiss")?.click();
    expect(((await done(pending)) as WritError).code).toBe("CONSENT_DENIED");
  });

  it("suggestSettings(): refuses invalid suggestions before anything is sent", async () => {
    const contract = settingsContract();
    contract.functions[1]!.settings = [{ key: "store_no", label: "Store number", kind: "text" }];
    (contract.functions[1] as { mode?: string }).mode = "cloud";
    const { provider, bridge } = setupBridge({ contract, granted: ["pos.receive"] });
    await settle();
    await expect(bridge.suggestSettings("pos.local" as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bridge.suggestSettings({ "pos.void": { pos_host: "x" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(bridge.suggestSettings({ "pos.lookup": { store_no: "12" } })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("runs on Writ Cloud"),
    });
    await expect(bridge.suggestSettings({ "pos.receive": { pos_host: "pos.local\u0000" } })).rejects.toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("control characters"),
    });
    await expect(bridge.suggestSettings({ "pos.receive": { store_no: "1".repeat(201) } })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(bridge.suggestSettings({ "pos.receive": { pos_ip: "x" } })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(provider?.sent("writ_connect")).toEqual([]);
  });

  it("suggestSettings(): destroy() rejects a waiting suggestion with CANCELLED", async () => {
    const { bridge } = setupBridge({ contract: settingsContract() });
    await settle();
    const pending = bridge.suggestSettings({ "pos.receive": { pos_host: "pos.local" } }).catch((e: unknown) => e as WritError);
    bridge.destroy();
    expect(((await done(pending)) as WritError).code).toBe("CANCELLED");
    await expect(bridge.suggestSettings({ "pos.receive": { pos_host: "pos.local" } })).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
