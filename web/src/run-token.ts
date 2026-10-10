/**
 * Run tokens for linked workflows in `token` mode (CONTRACT.md §11 "Token mode").
 *
 * Your backend mints a run token (a JWT, HS256, signed with the publication's secret key, which
 * never reaches the page) and the page passes it on each call to such a workflow. Writ Cloud
 * verifies it; the extension and Writ desktop never store it.
 *
 * The page cannot verify a token, and does not try: it only reads the payload's `exp` to know how
 * long to reuse it. A token is kept in memory, in this module, never in storage, and only until
 * {@link RUN_TOKEN_REFRESH_MARGIN_MS} before it expires. One cache per `getRunToken` function, so
 * every session, client and bridge given the same function shares one token.
 */

import { MAX_RUN_TOKEN_LENGTH, RUN_TOKEN_REFRESH_MARGIN_MS } from "./constants.js";
import { WritError, isWritError, toWritError } from "./errors.js";
import { isPlainObject } from "./json.js";

/** Three base64url segments: header, claims, signature. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Gets run tokens from one `getRunToken` function and reuses each until a minute before its
 * `exp`. Concurrent calls share one request to your backend. A failure is never cached.
 */
export class RunTokenCache {
  readonly #getRunToken: () => Promise<string>;
  readonly #now: () => number;
  #token: string | null = null;
  /** Unix ms until which {@link #token} is reused. */
  #reuseUntil = 0;
  #pending: Promise<string> | null = null;

  /** `now` is unix milliseconds (tests move it). */
  constructor(getRunToken: () => Promise<string>, now: () => number = Date.now) {
    this.#getRunToken = getRunToken;
    this.#now = now;
  }

  /**
   * A run token for the next call: the cached one while it has more than a minute left, else a
   * fresh one from `getRunToken`. Rejects with a {@link WritError}: the code `getRunToken`
   * rejected with when it was a WritError, `NOT_GRANTED` for any other failure, and
   * `BAD_REQUEST` when it resolved with something that is not a run token.
   */
  get(): Promise<string> {
    if (this.#token !== null && this.#now() < this.#reuseUntil) return Promise.resolve(this.#token);
    this.#token = null;
    if (this.#pending !== null) return this.#pending;
    const pending = this.#fetch();
    this.#pending = pending;
    const clear = (): void => {
      if (this.#pending === pending) this.#pending = null;
    };
    pending.then(clear, clear);
    return pending;
  }

  /**
   * Writ Cloud refused a call that carried `token` (`NOT_GRANTED`: expired, revoked, or for
   * another publication): never reuse it.
   */
  refused(token: string): void {
    if (this.#token !== token) return;
    this.#token = null;
    this.#reuseUntil = 0;
  }

  async #fetch(): Promise<string> {
    let raw: unknown;
    try {
      raw = await this.#getRunToken();
    } catch (error) {
      if (isWritError(error)) throw toWritError(error);
      const reason = error instanceof Error && error.message !== "" ? `: ${error.message}` : ".";
      throw new WritError("NOT_GRANTED", `getRunToken() failed, so the call has no run token${reason}`, { cause: error });
    }
    const token = checkRunToken(raw);
    const exp = runTokenExpiry(token);
    if (exp !== null) {
      const until = exp * 1000 - RUN_TOKEN_REFRESH_MARGIN_MS;
      // A token with a minute or less left still serves this call; it is just not kept.
      if (until > this.#now()) {
        this.#token = token;
        this.#reuseUntil = until;
      }
    }
    return token;
  }
}

/** One cache per `getRunToken` function, held only as long as the function itself. */
const CACHES = new WeakMap<object, RunTokenCache>();

/** The shared {@link RunTokenCache} of `getRunToken`. */
export function runTokensFor(getRunToken: () => Promise<string>): RunTokenCache {
  let cache = CACHES.get(getRunToken);
  if (cache === undefined) {
    cache = new RunTokenCache(getRunToken);
    CACHES.set(getRunToken, cache);
  }
  return cache;
}

/**
 * A run token as `getRunToken` resolved it, trimmed (a backend answering `text/plain` often adds a
 * newline): a JWT of at most {@link MAX_RUN_TOKEN_LENGTH} characters. BAD_REQUEST otherwise.
 */
export function checkRunToken(raw: unknown): string {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (token === "" || token.length > MAX_RUN_TOKEN_LENGTH || !JWT_SHAPE.test(token)) {
    throw new WritError(
      "BAD_REQUEST",
      "getRunToken() must resolve with the run token your backend minted (a JWT: three base64url parts joined by dots), as text.",
    );
  }
  return token;
}

/** A run token passed as is (`options.token`): non-empty printable ASCII. BAD_REQUEST otherwise. */
export function checkGivenRunToken(raw: unknown): string {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_RUN_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(raw)) {
    throw new WritError(
      "BAD_REQUEST",
      "`token` must be the run token your backend minted, as text, or a function resolving with it.",
    );
  }
  return raw;
}

/**
 * The `exp` claim of a JWT, in unix seconds, read without verifying anything; null when the
 * payload is not a JSON object with a numeric `exp`.
 */
export function runTokenExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const text = decodeBase64UrlText(parts[1] as string);
  if (text === null) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(claims)) return null;
  const exp = claims.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
}

/** base64url (no padding) to UTF-8 text, without `atob` or `TextDecoder`; null when malformed. */
function decodeBase64UrlText(segment: string): string | null {
  if (segment.length % 4 === 1) return null;
  let buffer = 0;
  let bits = 0;
  let escaped = "";
  for (const char of segment) {
    const value = BASE64URL_ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = ((buffer << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      escaped += `%${((buffer >> bits) & 0xff).toString(16).padStart(2, "0")}`;
    }
  }
  try {
    return decodeURIComponent(escaped);
  } catch {
    return null;
  }
}
