/**
 * Error model: one class, {@link WritBridgeError}, carrying a stable {@link WritBridgeErrorCode}
 * (docs/browser-extension/CONTRACT.md §12.4, plus every code the visitor's side can answer).
 */

/** Codes the server bridge itself raises. */
export type WritBridgeOwnCode =
  | "WRIT_REQUIRED"
  | "USER_OFFLINE"
  | "RESULT_UNVERIFIED"
  | "CLOUD_NOT_CONFIGURED"
  | "CLOUD_UNAVAILABLE"
  | "QUOTA_EXCEEDED"
  | "CONFIG_INVALID";

/** Codes a call on the visitor's computer can end with (CONTRACT.md, "Error codes"). */
export type WritVisitorCode =
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
  // Linked workflows (CONTRACT.md §11): the visitor's Writ could not fetch the recipe.
  | "RECIPE_UNAVAILABLE"
  | "PUBLICATION_REVOKED";

/** Every code a {@link WritBridgeError} can carry. */
export type WritBridgeErrorCode = WritBridgeOwnCode | WritVisitorCode;

const DEFAULT_MESSAGES: Readonly<Record<WritBridgeErrorCode, string>> = Object.freeze({
  WRIT_REQUIRED: "This function runs only on the user's own computer, and the user has not set Writ up for this site.",
  USER_OFFLINE: "None of the user's pages is connected right now.",
  RESULT_UNVERIFIED: "The result did not come with a valid Writ receipt for this call.",
  CLOUD_NOT_CONFIGURED: "This function has no Writ Cloud workflow mapped, or WRIT_API_KEY is not set.",
  CLOUD_UNAVAILABLE: "Writ Cloud could not be reached.",
  QUOTA_EXCEEDED: "The Writ Cloud plan behind WRIT_API_KEY is out of runs, or of linked workflow deliveries.",
  CONFIG_INVALID: "The bridge configuration is invalid.",
  NOT_INSTALLED: "The Writ browser extension is not installed in the user's browser.",
  DESKTOP_MISSING: "Writ desktop is not installed on the user's computer.",
  DESKTOP_OUTDATED: "The user's Writ extension and Writ desktop speak different protocol versions.",
  DAEMON_UNAVAILABLE: "Writ could not reach or start its engine on the user's computer.",
  VAULT_LOCKED: "The user's Writ vault is locked.",
  CONSENT_DENIED: "The user declined.",
  NOT_GRANTED: "This site has no permission for that function.",
  GRANT_STALE: "The function changed since the user approved it.",
  WRITE_NEEDS_CONFIRM: "This change needs the user's confirmation.",
  INPUT_INVALID: "The inputs were refused.",
  RATE_LIMITED: "Too many calls. Wait, then try again.",
  LAN_NOT_ALLOWED: "The run needed a local-network address the owner has not approved.",
  RUN_FAILED: "The run failed.",
  CANCELLED: "The call was cancelled.",
  TIMEOUT: "The call took too long.",
  RESULT_TOO_LARGE: "The result is larger than Writ returns to a website.",
  BAD_REQUEST: "The request was malformed.",
  ORIGIN_NOT_ALLOWED: "Writ only answers https pages, in the top frame.",
  INTERNAL: "Writ failed unexpectedly.",
  RECIPE_UNAVAILABLE: "The user's Writ could not get the linked workflow's recipe from Writ Cloud.",
  PUBLICATION_REVOKED: "The linked workflow was withdrawn from Writ Cloud.",
});

/** All error codes. */
export const WRIT_BRIDGE_ERROR_CODES: readonly WritBridgeErrorCode[] = Object.freeze(
  Object.keys(DEFAULT_MESSAGES) as WritBridgeErrorCode[],
);

const CODE_SET: ReadonlySet<string> = new Set<string>(WRIT_BRIDGE_ERROR_CODES);

/** The HTTP status the page channel answers each code with. */
const HTTP_STATUS: Readonly<Partial<Record<WritBridgeErrorCode, number>>> = Object.freeze({
  BAD_REQUEST: 400,
  INPUT_INVALID: 400,
  QUOTA_EXCEEDED: 402,
  NOT_GRANTED: 403,
  WRIT_REQUIRED: 403,
  RATE_LIMITED: 429,
  RUN_FAILED: 502,
  CLOUD_UNAVAILABLE: 503,
  CLOUD_NOT_CONFIGURED: 503,
  CONFIG_INVALID: 503,
  TIMEOUT: 504,
});

/** Optional extras for a {@link WritBridgeError}. */
export interface WritBridgeErrorOptions {
  /** Structured context (the receipt, the Writ Cloud task id, an unknown visitor code...). Never secrets. */
  details?: Record<string, unknown>;
  /** The underlying error. */
  cause?: unknown;
}

/** Every failure this library reports: a stable {@link WritBridgeErrorCode} plus a readable message. */
export class WritBridgeError extends Error {
  /** Stable machine code. Branch on this, never on `message`. */
  readonly code: WritBridgeErrorCode;
  /** Structured context, when there is any. */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: WritBridgeErrorCode, message?: string, options: WritBridgeErrorOptions = {}) {
    super(
      message !== undefined && message !== "" ? message : DEFAULT_MESSAGES[code],
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WritBridgeError";
    this.code = code;
    if (options.details !== undefined) this.details = Object.freeze({ ...options.details });
  }

  /** The page channel's error envelope: `{ error: { code, message } }`. */
  toJSON(): { error: { code: WritBridgeErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

/** True when `value` is one of the codes above. */
export function isWritBridgeErrorCode(value: unknown): value is WritBridgeErrorCode {
  return typeof value === "string" && CODE_SET.has(value);
}

/**
 * True when `error` is a {@link WritBridgeError}, optionally with one of the given codes.
 *
 * ```ts
 * if (isWritBridgeError(e, "USER_OFFLINE")) return askUserToOpenTheApp();
 * if (isWritBridgeError(e, ["NOT_GRANTED", "GRANT_STALE"])) return showSetupHelp();
 * ```
 */
export function isWritBridgeError(
  error: unknown,
  code?: WritBridgeErrorCode | readonly WritBridgeErrorCode[],
): error is WritBridgeError {
  if (!(error instanceof WritBridgeError)) {
    if (typeof error !== "object" || error === null) return false;
    const record = error as { name?: unknown; code?: unknown; message?: unknown };
    if (record.name !== "WritBridgeError" || !isWritBridgeErrorCode(record.code) || typeof record.message !== "string") {
      return false;
    }
  }
  if (code === undefined) return true;
  const actual = (error as WritBridgeError).code;
  return typeof code === "string" ? actual === code : code.includes(actual);
}

/** The built-in message for a code. */
export function defaultMessage(code: WritBridgeErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

/** The HTTP status for a code on the page channel. */
export function httpStatusOf(code: WritBridgeErrorCode): number {
  return HTTP_STATUS[code] ?? 500;
}

/**
 * A code reported by the visitor's side, as a known code. `PROTOCOL_MISMATCH` is the host's
 * spelling of `DESKTOP_OUTDATED`; anything else unknown becomes `INTERNAL`.
 */
export function normalizeVisitorCode(raw: unknown): WritBridgeErrorCode {
  if (isWritBridgeErrorCode(raw)) return raw;
  if (raw === "PROTOCOL_MISMATCH") return "DESKTOP_OUTDATED";
  return "INTERNAL";
}

/** Any thrown value as a {@link WritBridgeError}; unknown failures become `INTERNAL`. */
export function toWritBridgeError(error: unknown): WritBridgeError {
  if (error instanceof WritBridgeError) return error;
  const message = error instanceof Error ? error.message : undefined;
  return new WritBridgeError("INTERNAL", message, { cause: error });
}
