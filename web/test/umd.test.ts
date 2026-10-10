/** The script-tag entry defines window.WritWeb and leaves window.writ to the extension. */

import { afterEach, describe, expect, it } from "vitest";
import {
  VERSION,
  WritError,
  connectWrit,
  contractFunctions,
  createWritBridge,
  createWritClient,
  definePackage,
  isWritError,
  mountWritBanner,
  validateContract,
} from "../src/index.js";

type WithGlobals = { WritWeb?: Record<string, unknown>; writ?: unknown };

afterEach(() => {
  delete (globalThis as unknown as WithGlobals).WritWeb;
});

describe("umd entry", () => {
  it("exposes the public API on WritWeb only", async () => {
    await import("../src/umd.js");
    const api = (globalThis as unknown as WithGlobals).WritWeb;
    expect(api).toBeDefined();
    expect(api?.createWritBridge).toBe(createWritBridge);
    expect(api?.connectWrit).toBe(connectWrit);
    expect(api?.mountWritBanner).toBe(mountWritBanner);
    expect(api?.createWritClient).toBe(createWritClient);
    expect(api?.validateContract).toBe(validateContract);
    expect(api?.contractFunctions).toBe(contractFunctions);
    expect(api?.definePackage).toBe(definePackage);
    expect(api?.WritError).toBe(WritError);
    expect(api?.isWritError).toBe(isWritError);
    expect(api?.version).toBe(VERSION);
    expect(Object.isFrozen(api)).toBe(true);
    expect("writ" in globalThis).toBe(false);
  });
});
