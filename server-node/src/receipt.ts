/**
 * Signed Writ receipts (docs/browser-extension/CONTRACT.md §12.1).
 *
 * The Writ engine on the visitor's computer signs, with an Ed25519 key of its own per site, what a
 * call did: which site and function, the server's challenge, the outcome, and a hash of the data
 * the page received. This module checks that a receipt is well formed and that its signature is
 * genuine; binding it to a challenge, a function and data is `bridge.verify()`'s job.
 */

import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";

import { canonicalJson, fromBase64Url, sha256Hex } from "./canonical.js";
import { ED25519_SPKI_PREFIX_HEX, MAX_CHALLENGE_CHARS } from "./constants.js";
import { describeValue, isPlainObject } from "./json.js";

/** How a call on the visitor's computer ended. */
export type WritReceiptOutcome = "success" | "failed" | "error" | "timeout" | "cancelled";

/** The signing key of one (Writ install, site). */
export interface WritReceiptDevice {
  /** First 16 hex characters of sha256(public key bytes). */
  kid: string;
  alg: "Ed25519";
  /** base64url of the 32-byte public key. */
  public_key: string;
  /** True once keys live in a Secure Enclave or TPM; software keys in the Writ vault for now. */
  hardware: boolean;
}

/** A receipt as the Writ engine signs it. */
export interface WritReceipt {
  v: 1;
  origin: string;
  key: string;
  package: string | null;
  function: string | null;
  challenge: string | null;
  /** sha256 hex of the challenge, a newline and the canonical JSON of the call's inputs (`inputsHash`). */
  inputs_hash?: string;
  outcome: WritReceiptOutcome;
  error_code: string | null;
  /** sha256 hex of the canonical JSON of the data the page received; null unless success. */
  data_hash: string | null;
  run_id: number;
  /** Unix seconds. */
  started_at: number;
  finished_at: number;
  writ: { version: string };
  device: WritReceiptDevice;
  /** base64url Ed25519 signature over the canonical JSON of the receipt without `sig`. */
  sig: string;
}

const OUTCOMES: ReadonlySet<string> = new Set(["success", "failed", "error", "timeout", "cancelled"]);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const SPKI_PREFIX = Buffer.from(ED25519_SPKI_PREFIX_HEX, "hex");

/** A parsed receipt, or why it is not one. */
export type ReceiptParse = { ok: true; receipt: WritReceipt } | { ok: false; reason: string };

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Check a receipt's shape: every field present with its type, the outcome known, the hashes and
 * keys well formed. Fields Writ does not know are left in place (the signature covers them).
 */
export function parseReceipt(value: unknown): ReceiptParse {
  if (!isPlainObject(value)) return { ok: false, reason: `the receipt is ${describeValue(value)}, not an object` };
  const r = value;
  if (r.v !== 1) return { ok: false, reason: "the receipt version is not 1" };
  if (typeof r.origin !== "string" || r.origin === "") return { ok: false, reason: "the receipt has no origin" };
  if (typeof r.key !== "string" || r.key === "") return { ok: false, reason: "the receipt has no function key" };
  if (!nullableString(r.package)) return { ok: false, reason: "the receipt package is malformed" };
  if (!nullableString(r.function)) return { ok: false, reason: "the receipt function is malformed" };
  if (!nullableString(r.challenge) || (typeof r.challenge === "string" && r.challenge.length > MAX_CHALLENGE_CHARS)) {
    return { ok: false, reason: "the receipt challenge is malformed" };
  }
  if (typeof r.outcome !== "string" || !OUTCOMES.has(r.outcome)) return { ok: false, reason: "the receipt outcome is unknown" };
  if (!nullableString(r.error_code)) return { ok: false, reason: "the receipt error code is malformed" };
  if (!(r.data_hash === null || (typeof r.data_hash === "string" && HEX64.test(r.data_hash)))) {
    return { ok: false, reason: "the receipt data hash is malformed" };
  }
  if (!(r.inputs_hash === undefined || (typeof r.inputs_hash === "string" && HEX64.test(r.inputs_hash)))) {
    return { ok: false, reason: "the receipt inputs hash is malformed" };
  }
  for (const field of ["run_id", "started_at", "finished_at"] as const) {
    if (!Number.isSafeInteger(r[field])) return { ok: false, reason: `the receipt ${field} is not an integer` };
  }
  if (!isPlainObject(r.writ) || typeof r.writ.version !== "string") return { ok: false, reason: "the receipt has no Writ version" };
  const device = r.device;
  if (!isPlainObject(device)) return { ok: false, reason: "the receipt has no device" };
  if (device.alg !== "Ed25519") return { ok: false, reason: "the receipt key is not Ed25519" };
  if (typeof device.kid !== "string" || !HEX16.test(device.kid)) return { ok: false, reason: "the receipt key id is malformed" };
  if (typeof device.public_key !== "string") return { ok: false, reason: "the receipt has no public key" };
  const publicKey = fromBase64Url(device.public_key);
  if (publicKey === null || publicKey.length !== 32) return { ok: false, reason: "the receipt public key is not 32 bytes" };
  if (typeof device.hardware !== "boolean") return { ok: false, reason: "the receipt hardware flag is malformed" };
  if (typeof r.sig !== "string") return { ok: false, reason: "the receipt is not signed" };
  const sig = fromBase64Url(r.sig);
  if (sig === null || sig.length !== 64) return { ok: false, reason: "the receipt signature is not 64 bytes" };
  return { ok: true, receipt: r as unknown as WritReceipt };
}

/** `kid` of a raw public key: the first 16 hex characters of its sha256. */
export function kidOf(publicKey: Uint8Array): string {
  return sha256Hex(publicKey).slice(0, 16);
}

/** A Node public key object for a raw 32-byte Ed25519 public key. */
export function ed25519PublicKey(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new RangeError("An Ed25519 public key is 32 bytes.");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]), format: "der", type: "spki" });
}

/** The exact bytes a receipt's signature covers: canonical JSON of the receipt without `sig`. */
export function receiptSigningBytes(receipt: Record<string, unknown>): Buffer {
  const unsigned: Record<string, unknown> = {};
  for (const key of Object.keys(receipt)) {
    if (key !== "sig") unsigned[key] = receipt[key];
  }
  return Buffer.from(canonicalJson(unsigned), "utf8");
}

/** The outcome of {@link verifyReceiptSignature}. */
export type ReceiptSignatureCheck =
  | { ok: true; receipt: WritReceipt; device: WritReceiptDevice }
  | { ok: false; reason: string };

/**
 * Check a receipt's shape, that `device.kid` names `device.public_key`, and its Ed25519
 * signature over the canonical bytes. Any one-field change fails. This says the receipt is what
 * some Writ install signed; it does not say which call it answers (see `bridge.verify()`).
 */
export function verifyReceiptSignature(value: unknown): ReceiptSignatureCheck {
  const parsed = parseReceipt(value);
  if (!parsed.ok) return parsed;
  const receipt = parsed.receipt;
  const publicKey = fromBase64Url(receipt.device.public_key) as Buffer;
  if (kidOf(publicKey) !== receipt.device.kid) return { ok: false, reason: "the receipt key id does not match its public key" };
  let bytes: Buffer;
  try {
    bytes = receiptSigningBytes(receipt as unknown as Record<string, unknown>);
  } catch {
    return { ok: false, reason: "the receipt has no canonical form" };
  }
  let genuine = false;
  try {
    genuine = verifySignature(null, bytes, ed25519PublicKey(publicKey), fromBase64Url(receipt.sig) as Buffer);
  } catch {
    genuine = false;
  }
  if (!genuine) return { ok: false, reason: "the receipt signature does not verify" };
  const device: WritReceiptDevice = {
    kid: receipt.device.kid,
    alg: "Ed25519",
    public_key: receipt.device.public_key,
    hardware: receipt.device.hardware,
  };
  return { ok: true, receipt, device };
}
