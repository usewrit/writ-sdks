/**
 * Server-minted values (docs/browser-extension/CONTRACT.md §12.2): user tokens and challenges.
 *
 * Both are `base64url(canonical JSON) "." base64url(HMAC-SHA256(secret, first part as ASCII))`.
 * The Python SDK mints the same bytes for the same input (`sdks/fixtures/bridge_tokens_golden.json`).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { canonicalJson, fromBase64Url, toBase64Url } from "./canonical.js";
import { MAX_SUBJECT_LENGTH, MAX_TOKEN_CHARS } from "./constants.js";
import { isPlainObject } from "./json.js";

/** The payload of a user token. */
export interface WritUserTokenPayload {
  v: 1;
  typ: "user";
  sub: string;
  /** Unix seconds. */
  exp: number;
}

/** The payload of a challenge. */
export interface WritChallengePayload {
  v: 1;
  typ: "challenge";
  sub: string;
  key: string;
  /** 16 random bytes, base64url. For a command sent to a user's page, the command id. */
  nonce: string;
  /** Unix seconds. */
  exp: number;
}

/** The secret as bytes: a string is taken as UTF-8. */
export function secretBytes(secret: string | Uint8Array): Buffer {
  return typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
}

function mac(secret: Uint8Array, body: string): string {
  return createHmac("sha256", secret).update(body, "ascii").digest("base64url");
}

/** Sign any JSON object into the token format. Integers only (canonical JSON). */
export function signToken(secret: string | Uint8Array, payload: Record<string, unknown>): string {
  const body = toBase64Url(canonicalJson(payload));
  return `${body}.${mac(secretBytes(secret), body)}`;
}

/**
 * The payload of a token this secret signed, or `null`: wrong shape, a non-canonical encoding,
 * or a MAC that does not match (compared in constant time). Expiry and type are the caller's.
 */
export function openToken(secret: string | Uint8Array, token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  const given = token.slice(dot + 1);
  const bodyBytes = fromBase64Url(body);
  if (bodyBytes === null || fromBase64Url(given) === null) return null;
  const expected = mac(secretBytes(secret), body);
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(given, "ascii"), Buffer.from(expected, "ascii"))) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(bodyBytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  return isPlainObject(payload) ? payload : null;
}

/** A user id or challenge subject as the string tokens carry, or `null` when it cannot be one. */
export function subjectOf(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_SUBJECT_LENGTH) return null;
  // No control characters: a subject ends up in logs and in the developer's own lookups.
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return null;
  }
  return value;
}

/** Mint a user token (CONTRACT.md §12.2). `exp` in unix seconds. */
export function mintUserToken(secret: string | Uint8Array, sub: string, exp: number): string {
  const payload: WritUserTokenPayload = { v: 1, typ: "user", sub, exp };
  return signToken(secret, payload as unknown as Record<string, unknown>);
}

/** Mint a challenge (CONTRACT.md §12.2). `exp` in unix seconds; `nonce` defaults to 16 random bytes. */
export function mintChallenge(
  secret: string | Uint8Array,
  fields: { sub: string; key: string; exp: number; nonce?: string },
): string {
  const payload: WritChallengePayload = {
    v: 1,
    typ: "challenge",
    sub: fields.sub,
    key: fields.key,
    nonce: fields.nonce ?? newNonce(),
    exp: fields.exp,
  };
  return signToken(secret, payload as unknown as Record<string, unknown>);
}

/** 16 random bytes, base64url (22 characters). Used for challenge nonces and command ids. */
export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * The user token's payload when `token` is a valid, unexpired user token for this secret,
 * else `null`. `nowSeconds` is the current unix time.
 */
export function readUserToken(
  secret: string | Uint8Array,
  token: unknown,
  nowSeconds: number,
): WritUserTokenPayload | null {
  const payload = openToken(secret, token);
  if (payload === null) return null;
  if (payload.v !== 1 || payload.typ !== "user") return null;
  const sub = subjectOf(payload.sub);
  if (sub === null || typeof payload.sub !== "string") return null;
  if (!Number.isSafeInteger(payload.exp) || (payload.exp as number) <= nowSeconds) return null;
  return { v: 1, typ: "user", sub, exp: payload.exp as number };
}

/** Why a challenge was refused, or its payload. */
export type ChallengeReading =
  | { ok: true; payload: WritChallengePayload }
  | { ok: false; reason: string };

/**
 * Read a challenge minted with this secret: valid MAC, `typ: "challenge"`, a nonce of 16 bytes,
 * and unexpired at `nowSeconds`.
 */
export function readChallenge(secret: string | Uint8Array, challenge: unknown, nowSeconds: number): ChallengeReading {
  const payload = openToken(secret, challenge);
  if (payload === null) return { ok: false, reason: "the challenge was not minted by this server" };
  if (payload.v !== 1 || payload.typ !== "challenge") return { ok: false, reason: "the token is not a challenge" };
  if (typeof payload.sub !== "string" || subjectOf(payload.sub) === null) {
    return { ok: false, reason: "the challenge has no valid subject" };
  }
  if (typeof payload.key !== "string" || payload.key === "") return { ok: false, reason: "the challenge names no function" };
  const nonce = typeof payload.nonce === "string" ? fromBase64Url(payload.nonce) : null;
  if (nonce === null || nonce.length !== 16) return { ok: false, reason: "the challenge nonce is malformed" };
  if (!Number.isSafeInteger(payload.exp)) return { ok: false, reason: "the challenge has no valid expiry" };
  if ((payload.exp as number) <= nowSeconds) return { ok: false, reason: "the challenge expired" };
  return {
    ok: true,
    payload: {
      v: 1,
      typ: "challenge",
      sub: payload.sub,
      key: payload.key,
      nonce: payload.nonce as string,
      exp: payload.exp as number,
    },
  };
}
