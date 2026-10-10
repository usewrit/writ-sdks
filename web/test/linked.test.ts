/**
 * Linked workflows (CONTRACT.md §11, LINKED_WORKFLOWS_DESIGN.md §9): contract entries, run tokens
 * in token mode, the recipe cache policy, refreshRecipes, and the banner's "Update" and
 * "Unavailable" states. The same page code serves bundled and linked workflows: the contract
 * decides.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectWrit,
  contractFunctions,
  createWritBridge,
  createWritClient,
  definePackage,
  isWritError,
  mountWritBanner,
  validateContract,
  type CallOptions,
  type FunctionRequest,
  type WritBannerOptions,
  type WritClient,
  type WritContract,
  type WritError,
  type WritLinkedPackage,
  type WritPackage,
  type WritSession,
} from "../src/index.js";
import { PORTAL_KEYS, done, finishCall, settle as settleBridge, setupBridge } from "./bridge-helpers.js";
import { BannerWindow } from "./fake-dom.js";
import { CHROME_UA, FakeProvider, FakeWindow, deferred, flush, grantFor, installDirect } from "./fake-provider.js";
import { BridgeWindow } from "./fake-server.js";
import {
  PUBLICATION_ID,
  bridgeContract,
  linkedContract,
  linkedPortalPackage,
  portalPackage,
  posReceivePackage,
  runTokenWith,
} from "./fixtures.js";

function thrown(run: () => unknown): WritError | undefined {
  try {
    run();
  } catch (error) {
    return error as WritError;
  }
  return undefined;
}

/** The linked contract with one field of its package changed. */
function patchedLinked(mutate: (pkg: Record<string, unknown> & { manifest: Record<string, unknown> }) => void): unknown {
  const contract = JSON.parse(JSON.stringify(linkedContract())) as { packages: (Record<string, unknown> & { manifest: Record<string, unknown> })[] };
  mutate(contract.packages[0] as Record<string, unknown> & { manifest: Record<string, unknown> });
  return contract;
}

/** Unix seconds from now. */
function inSeconds(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

async function writWith(provider: FakeProvider = new FakeProvider()): Promise<{ provider: FakeProvider; writ: WritClient }> {
  const win = new FakeWindow();
  installDirect(win, provider);
  const writ = await connectWrit({ window: win });
  if (!writ.available) throw new Error("expected the fake provider to be found");
  return { provider, writ };
}

/** A plain key (no package) next to the linked ones: its calls carry nothing linked. */
const PLAIN: FunctionRequest = { key: "pos.receive", description: "Receive an invoice in your POS", writes: true };

/** A getRunToken that counts its calls and answers `token()` each time. */
function counting(token: () => string): { getRunToken: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    getRunToken: async () => {
      calls += 1;
      return token();
    },
    calls: () => calls,
  };
}

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

describe("validateContract(): linked entries", () => {
  it("accepts a linked contract, alone or next to bundled packages, as a deep-frozen copy", () => {
    const contract = validateContract(linkedContract());
    expect(contract.packages).toEqual([linkedPortalPackage()]);
    expect(Object.isFrozen((contract.packages[0] as WritLinkedPackage).manifest.functions)).toBe(true);
    expect(contract.functions.map((fn) => [fn.key, fn.function, fn.cloud])).toEqual([
      ["auth.verify_login", "verify_login", { workflow_id: 812, function: "verify_login" }],
      ["orders.list", "list_orders", { workflow_id: 812, function: "list_orders" }],
    ]);

    const mixed = bridgeContract({ withPos: true });
    mixed.packages[0] = linkedPortalPackage("token");
    expect(validateContract(mixed).packages.map((pkg) => pkg.format)).toEqual(["writ.linked/v1", "writ.workflow/v1"]);
  });

  it("accepts a development base, a pinned version and a publisher", () => {
    for (const base of ["https://cloud.example.com", "https://cloud.example.com:8443/", "http://localhost:8000", "http://127.0.0.1:8000"]) {
      const contract = patchedLinked((pkg) => {
        pkg.publication = { id: PUBLICATION_ID, base, version: 3 };
      });
      expect(() => validateContract(contract), base).not.toThrow();
    }
  });

  const refused: [string, unknown, string][] = [
    ["a bad package id", patchedLinked((pkg) => (pkg.id = "Arrivos Portal")), "contract.packages[0].id"],
    ["no name", patchedLinked((pkg) => (pkg.name = " ")), "contract.packages[0].name"],
    ["a publication that is text", patchedLinked((pkg) => (pkg.publication = PUBLICATION_ID)), "publication must be an object"],
    ["a short publication id", patchedLinked((pkg) => (pkg.publication = { id: "pub_short" })), "publication.id"],
    ["a publication id with symbols", patchedLinked((pkg) => (pkg.publication = { id: "pub_0123456789abcdef-BCDEF" })), "publication.id"],
    ["plain http to another host", patchedLinked((pkg) => (pkg.publication = { id: PUBLICATION_ID, base: "http://cloud.example.com" })), "publication.base"],
    ["a base with a path", patchedLinked((pkg) => (pkg.publication = { id: PUBLICATION_ID, base: "https://cloud.example.com/api" })), "publication.base"],
    ["a base with a query", patchedLinked((pkg) => (pkg.publication = { id: PUBLICATION_ID, base: "https://cloud.example.com?x=1" })), "publication.base"],
    ["a base with a user name", patchedLinked((pkg) => (pkg.publication = { id: PUBLICATION_ID, base: "https://u:p@cloud.example.com" })), "publication.base"],
    ["version 0", patchedLinked((pkg) => (pkg.publication = { id: PUBLICATION_ID, version: 0 })), "publication.version"],
    ["a fractional version", patchedLinked((pkg) => (pkg.publication = { id: PUBLICATION_ID, version: 1.5 })), "publication.version"],
    ["the secret key", patchedLinked((pkg) => (pkg.key = "wsk_0123456789abcdef0123456789ABCDEF")), "Never put the secret key"],
    ["a short publishable key", patchedLinked((pkg) => (pkg.key = "wpk_0123")), "publishable key"],
    ["an unknown access mode", patchedLinked((pkg) => (pkg.access = "private")), 'access must be "public" or "token"'],
    ["another manifest format", patchedLinked((pkg) => (pkg.manifest.format = "writ.manifest/v2")), 'manifest.format must be "writ.manifest/v1"'],
    ["a manifest of another publication", patchedLinked((pkg) => (pkg.manifest.publication = "pub_ZZZZZZZZZZZZZZZZZZZZZZ")), "belongs to another publication"],
    ["a manifest without functions", patchedLinked((pkg) => (pkg.manifest.functions = [])), "manifest.functions must list"],
    ["a manifest setting without a label", patchedLinked((pkg) => (pkg.manifest.settings = [{ key: "pos_host" }])), "manifest.settings[0].label"],
    ["an uppercase manifest hash", patchedLinked((pkg) => (pkg.manifest_hash = "3F".repeat(32))), "manifest_hash"],
    ["a short manifest hash", patchedLinked((pkg) => (pkg.manifest_hash = "3f".repeat(16))), "manifest_hash"],
  ];

  it.each(refused)("refuses %s with INPUT_INVALID", (_label, contract, message) => {
    const error = thrown(() => validateContract(contract));
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect(error?.message).toContain(message);
  });

  it("picks functions from the manifest", () => {
    const contract = JSON.parse(JSON.stringify(linkedContract())) as WritContract;
    (contract.functions[1] as { function: string | null }).function = "refund";
    expect(thrown(() => validateContract(contract))?.message).toContain('no such function; it has "verify_login", "list_orders"');
    (contract.functions[1] as { function: string | null }).function = null;
    expect(thrown(() => validateContract(contract))?.message).toContain("set `function`");
  });

  it("contractFunctions() passes each linked package as the key's package, like a bundled one", () => {
    const requests = contractFunctions(linkedContract("token"));
    expect(requests.map((request) => [request.key, request.package?.id, request.function])).toEqual([
      ["auth.verify_login", "arrivos.portal", "verify_login"],
      ["orders.list", "arrivos.portal", "list_orders"],
    ]);
    expect(requests[0]?.package).toEqual(linkedPortalPackage("token"));
  });

  it("definePackage() stays for bundled packages", () => {
    const error = thrown(() => definePackage(linkedPortalPackage() as unknown as WritPackage));
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect(error?.message).toContain("validateContract");
    expect(() => definePackage(portalPackage())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// connect(), resume() and calls
// ---------------------------------------------------------------------------------------------

describe("connect() with linked workflows", () => {
  it("installs the linked package, and keeps getRunToken and recipeCache in the page", async () => {
    const { provider, writ } = await writWith();
    const getRunToken = async (): Promise<string> => runTokenWith({ exp: inSeconds(600) });
    await writ.connect({ app: "Arrivos", functions: contractFunctions(linkedContract("token")), getRunToken, recipeCache: "call" });
    const [sent] = provider.sent("writ_connect") as Record<string, unknown>[];
    expect(Object.keys(sent ?? {})).toEqual(["app", "functions"]);
    const functions = (sent as { functions: FunctionRequest[] }).functions;
    expect(functions.map((fn) => fn.package)).toEqual([linkedPortalPackage("token"), linkedPortalPackage("token")]);
  });

  it("refuses a token-mode linked workflow without getRunToken, before sending anything", async () => {
    const { provider, writ } = await writWith();
    const error = await writ.connect({ app: "Arrivos", functions: contractFunctions(linkedContract("token")) }).catch((e: unknown) => e);
    expect(isWritError(error, "BAD_REQUEST")).toBe(true);
    expect((error as WritError).message).toContain("getRunToken");
    expect(provider.requests).toEqual([]);
  });

  it("refuses a getRunToken that is not a function, and an unknown recipeCache", async () => {
    const { writ } = await writWith();
    const functions = contractFunctions(linkedContract());
    await expect(writ.connect({ app: "Arrivos", functions, getRunToken: "token" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(writ.connect({ app: "Arrivos", functions, recipeCache: "forever" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("calls to linked workflows", () => {
  it("public mode: each linked call carries the recipe policy, and other keys nothing new", async () => {
    const { provider, writ } = await writWith();
    const session = await writ.connect({ app: "Arrivos", functions: [...contractFunctions(linkedContract()), PLAIN] });

    const linked = session.call("orders.list", {});
    const plain = session.call("pos.receive", { invoice_no: "F-1029" });
    const fresh = session.call("orders.list", {}, { recipeCache: "call" });
    await flush();
    expect(provider.sent("writ_call")).toEqual([
      { key: "orders.list", inputs: {}, recipe_cache: "session" },
      { key: "pos.receive", inputs: { invoice_no: "F-1029" } },
      { key: "orders.list", inputs: {}, recipe_cache: "call" },
    ]);
    await Promise.all([linked.cancel(), plain.cancel(), fresh.cancel()]);
  });

  it("uses the session's recipeCache by default", async () => {
    const { provider, writ } = await writWith();
    const session = await writ.connect({ app: "Arrivos", functions: contractFunctions(linkedContract()), recipeCache: "call" });
    const call = session.call("auth.verify_login", { company: "ACME", username: "ana" });
    await flush();
    expect(provider.sent("writ_call")).toEqual([
      { key: "auth.verify_login", inputs: { company: "ACME", username: "ana" }, recipe_cache: "call" },
    ]);
    await call.cancel();
  });

  it("token mode: gets a run token before the call goes out, and passes it as the call's token", async () => {
    const { provider, writ } = await writWith();
    const minted = deferred<string>();
    const session = await writ.connect({
      app: "Arrivos",
      functions: contractFunctions(linkedContract("token")),
      getRunToken: () => minted.promise,
    });

    const call = session.call("orders.list", {});
    await flush();
    expect(provider.sent("writ_call")).toEqual([]);
    expect(call.status).toBe("pending");

    const token = runTokenWith({ pub: PUBLICATION_ID, exp: inSeconds(600) });
    minted.resolve(token);
    await flush();
    expect(provider.sent("writ_call")).toEqual([{ key: "orders.list", inputs: {}, recipe_cache: "session", token }]);
    await expect(call.callId).resolves.toBe("call-1");
    await call.cancel();
  });

  it("token mode: reuses the token while it has more than a minute left, and fetches one near exp", async () => {
    const { provider, writ } = await writWith();
    let exp = inSeconds(3_600);
    const source = counting(() => runTokenWith({ pub: PUBLICATION_ID, exp }));
    const session = await writ.connect({ app: "Arrivos", functions: contractFunctions(linkedContract("token")), getRunToken: source.getRunToken });

    const calls = [session.call("orders.list", {}), session.call("orders.list", {})];
    await flush();
    calls.push(session.call("orders.list", {}));
    await flush();
    expect(source.calls()).toBe(1);
    const sent = provider.sent("writ_call") as { token?: string }[];
    expect(new Set(sent.map((params) => params.token)).size).toBe(1);

    // A different getRunToken has its own cache; a token with under a minute left is never kept.
    exp = inSeconds(30);
    const short = counting(() => runTokenWith({ pub: PUBLICATION_ID, exp }));
    const other = await writ.connect({ app: "Arrivos", functions: contractFunctions(linkedContract("token")), getRunToken: short.getRunToken });
    calls.push(other.call("orders.list", {}));
    await flush();
    calls.push(other.call("orders.list", {}));
    await flush();
    expect(short.calls()).toBe(2);
    await Promise.all(calls.map((call) => call.cancel()));
  });

  it("token mode: a token Writ Cloud refused (NOT_GRANTED) is never reused", async () => {
    const { provider, writ } = await writWith();
    let serial = 0;
    const source = counting(() => runTokenWith({ pub: PUBLICATION_ID, exp: inSeconds(3_600), n: (serial += 1) }));
    const session = await writ.connect({ app: "Arrivos", functions: contractFunctions(linkedContract("token")), getRunToken: source.getRunToken });

    const first = session.call("orders.list", {});
    await flush();
    provider.emit({ call_id: "call-1", type: "error", code: "NOT_GRANTED", message: "Writ Cloud refused the run token." });
    await expect(first.result).rejects.toMatchObject({ code: "NOT_GRANTED" });

    const second = session.call("orders.list", {});
    await flush();
    expect(source.calls()).toBe(2);
    const [a, b] = provider.sent("writ_call") as { token: string }[];
    expect(a?.token).not.toBe(b?.token);
    await second.cancel();
  });

  it("token mode: a failing getRunToken fails the call with NOT_GRANTED and sends nothing", async () => {
    const { provider, writ } = await writWith();
    const session = await writ.connect({
      app: "Arrivos",
      functions: contractFunctions(linkedContract("token")),
      getRunToken: async () => {
        throw new Error("401 from /api/writ-token");
      },
    });
    const error = await session.call("orders.list", {}).result.catch((e: unknown) => e);
    expect(isWritError(error, "NOT_GRANTED")).toBe(true);
    expect((error as WritError).message).toContain("401 from /api/writ-token");
    expect(provider.sent("writ_call")).toEqual([]);
  });

  it("a token given in the call's options is sent as is, and cancel works while the token is fetched", async () => {
    const { provider, writ } = await writWith();
    const minted = deferred<string>();
    const session = await writ.connect({
      app: "Arrivos",
      functions: contractFunctions(linkedContract("token")),
      getRunToken: () => minted.promise,
    });
    const given = runTokenWith({ pub: PUBLICATION_ID, exp: inSeconds(600), from: "page" });
    const explicit = session.call("orders.list", {}, { token: given });
    await flush();
    expect(provider.sent("writ_call")).toEqual([{ key: "orders.list", inputs: {}, recipe_cache: "session", token: given }]);
    await explicit.cancel();

    const waiting = session.call("orders.list", {});
    await waiting.cancel();
    await expect(waiting.result).rejects.toMatchObject({ code: "CANCELLED" });
    minted.resolve(runTokenWith({ exp: inSeconds(600) }));
    await flush();
    expect(provider.sent("writ_call")).toHaveLength(1);
    expect(provider.sent("writ_cancel")).toHaveLength(1);
  });

  it("refuses a malformed token option with BAD_REQUEST", async () => {
    const { writ } = await writWith();
    const session = await writ.connect({ app: "Arrivos", functions: contractFunctions(linkedContract()) });
    await expect(session.call("orders.list", {}, { token: "has spaces" }).result).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(session.call("orders.list", {}, { recipeCache: "never" as never }).result).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("resume() with the same functions handles linked calls the same way", async () => {
    const provider = new FakeProvider();
    provider.handlers.set("writ_functions", () => ({
      origin: "https://arrivos.example",
      functions: PORTAL_KEYS.map((key) => ({ key, description: key, inputs: [], outputs: [], writes: false, local_network: false })),
    }));
    const { writ } = await writWith(provider);
    const functions = contractFunctions(linkedContract("token"));
    await expect(writ.resume({ functions })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const token = runTokenWith({ exp: inSeconds(600) });
    const session = (await writ.resume({ functions, getRunToken: async () => token })) as WritSession;
    const call = session.call("orders.list", {});
    await flush();
    expect(provider.sent("writ_call")).toEqual([{ key: "orders.list", inputs: {}, recipe_cache: "session", token }]);
    await call.cancel();
  });
});

describe("refreshRecipes()", () => {
  it("asks the provider through request({ method: \"writ_refresh_recipes\" }), from the client and the session", async () => {
    const provider = new FakeProvider();
    provider.handlers.set("writ_refresh_recipes", () => ({ ok: true }));
    const { writ } = await writWith(provider);
    const session = await writ.connect({ app: "Arrivos", functions: contractFunctions(linkedContract()) });
    await writ.refreshRecipes();
    await session.refreshRecipes();
    expect(provider.sent("writ_refresh_recipes")).toEqual([undefined, undefined]);
  });

  it("maps a refusal to a WritError", async () => {
    const provider = new FakeProvider();
    provider.handlers.set("writ_refresh_recipes", () => {
      throw { code: "DAEMON_UNAVAILABLE", message: "Writ is not running." };
    });
    const { writ } = await writWith(provider);
    await expect(writ.refreshRecipes()).rejects.toMatchObject({
      code: "DAEMON_UNAVAILABLE",
      details: { method: "writ_refresh_recipes" },
    });

    provider.handlers.delete("writ_refresh_recipes");
    await expect(writ.refreshRecipes()).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ---------------------------------------------------------------------------------------------
// The typed client
// ---------------------------------------------------------------------------------------------

/** A session double that records calls. */
function recordingSession(): { session: WritSession; calls: { key: string; options: CallOptions | undefined }[] } {
  const calls: { key: string; options: CallOptions | undefined }[] = [];
  const session = {
    call(key: string, _inputs?: object, options?: CallOptions) {
      calls.push({ key, options });
      return { recorded: true };
    },
  } as unknown as WritSession;
  return { session, calls };
}

describe("createWritClient(): linked workflows", () => {
  it("refuses a token-mode contract when neither the client nor the session has getRunToken", () => {
    const { session } = recordingSession();
    const error = thrown(() => createWritClient(session, linkedContract("token")));
    expect(isWritError(error, "BAD_REQUEST")).toBe(true);
    expect(error?.message).toContain("getRunToken");
    expect(() => createWritClient(session, linkedContract("public"))).not.toThrow();
  });

  it("passes its getRunToken and recipeCache on linked calls, under the call's own options", () => {
    const { session, calls } = recordingSession();
    const getRunToken = async (): Promise<string> => runTokenWith({ exp: inSeconds(600) });
    const client = createWritClient(session, linkedContract("token"), { getRunToken, recipeCache: "call" });
    client.orders?.list?.({});
    client.orders?.list?.({}, { recipeCache: "session", token: "given.run.token" });
    expect(calls).toEqual([
      { key: "orders.list", options: { token: getRunToken, recipeCache: "call" } },
      { key: "orders.list", options: { token: "given.run.token", recipeCache: "session" } },
    ]);
  });

  it("uses the session's getRunToken when the client has none (the banner's session)", async () => {
    const { provider, writ } = await writWith();
    const token = runTokenWith({ exp: inSeconds(600) });
    const session = await writ.connect({
      app: "Arrivos",
      functions: contractFunctions(linkedContract("token")),
      getRunToken: async () => token,
    });
    const client = createWritClient(session, linkedContract("token"));
    const call = client.orders?.list?.({});
    await flush();
    expect(provider.sent("writ_call")).toEqual([{ key: "orders.list", inputs: {}, recipe_cache: "session", token }]);
    await call?.cancel();
  });

  it("leaves calls to bundled packages untouched", () => {
    const { session, calls } = recordingSession();
    const client = createWritClient(session, bridgeContract(), { recipeCache: "call" });
    client.orders?.list?.({});
    expect(calls).toEqual([{ key: "orders.list", options: undefined }]);
  });
});

// ---------------------------------------------------------------------------------------------
// The banner: "Update" and "Unavailable"
// ---------------------------------------------------------------------------------------------

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await flush();
}

function bannerWith(overrides: Partial<WritBannerOptions> = {}, locale = "en-US") {
  const win = new BannerWindow({ userAgent: CHROME_UA, language: locale });
  const provider = new FakeProvider();
  installDirect(win, provider);
  // The extension remembers what the visitor granted, as the real one does.
  let granted: ReturnType<typeof grantFor>[] = [];
  provider.handlers.set("writ_connect", (params) => {
    granted = (params as { functions: FunctionRequest[] }).functions.map((fn) => grantFor(fn));
    return { origin: "https://arrivos.example", functions: granted };
  });
  provider.handlers.set("writ_functions", () => ({ origin: "https://arrivos.example", functions: granted }));
  const ready: WritSession[] = [];
  const banner = mountWritBanner({
    app: "Arrivos",
    contract: linkedContract(),
    onReady: (session) => ready.push(session),
    timeoutMs: 0,
    window: win as never,
    ...overrides,
  });
  return { win, provider, ready, banner };
}

/** Install through the banner, then fail one linked call with `code`. */
async function connectedThenFailed(code: string, overrides: Partial<WritBannerOptions> = {}, locale = "en-US") {
  const setup = bannerWith(overrides, locale);
  await settle();
  setup.win.control("primary")?.click();
  await settle();
  expect(setup.ready).toHaveLength(1);
  expect(setup.win.host()).toBeNull();

  const session = setup.ready[0] as WritSession;
  const call = session.call("orders.list", {});
  call.result.catch(() => undefined);
  await settle();
  setup.provider.emit({ call_id: "call-1", type: "error", code, message: "From Writ Cloud." });
  await settle();
  return { ...setup, session };
}

describe("mountWritBanner(): linked workflows", () => {
  it("refuses a token-mode contract without getRunToken, before rendering", () => {
    const win = new BannerWindow();
    let error: unknown;
    try {
      mountWritBanner({ app: "Arrivos", contract: linkedContract("token"), onReady: () => undefined, timeoutMs: 0, window: win as never });
    } catch (caught) {
      error = caught;
    }
    expect(isWritError(error, "BAD_REQUEST")).toBe(true);
    expect(win.document.created).toBe(0);
  });

  it("hands over a session that sends run tokens and the recipe policy", async () => {
    const token = runTokenWith({ exp: inSeconds(600) });
    const { win, provider, ready } = bannerWith({ contract: linkedContract("token"), getRunToken: async () => token, recipeCache: "call" });
    await settle();
    expect(win.control("primary")?.textContent).toBe("Install Arrivos supplier portal (one click)");
    win.control("primary")?.click();
    await settle();
    const call = (ready[0] as WritSession).call("orders.list", {});
    await settle();
    expect(provider.sent("writ_call")).toEqual([{ key: "orders.list", inputs: {}, recipe_cache: "call", token }]);
    await call.cancel();
  });

  it("GRANT_STALE on a linked call shows Update, which re-runs connect and hides again", async () => {
    const { win, provider, ready, banner } = await connectedThenFailed("GRANT_STALE");
    expect(win.state()).toBe("connect");
    expect(win.part("title")?.textContent).toBe("Update Arrivos supplier portal");
    expect(win.control("primary")?.textContent).toBe("Update Arrivos supplier portal (one click)");
    expect(win.part("note")?.textContent).toBe("");

    // A focus re-check keeps it: the grant is still listed, but the workflow needs the visitor.
    win.focusWindow();
    await settle();
    expect(win.state()).toBe("connect");
    expect(win.control("primary")?.textContent).toBe("Update Arrivos supplier portal (one click)");

    win.control("primary")?.click();
    await settle();
    expect(provider.sent("writ_connect")).toHaveLength(2);
    expect(win.host()).toBeNull();
    expect(ready).toHaveLength(1);
    await expect(banner.session).resolves.toBe(ready[0]);
  });

  it("PUBLICATION_REVOKED shows Unavailable with nothing to retry; closing it keeps the session", async () => {
    const { win, banner, ready } = await connectedThenFailed("PUBLICATION_REVOKED");
    expect(win.state()).toBe("unavailable");
    expect(win.part("title")?.textContent).toBe("Arrivos supplier portal is unavailable");
    expect(win.part("body")?.textContent).toBe("Arrivos withdrew it. It will not run on this computer until Arrivos offers it again.");
    expect(win.control("primary")).toBeNull();

    win.focusWindow();
    await settle();
    expect(win.state()).toBe("unavailable");

    win.control("dismiss")?.click();
    expect(win.host()).toBeNull();
    expect(win.sessionStorage.values.size).toBe(0);
    await expect(banner.session).resolves.toBe(ready[0]);
  });

  it("RECIPE_UNAVAILABLE shows Unavailable with Retry, which refreshes the recipes and hides", async () => {
    const { win, provider } = await connectedThenFailed("RECIPE_UNAVAILABLE");
    expect(win.state()).toBe("unavailable");
    expect(win.part("body")?.textContent).toBe("Writ could not get it from Arrivos. Check your internet connection, then retry.");
    expect(win.control("primary")?.textContent).toBe("Retry");

    provider.handlers.set("writ_refresh_recipes", () => ({ ok: true }));
    win.control("primary")?.click();
    await settle();
    expect(provider.sent("writ_refresh_recipes")).toHaveLength(1);
    expect(win.host()).toBeNull();
  });

  it("shows the manifest's name, which Writ Cloud vouches for, over the entry's own", async () => {
    const contract = linkedContract();
    const pkg = contract.packages[0] as WritLinkedPackage;
    pkg.name = "Anything the site wrote";
    pkg.publisher = { name: "Not verified" };
    (contract.functions[1] as { description: string }).description = "";
    const { win } = bannerWith({ contract });
    await settle();
    expect(win.control("primary")?.textContent).toBe("Install Arrivos supplier portal (one click)");
    // An empty description falls back to the package's name in consent: the vouched one.
    expect(contractFunctions(contract)[1]?.description).toBe("Arrivos supplier portal");
  });

  it("speaks French and Spanish", async () => {
    const fr = await connectedThenFailed("PUBLICATION_REVOKED", {}, "fr-FR");
    expect(fr.win.part("title")?.textContent).toBe("Arrivos supplier portal est indisponible");
    const es = await connectedThenFailed("RECIPE_UNAVAILABLE", {}, "es-ES");
    expect(es.win.part("title")?.textContent).toBe("Arrivos supplier portal no está disponible");
    expect(es.win.control("primary")?.textContent).toBe("Reintentar");
  });

  it("shows Unavailable when the install itself cannot fetch the manifest, and Retry connects again", async () => {
    const { win, provider, ready } = bannerWith();
    provider.handlers.set("writ_connect", () => {
      throw { code: "RECIPE_UNAVAILABLE", message: "Writ Cloud is unreachable." };
    });
    await settle();
    win.control("primary")?.click();
    await settle();
    expect(win.state()).toBe("unavailable");

    provider.handlers.set("writ_connect", (params) => ({
      origin: "https://arrivos.example",
      functions: (params as { functions: FunctionRequest[] }).functions.map((fn) => ({
        key: fn.key,
        description: fn.description,
        inputs: [],
        outputs: [],
        writes: false,
        local_network: false,
      })),
    }));
    win.control("primary")?.click();
    await settle();
    expect(provider.sent("writ_connect")).toHaveLength(2);
    expect(ready).toHaveLength(1);
  });

  it("never comes back for a bundled package's GRANT_STALE", async () => {
    const win = new BannerWindow();
    const provider = new FakeProvider();
    installDirect(win, provider);
    const ready: WritSession[] = [];
    mountWritBanner({
      app: "Arrivos",
      functions: [{ key: "pos.receive", description: "Receive an invoice in your POS", writes: true, package: posReceivePackage() }],
      onReady: (session) => ready.push(session),
      timeoutMs: 0,
      window: win as never,
    });
    await settle();
    win.control("primary")?.click();
    await settle();
    const call = (ready[0] as WritSession).call("pos.receive", { invoice_no: "F-1029" });
    call.result.catch(() => undefined);
    await settle();
    provider.emit({ call_id: "call-1", type: "error", code: "GRANT_STALE", message: "Changed." });
    await settle();
    expect(win.host()).toBeNull();
  });

  it("destroy() removes a banner that is watching", async () => {
    const { win, banner } = await connectedThenFailed("GRANT_STALE");
    expect(win.state()).toBe("connect");
    banner.destroy();
    expect(win.host()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The Writ Bridge
// ---------------------------------------------------------------------------------------------

describe("createWritBridge(): linked workflows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a token-mode linked workflow without getRunToken, unless it only runs on Writ Cloud", () => {
    const win = new BridgeWindow();
    const error = thrown(() => createWritBridge({ contract: linkedContract("token"), app: "Arrivos", window: win as never }));
    expect(error?.code).toBe("BAD_REQUEST");
    expect(error?.message).toContain("getRunToken");
    expect(thrown(() => createWritBridge({ contract: linkedContract(), app: "Arrivos", recipeCache: "always" as never, window: win as never }))?.code).toBe(
      "BAD_REQUEST",
    );
    createWritBridge({ contract: linkedContract("token"), app: "Arrivos", mode: "cloud", timeoutMs: 0, window: win as never }).destroy();
  });

  it("sends a run token and the recipe policy on local calls, minting once while the token is fresh", async () => {
    const token = runTokenWith({ exp: inSeconds(3_600) });
    const source = counting(() => token);
    const { provider, bridge } = setupBridge({
      contract: linkedContract("token"),
      granted: PORTAL_KEYS,
      getRunToken: source.getRunToken,
      recipeCache: "call",
    });
    await settleBridge();

    const first = bridge.orders.list();
    await settleBridge();
    expect(provider?.sent("writ_call")).toEqual([{ key: "orders.list", inputs: {}, recipe_cache: "call", token }]);
    finishCall(provider as FakeProvider, "call-1", { orders: ["PO-1"] });
    await expect(done(first)).resolves.toMatchObject({ data: { orders: ["PO-1"] }, venue: "user" });

    const second = bridge.orders.list(undefined, { recipeCache: "session" });
    await settleBridge();
    expect((provider?.sent("writ_call") as { recipe_cache?: string }[])[1]?.recipe_cache).toBe("session");
    expect(source.calls()).toBe(1);
    finishCall(provider as FakeProvider, "call-2", { orders: [] });
    await done(second);
    bridge.destroy();
  });

  it("refreshRecipes() asks the visitor's Writ, and rejects after destroy()", async () => {
    const { provider, bridge } = setupBridge({ contract: linkedContract(), granted: PORTAL_KEYS });
    await settleBridge();
    provider?.handlers.set("writ_refresh_recipes", () => ({ ok: true }));
    await done(bridge.refreshRecipes());
    expect(provider?.sent("writ_refresh_recipes")).toHaveLength(1);
    bridge.destroy();
    await expect(bridge.refreshRecipes()).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("brings its banner back with Update on GRANT_STALE, and removes it on destroy()", async () => {
    const { win, provider, bridge } = setupBridge({ contract: linkedContract(), granted: PORTAL_KEYS });
    await settleBridge();
    expect(win.host()).toBeNull();

    const pending = bridge.orders.list();
    pending.catch(() => undefined);
    await settleBridge();
    provider?.emit({ call_id: "call-1", type: "error", code: "GRANT_STALE", message: "The workflow changed." });
    await expect(done(pending)).rejects.toMatchObject({ code: "GRANT_STALE" });
    await settleBridge();
    expect(win.state()).toBe("connect");
    expect(win.control("primary")?.textContent).toBe("Update Arrivos supplier portal (one click)");

    bridge.destroy();
    expect(win.host()).toBeNull();
  });
});
