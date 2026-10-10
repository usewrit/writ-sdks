/**
 * The page channel: the one route the developer mounts (docs/browser-extension/CONTRACT.md §12.3).
 *
 * | request | body | answer |
 * |---|---|---|
 * | `POST` | `{ hello: { ready, granted, writ_version } }` | `204` |
 * | `GET ?wait=N` | none | `200 { commands: [...] }` (long-poll, N at most `pollSeconds`) |
 * | `POST` | `{ result: { id, ok, data, receipt } }` or `{ result: { id, ok: false, error, receipt? } }` | `204` |
 * | `POST` | `{ run: { key, inputs, options } }` | `200 { data, venue: "cloud" }` (`recommended` / `cloud` only) |
 *
 * Every request carries `Authorization: Writ <userToken>`. Errors answer `{ error: { code, message } }`.
 */

import {
  DEFAULT_CALL_TIMEOUT_MS,
  FUNCTION_KEY_PATTERN,
  MAX_CALL_TIMEOUT_MS,
  MAX_COMMANDS_PER_POLL,
  MAX_GRANTED_KEYS,
  MAX_PAGE_RUNS_PER_USER,
  MIN_CALL_TIMEOUT_MS,
  PRESENCE_RETENTION_MS,
} from "./constants.js";
import { checkInputs, type WritBridgeMode, type WritContractFunction } from "./contract.js";
import { WritBridgeError, defaultMessage, httpStatusOf, type WritBridgeErrorCode } from "./errors.js";
import { describeValue, isPlainObject, type JsonObject } from "./json.js";
import type { WritBridgeStore, WritCommandOutcome, WritPendingCommand, WritPresence } from "./store.js";
import { readUserToken } from "./tokens.js";
import { checkReceipt, type ReceiptExpectations, type ReceiptVerdict, type WritDevicePolicy } from "./verify.js";

/** What the channel needs from the bridge. */
export interface ChannelContext {
  secret: Buffer | null;
  store: WritBridgeStore;
  pollSeconds: number;
  maxBodyBytes: number;
  now: () => number;
  functions: ReadonlyMap<string, WritContractFunction>;
  modeOf(key: string): WritBridgeMode;
  devices: WritDevicePolicy;
  authorizeRun?: (userId: string, key: string, inputs: JsonObject) => boolean | Promise<boolean>;
  runCloud(fn: WritContractFunction, inputs: JsonObject, options: { timeoutMs: number; dryRun: boolean }, signal?: AbortSignal): Promise<unknown>;
  /** Page `run` calls in flight per user, on this instance. */
  pageRuns: Map<string, number>;
}

const BASE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", ...extra },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

function failure(status: number, code: WritBridgeErrorCode, message: string, extra: Record<string, string> = {}): Response {
  return json(status, { error: { code, message } }, extra);
}

function badRequest(message: string): WritBridgeError {
  return new WritBridgeError("BAD_REQUEST", message);
}

/** Thrown by the body reader: the body is over the limit. */
class BodyTooLarge extends Error {}

/** Serve one page channel request. Never throws: every failure is an error response. */
export async function handleChannel(ctx: ChannelContext, request: Request): Promise<Response> {
  try {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "POST") {
      return failure(405, "BAD_REQUEST", "The Writ Bridge route answers GET and POST.", { allow: "GET, POST" });
    }
    if (ctx.secret === null) {
      return failure(503, "CONFIG_INVALID", "WRIT_BRIDGE_SECRET is not set, so this bridge cannot serve pages.");
    }
    const userId = authenticate(ctx.secret, request.headers.get("authorization"), ctx.now());
    if (userId === null) {
      return failure(401, "NOT_GRANTED", "The Writ user token is missing, invalid or expired.", { "www-authenticate": "Writ" });
    }
    return method === "GET" ? await poll(ctx, request, userId) : await post(ctx, request, userId);
  } catch (error) {
    if (error instanceof BodyTooLarge) {
      return failure(413, "BAD_REQUEST", `The request body is larger than ${ctx.maxBodyBytes} bytes.`);
    }
    if (error instanceof WritBridgeError && error.code !== "INTERNAL") {
      return failure(httpStatusOf(error.code), error.code, error.message);
    }
    // Never echo an unexpected failure to the page: it may name internals.
    return failure(500, "INTERNAL", defaultMessage("INTERNAL"));
  }
}

function authenticate(secret: Buffer, header: string | null, nowMs: number): string | null {
  if (header === null) return null;
  const match = /^\s*Writ\s+(\S+)\s*$/i.exec(header);
  if (match === null) return null;
  const payload = readUserToken(secret, match[1], Math.floor(nowMs / 1000));
  return payload === null ? null : payload.sub;
}

// ---------------------------------------------------------------------------------------------
// GET: long-poll for commands
// ---------------------------------------------------------------------------------------------

async function poll(ctx: ChannelContext, request: Request, userId: string): Promise<Response> {
  let waitSeconds = 0;
  const raw = new URL(request.url).searchParams.get("wait");
  if (raw !== null && raw !== "") {
    if (!/^[0-9]{1,6}$/.test(raw)) throw badRequest("`wait` must be a whole number of seconds.");
    waitSeconds = Math.min(Number(raw), ctx.pollSeconds);
  }

  await touchPresence(ctx, userId);
  const signal = request.signal;
  const commands = await ctx.store.take(userId, waitSeconds * 1000, { max: MAX_COMMANDS_PER_POLL, signal });
  if (signal.aborted && commands.length > 0) {
    // The page left while we waited: nobody will read this answer, so the commands go back.
    await ctx.store.requeue(userId, commands);
    return json(200, { commands: [] });
  }
  const nowSeconds = Math.floor(ctx.now() / 1000);
  return json(200, { commands: commands.filter((command) => command.expires_at > nowSeconds) });
}

async function touchPresence(ctx: ChannelContext, userId: string): Promise<void> {
  const previous = await ctx.store.getPresence(userId);
  const next: WritPresence = previous === null
    ? { ready: false, granted: [], writ_version: null, last_seen: ctx.now(), ever_ready: false }
    : { ...previous, last_seen: ctx.now() };
  await ctx.store.setPresence(userId, next, PRESENCE_RETENTION_MS);
}

// ---------------------------------------------------------------------------------------------
// POST: hello, result, run
// ---------------------------------------------------------------------------------------------

async function post(ctx: ChannelContext, request: Request, userId: string): Promise<Response> {
  const body = parseObject(await readBody(request, ctx.maxBodyBytes));
  const kinds = ["hello", "result", "run"].filter((name) => body[name] !== undefined);
  if (kinds.length !== 1) throw badRequest("The body must carry exactly one of hello, result or run.");
  if (body.hello !== undefined) return hello(ctx, userId, body.hello);
  if (body.result !== undefined) return result(ctx, userId, body.result);
  return run(ctx, request, userId, body.run);
}

function parseObject(text: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw badRequest("The body must be JSON.");
  }
  if (!isPlainObject(body)) throw badRequest("The body must be a JSON object { hello } | { result } | { run }.");
  return body;
}

async function readBody(request: Request, limit: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw new BodyTooLarge();
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function hello(ctx: ChannelContext, userId: string, raw: unknown): Promise<Response> {
  if (!isPlainObject(raw)) throw badRequest("hello must be { ready, granted, writ_version }.");
  const ready = raw.ready;
  if (typeof ready !== "boolean") throw badRequest("hello.ready must be true or false.");
  const granted = raw.granted ?? [];
  if (!Array.isArray(granted) || granted.length > MAX_GRANTED_KEYS || !granted.every((key: unknown) => typeof key === "string")) {
    throw badRequest(`hello.granted must be an array of at most ${MAX_GRANTED_KEYS} function keys.`);
  }
  const rawVersion = raw.writ_version ?? null;
  if (rawVersion !== null && (typeof rawVersion !== "string" || rawVersion.length > 64)) {
    throw badRequest("hello.writ_version must be a version string or null.");
  }
  const version: string | null = typeof rawVersion === "string" ? rawVersion : null;
  // Only keys of this contract matter; the rest is noise a page cannot use.
  const keys = [...new Set((granted as string[]).filter((key) => ctx.functions.has(key)))];
  const previous = await ctx.store.getPresence(userId);
  await ctx.store.setPresence(
    userId,
    {
      ready,
      granted: keys,
      writ_version: version,
      last_seen: ctx.now(),
      ever_ready: (previous?.ever_ready ?? false) || ready,
    },
    PRESENCE_RETENTION_MS,
  );
  return noContent();
}

async function result(ctx: ChannelContext, userId: string, raw: unknown): Promise<Response> {
  if (!isPlainObject(raw)) throw badRequest("result must be { id, ok, data, receipt } or { id, ok: false, error, receipt? }.");
  const id = raw.id;
  if (typeof id !== "string" || id === "" || id.length > 64) throw badRequest("result.id must be a command id.");
  if (typeof raw.ok !== "boolean") throw badRequest("result.ok must be true or false.");

  const pending = await ctx.store.pending(id);
  // Another user's command answers exactly like an unknown one: ids are not to be probed.
  if (pending === null || pending.user !== userId) {
    return failure(404, "BAD_REQUEST", "No command with that id is waiting for a result.");
  }

  const expect = expectationsFor(ctx, pending, userId);
  let outcome: WritCommandOutcome;
  if (raw.ok) {
    if (!("data" in raw)) {
      outcome = unverified(pending, { reason: "the result carries no data" });
    } else {
      const verdict = await checkReceipt(raw.receipt, { ...expect, data: { value: raw.data }, requireSuccess: true });
      outcome = verdict.ok && verdict.receipt !== undefined
        ? { ok: true, data: raw.data, receipt: verdict.receipt }
        : unverified(pending, verdict);
    }
  } else {
    const error = visitorError(raw.error);
    if (raw.receipt === undefined || raw.receipt === null) {
      outcome = { ok: false, error, receipt: null };
    } else {
      const verdict = await checkReceipt(raw.receipt, { ...expect, requireSuccess: false });
      outcome = verdict.ok && verdict.receipt !== undefined
        ? { ok: false, error, receipt: verdict.receipt }
        : unverified(pending, verdict);
    }
  }
  await ctx.store.resolve(pending.id, outcome);
  return noContent();
}

function expectationsFor(ctx: ChannelContext, pending: WritPendingCommand, userId: string): Omit<ReceiptExpectations, "requireSuccess"> {
  const expect: Omit<ReceiptExpectations, "requireSuccess"> = {
    secret: ctx.secret as Buffer,
    nowSeconds: Math.floor(ctx.now() / 1000),
    challenge: pending.challenge,
    key: pending.key,
    subject: userId,
    nonce: pending.id,
    spendNonce: (nonce, ttlMs) => ctx.store.spendNonce(nonce, ttlMs),
    ...(pending.inputs_hash !== undefined ? { inputsHash: pending.inputs_hash } : {}),
    devices: ctx.devices,
    checkDevice: (subject, publicKey, firstUse) => ctx.store.checkDevice(subject, publicKey, firstUse),
  };
  return expect;
}

function unverified(pending: WritPendingCommand, verdict: Pick<ReceiptVerdict, "reason"> & Partial<ReceiptVerdict>): WritCommandOutcome {
  const reason = verdict.reason ?? "the receipt does not verify";
  const error = { code: "RESULT_UNVERIFIED", message: `The result for ${pending.key} was refused: ${reason}.` };
  // Hand the developer the device to approve, when that is the only thing wrong.
  return verdict.unknownDevice === true && verdict.device
    ? { ok: false, error, unknownDevice: verdict.device }
    : { ok: false, error };
}

/** The `{ code, message }` a page reported, made safe to carry. */
function visitorError(raw: unknown): { code: string; message: string } {
  const record = isPlainObject(raw) ? raw : {};
  const code = typeof record.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(record.code) ? record.code : "INTERNAL";
  const message = typeof record.message === "string" && record.message.trim() !== ""
    ? record.message.slice(0, 1_000)
    : "The call failed on the user's computer.";
  return { code, message };
}

async function run(ctx: ChannelContext, request: Request, userId: string, raw: unknown): Promise<Response> {
  if (!isPlainObject(raw)) throw badRequest("run must be { key, inputs, options }.");
  const key = raw.key;
  if (typeof key !== "string" || !FUNCTION_KEY_PATTERN.test(key)) throw badRequest(`run.key ${describeValue(key)} is not a function key.`);
  const fn = ctx.functions.get(key);
  if (fn === undefined) throw new WritBridgeError("INPUT_INVALID", `This site has no function "${key}".`);
  if (ctx.modeOf(key) === "required") {
    throw new WritBridgeError("WRIT_REQUIRED", `"${key}" runs only on the visitor's computer, never on Writ Cloud.`);
  }
  const inputs = checkInputs(fn, raw.inputs);

  const options = raw.options ?? {};
  if (!isPlainObject(options)) throw badRequest("run.options must be { timeout_ms?, dry_run? }.");
  let timeoutMs = DEFAULT_CALL_TIMEOUT_MS;
  if (options.timeout_ms !== undefined && options.timeout_ms !== null) {
    if (typeof options.timeout_ms !== "number" || !Number.isFinite(options.timeout_ms)) {
      throw badRequest("run.options.timeout_ms must be a number of milliseconds.");
    }
    timeoutMs = Math.min(MAX_CALL_TIMEOUT_MS, Math.max(MIN_CALL_TIMEOUT_MS, Math.round(options.timeout_ms)));
  }
  const dryRun = options.dry_run ?? false;
  if (typeof dryRun !== "boolean") throw badRequest("run.options.dry_run must be true or false.");

  if (ctx.authorizeRun !== undefined && (await ctx.authorizeRun(userId, key, inputs)) !== true) {
    throw new WritBridgeError("NOT_GRANTED", `This user may not run "${key}" on Writ Cloud.`);
  }

  const inFlight = ctx.pageRuns.get(userId) ?? 0;
  if (inFlight >= MAX_PAGE_RUNS_PER_USER) {
    throw new WritBridgeError("RATE_LIMITED", `At most ${MAX_PAGE_RUNS_PER_USER} Writ Cloud calls run at once for one user.`);
  }
  ctx.pageRuns.set(userId, inFlight + 1);
  try {
    const data = await ctx.runCloud(fn, inputs, { timeoutMs, dryRun }, request.signal);
    return json(200, { data, venue: "cloud" });
  } finally {
    const left = (ctx.pageRuns.get(userId) ?? 1) - 1;
    if (left <= 0) ctx.pageRuns.delete(userId);
    else ctx.pageRuns.set(userId, left);
  }
}
