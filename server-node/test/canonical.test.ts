/** RFC 8785 canonical JSON (CONTRACT.md §11 "Canonical JSON"). */

import { describe, expect, it } from "vitest";

import { canonicalJson, dataHash, inputsHash, isWritBridgeError, sha256Hex } from "../src/index.js";
import { receiptGolden } from "./fixtures.js";

function refusal(value: unknown): unknown {
  try {
    canonicalJson(value);
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe("canonicalJson()", () => {
  it("sorts keys recursively, compact, integers as is", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: null, y: true }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":true,"z":null}]},"b":1}',
    );
  });

  it("sorts keys by UTF-16 code units, not code points (RFC 8785 §3.2.3)", () => {
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FF5E in UTF-16.
    expect(canonicalJson({ "\uff5e": 1, "\ud83d\ude00": 2, a: 0 })).toBe('{"a":0,"\ud83d\ude00":2,"\uff5e":1}');
  });

  it("emits non-ASCII as is and escapes only quotes, backslashes and control characters", () => {
    expect(canonicalJson({ s: 'Zoé "q" \\ \n\t\u0001\u001f\u007f' })).toBe('{"s":"Zoé \\"q\\" \\\\ \\n\\t\\u0001\\u001f\u007f"}');
  });

  it("prints -0 as 0, and a bigint as the double a JSON parser reads", () => {
    expect(canonicalJson([-0, 12n, 9007199254740993n])).toBe("[0,12,9007199254740992]");
  });

  // The same table as the engine's `numbers_canonicalize_as_javascript_prints_them`.
  it.each<[number, string]>([
    [0, "0"],
    [1.0, "1"],
    [12.5, "12.5"],
    [-12.5, "-12.5"],
    [0.1, "0.1"],
    [100.0, "100"],
    [1e20, "100000000000000000000"],
    [1e21, "1e+21"],
    [1.5e-7, "1.5e-7"],
    [0.000001, "0.000001"],
    [1e-7, "1e-7"],
    [-1e-7, "-1e-7"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [123456789.125, "123456789.125"],
    [0.1 + 0.2, "0.30000000000000004"],
    [2 ** 53 + 2, "9007199254740994"],
    [1.23e-18, "1.23e-18"],
  ])("prints %s as RFC 8785 does", (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it("hashes results with fractions", () => {
    expect(canonicalJson({ qty: 3, price: 12.5, lines: [{ t: 1.0 }] })).toBe('{"lines":[{"t":1}],"price":12.5,"qty":3}');
  });

  it("leaves out undefined properties, as JSON.stringify does", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it.each<[string, unknown]>([
    ["NaN", [Number.NaN]],
    ["Infinity", { n: Number.POSITIVE_INFINITY }],
    ["a lone surrogate", { s: "\ud83d" }],
    ["undefined in an array", [1, undefined]],
    ["a Date", { at: new Date(0) }],
    ["a function", { f: () => 1 }],
  ])("refuses %s", (_label, value) => {
    const error = refusal(value);
    expect(isWritBridgeError(error, "INPUT_INVALID")).toBe(true);
  });

  it("refuses cycles", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(isWritBridgeError(refusal(value), "INPUT_INVALID")).toBe(true);
  });

  it("names the path at fault", () => {
    expect((refusal({ a: [{ b: Number.NaN }] }) as Error).message).toContain("$.a[0].b");
  });
});

describe("golden receipt data", () => {
  it("reproduces the daemon's canonical bytes and data hash", () => {
    const golden = receiptGolden();
    expect(canonicalJson(golden.data)).toBe(golden.data_canonical);
    expect(sha256Hex(golden.data_canonical)).toBe(golden.data_hash);
    expect(dataHash(golden.data)).toBe(golden.data_hash);
  });

  it("reproduces the daemon's inputs hash (challenge, newline, canonical inputs)", () => {
    const golden = receiptGolden() as unknown as { inputs: unknown; inputs_hash: string; receipt: { challenge: string; inputs_hash: string } };
    expect(inputsHash(golden.receipt.challenge, golden.inputs)).toBe(golden.inputs_hash);
    expect(golden.receipt.inputs_hash).toBe(golden.inputs_hash);
    expect(inputsHash(null, {})).toBe(sha256Hex("\n{}"));
  });

  it("reproduces the receipt's canonical unsigned bytes", () => {
    const golden = receiptGolden();
    const { sig: _sig, ...unsigned } = golden.receipt;
    expect(canonicalJson(unsigned)).toBe(golden.receipt_canonical_unsigned);
  });
});
