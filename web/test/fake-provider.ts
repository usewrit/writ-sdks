/**
 * Test doubles: a minimal EventTarget window and a scriptable provider that behaves like the
 * extension's `window.writ` (CONTRACT.md §1). No jsdom: the library only needs events.
 */

import {
  ANNOUNCE_PROVIDER_EVENT,
  REQUEST_PROVIDER_EVENT,
  connectWrit,
  type CallEvent,
  type FunctionRequest,
  type WritClient,
  type WritNavigator,
  type WritProvider,
  type WritSession,
} from "../src/index.js";

export const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
export const EDGE_UA = `${CHROME_UA} Edg/141.0.0.0`;
export const FIREFOX_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) Gecko/20100101 Firefox/141.0";

/** `CustomEvent` without relying on the Node global (absent before Node 19). */
export class TestCustomEvent<T> extends Event {
  readonly detail: T;
  constructor(type: string, init: { detail: T }) {
    super(type);
    this.detail = init.detail;
  }
}

/** The parts of `window` the library uses. */
export class FakeWindow extends EventTarget {
  declare readonly writ?: unknown;
  navigator: WritNavigator;
  readonly Event = Event;

  constructor(navigator: WritNavigator = { userAgent: CHROME_UA }) {
    super();
    this.navigator = navigator;
  }
}

type Handler = (params: unknown) => unknown;

export interface RecordedRequest {
  method: string;
  params: unknown;
}

/** A provider whose methods are scriptable per test. */
export class FakeProvider implements WritProvider {
  readonly isWrit = true as const;
  readonly version: string = "1.0.0";
  readonly protocol: 1 = 1;
  readonly requests: RecordedRequest[] = [];
  readonly handlers = new Map<string, Handler>();
  readonly #listeners = new Set<(payload: CallEvent) => void>();
  #nextCall = 0;

  constructor() {
    this.handlers.set("writ_status", () => ({
      extension_version: this.version,
      protocol: 1,
      host: "ok",
      daemon: "running",
      desktop_version: "1.0.7",
      lan_capable: true,
    }));
    this.handlers.set("writ_connect", (params) => ({
      origin: "https://arrivos.example",
      functions: ((params as { functions: FunctionRequest[] }).functions ?? []).map((fn) => grantFor(fn)),
    }));
    this.handlers.set("writ_functions", () => ({ origin: "https://arrivos.example", functions: [] }));
    this.handlers.set("writ_call", () => {
      this.#nextCall += 1;
      return { call_id: `call-${this.#nextCall}` };
    });
    this.handlers.set("writ_cancel", () => ({ ok: true }));
    this.handlers.set("writ_disconnect", () => ({ ok: true }));
  }

  async request(args: { method: string; params?: unknown }): Promise<unknown> {
    this.requests.push({ method: args.method, params: args.params });
    const handler = this.handlers.get(args.method);
    if (handler === undefined) throw { code: "BAD_REQUEST", message: `Unknown method ${args.method}` };
    return handler(args.params);
  }

  on(event: "call", listener: (payload: CallEvent) => void): void {
    if (event === "call") this.#listeners.add(listener);
  }

  off(event: "call", listener: (payload: CallEvent) => void): void {
    if (event === "call") this.#listeners.delete(listener);
  }

  /** Deliver a `call` event to every listener, as the bridge would. */
  emit(event: CallEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  sent(method: string): unknown[] {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }
}

/** What the fake extension grants for a requested function. */
export function grantFor(fn: FunctionRequest) {
  return {
    key: fn.key,
    description: fn.description,
    inputs: [{ name: "invoice_no", required: true, description: "Invoice number" }],
    outputs: ["received", "lines"],
    writes: fn.writes === true,
    local_network: true,
  };
}

/** Define `window.writ` the way the extension does: frozen, not writable, not configurable. */
export function installDirect(win: FakeWindow, provider: unknown): void {
  Object.defineProperty(win, "writ", { value: provider, writable: false, configurable: false });
}

/** Announce `provider` once, as the extension does at injection. */
export function announce(win: FakeWindow, provider: { version?: unknown; protocol?: unknown }): void {
  win.dispatchEvent(
    new TestCustomEvent(ANNOUNCE_PROVIDER_EVENT, {
      detail: Object.freeze({
        provider,
        info: { name: "Writ", version: provider.version, protocol: provider.protocol },
      }),
    }),
  );
}

/** Re-announce on every `writ:requestProvider`, as the extension does. Returns the count. */
export function announceOnRequest(win: FakeWindow, provider: { version?: unknown; protocol?: unknown }): () => number {
  let requests = 0;
  win.addEventListener(REQUEST_PROVIDER_EVENT, () => {
    requests += 1;
    announce(win, provider);
  });
  return () => requests;
}

export const POS_RECEIVE: FunctionRequest = {
  key: "pos.receive",
  description: "Receive an invoice in your POS",
  writes: true,
  match: { host: "192.168.1.20" },
};

/** A connected client and session over a fresh fake provider. */
export async function connected(provider: FakeProvider = new FakeProvider()): Promise<{
  provider: FakeProvider;
  win: FakeWindow;
  writ: WritClient;
  session: WritSession;
}> {
  const win = new FakeWindow();
  installDirect(win, provider);
  const writ = await connectWrit({ window: win });
  if (!writ.available) throw new Error("expected the fake provider to be found");
  const session = await writ.connect({ app: "Arrivos", functions: [POS_RECEIVE] });
  return { provider, win, writ, session };
}

/** Let pending promise callbacks run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise with its resolvers. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
