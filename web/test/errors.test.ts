/** The error model: codes, isWritError, and normalising what the provider rejects with. */

import { describe, expect, it } from "vitest";
import { WRIT_ERROR_CODES, WritError, isWritError, isWritErrorCode } from "../src/index.js";
import { normalizeErrorCode, toWritError } from "../src/errors.js";

describe("WritError", () => {
  it("carries a contract code, a default message and frozen details", () => {
    const error = new WritError("CONSENT_DENIED", undefined, { details: { method: "writ_connect" } });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("WritError");
    expect(error.code).toBe("CONSENT_DENIED");
    expect(error.message).toBe("The user declined.");
    expect(error.details).toEqual({ method: "writ_connect" });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it("keeps the cause", () => {
    const cause = new Error("boom");
    expect(new WritError("INTERNAL", "wrapped", { cause }).cause).toBe(cause);
  });

  it("lists every contract code once", () => {
    expect(WRIT_ERROR_CODES).toEqual([
      "NOT_INSTALLED",
      "DESKTOP_MISSING",
      "DESKTOP_OUTDATED",
      "DAEMON_UNAVAILABLE",
      "VAULT_LOCKED",
      "CONSENT_DENIED",
      "NOT_GRANTED",
      "GRANT_STALE",
      "WRITE_NEEDS_CONFIRM",
      "INPUT_INVALID",
      "RATE_LIMITED",
      "LAN_NOT_ALLOWED",
      "RUN_FAILED",
      "CANCELLED",
      "TIMEOUT",
      "RESULT_TOO_LARGE",
      "BAD_REQUEST",
      "ORIGIN_NOT_ALLOWED",
      "INTERNAL",
      "RECIPE_UNAVAILABLE",
      "PUBLICATION_REVOKED",
      "QUOTA_EXCEEDED",
      "WRIT_REQUIRED",
      "USER_OFFLINE",
      "RESULT_UNVERIFIED",
      "CLOUD_NOT_CONFIGURED",
    ]);
    expect(isWritErrorCode("RUN_FAILED")).toBe(true);
    expect(isWritErrorCode("run_failed")).toBe(false);
  });
});

describe("isWritError", () => {
  it("matches a code or any of several", () => {
    const error = new WritError("GRANT_STALE");
    expect(isWritError(error)).toBe(true);
    expect(isWritError(error, "GRANT_STALE")).toBe(true);
    expect(isWritError(error, "NOT_GRANTED")).toBe(false);
    expect(isWritError(error, ["NOT_GRANTED", "GRANT_STALE"])).toBe(true);
  });

  it("rejects other errors", () => {
    expect(isWritError(new Error("x"))).toBe(false);
    expect(isWritError({ code: "TIMEOUT", message: "x" })).toBe(false);
    expect(isWritError(null)).toBe(false);
  });

  it("recognises a WritError from another copy of the library", () => {
    const foreign = Object.assign(new Error("from the IIFE build"), { name: "WritError", code: "TIMEOUT" });
    expect(isWritError(foreign, "TIMEOUT")).toBe(true);
  });
});

describe("toWritError", () => {
  it("maps a provider rejection { code, message }", () => {
    const error = toWritError({ code: "CONSENT_DENIED", message: "Declined in the consent window." });
    expect(error.code).toBe("CONSENT_DENIED");
    expect(error.message).toBe("Declined in the consent window.");
  });

  it("maps an Error with a code property", () => {
    const raw = Object.assign(new Error("Vault is locked"), { code: "VAULT_LOCKED" });
    expect(toWritError(raw)).toMatchObject({ code: "VAULT_LOCKED", message: "Vault is locked" });
  });

  it("turns an unknown code into INTERNAL and keeps it", () => {
    const error = toWritError({ code: "SOMETHING_NEW", message: "new failure" });
    expect(error.code).toBe("INTERNAL");
    expect(error.details).toEqual({ providerCode: "SOMETHING_NEW" });
  });

  it("reads the host-side PROTOCOL_MISMATCH as DESKTOP_OUTDATED", () => {
    expect(normalizeErrorCode("PROTOCOL_MISMATCH")).toBe("DESKTOP_OUTDATED");
    expect(toWritError({ code: "PROTOCOL_MISMATCH", message: "x" }).code).toBe("DESKTOP_OUTDATED");
  });

  it("wraps anything else as INTERNAL", () => {
    expect(toWritError(new TypeError("bad")).code).toBe("INTERNAL");
    expect(toWritError("text").message).toBe("text");
    expect(toWritError(undefined).message).toBe("Writ failed unexpectedly.");
  });

  it("adds details without losing the code", () => {
    const error = toWritError(new WritError("RATE_LIMITED"), { method: "writ_call" });
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.details).toEqual({ method: "writ_call" });
  });
});
