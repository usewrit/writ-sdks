/**
 * Run tokens for linked workflows in `token` mode (docs/browser-extension/CONTRACT.md §11
 * "Token mode").
 *
 * A publication in `token` mode hands its recipe only to calls that carry a run token your
 * backend minted. Your page's `getRunToken` fetches one from a route of yours; the visitor's Writ
 * passes it to Writ Cloud, which verifies it. Neither the extension nor Writ desktop stores it.
 *
 * A run token is a JWT, HS256:
 * - the HMAC key is the UTF-8 bytes of the publication's secret key, `wsk_` prefix included;
 * - header `{"alg":"HS256","typ":"JWT"}`, exactly these keys in this order;
 * - claims `{"pub","iat","exp","sub"?}`, exactly this key order, `sub` left out when there is
 *   none, `exp = iat + ttlSeconds` with `ttlSeconds` at most 3600;
 * - both compact JSON (no whitespace), UTF-8, base64url without padding; the signature is
 *   HMAC-SHA256 over the ASCII bytes of `header.claims`.
 *
 * The Python SDK (`usewrit.mint_run_token`) mints the same bytes for the same input
 * (`sdks/fixtures/run_token_golden.json`). No dependency: `node:crypto` only.
 */

import { createHmac } from "node:crypto";

import {
  DEFAULT_RUN_TOKEN_TTL_SECONDS,
  MAX_RUN_TOKEN_TTL_SECONDS,
  MAX_SUBJECT_LENGTH,
  PUBLICATION_ID_PATTERN,
  SECRET_KEY_PREFIX,
} from "./constants.js";
import { WritBridgeError } from "./errors.js";
import { describeValue, isPlainObject } from "./json.js";

/** Options of {@link mintRunToken}. */
export interface MintRunTokenOptions {
  /** The publication the token is for, `pub_` + 22 letters or digits. */
  publication: string;
  /**
   * Who the token is for, usually your signed-in user's id: text of 1 to 256 characters without
   * control characters, or a safe integer (sent as its decimal text). Left out when absent.
   */
  sub?: string | number;
  /** Lifetime in seconds, 1 to 3600. Default 600. */
  ttlSeconds?: number;
  /** `iat`, in unix seconds. Default: now. For tests and replays of a fixed clock. */
  issuedAt?: number;
}

/** The claims of a run token, in the order they are signed. */
export interface WritRunTokenClaims {
  pub: string;
  iat: number;
  exp: number;
  sub?: string;
}

/** The JOSE header, as signed: this exact text. */
const HEADER_JSON = '{"alg":"HS256","typ":"JWT"}';

/** A secret key as Writ Cloud shows it: `wsk_` and printable ASCII, no spaces or line breaks. */
const SECRET_KEY_SHAPE = /^wsk_[\x21-\x7e]+$/;

/** An unpaired UTF-16 surrogate: not text, and Python could not encode it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Mint a run token for a linked workflow in `token` mode (CONTRACT.md §11): what your route
 * answers the page's `getRunToken`.
 *
 * ```ts
 * app.get("/api/writ-token", requireUser, (req, res) => {
 *   res.type("text/plain").send(
 *     mintRunToken(process.env.WRIT_PUBLICATION_SECRET!, { publication: "pub_...", sub: req.user.id }),
 *   );
 * });
 * ```
 *
 * Throws a {@link WritBridgeError}: `CONFIG_INVALID` when `secretKey` is not a secret key
 * (`wsk_...`, no spaces or line breaks; the message never repeats it), `INPUT_INVALID` for a
 * `publication` or `sub` that cannot be one, and `BAD_REQUEST` for a `ttlSeconds` outside 1 to
 * 3600 or an `issuedAt` that is not a whole number of seconds.
 */
export function mintRunToken(secretKey: string, options: MintRunTokenOptions): string {
  const key = checkSecretKey(secretKey);
  if (!isPlainObject(options)) {
    throw new WritBridgeError("BAD_REQUEST", "mintRunToken() takes (secretKey, { publication, sub?, ttlSeconds? }).");
  }
  const publication = options.publication;
  if (typeof publication !== "string" || !PUBLICATION_ID_PATTERN.test(publication)) {
    throw new WritBridgeError(
      "INPUT_INVALID",
      `publication must be the publication's id, "pub_" and 22 letters or digits; got ${describeValue(publication)}.`,
    );
  }
  const ttl = options.ttlSeconds ?? DEFAULT_RUN_TOKEN_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_RUN_TOKEN_TTL_SECONDS) {
    throw new WritBridgeError(
      "BAD_REQUEST",
      `ttlSeconds must be a whole number of seconds from 1 to ${MAX_RUN_TOKEN_TTL_SECONDS}: Writ Cloud refuses a run token that lives longer; got ${describeValue(ttl)}.`,
    );
  }
  const iat = options.issuedAt ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(iat) || iat < 0) {
    throw new WritBridgeError("BAD_REQUEST", `issuedAt must be unix seconds, a whole number; got ${describeValue(iat)}.`);
  }

  // The key order is part of the signed bytes: pub, iat, exp, then sub.
  const claims: WritRunTokenClaims = { pub: publication, iat, exp: iat + ttl };
  if (options.sub !== undefined && options.sub !== null) claims.sub = runTokenSubject(options.sub);

  const signingInput = `${base64Url(HEADER_JSON)}.${base64Url(JSON.stringify(claims))}`;
  const signature = createHmac("sha256", Buffer.from(key, "utf8")).update(signingInput, "ascii").digest("base64url");
  return `${signingInput}.${signature}`;
}

/** The secret key, or CONFIG_INVALID. Never echoes the value: it is a secret. */
function checkSecretKey(secretKey: unknown): string {
  if (typeof secretKey !== "string" || !secretKey.startsWith(SECRET_KEY_PREFIX)) {
    throw new WritBridgeError(
      "CONFIG_INVALID",
      `mintRunToken() needs the publication's secret key, which starts with "${SECRET_KEY_PREFIX}" (Writ Cloud shows it once, when you publish or rotate it). Never the publishable key (wpk_).`,
    );
  }
  if (!SECRET_KEY_SHAPE.test(secretKey)) {
    throw new WritBridgeError(
      "CONFIG_INVALID",
      "The secret key holds spaces, line breaks or other characters a secret key never has: check how it is read from the environment.",
    );
  }
  return secretKey;
}

/** `sub` as the token carries it: text, without control characters or lone surrogates. */
function runTokenSubject(value: unknown): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > MAX_SUBJECT_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(text) ||
    LONE_SURROGATE.test(text)
  ) {
    throw new WritBridgeError(
      "INPUT_INVALID",
      `sub must be text of 1 to ${MAX_SUBJECT_LENGTH} characters without control characters, or a safe integer; got ${describeValue(value)}.`,
    );
  }
  return text;
}

function base64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}
