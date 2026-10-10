/**
 * Checks that run before anything is sent to the extension. The extension and the Writ engine
 * enforce the same rules again: these exist to fail fast with a precise message, never as the
 * security boundary.
 */

import {
  FORBIDDEN_INPUT_PREFIXES,
  FUNCTION_KEY_PATTERN,
  MAX_APP_NAME_LENGTH,
  MAX_CALL_TIMEOUT_MS,
  MAX_CHALLENGE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_INPUT_BYTES,
  MAX_INPUT_DEPTH,
  MAX_SETTING_VALUE_LENGTH,
  MAX_SUGGESTED_SETTINGS,
  MIN_CALL_TIMEOUT_MS,
  RESERVED_INPUT_NAMES,
  SETTING_KEY_PATTERN,
  UNSAFE_TEXT_PATTERN,
} from "./constants.js";
import { WritError } from "./errors.js";
import { cloneJsonValue, describeValue, isPlainObject, utf8Length } from "./json.js";
import { isLinkedPackage, packageSettings, validateLinkedPackage, validateRecipeCache } from "./linked.js";
import { selectPackageFunction, validatePackage } from "./package.js";
import { checkGivenRunToken } from "./run-token.js";
import type {
  ConnectRequest,
  FunctionMatch,
  FunctionRequest,
  JsonObject,
  WritContractPackage,
  WritRecipeCache,
  WritSettingValues,
} from "./types.js";

export { isPlainObject, utf8Length } from "./json.js";

/** A connect request, validated and stripped to the fields the contract defines. */
export interface CleanConnectRequest {
  app: string;
  functions: FunctionRequest[];
}

/** Call options, validated. */
export interface CleanCallOptions {
  signal: AbortSignal | undefined;
  timeoutMs: number | undefined;
  dryRun: boolean | undefined;
  challenge: string | undefined;
  /** A run token as given, or a function that gets one (linked workflows in token mode). */
  token: string | (() => Promise<string>) | undefined;
  recipeCache: WritRecipeCache | undefined;
}

function badRequest(message: string): WritError {
  return new WritError("BAD_REQUEST", message);
}

function inputInvalid(message: string): WritError {
  return new WritError("INPUT_INVALID", message);
}

/** A function key, or BAD_REQUEST. */
export function validateFunctionKey(key: unknown): string {
  if (typeof key !== "string" || !FUNCTION_KEY_PATTERN.test(key)) {
    throw badRequest(
      `Function key ${describeValue(key)} is not valid: use 1 to 64 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit (e.g. "pos.receive").`,
    );
  }
  return key;
}

/**
 * Validate `writ.connect()`'s argument. BAD_REQUEST for a malformed request; INPUT_INVALID for
 * a `package` the Writ engine would refuse, a `function` that does not pick one of its
 * functions, or `settings` that are not valid suggestions for its settings (CONTRACT.md §8).
 *
 * Only the fields sent to the extension are returned: `getRunToken` and `recipeCache` stay in the
 * page (`linkedSessionConfig`).
 */
export function validateConnectRequest(request: ConnectRequest): CleanConnectRequest {
  if (!isPlainObject(request)) {
    throw badRequest('connect() takes { app, functions: [{ key, description }] }.');
  }

  const rawApp = request.app;
  if (typeof rawApp !== "string" || rawApp.trim() === "") {
    throw badRequest("connect() needs `app`: your app's name, shown in the consent window.");
  }
  const app = rawApp.trim();
  if (app.length > MAX_APP_NAME_LENGTH) {
    throw badRequest(`\`app\` is ${app.length} characters; at most ${MAX_APP_NAME_LENGTH} are allowed.`);
  }

  return { app, functions: validateFunctionRequests(request.functions, "connect()") };
}

/**
 * Validate a list of function requests (`connect()`'s `functions`, or `resume()`'s), with the
 * same rules and codes as {@link validateConnectRequest}. A `package` is a bundled package
 * (`writ.workflow/v1`, CONTRACT.md §8) or a linked one (`writ.linked/v1`, §11).
 */
export function validateFunctionRequests(rawFunctions: unknown, label: string): FunctionRequest[] {
  if (!Array.isArray(rawFunctions) || rawFunctions.length === 0) {
    throw badRequest(`${label} needs \`functions\`: at least one { key, description }.`);
  }

  const seen = new Set<string>();
  const packages = new Map<string, { where: string; json: string }>();
  /** The first suggestion for each package's setting, to refuse a different one on another key. */
  const suggested = new Map<string, Map<string, { where: string; value: string }>>();
  const functions: FunctionRequest[] = [];
  rawFunctions.forEach((raw: unknown, index: number) => {
    const where = `functions[${index}]`;
    if (!isPlainObject(raw)) throw badRequest(`${where} must be an object { key, description }.`);

    const key = validateFunctionKey(raw.key);
    if (seen.has(key)) throw badRequest(`Function key "${key}" is requested twice.`);
    seen.add(key);

    const rawDescription = raw.description;
    if (typeof rawDescription !== "string" || rawDescription.trim() === "") {
      throw badRequest(`${where} ("${key}") needs a description; the user reads it in the consent window.`);
    }
    const description = rawDescription.trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw badRequest(
        `The description of "${key}" is ${description.length} characters; at most ${MAX_DESCRIPTION_LENGTH} are allowed.`,
      );
    }

    const clean: FunctionRequest = { key, description };

    if (raw.writes !== undefined) {
      if (typeof raw.writes !== "boolean") throw badRequest(`${where}.writes must be true or false.`);
      clean.writes = raw.writes;
    }

    if (raw.match !== undefined) {
      if (!isPlainObject(raw.match)) {
        throw badRequest(`${where}.match must be an object { name?, host? }.`);
      }
      const match: FunctionMatch = {};
      for (const field of ["name", "host"] as const) {
        const value = raw.match[field];
        if (value === undefined) continue;
        if (typeof value !== "string") throw badRequest(`${where}.match.${field} must be a string.`);
        const trimmed = value.trim();
        if (trimmed !== "") match[field] = trimmed;
      }
      if (match.name !== undefined || match.host !== undefined) clean.match = match;
    }

    if (raw.package !== undefined) {
      const pkg: WritContractPackage = isLinkedPackage(raw.package)
        ? validateLinkedPackage(raw.package, `${where}.package`)
        : validatePackage(raw.package, `${where}.package`);
      const json = JSON.stringify(pkg);
      const earlier = packages.get(pkg.id);
      if (earlier !== undefined && earlier.json !== json) {
        throw inputInvalid(
          `${earlier.where}.package and ${where}.package are different packages with the same id "${pkg.id}"; one id names one installed workflow, so ship one package and pick its functions with \`function\`.`,
        );
      }
      packages.set(pkg.id, { where, json });
      clean.package = pkg;
      const fn = selectPackageFunction(pkg, raw.function, where);
      if (fn !== undefined) clean.function = fn;
    } else if (raw.function !== undefined) {
      throw inputInvalid(
        `${where}.function picks a function of the workflow package this key installs, but ${where} has no \`package\`.`,
      );
    }

    if (raw.settings !== undefined && raw.settings !== null) {
      const pkg = clean.package;
      if (pkg === undefined) {
        throw inputInvalid(
          `${where}.settings suggests values for the settings of the workflow package this key installs, but ${where} has no \`package\`.`,
        );
      }
      const settings = validateSuggestedSettings(raw.settings, `${where}.settings`, pkg);
      const first = suggested.get(pkg.id) ?? new Map<string, { where: string; value: string }>();
      suggested.set(pkg.id, first);
      for (const [name, value] of Object.entries(settings)) {
        const earlier = first.get(name);
        if (earlier === undefined) {
          first.set(name, { where, value });
        } else if (earlier.value !== value) {
          throw inputInvalid(
            `${where}.settings.${name} is ${JSON.stringify(value)}, but ${earlier.where}.settings.${name} is ${JSON.stringify(earlier.value)}: both keys install package "${pkg.id}", which keeps one value per setting. Suggest the same value, or leave it out on one of them.`,
          );
        }
      }
      if (Object.keys(settings).length > 0) clean.settings = settings;
    }

    functions.push(clean);
  });

  return functions;
}

/**
 * Suggested values for a package's settings (`FunctionRequest.settings`, CONTRACT.md §8): a
 * plain object of at most 8 of `pkg`'s declared setting keys, each value text of 1 to 200
 * characters without control characters, as the extension enforces. An `undefined` value is
 * left out, as JSON would. Returns a copy with the values trimmed; INPUT_INVALID otherwise.
 * `where` names the field in messages.
 *
 * Only the text is checked: a `lan_host` suggestion that is not a valid address still reaches
 * the consent window, which leaves the field for the user to fill in.
 */
export function validateSuggestedSettings(value: unknown, where: string, pkg: WritContractPackage): WritSettingValues {
  if (!isPlainObject(value)) {
    throw inputInvalid(
      `${where} must be an object { [setting key]: value }, like { pos_host: "192.168.1.20:8080" }; got ${describeValue(value)}.`,
    );
  }
  const record: Record<string, unknown> = value;
  const names = Object.keys(record).filter((name) => record[name] !== undefined);
  if (names.length > MAX_SUGGESTED_SETTINGS) {
    throw inputInvalid(`${where} has ${names.length} entries; at most ${MAX_SUGGESTED_SETTINGS} are allowed.`);
  }
  const declared = packageSettings(pkg).map((setting) => setting.key);
  const out: WritSettingValues = {};
  for (const name of names) {
    if (!SETTING_KEY_PATTERN.test(name) || !declared.includes(name)) {
      const listed = declared.map((key) => `"${key}"`).join(", ");
      throw inputInvalid(
        `${where} names ${JSON.stringify(name)}, but package "${pkg.id}" has no such setting; ${declared.length === 0 ? "it declares none" : `its settings are ${listed}`}.`,
      );
    }
    const raw = record[name];
    if (typeof raw !== "string") throw inputInvalid(`${where}.${name} must be text; got ${describeValue(raw)}.`);
    const text = raw.trim();
    if (text === "") {
      throw inputInvalid(`${where}.${name} is empty; leave it out and the user types the value in Writ's consent window.`);
    }
    if (text.length > MAX_SETTING_VALUE_LENGTH) {
      throw inputInvalid(`${where}.${name} is ${text.length} characters; at most ${MAX_SETTING_VALUE_LENGTH} are allowed.`);
    }
    if (UNSAFE_TEXT_PATTERN.test(text)) throw inputInvalid(`${where}.${name} contains control characters.`);
    // defineProperty keeps a "__proto__" key an own property, as JSON.parse does.
    Object.defineProperty(out, name, { value: text, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Validate a call's options; BAD_REQUEST on any problem. */
export function validateCallOptions(options: unknown): CleanCallOptions {
  if (options === undefined || options === null) {
    return {
      signal: undefined,
      timeoutMs: undefined,
      dryRun: undefined,
      challenge: undefined,
      token: undefined,
      recipeCache: undefined,
    };
  }
  if (typeof options !== "object") {
    throw badRequest("Call options must be an object { signal?, timeoutMs?, dryRun?, challenge?, token?, recipeCache? }.");
  }
  const { signal, timeoutMs, dryRun, challenge, token, recipeCache } = options as {
    signal?: unknown;
    timeoutMs?: unknown;
    dryRun?: unknown;
    challenge?: unknown;
    token?: unknown;
    recipeCache?: unknown;
  };

  if (signal !== undefined && !isAbortSignal(signal)) {
    throw badRequest("`signal` must be an AbortSignal (from new AbortController().signal).");
  }

  let clamped: number | undefined;
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw badRequest("`timeoutMs` must be a positive number of milliseconds.");
    }
    clamped = clampTimeout(timeoutMs);
  }

  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    throw badRequest("`dryRun` must be true or false.");
  }

  let cleanToken: CleanCallOptions["token"];
  if (typeof token === "function") cleanToken = token as () => Promise<string>;
  else if (token !== undefined && token !== null) cleanToken = checkGivenRunToken(token);

  return {
    signal: signal as AbortSignal | undefined,
    timeoutMs: clamped,
    dryRun: dryRun as boolean | undefined,
    challenge: validateChallenge(challenge),
    token: cleanToken,
    recipeCache: validateRecipeCache(recipeCache, "`recipeCache`"),
  };
}

/**
 * A call's `challenge` (CONTRACT.md §12.1): the opaque string your server minted, 1 to 2 048
 * characters, sent as is (never trimmed: the receipt signs it byte for byte). BAD_REQUEST otherwise.
 */
export function validateChallenge(challenge: unknown): string | undefined {
  if (challenge === undefined || challenge === null) return undefined;
  if (typeof challenge !== "string" || challenge === "") {
    throw badRequest("`challenge` must be the non-empty string your server minted (bridge.challenge(...)).");
  }
  if (challenge.length > MAX_CHALLENGE_LENGTH) {
    throw badRequest(`\`challenge\` is ${challenge.length} characters; at most ${MAX_CHALLENGE_LENGTH} are allowed.`);
  }
  return challenge;
}

/** The extension's clamp for `timeout_ms`, applied before sending so both sides agree. */
export function clampTimeout(ms: number): number {
  return Math.min(MAX_CALL_TIMEOUT_MS, Math.max(MIN_CALL_TIMEOUT_MS, Math.round(ms)));
}

/** Validate `connectWrit({ timeoutMs })`; BAD_REQUEST when it is not a non-negative number. */
export function validateDiscoveryTimeout(timeoutMs: unknown, fallback: number): number {
  if (timeoutMs === undefined) return fallback;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw badRequest("connectWrit({ timeoutMs }) must be a non-negative number of milliseconds.");
  }
  return Math.round(timeoutMs);
}

/**
 * Validate a call's `inputs` and return a fresh plain-JSON copy (INPUT_INVALID on any problem).
 *
 * Rules: a plain object; JSON values only (no functions, symbols, bigints, non-finite numbers,
 * Dates, Maps, class instances, cycles); no reserved names (`persona_id`, `function_name`,
 * `auth_policy`) and no `secret:` / `file:` names; at most 1 MB as UTF-8 JSON. An `undefined`
 * property is dropped, as `JSON.stringify` would.
 */
export function sanitizeInputs(inputs: unknown): JsonObject | undefined {
  if (inputs === undefined) return undefined;
  if (!isPlainObject(inputs)) {
    throw inputInvalid(
      `inputs must be a plain JSON object, like { invoice_no: "F-1029" }; got ${describeValue(inputs)}.`,
    );
  }

  for (const name of Object.keys(inputs)) {
    if (RESERVED_INPUT_NAMES.includes(name)) {
      throw inputInvalid(
        `A website cannot set "${name}": the user chose it when binding the function.`,
      );
    }
    const lower = name.toLowerCase();
    if (FORBIDDEN_INPUT_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      throw inputInvalid(
        `Input "${name}" names a secret or a file; websites can only pass the function's declared plain inputs.`,
      );
    }
  }

  const copy = cloneJsonValue(inputs, "inputs", MAX_INPUT_DEPTH) as JsonObject;
  const bytes = utf8Length(JSON.stringify(copy));
  if (bytes > MAX_INPUT_BYTES) {
    throw inputInvalid(`inputs are ${bytes} bytes as JSON; the limit is ${MAX_INPUT_BYTES}.`);
  }
  return copy;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { aborted?: unknown; addEventListener?: unknown; removeEventListener?: unknown };
  return (
    typeof record.aborted === "boolean" &&
    typeof record.addEventListener === "function" &&
    typeof record.removeEventListener === "function"
  );
}
