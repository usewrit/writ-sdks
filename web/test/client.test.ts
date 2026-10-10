/** Client and session: status, connect (validation, consent), resume, refresh, disconnect. */

import { describe, expect, it } from "vitest";
import { connectWrit, isWritError, type ConnectRequest, type WritClient } from "../src/index.js";
import {
  FakeProvider,
  FakeWindow,
  POS_RECEIVE,
  connected,
  deferred,
  flush,
  grantFor,
  installDirect,
} from "./fake-provider.js";

async function client(provider = new FakeProvider()): Promise<WritClient> {
  const win = new FakeWindow();
  installDirect(win, provider);
  const writ = await connectWrit({ window: win });
  if (!writ.available) throw new Error("expected a client");
  return writ;
}

describe("writ.status()", () => {
  it("returns writ_status as sent", async () => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    await expect(writ.status()).resolves.toEqual({
      extension_version: "1.0.0",
      protocol: 1,
      host: "ok",
      daemon: "running",
      desktop_version: "1.0.7",
      lan_capable: true,
    });
    expect(provider.requests).toEqual([{ method: "writ_status", params: undefined }]);
  });

  it("maps a provider failure to its code", async () => {
    const provider = new FakeProvider();
    provider.handlers.set("writ_status", () => {
      throw { code: "DESKTOP_MISSING", message: "Install Writ desktop." };
    });
    const writ = await client(provider);
    await expect(writ.status()).rejects.toMatchObject({ code: "DESKTOP_MISSING", message: "Install Writ desktop." });
  });
});

describe("writ.connect()", () => {
  it("sends the request and exposes the granted functions", async () => {
    const { provider, session } = await connected();

    expect(provider.sent("writ_connect")).toEqual([
      {
        app: "Arrivos",
        functions: [
          {
            key: "pos.receive",
            description: "Receive an invoice in your POS",
            writes: true,
            match: { host: "192.168.1.20" },
          },
        ],
      },
    ]);
    expect(session.origin).toBe("https://arrivos.example");
    expect(session.functions).toEqual([grantFor(POS_RECEIVE)]);
    expect(Object.isFrozen(session.functions)).toBe(true);
    expect(session.function("pos.receive")?.writes).toBe(true);
    expect(session.function("pos.receive")?.local_network).toBe(true);
    expect(session.function("missing")).toBeUndefined();
  });

  it("strips fields the contract does not define and trims text", async () => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    await writ.connect({
      app: "  Arrivos  ",
      functions: [
        {
          key: "pos.lookup",
          description: "  Look up a product  ",
          match: { name: " Auphan ", host: "", extra: 1 } as never,
          junk: true,
        } as never,
      ],
    });
    expect(provider.sent("writ_connect")).toEqual([
      { app: "Arrivos", functions: [{ key: "pos.lookup", description: "Look up a product", match: { name: "Auphan" } }] },
    ]);
  });

  const invalid: [string, unknown][] = [
    ["no app", { functions: [POS_RECEIVE] }],
    ["blank app", { app: "   ", functions: [POS_RECEIVE] }],
    ["app over 80 characters", { app: "a".repeat(81), functions: [POS_RECEIVE] }],
    ["no functions", { app: "Arrivos", functions: [] }],
    ["functions not an array", { app: "Arrivos", functions: POS_RECEIVE }],
    ["uppercase key", { app: "Arrivos", functions: [{ key: "POS.receive", description: "x" }] }],
    ["key starting with a dot", { app: "Arrivos", functions: [{ key: ".pos", description: "x" }] }],
    ["key over 64 characters", { app: "Arrivos", functions: [{ key: "a".repeat(65), description: "x" }] }],
    ["missing description", { app: "Arrivos", functions: [{ key: "pos.receive" }] }],
    ["description over 200 characters", { app: "Arrivos", functions: [{ key: "pos.receive", description: "d".repeat(201) }] }],
    ["duplicate keys", { app: "Arrivos", functions: [POS_RECEIVE, POS_RECEIVE] }],
    ["writes not a boolean", { app: "Arrivos", functions: [{ ...POS_RECEIVE, writes: "yes" }] }],
    ["match not an object", { app: "Arrivos", functions: [{ ...POS_RECEIVE, match: "192.168.1.20" }] }],
    ["match.host not a string", { app: "Arrivos", functions: [{ ...POS_RECEIVE, match: { host: 5 } }] }],
    ["not an object", null],
  ];

  it.each(invalid)("refuses %s with BAD_REQUEST before sending", async (_label, request) => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    await expect(writ.connect(request as ConnectRequest)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(provider.sent("writ_connect")).toEqual([]);
  });

  it("accepts the longest valid key, app and description", async () => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    const key = `a${"b".repeat(63)}`;
    await writ.connect({ app: "a".repeat(80), functions: [{ key, description: "d".repeat(200) }] });
    expect(provider.sent("writ_connect")).toHaveLength(1);
  });

  it("rejects with CONSENT_DENIED when the user declines", async () => {
    const provider = new FakeProvider();
    provider.handlers.set("writ_connect", () => {
      throw { code: "CONSENT_DENIED", message: "The user declined." };
    });
    const writ = await client(provider);
    const error: unknown = await writ.connect({ app: "Arrivos", functions: [POS_RECEIVE] }).catch((e: unknown) => e);
    expect(isWritError(error, "CONSENT_DENIED")).toBe(true);
    expect((error as { details?: unknown }).details).toEqual({ method: "writ_connect" });
  });

  it("refuses a malformed answer with INTERNAL", async () => {
    const provider = new FakeProvider();
    provider.handlers.set("writ_connect", () => ({ functions: "nope" }));
    const writ = await client(provider);
    await expect(writ.connect({ app: "Arrivos", functions: [POS_RECEIVE] })).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });

  it("drops granted entries without a key and normalises the rest", async () => {
    const provider = new FakeProvider();
    provider.handlers.set("writ_connect", () => ({
      origin: "https://arrivos.example",
      functions: [
        { description: "no key" },
        { key: "pos.receive", inputs: [{ name: "invoice_no" }, { nope: 1 }], outputs: ["a", 2] },
      ],
    }));
    const writ = await client(provider);
    const session = await writ.connect({ app: "Arrivos", functions: [POS_RECEIVE] });
    expect(session.functions).toEqual([
      {
        key: "pos.receive",
        description: "",
        inputs: [{ name: "invoice_no", required: false }],
        outputs: ["a"],
        writes: false,
        local_network: false,
      },
    ]);
  });
});

describe("granted packages", () => {
  it("keeps the installed package a grant reports, and nothing when it reports none", async () => {
    const provider = new FakeProvider();
    provider.handlers.set("writ_connect", () => ({
      origin: "https://arrivos.example",
      functions: [
        { ...grantFor(POS_RECEIVE), package: { id: "arrivos.pos-receive", version: "1.2.0" } },
        { ...grantFor({ key: "pos.lookup", description: "Look up" }), package: null },
        { ...grantFor({ key: "pos.count", description: "Count" }), package: { id: "arrivos.pos" } },
        { ...grantFor({ key: "pos.other", description: "Other" }), package: "nope" },
      ],
    }));
    const writ = await client(provider);
    const session = await writ.connect({ app: "Arrivos", functions: [POS_RECEIVE] });
    expect(session.function("pos.receive")?.package).toEqual({ id: "arrivos.pos-receive", version: "1.2.0" });
    expect(session.function("pos.lookup")?.package).toBeNull();
    expect(session.function("pos.count")?.package).toEqual({ id: "arrivos.pos", version: null });
    expect(session.function("pos.other")).not.toHaveProperty("package");
  });
});

describe("writ.resume()", () => {
  it("is null when this origin has no grant, and never opens consent", async () => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    await expect(writ.resume()).resolves.toBeNull();
    expect(provider.sent("writ_connect")).toEqual([]);
  });

  it("returns a session for an existing grant", async () => {
    const provider = new FakeProvider();
    provider.handlers.set("writ_functions", () => ({
      origin: "https://arrivos.example",
      functions: [grantFor(POS_RECEIVE)],
    }));
    const writ = await client(provider);
    const session = await writ.resume();
    expect(session?.function("pos.receive")?.key).toBe("pos.receive");
  });
});

describe("session.refresh()", () => {
  it("re-reads the grant", async () => {
    const { provider, session } = await connected();
    provider.handlers.set("writ_functions", () => ({
      origin: "https://arrivos.example",
      functions: [grantFor({ key: "pos.lookup", description: "Look up" })],
    }));
    const functions = await session.refresh();
    expect(functions.map((fn) => fn.key)).toEqual(["pos.lookup"]);
    expect(session.functions).toBe(functions);
    expect(session.function("pos.receive")).toBeUndefined();
  });
});

describe("session.disconnect()", () => {
  it("cancels running calls, revokes the grant, and closes the session", async () => {
    const { provider, session } = await connected();
    const call = session.call("pos.receive", { invoice_no: "F-1029" });
    const outcome = call.result.catch((e: unknown) => e);
    const id = await call.callId;

    await session.disconnect();

    expect(isWritError(await outcome, "CANCELLED")).toBe(true);
    expect(provider.sent("writ_cancel")).toEqual([{ call_id: id }]);
    expect(provider.requests.map((r) => r.method).slice(-2)).toEqual(["writ_cancel", "writ_disconnect"]);
    expect(session.functions).toEqual([]);

    const later = session.call("pos.receive", { invoice_no: "F-1030" });
    await expect(later.result).rejects.toMatchObject({ code: "NOT_GRANTED" });
    expect(provider.sent("writ_call")).toHaveLength(1);
  });

  it("can be retried when writ_disconnect fails", async () => {
    const { provider, session } = await connected();
    const failing = deferred<unknown>();
    provider.handlers.set("writ_disconnect", () => failing.promise);
    const first = session.disconnect();
    await flush();
    failing.reject({ code: "DAEMON_UNAVAILABLE", message: "Writ is not running." });
    await expect(first).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });

    provider.handlers.set("writ_disconnect", () => ({ ok: true }));
    await expect(session.disconnect()).resolves.toBeUndefined();
    await flush();
    expect(provider.sent("writ_disconnect")).toHaveLength(2);
  });
});
