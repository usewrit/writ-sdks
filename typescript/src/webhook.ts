/**
 * Verify (and sign) Writ webhook deliveries.
 *
 * Writ signs every outbound delivery twice:
 *
 * ```
 * X-Writ-Signature-V1  HMAC-SHA256 over "{timestamp}." + raw body  ← verify this
 * X-Writ-Signature     HMAC-SHA256 over the raw body alone         ← legacy
 * ```
 *
 * V1 binds the timestamp into the MAC, so a captured delivery stops being
 * replayable the moment its timestamp goes stale. The body-only signature is
 * still sent for handlers written before V1 and is accepted here as an opt-in
 * fallback, but it CANNOT support a freshness check — nothing ties it to a
 * point in time.
 *
 * Uses Web Crypto (`globalThis.crypto.subtle`), so the same code runs on Node
 * 18+, Deno, Bun, Cloudflare Workers and the browser.
 */

import { WritError } from "./errors.js";

export const WEBHOOK_SIGNATURE_V1_HEADER = "x-writ-signature-v1";
export const WEBHOOK_SIGNATURE_HEADER = "x-writ-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-writ-timestamp";

/** Freshness window for a V1 signature, matching the server's own ±5 minutes. */
export const DEFAULT_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/** Why {@link verifyWebhook} rejected a delivery. */
export type WebhookFailureReason =
  | "no_signature"
  | "signature_mismatch"
  | "stale"
  | "bad_timestamp"
  | "no_secret";

/**
 * Thrown by {@link verifyWebhook}. Treat ANY of these as "do not act on this
 * payload" — `reason` is for logging and metrics, not for deciding to proceed.
 */
export class WritWebhookVerificationError extends WritError {
  readonly reason: WebhookFailureReason;

  constructor(reason: WebhookFailureReason, message: string) {
    super(message);
    this.name = "WritWebhookVerificationError";
    this.reason = reason;
  }
}

/** Anything header-shaped: a `Headers`, a plain object, or a Node `IncomingHttpHeaders`. */
export type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

export interface VerifyWebhookOptions {
  /**
   * Freshness window in ms. Defaults to {@link DEFAULT_WEBHOOK_TOLERANCE_MS}.
   * A negative value disables the check — only sensible when something upstream
   * already enforces replay protection.
   */
  toleranceMs?: number;
  /**
   * Accept a delivery carrying ONLY the body-only `X-Writ-Signature`. Off by
   * default: that signature cannot be checked for freshness, so accepting it
   * silently reintroduces unlimited replay. Turn it on only while migrating a
   * handler that predates V1.
   */
  allowLegacyBodyOnly?: boolean;
  /** Override the clock (tests). */
  now?: () => number;
}

function headerValue(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return ((headers as Headers).get(name) ?? null) as string | null;
  }
  const bag = headers as Record<string, string | string[] | undefined>;
  // Node lower-cases incoming header names, but a hand-built object may not.
  const direct = bag[name] ?? bag[name.toLowerCase()];
  const found =
    direct ??
    Object.entries(bag).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  if (Array.isArray(found)) return found[0] ?? null;
  return found ?? null;
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new WritError(
      "Web Crypto is unavailable — webhook verification needs globalThis.crypto.subtle (Node 18+)",
    );
  }
  const key = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle.sign("HMAC", key, message);
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time string compare. A plain `===` on a hex digest leaks how many
 * leading characters matched, which is enough to recover the expected MAC one
 * byte at a time over many attempts.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

function concat(prefix: string, body: Uint8Array): Uint8Array {
  const head = encoder.encode(prefix);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/**
 * Authenticate an outbound Writ delivery. Resolves on success; throws
 * {@link WritWebhookVerificationError} otherwise.
 *
 * ```ts
 * const body = await req.text();          // RAW bytes — see below
 * await verifyWebhook(req.headers, body, process.env.WRIT_WEBHOOK_SECRET!);
 * ```
 *
 * `body` MUST be the exact bytes received. Parsing and re-serialising first
 * changes them (key order, spacing, number formatting) and the MAC will not
 * match — this is the single most common cause of a "wrong secret" report.
 */
export async function verifyWebhook(
  headers: HeaderSource,
  body: string | Uint8Array | ArrayBuffer,
  secret: string,
  opts: VerifyWebhookOptions = {},
): Promise<void> {
  if (!secret) {
    throw new WritWebhookVerificationError("no_secret", "webhook secret is empty");
  }
  const bytes = toBytes(body);

  const v1 = headerValue(headers, WEBHOOK_SIGNATURE_V1_HEADER)?.trim();
  if (v1) {
    const ts = headerValue(headers, WEBHOOK_TIMESTAMP_HEADER)?.trim();
    if (!ts) {
      throw new WritWebhookVerificationError(
        "bad_timestamp",
        `a ${WEBHOOK_SIGNATURE_V1_HEADER} was present but ${WEBHOOK_TIMESTAMP_HEADER} was missing`,
      );
    }
    checkFreshness(ts, opts);
    const expected = await hmacHex(secret, concat(`${ts}.`, bytes));
    if (!timingSafeEqual(stripPrefix(v1), expected)) {
      throw new WritWebhookVerificationError(
        "signature_mismatch",
        "webhook signature does not match — treat this request as hostile",
      );
    }
    return;
  }

  const legacy = headerValue(headers, WEBHOOK_SIGNATURE_HEADER)?.trim();
  if (!legacy) {
    throw new WritWebhookVerificationError(
      "no_signature",
      "request carries no Writ webhook signature",
    );
  }
  if (!opts.allowLegacyBodyOnly) {
    throw new WritWebhookVerificationError(
      "no_signature",
      `only the body-only ${WEBHOOK_SIGNATURE_HEADER} was present. It cannot be checked for ` +
        `freshness, so it is refused by default — pass { allowLegacyBodyOnly: true } while migrating`,
    );
  }
  const expected = await hmacHex(secret, bytes);
  if (!timingSafeEqual(stripPrefix(legacy), expected)) {
    throw new WritWebhookVerificationError(
      "signature_mismatch",
      "webhook signature does not match — treat this request as hostile",
    );
  }
}

function stripPrefix(sig: string): string {
  return (sig.startsWith("sha256=") ? sig.slice(7) : sig).toLowerCase();
}

function checkFreshness(ts: string, opts: VerifyWebhookOptions): void {
  const tolerance = opts.toleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS;
  if (tolerance < 0) return;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) {
    throw new WritWebhookVerificationError(
      "bad_timestamp",
      `${WEBHOOK_TIMESTAMP_HEADER} is not a unix timestamp: ${ts}`,
    );
  }
  const now = opts.now ? opts.now() : Date.now();
  // Absolute skew: a delivery timestamped in the FUTURE is as suspect as a
  // stale one — it means forged headers or a badly wrong clock.
  const drift = Math.abs(now - seconds * 1000);
  if (drift > tolerance) {
    throw new WritWebhookVerificationError(
      "stale",
      `webhook timestamp ${ts} is ${Math.round(drift / 1000)}s away from now (tolerance ${Math.round(
        tolerance / 1000,
      )}s)`,
    );
  }
}

/**
 * Produce the headers for an INBOUND call to a Writ hook
 * (`POST /api/webhooks/hook/{token}`), which requires a fresh signed timestamp:
 * the MAC covers `"{timestamp}." + body`, and an unsigned or stale call is
 * rejected 401.
 *
 * ```ts
 * const body = JSON.stringify({ sku: "SKU-123" });
 * const headers = await signWebhookRequest(body, secret);
 * await fetch(hookUrl, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
 * ```
 */
export async function signWebhookRequest(
  body: string | Uint8Array | ArrayBuffer,
  secret: string,
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex(secret, concat(`${ts}.`, toBytes(body)));
  return {
    "X-Writ-Timestamp": ts,
    "X-Writ-Signature": `sha256=${sig}`,
  };
}
