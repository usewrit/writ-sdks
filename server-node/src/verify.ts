/**
 * Binding a receipt to a call: the server's challenge, the function, the user, the origin and
 * the data (docs/browser-extension/CONTRACT.md §12.1, §12.3 "Server checks").
 */

import { dataHash, inputsHash } from "./canonical.js";
import { verifyReceiptSignature, type WritReceipt, type WritReceiptDevice, type WritReceiptOutcome } from "./receipt.js";
import type { WritDeviceCheck } from "./store.js";
import { readChallenge } from "./tokens.js";

/**
 * Which Writ installs may sign a user's receipts (CONTRACT.md §12.4 "Device pins").
 *
 * A receipt carries the public key that signed it, so a signature alone proves nothing about WHO
 * signed: anyone can make a key and sign a receipt that claims success. Pinning is what ties
 * receipts to the user's own Writ:
 * - `"first-use"` (default): the first device whose receipt verifies for a user is pinned to that
 *   user, and only pinned devices verify afterwards. Another computer is refused
 *   (`unknownDevice: true`) until you approve it with `bridge.approveDevice()`, after checking it is
 *   theirs (an email link, say). Pins live in the bridge's store: use a durable one (Redis) in
 *   production, or a function.
 * - a function `(userId, device) => boolean`: your own registry decides.
 * - `"off"`: any signer is accepted. Receipts then stop replays and cross-site reuse but not
 *   forgery; use it only where the result gates nothing.
 */
export type WritDevicePolicy = "first-use" | "off" | ((userId: string, device: WritReceiptDevice) => boolean | Promise<boolean>);

/** What `bridge.verify()` answers. */
export interface WritVerifyResult {
  /** The receipt is genuine, answers this challenge for this function, and the call succeeded. */
  ok: boolean;
  /** How the call ended, once the signature verified; `null` for a receipt that is not genuine. */
  outcome: WritReceiptOutcome | null;
  /** Why `ok` is false. */
  reason?: string;
  /** The signing device, once the signature verified. */
  device: WritReceiptDevice | null;
  /**
   * `true` when the receipt was refused only because this user has not pinned its signer (another
   * computer, or a forgery). Approve it with `bridge.approveDevice(userId, device)` once you have
   * confirmed it is theirs; never on the page's word alone.
   */
  unknownDevice?: boolean;
}

/** What a receipt must match. */
export interface ReceiptExpectations {
  secret: Buffer;
  nowSeconds: number;
  /** The challenge the server minted, exactly as the receipt must carry it. */
  challenge: string;
  /** The contract key the call was for. */
  key: string;
  /** The challenge's subject must be this (the user id, for commands). */
  subject?: string;
  /** The challenge's nonce must be this (the command id, for commands). */
  nonce?: string;
  /** The receipt's origin must be this. */
  origin?: string;
  /** When present, the data the server received; its hash must equal the receipt's. */
  data?: { value: unknown };
  /** When present, the inputs the call must have run with; the receipt's `inputs_hash` must be theirs. */
  inputs?: { value: unknown };
  /** The inputs hash the call must carry, when the server computed it itself (a command it sent). */
  inputsHash?: string;
  /** `ok` only for `outcome: "success"`. */
  requireSuccess: boolean;
  /** Which signers verify for the subject. */
  devices: WritDevicePolicy;
  /** The store's atomic pin check (`"first-use"`). */
  checkDevice: (subject: string, publicKey: string, firstUse: boolean) => Promise<WritDeviceCheck>;
  /** Spend the challenge nonce; `false` when it was already spent. */
  spendNonce: (nonce: string, ttlMs: number) => Promise<boolean>;
}

/** A verdict, plus the receipt when its signature verified. */
export type ReceiptVerdict = WritVerifyResult & { receipt?: WritReceipt };

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

/** Whether `device` may sign for `subject` under the policy. A throwing hook or store refuses. */
async function devicePinned(expect: ReceiptExpectations, subject: string, device: WritReceiptDevice): Promise<boolean> {
  try {
    if (expect.devices === "off") return true;
    if (expect.devices === "first-use") return (await expect.checkDevice(subject, device.public_key, true)) !== "unknown";
    return (await expect.devices(subject, device)) === true;
  } catch {
    return false;
  }
}

/**
 * Check every rule, in order: signature (and key id), function key, challenge equality, the
 * challenge itself (minted here, unexpired, for this key, subject and nonce), origin, the
 * developer's device pin, single use, outcome, and the data hash. The challenge is spent once the
 * receipt is proven to answer it, whatever the outcome, so a genuine receipt is never accepted twice.
 */
export async function checkReceipt(receipt: unknown, expect: ReceiptExpectations): Promise<ReceiptVerdict> {
  const signature = verifyReceiptSignature(receipt);
  if (!signature.ok) return { ok: false, outcome: null, reason: signature.reason, device: null };
  const r = signature.receipt;
  const device = signature.device;
  const refuse = (reason: string): ReceiptVerdict => ({ ok: false, outcome: r.outcome, reason, device, receipt: r });

  if (r.key !== expect.key) return refuse(`the receipt is for "${r.key}", not "${expect.key}"`);
  if (r.challenge === null) return refuse("the receipt carries no challenge");
  if (r.challenge !== expect.challenge) return refuse("the receipt answers another challenge");

  const challenge = readChallenge(expect.secret, expect.challenge, expect.nowSeconds);
  if (!challenge.ok) return refuse(challenge.reason);
  const payload = challenge.payload;
  if (payload.key !== expect.key) return refuse("the challenge was minted for another function");
  if (expect.subject !== undefined && payload.sub !== expect.subject) return refuse("the challenge was minted for another subject");
  if (expect.nonce !== undefined && payload.nonce !== expect.nonce) return refuse("the challenge was minted for another command");

  if (expect.origin !== undefined && r.origin !== normalizeOrigin(expect.origin)) {
    return refuse(`the receipt comes from ${r.origin}, not ${normalizeOrigin(expect.origin)}`);
  }

  if (!(await devicePinned(expect, payload.sub, device))) {
    return { ...refuse("the receipt was signed by a device this user has not registered"), unknownDevice: true };
  }

  const ttlMs = Math.max(1_000, (payload.exp - expect.nowSeconds + 1) * 1_000);
  if (!(await expect.spendNonce(payload.nonce, ttlMs))) return refuse("the challenge was already used");

  if (expect.requireSuccess && r.outcome !== "success") {
    return refuse(`the call ended "${r.outcome}"${r.error_code !== null ? ` (${r.error_code})` : ""}`);
  }

  // What the call ran with: a page can't run the function with one account's sign-in and claim another.
  if (expect.inputs !== undefined || expect.inputsHash !== undefined) {
    if (r.inputs_hash === undefined) return refuse("the receipt doesn't say what the call ran with");
    let want = expect.inputsHash;
    if (want === undefined) {
      try {
        want = inputsHash(expect.challenge, expect.inputs?.value);
      } catch (error) {
        return refuse(`the inputs have no canonical form (${error instanceof Error ? error.message : "unknown"})`);
      }
    }
    if (want !== r.inputs_hash) return refuse("the call ran with other inputs than these");
  }

  if (expect.data !== undefined && r.outcome === "success") {
    if (r.data_hash === null) return refuse("the receipt carries no data hash");
    let hash: string;
    try {
      hash = dataHash(expect.data.value);
    } catch (error) {
      return refuse(`the data has no canonical form (${error instanceof Error ? error.message : "unknown"})`);
    }
    if (hash !== r.data_hash) return refuse("the data does not match the receipt");
  }

  return { ok: true, outcome: r.outcome, device, receipt: r };
}
