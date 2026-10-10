/**
 * RFC 8785 (JCS) canonical JSON, and the hashes and encodings built on it
 * (docs/browser-extension/CONTRACT.md §11 "Canonical JSON", §12.1, §12.2).
 *
 * Rules, as the Writ engine applies them (`local::update::manifest::canonicalize`):
 * - object keys sorted by UTF-16 code units, recursively;
 * - compact separators, no whitespace;
 * - non-ASCII emitted as is (UTF-8 once encoded); only `"`, `\` and control characters escaped;
 * - numbers as ECMAScript prints them (RFC 8785 §3.2.2.3: `12.5`, `100`, `1e+21`), which the engine
 *   reproduces from the shortest round-trip digits, so a result with fractions hashes identically.
 */

import { createHash } from "node:crypto";

import { MAX_JSON_DEPTH } from "./constants.js";
import { WritBridgeError } from "./errors.js";
import { describeValue, isPlainObject } from "./json.js";

/** A lone UTF-16 surrogate: not valid Unicode, so it has no canonical form. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function refuse(path: string, message: string): WritBridgeError {
  return new WritBridgeError("INPUT_INVALID", `${path} ${message}`);
}

/**
 * The RFC 8785 canonical JSON text of `value`.
 *
 * Accepts null, booleans, strings, finite numbers, bigints (as the number a JSON parser would read
 * for them), arrays and plain objects. A property whose value is `undefined` is left out, as
 * `JSON.stringify` does. Throws an `INPUT_INVALID` {@link WritBridgeError} naming the path for
 * anything else: NaN or an infinity, a lone surrogate, `undefined` in an array, a function, a Date,
 * a cycle, or nesting deeper than 128 levels.
 */
export function canonicalJson(value: unknown): string {
  return emit(value, "$", 0, new Set<object>());
}

function emit(value: unknown, path: string, depth: number, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw refuse(path, `is ${String(value)}; canonical JSON has no such number.`);
      // ECMAScript Number::toString, which RFC 8785 adopts as is (-0 prints "0").
      return String(value);
    case "bigint":
      // A JSON document carries numbers as doubles: hash the one a parser reads for this value,
      // as the engine does for an integer beyond 2^53.
      return String(Number(value));
    case "string":
      return quote(value, path);
    case "object":
      break;
    default:
      throw refuse(path, `is ${describeValue(value)}; only JSON values have a canonical form.`);
  }

  const object = value as object;
  if (depth >= MAX_JSON_DEPTH) throw refuse(path, `is nested deeper than ${MAX_JSON_DEPTH} levels.`);
  if (ancestors.has(object)) throw refuse(path, "contains a circular reference.");
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const parts: string[] = [];
      for (let i = 0; i < object.length; i += 1) {
        const item: unknown = object[i];
        if (item === undefined) throw refuse(`${path}[${i}]`, "is undefined or missing; use null.");
        parts.push(emit(item, `${path}[${i}]`, depth + 1, ancestors));
      }
      return `[${parts.join(",")}]`;
    }
    if (!isPlainObject(object)) {
      throw refuse(path, `is ${describeValue(object)}; only plain objects have a canonical form.`);
    }
    // Default string order compares UTF-16 code units, which is exactly RFC 8785 §3.2.3.
    const keys = Object.keys(object).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = object[key];
      if (item === undefined) continue;
      parts.push(`${quote(key, path)}:${emit(item, `${path}.${key}`, depth + 1, ancestors)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    ancestors.delete(object);
  }
}

function quote(text: string, path: string): string {
  if (LONE_SURROGATE.test(text)) throw refuse(path, "holds a lone UTF-16 surrogate; it is not valid Unicode.");
  // JSON.stringify escapes exactly what RFC 8785 requires: `"`, `\`, \b \f \n \r \t, and the
  // other control characters as lowercase \u00xx; everything else is emitted as is.
  return JSON.stringify(text);
}

/** Lowercase hex sha256 of a string's UTF-8 bytes, or of raw bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof input === "string") hash.update(input, "utf8");
  else hash.update(input);
  return hash.digest("hex");
}

/**
 * The receipt's `inputs_hash`: lowercase hex sha256 of the call's challenge (empty when none), a
 * newline, and the canonical JSON of the inputs it ran with (CONTRACT.md §12.1). Binds a receipt to
 * what the call ran with; salted with the single-use challenge. Throws like {@link canonicalJson}.
 */
export function inputsHash(challenge: string | null, inputs: unknown): string {
  return sha256Hex(`${challenge ?? ""}\n${canonicalJson(inputs ?? {})}`);
}

/**
 * The receipt's `data_hash` of `data`: lowercase hex sha256 of its canonical JSON (CONTRACT.md
 * §12.1). Throws like {@link canonicalJson}.
 */
export function dataHash(data: unknown): string {
  return sha256Hex(canonicalJson(data));
}

// ---------------------------------------------------------------------------------------------
// base64url (RFC 4648 §5, no padding), strict
// ---------------------------------------------------------------------------------------------

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** base64url without padding. */
export function toBase64Url(bytes: Uint8Array | string): string {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return buffer.toString("base64url");
}

/**
 * The bytes of a base64url string, or `null` when it is not the one canonical encoding of some
 * bytes: wrong alphabet, padding, an impossible length, or spare bits set in the last character
 * (two spellings of the same bytes would let a token change and still verify).
 */
export function fromBase64Url(text: string): Buffer | null {
  if (typeof text !== "string" || !BASE64URL.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}
