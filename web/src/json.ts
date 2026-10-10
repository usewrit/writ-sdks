/**
 * Plain-JSON helpers shared by input, package and contract validation. Every failure is an
 * `INPUT_INVALID` {@link WritError} whose message names the offending path.
 */

import { WritError } from "./errors.js";
import type { JsonObject, JsonValue } from "./types.js";

function inputInvalid(message: string): WritError {
  return new WritError("INPUT_INVALID", message);
}

/** A plain object from any realm (`{}` literal, `Object.create(null)`, JSON.parse). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

const DROP = Symbol("drop");

/**
 * A fresh plain-JSON copy of `value`, or INPUT_INVALID naming `path` for the first value JSON
 * cannot carry: functions, symbols, bigints, non-finite numbers, Dates, Maps, class instances,
 * cycles, `undefined` inside an array, or nesting deeper than `maxDepth`. An `undefined`
 * property is dropped, as `JSON.stringify` would. A `"__proto__"` key stays an own property.
 */
export function cloneJsonValue(value: unknown, path: string, maxDepth: number): JsonValue {
  const copy = cloneJson(value, path, 0, maxDepth, new Set<object>());
  if (copy === DROP) throw inputInvalid(`${path} is undefined; use null.`);
  return copy;
}

/** {@link cloneJsonValue} for a value that must be a plain object. */
export function cloneJsonObject(value: unknown, path: string, maxDepth: number): JsonObject {
  if (!isPlainObject(value)) {
    throw inputInvalid(`${path} must be a plain JSON object; got ${describeValue(value)}.`);
  }
  return cloneJsonValue(value, path, maxDepth) as JsonObject;
}

function cloneJson(
  value: unknown,
  path: string,
  depth: number,
  maxDepth: number,
  ancestors: Set<object>,
): JsonValue | typeof DROP {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw inputInvalid(`${path} is ${String(value)}; only finite numbers are JSON.`);
      return value;
    case "undefined":
      return DROP;
    case "bigint":
      throw inputInvalid(`${path} is a bigint; send it as a string.`);
    case "function":
    case "symbol":
      throw inputInvalid(`${path} is a ${typeof value}; only JSON values can be sent.`);
    default:
      break;
  }
  if (value === null) return null;

  const object = value as object;
  if (depth >= maxDepth) throw inputInvalid(`${path} is nested deeper than ${maxDepth} levels.`);
  if (ancestors.has(object)) throw inputInvalid(`${path} contains a circular reference.`);

  if (Array.isArray(object)) {
    ancestors.add(object);
    const out: JsonValue[] = [];
    for (let i = 0; i < object.length; i += 1) {
      const item = cloneJson(object[i], `${path}[${i}]`, depth + 1, maxDepth, ancestors);
      if (item === DROP) throw inputInvalid(`${path}[${i}] is undefined or missing; use null.`);
      out.push(item);
    }
    ancestors.delete(object);
    return out;
  }

  if (!isPlainObject(object)) {
    throw inputInvalid(
      `${path} is ${describeValue(object)}; convert it to a string, number, boolean, array or plain object first.`,
    );
  }

  ancestors.add(object);
  const out: JsonObject = {};
  for (const name of Object.keys(object)) {
    const item = cloneJson(object[name], `${path}.${name}`, depth + 1, maxDepth, ancestors);
    if (item === DROP) continue;
    // defineProperty keeps a "__proto__" key as an own property, as JSON.parse does.
    Object.defineProperty(out, name, { value: item, enumerable: true, writable: true, configurable: true });
  }
  ancestors.delete(object);
  return out;
}

/** Freeze a plain-JSON value and everything inside it. Returns the same value. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    const record = value as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) deepFreeze(record[key]);
  }
  return value;
}

/** UTF-8 byte length of a string, without allocating. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/** Characters as the Writ engine counts them (Unicode code points, not UTF-16 units). */
export function charCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

/** A short description of a value for error messages. Never prints a whole object. */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value.length > 70 ? `${value.slice(0, 70)}...` : value);
  if (typeof value === "object") {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" && name !== "" && name !== "Object" ? `a ${name}` : "an object";
  }
  return `a ${typeof value}`;
}
