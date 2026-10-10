/** Shared setup for the Writ Bridge tests: a page, the extension (optional) and the bridge. */

import { vi } from "vitest";
import {
  createWritBridge,
  type CallEvent,
  type WritBridge,
  type WritBridgeOptions,
  type WritReceipt,
} from "../src/index.js";
import { FakeProvider, grantFor, installDirect } from "./fake-provider.js";
import { BridgeWindow, PAGE_ORIGIN } from "./fake-server.js";
import { bridgeContract } from "./fixtures.js";

/** The `WritFunctions` interface Writ would generate for {@link bridgeContract}. */
export interface PortalFunctions {
  "auth.verify_login": { inputs: { company: string; username: string }; outputs: { ok: boolean } };
  "orders.list": { inputs: Record<string, never>; outputs: { orders: string[] } };
}

export const PORTAL_KEYS = ["auth.verify_login", "orders.list"];

export interface BridgeSetup {
  win: BridgeWindow;
  /** Null when the visitor has no Writ extension. */
  provider: FakeProvider | null;
  bridge: WritBridge<PortalFunctions>;
}

export interface SetupOptions extends Partial<WritBridgeOptions> {
  /** False: the visitor has no Writ extension. Default true. */
  extension?: boolean;
  /** Keys the visitor already granted this site. Default none. */
  granted?: readonly string[];
}

/** The visitor's Writ grants these keys to the page (`writ_functions`). */
export function grantKeys(provider: FakeProvider, keys: readonly string[]): void {
  provider.handlers.set("writ_functions", () => ({
    origin: PAGE_ORIGIN,
    functions: keys.map((key) => grantFor({ key, description: key })),
  }));
}

export function setupBridge(options: SetupOptions = {}): BridgeSetup {
  const { extension, granted, ...rest } = options;
  const win = new BridgeWindow();
  let provider: FakeProvider | null = null;
  if (extension !== false) {
    provider = new FakeProvider();
    installDirect(win, provider);
    if (granted !== undefined) grantKeys(provider, granted);
  }
  const bridge = createWritBridge<PortalFunctions>({
    contract: bridgeContract(),
    app: "Arrivos",
    timeoutMs: 0,
    window: win as never,
    ...rest,
  });
  return { win, provider, bridge };
}

/** Let promises, discovery and zero-delay timers run (fake timers). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await vi.advanceTimersByTimeAsync(0);
}

/** Settle until `promise` is done, then hand it back (fake timers). */
export async function done<T>(promise: Promise<T>): Promise<T> {
  let finished = false;
  promise.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  for (let i = 0; i < 100 && !finished; i += 1) await vi.advanceTimersByTimeAsync(0);
  return promise;
}

/** Whether `promise` has settled yet, without waiting for it. */
export async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let finished = false;
  promise.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  await settle();
  return finished;
}

/** A receipt as the visitor's Writ signs it (CONTRACT.md §12.1). */
export function makeReceipt(overrides: Partial<WritReceipt> = {}): WritReceipt {
  return {
    v: 1,
    origin: PAGE_ORIGIN,
    key: "auth.verify_login",
    package: "arrivos.portal",
    function: "verify_login",
    challenge: null,
    outcome: "success",
    error_code: null,
    data_hash: "ab".repeat(32),
    run_id: 41,
    started_at: 1_791_550_000,
    finished_at: 1_791_550_002,
    writ: { version: "1.0.8" },
    device: { kid: "0123456789abcdef", alg: "Ed25519", public_key: "A".repeat(43), hardware: false },
    sig: "B".repeat(86),
    ...overrides,
  };
}

/** The extension says call `callId` finished. */
export function finishCall(
  provider: FakeProvider,
  callId: string,
  data: unknown,
  receipt: WritReceipt | null = null,
): void {
  const event: CallEvent = { call_id: callId, type: "finished", run_id: 41, data, duration_ms: 12, engine: "http", receipt };
  provider.emit(event);
}
