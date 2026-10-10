/** Contracts, keys, golden files and a fake page shared by the tests. */

import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  canonicalJson,
  createWritBridge,
  dataHash,
  inputsHash,
  kidOf,
  type WritBridge,
  type WritBridgeOptions,
  type WritCommand,
  type WritContract,
  type WritReceipt,
} from "../src/index.js";

/** The golden secret (40 bytes), from `sdks/fixtures/bridge_tokens_golden.json`. */
export const SECRET = "writ-bridge-test-secret-0123456789abcdef";

/** 2026-10-09T10:46:40Z, a little before every golden expiry. */
export const T0 = 1_791_550_000_000;

/** The Ed25519 seed of the golden receipt. */
export const GOLDEN_SEED_HEX = "0707070707070707070707070707070707070707070707070707070707070707";
/** Another device. */
export const OTHER_SEED_HEX = "0909090909090909090909090909090909090909090909090909090909090909";

export const ORIGIN = "https://app.example.com";

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as Record<string, unknown>;
}

/** `sdks/fixtures/bridge_tokens_golden.json`. */
export function tokensGolden(): {
  secret: string;
  user_token: { payload: Record<string, unknown>; payload_canonical: string; token: string };
  challenge: { payload: Record<string, unknown>; payload_canonical: string; token: string };
} {
  return readJson("../../fixtures/bridge_tokens_golden.json") as never;
}

/** One vector of `sdks/fixtures/run_token_golden.json`. */
export interface RunTokenVector {
  sub: string | null;
  exp: number;
  header_json: string;
  payload_json: string;
  signing_input: string;
  token: string;
}

/** `sdks/fixtures/run_token_golden.json` (written by `run_token_golden_gen.py`, shared with Python). */
export function runTokenGolden(): {
  secret: string;
  publication: string;
  iat: number;
  ttl_seconds: number;
  with_sub: RunTokenVector;
  without_sub: RunTokenVector;
} {
  return readJson("../../fixtures/run_token_golden.json") as never;
}

/** `fixtures/receipt_golden.json`: a byte-for-byte copy of the Writ engine's receipt golden file. */
export const RECEIPT_GOLDEN_COPY = new URL("./fixtures/receipt_golden.json", import.meta.url);

/** The engine's own receipt golden file, when `WRIT_RECEIPT_GOLDEN` names it (the monorepo's publish script does). */
export const RECEIPT_GOLDEN_ENGINE = process.env.WRIT_RECEIPT_GOLDEN || undefined;

/**
 * The Writ engine's receipt golden file (the daemon writes it): the engine's own when
 * `WRIT_RECEIPT_GOLDEN` names it, otherwise the copy, so this package also tests on its own.
 */
export function receiptGolden(): {
  test_seed_hex: string;
  public_key: string;
  data: unknown;
  data_canonical: string;
  data_hash: string;
  receipt: WritReceipt;
  receipt_canonical_unsigned: string;
} {
  return JSON.parse(readFileSync(RECEIPT_GOLDEN_ENGINE ?? RECEIPT_GOLDEN_COPY, "utf8")) as never;
}

/** The functions Writ generates next to the contract (`writ-functions.d.ts`). */
export interface WritFunctions {
  "auth.verify_login": { inputs: { company: string; username: string }; outputs: { ok: boolean; user: string } };
  "pos.receive": { inputs: { invoice_no: string }; outputs: { received: boolean; lines: number } };
  "orders.list": { inputs: { status?: string }; outputs: { orders: number } };
  "reports.export": { inputs: { month: string }; outputs: { url: string } };
}

/**
 * Four functions: one per routing case.
 * - `auth.verify_login`: no mode of its own (the bridge's);
 * - `pos.receive`: reaches the visitor's network, so always `required`;
 * - `orders.list`: `recommended`, mapped to Writ Cloud workflow 12 function `list_orders`;
 * - `reports.export`: `cloud`, mapped to the whole of workflow 13.
 */
export function contract(): WritContract {
  return {
    format: "writ.contract/v1",
    generated_at: "2026-10-09T12:00:00Z",
    generator: "writ-cloud",
    publisher: { name: "Arrivos" },
    functions: [
      {
        key: "auth.verify_login",
        description: "Check the user can sign in to the supplier portal",
        package: "app.auth",
        function: "verify_login",
        inputs: [
          { name: "company", required: true },
          { name: "username", required: true },
        ],
        outputs: ["ok", "user"],
        writes: false,
        local_network: [],
      },
      {
        key: "pos.receive",
        description: "Receive a supplier invoice in the POS",
        package: "app.pos",
        function: "receive",
        inputs: [{ name: "invoice_no", required: true }],
        outputs: ["received", "lines"],
        writes: true,
        local_network: ["192.168.1.20:8080"],
      },
      {
        key: "orders.list",
        description: "List the supplier's open orders",
        package: "app.orders",
        function: "list_orders",
        inputs: [{ name: "status", required: false }],
        outputs: ["orders"],
        writes: false,
        local_network: [],
        mode: "recommended",
        cloud: { workflow_id: 12, function: "list_orders" },
      },
      {
        key: "reports.export",
        description: "Export the month's report",
        package: "app.reports",
        function: null,
        inputs: [{ name: "month", required: true }],
        outputs: ["url"],
        writes: false,
        local_network: [],
        mode: "cloud",
        cloud: { workflow_id: 13, function: null },
      },
    ],
    packages: [
      { id: "app.auth", format: "writ.workflow/v1", name: "Supplier sign-in", steps: [] },
      { id: "app.pos", format: "writ.workflow/v1", name: "POS", steps: [] },
      { id: "app.orders", format: "writ.workflow/v1", name: "Orders", steps: [] },
      { id: "app.reports", format: "writ.workflow/v1", name: "Reports", steps: [] },
    ],
  };
}

/** A mutable clock for a bridge. */
export interface Clock {
  now: () => number;
  set(ms: number): void;
  advance(ms: number): void;
}

export function clock(start = T0): Clock {
  let t = start;
  return {
    now: () => t,
    set(ms) {
      t = ms;
    },
    advance(ms) {
      t += ms;
    },
  };
}

/** A bridge with test defaults: the golden secret, a fixed clock, a fetch that fails loudly. */
export function testBridge(
  overrides: Partial<WritBridgeOptions> = {},
  time: Clock = clock(),
): WritBridge<WritFunctions> {
  return createWritBridge<WritFunctions>({
    contract: contract(),
    secret: SECRET,
    apiKey: "wrk_test_key",
    cloudBase: "https://cloud.test",
    now: time.now,
    cloudPoll: { initialMs: 5, maxMs: 10 },
    fetch: (async () => {
      throw new Error("unexpected Writ Cloud call");
    }) as unknown as typeof fetch,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------------------------
// Device keys and receipts
// ---------------------------------------------------------------------------------------------

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The Ed25519 key of a 32-byte seed, and its raw public key in base64url. */
export function deviceKey(seedHex: string): { privateKey: ReturnType<typeof createPrivateKey>; publicKey: string } {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return { privateKey, publicKey: Buffer.from(spki.subarray(spki.length - 32)).toString("base64url") };
}

/** Sign `unsigned` (a receipt without `sig`) the way the Writ engine does. */
export function signReceipt(unsigned: Omit<WritReceipt, "sig"> | Record<string, unknown>, seedHex = GOLDEN_SEED_HEX): WritReceipt {
  const { privateKey } = deviceKey(seedHex);
  const sig = sign(null, Buffer.from(canonicalJson(unsigned), "utf8"), privateKey).toString("base64url");
  return { ...(unsigned as Record<string, unknown>), sig } as WritReceipt;
}

/** A complete, signed receipt for a call; `fields` override anything before signing. */
export function makeReceipt(
  fields: { key: string; challenge: string | null; data?: unknown; inputs?: unknown } & Partial<Omit<WritReceipt, "sig">>,
  seedHex = GOLDEN_SEED_HEX,
): WritReceipt {
  const { publicKey } = deviceKey(seedHex);
  const { data, inputs, ...rest } = fields;
  const outcome = rest.outcome ?? "success";
  const unsigned: Omit<WritReceipt, "sig"> = {
    v: 1,
    origin: ORIGIN,
    package: "app.auth",
    function: "verify_login",
    outcome,
    error_code: null,
    data_hash: outcome === "success" ? dataHash(data ?? null) : null,
    run_id: 7,
    started_at: Math.floor(T0 / 1000),
    finished_at: Math.floor(T0 / 1000) + 2,
    writ: { version: "1.0.7" },
    device: { kid: kidOf(Buffer.from(publicKey, "base64url")), alg: "Ed25519", public_key: publicKey, hardware: false },
    // What the call ran with, as the daemon binds it (`inputs_hash`), when the test says.
    ...(inputs !== undefined ? { inputs_hash: inputsHash(rest.challenge ?? null, inputs) } : {}),
    ...rest,
  };
  return signReceipt(unsigned, seedHex);
}

// ---------------------------------------------------------------------------------------------
// A fake page speaking the page channel through bridge.handler
// ---------------------------------------------------------------------------------------------

export const ENDPOINT = "https://app.example.com/writ-bridge";

export interface FakePage {
  hello(body: { ready: boolean; granted: string[]; writ_version?: string | null }): Promise<Response>;
  poll(wait?: number | string): Promise<Response>;
  /** Poll until a command arrives (at most `wait` seconds). */
  nextCommand(wait?: number): Promise<WritCommand>;
  post(body: unknown): Promise<Response>;
  /** Run `command` "on the user's computer": post `data` with a genuine receipt. */
  answer(command: WritCommand, data: unknown, receipt?: Partial<WritReceipt>): Promise<Response>;
}

export function fakePage(bridge: WritBridge<WritFunctions>, token: string): FakePage {
  const headers = { authorization: `Writ ${token}`, "content-type": "application/json" };
  const page: FakePage = {
    hello: (body) => bridge.handler(new Request(ENDPOINT, { method: "POST", headers, body: JSON.stringify({ hello: { writ_version: "1.0.7", ...body } }) })),
    poll: (wait = 0) => bridge.handler(new Request(`${ENDPOINT}?wait=${wait}`, { method: "GET", headers: { authorization: headers.authorization } })),
    async nextCommand(wait = 5) {
      const response = await page.poll(wait);
      const body = (await response.json()) as { commands: WritCommand[] };
      const command = body.commands[0];
      if (command === undefined) throw new Error("no command arrived");
      return command;
    },
    post: (body) => bridge.handler(new Request(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) })),
    answer: (command, data, receipt = {}) =>
      page.post({
        result: { id: command.id, ok: true, data, receipt: makeReceipt({ key: command.key, challenge: command.challenge, inputs: command.inputs, data, ...receipt }) },
      }),
  };
  return page;
}

/** The rejection of a promise, or a failure if it resolved. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** A `fetch` double answering from a list of handlers, recording every request. */
export function mockFetch(
  respond: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] } {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetcher = (async (input: unknown, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    calls.push({ url, method, headers, body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown) });
    return respond(url, { method, headers, ...(init.body !== undefined ? { body: init.body } : {}) });
  }) as unknown as typeof fetch;
  return { fetch: fetcher, calls };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
