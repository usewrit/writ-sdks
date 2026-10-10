/** WritBridgeError and its helpers. */

import { describe, expect, it } from "vitest";

import { WRIT_BRIDGE_ERROR_CODES, WritBridgeError, defaultMessage, isWritBridgeError, isWritBridgeErrorCode } from "../src/index.js";

describe("WritBridgeError", () => {
  it("carries a code, a default message and frozen details", () => {
    const error = new WritBridgeError("USER_OFFLINE", undefined, { details: { userId: "u1" } });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("WritBridgeError");
    expect(error.code).toBe("USER_OFFLINE");
    expect(error.message).toBe(defaultMessage("USER_OFFLINE"));
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(error.toJSON()).toEqual({ error: { code: "USER_OFFLINE", message: defaultMessage("USER_OFFLINE") } });
  });

  it("keeps its cause", () => {
    const cause = new Error("socket closed");
    expect(new WritBridgeError("CLOUD_UNAVAILABLE", "down", { cause }).cause).toBe(cause);
  });

  it("lists every server and visitor code", () => {
    for (const code of ["WRIT_REQUIRED", "USER_OFFLINE", "RESULT_UNVERIFIED", "TIMEOUT", "NOT_GRANTED", "CLOUD_NOT_CONFIGURED", "CLOUD_UNAVAILABLE", "QUOTA_EXCEEDED", "RUN_FAILED", "INPUT_INVALID", "CONSENT_DENIED", "LAN_NOT_ALLOWED"]) {
      expect(WRIT_BRIDGE_ERROR_CODES).toContain(code);
      expect(isWritBridgeErrorCode(code)).toBe(true);
    }
    expect(isWritBridgeErrorCode("PROTOCOL_MISMATCH")).toBe(false);
  });

  it("isWritBridgeError() narrows by code, and recognises a copy from another module instance", () => {
    const error = new WritBridgeError("TIMEOUT");
    expect(isWritBridgeError(error)).toBe(true);
    expect(isWritBridgeError(error, "TIMEOUT")).toBe(true);
    expect(isWritBridgeError(error, ["USER_OFFLINE", "TIMEOUT"])).toBe(true);
    expect(isWritBridgeError(error, "USER_OFFLINE")).toBe(false);
    expect(isWritBridgeError({ name: "WritBridgeError", code: "TIMEOUT", message: "late" }, "TIMEOUT")).toBe(true);
    expect(isWritBridgeError(new Error("x"))).toBe(false);
    expect(isWritBridgeError(null)).toBe(false);
  });
});
