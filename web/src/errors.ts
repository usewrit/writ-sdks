/**
 * Error model: one class, {@link WritError}, carrying a stable {@link WritErrorCode} from the
 * wire contract (docs/browser-extension/CONTRACT.md, "Error codes").
 */

/** Every error code a call can end with, on every hop. */
export type WritErrorCode =
  | "NOT_INSTALLED"
  | "DESKTOP_MISSING"
  | "DESKTOP_OUTDATED"
  | "DAEMON_UNAVAILABLE"
  | "VAULT_LOCKED"
  | "CONSENT_DENIED"
  | "NOT_GRANTED"
  | "GRANT_STALE"
  | "WRITE_NEEDS_CONFIRM"
  | "INPUT_INVALID"
  | "RATE_LIMITED"
  | "LAN_NOT_ALLOWED"
  | "RUN_FAILED"
  | "CANCELLED"
  | "TIMEOUT"
  | "RESULT_TOO_LARGE"
  | "BAD_REQUEST"
  | "ORIGIN_NOT_ALLOWED"
  | "INTERNAL"
  // Linked workflows (CONTRACT.md §11): fetching the recipe from the developer's Writ Cloud.
  | "RECIPE_UNAVAILABLE"
  | "PUBLICATION_REVOKED"
  | "QUOTA_EXCEEDED"
  // Writ Bridge (CONTRACT.md §12.4): what your server's bridge can answer the page.
  | "WRIT_REQUIRED"
  | "USER_OFFLINE"
  | "RESULT_UNVERIFIED"
  | "CLOUD_NOT_CONFIGURED";

const DEFAULT_MESSAGES: Readonly<Record<WritErrorCode, string>> = Object.freeze({
  NOT_INSTALLED: "The Writ browser extension is not installed in this browser.",
  DESKTOP_MISSING:
    "Writ desktop is not installed on this computer, or is too old to talk to the extension.",
  DESKTOP_OUTDATED: "The Writ extension and Writ desktop speak different protocol versions.",
  DAEMON_UNAVAILABLE: "Writ could not reach or start its engine on this computer.",
  VAULT_LOCKED: "The Writ vault is locked. Unlock Writ and try again.",
  CONSENT_DENIED: "The user declined.",
  NOT_GRANTED: "This site has no permission for that function. Call connect() first.",
  GRANT_STALE: "The function changed since the user approved it. Call connect() again.",
  WRITE_NEEDS_CONFIRM: "This change needs the user's confirmation.",
  INPUT_INVALID: "The inputs were refused.",
  RATE_LIMITED: "Too many calls from this site. Wait, then try again.",
  LAN_NOT_ALLOWED: "The run needed a local-network address the owner has not approved.",
  RUN_FAILED: "The run failed.",
  CANCELLED: "The call was cancelled.",
  TIMEOUT: "The call took too long.",
  RESULT_TOO_LARGE: "The result is larger than Writ returns to a website.",
  BAD_REQUEST: "The request was malformed.",
  ORIGIN_NOT_ALLOWED: "Writ only answers https pages, in the top frame.",
  INTERNAL: "Writ failed unexpectedly.",
  RECIPE_UNAVAILABLE: "Writ could not get this workflow from the site's Writ Cloud. Check the connection, then retry.",
  PUBLICATION_REVOKED: "The site withdrew this workflow.",
  QUOTA_EXCEEDED: "The site's Writ plan is out of workflow deliveries for this month.",
  WRIT_REQUIRED: "This function runs only on the visitor's computer, with Writ.",
  USER_OFFLINE: "None of this user's pages has Writ ready right now.",
  RESULT_UNVERIFIED: "The result's Writ receipt did not verify.",
  CLOUD_NOT_CONFIGURED: "The site's server is not set up to run this function on Writ Cloud.",
});

/** All error codes, in contract order, then the linked workflows' (§11), then the Writ Bridge's. */
export const WRIT_ERROR_CODES: readonly WritErrorCode[] = Object.freeze(
  Object.keys(DEFAULT_MESSAGES) as WritErrorCode[],
);

const CODE_SET: ReadonlySet<string> = new Set<string>(WRIT_ERROR_CODES);

/** Optional extras for a {@link WritError}. */
export interface WritErrorOptions {
  /** Structured context (call id, the provider's own unknown code, ...). Never secrets. */
  details?: Record<string, unknown>;
  /** The underlying error or abort reason. */
  cause?: unknown;
}

/** Every failure this library reports: a contract {@link WritErrorCode} plus a readable message. */
export class WritError extends Error {
  /** Stable machine code from the contract. Branch on this, never on `message`. */
  readonly code: WritErrorCode;
  /** Structured context, when there is any. */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: WritErrorCode, message?: string, options: WritErrorOptions = {}) {
    super(
      message !== undefined && message !== "" ? message : DEFAULT_MESSAGES[code],
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    // A literal, not `new.target.name`: the IIFE build is minified and renames classes.
    this.name = "WritError";
    this.code = code;
    if (options.details !== undefined) this.details = Object.freeze({ ...options.details });
  }
}

/** True when `value` is one of the contract's error codes. */
export function isWritErrorCode(value: unknown): value is WritErrorCode {
  return typeof value === "string" && CODE_SET.has(value);
}

/**
 * True when `error` is a {@link WritError}, optionally with one of the given codes.
 *
 * Also recognises a WritError from another copy of this library on the page (the IIFE build
 * next to a bundled one), where `instanceof` fails.
 *
 * ```ts
 * if (isWritError(e, "CONSENT_DENIED")) showDeclinedNotice();
 * if (isWritError(e, ["NOT_GRANTED", "GRANT_STALE"])) await writ.connect(request);
 * ```
 */
export function isWritError(
  error: unknown,
  code?: WritErrorCode | readonly WritErrorCode[],
): error is WritError {
  if (!looksLikeWritError(error)) return false;
  if (code === undefined) return true;
  return typeof code === "string" ? error.code === code : code.includes(error.code);
}

/** The built-in message for a code. */
export function defaultMessage(code: WritErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

/**
 * Map a code from the wire to a contract code. `PROTOCOL_MISMATCH` is the host-side spelling
 * of `DESKTOP_OUTDATED`; anything unknown becomes `INTERNAL`.
 */
export function normalizeErrorCode(raw: unknown): WritErrorCode {
  if (isWritErrorCode(raw)) return raw;
  if (raw === "PROTOCOL_MISMATCH") return "DESKTOP_OUTDATED";
  return "INTERNAL";
}

/**
 * Turn anything the provider rejected with into a {@link WritError}. The provider rejects with
 * `{ code, message }` (an Error or a plain object); a code this version does not know becomes
 * `INTERNAL`, with the original kept in `details.providerCode`.
 */
export function toWritError(error: unknown, extraDetails?: Record<string, unknown>): WritError {
  if (error instanceof WritError && extraDetails === undefined) return error;
  if (looksLikeWritError(error)) {
    return new WritError(error.code, error.message, {
      details: mergeDetails(error.details, extraDetails),
      cause: error,
    });
  }
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown };
    const message =
      typeof record.message === "string" && record.message !== "" ? record.message : undefined;
    if (typeof record.code === "string" && record.code !== "") {
      const code = normalizeErrorCode(record.code);
      const providerCode = code === record.code ? undefined : { providerCode: record.code };
      return new WritError(code, message, {
        details: mergeDetails(providerCode, extraDetails),
        cause: error,
      });
    }
    return new WritError("INTERNAL", message, { details: extraDetails, cause: error });
  }
  if (typeof error === "string" && error !== "") {
    return new WritError("INTERNAL", error, { details: extraDetails });
  }
  return new WritError("INTERNAL", undefined, { details: extraDetails, cause: error });
}

function looksLikeWritError(error: unknown): error is WritError {
  if (error instanceof WritError) return true;
  if (typeof error !== "object" || error === null) return false;
  const record = error as { name?: unknown; code?: unknown; message?: unknown };
  return (
    record.name === "WritError" && isWritErrorCode(record.code) && typeof record.message === "string"
  );
}

function mergeDetails(
  a: Readonly<Record<string, unknown>> | undefined,
  b: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (a === undefined && b === undefined) return undefined;
  return { ...a, ...b };
}
