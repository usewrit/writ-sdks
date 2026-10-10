/**
 * The contract file (`writ-contract.json`, CONTRACT.md §10) and the typed client built from it.
 *
 * ```ts
 * import contract from "./writ-contract.json";
 * import type { WritFunctions } from "./writ-functions";
 *
 * mountWritBanner({
 *   app: "Arrivos",
 *   contract,
 *   onReady(session) {
 *     const pos = createWritClient<WritFunctions>(session, contract);
 *     pos.pos.receive({ invoice_no: "F-1029" }).result.then(({ data }) => showReceived(data));
 *   },
 * });
 * ```
 *
 * The same code serves bundled and linked workflows (CONTRACT.md §11): the contract decides. A
 * contract with a linked workflow in `token` mode also needs `getRunToken` (on the banner, the
 * session or the client).
 */

import type { WritCall } from "./call.js";
import type { WritSession } from "./client.js";
import {
  CONTRACT_FORMAT,
  FUNCTION_KEY_PATTERN,
  MAX_DESCRIPTION_LENGTH,
  MAX_PACKAGE_SETTINGS,
  MAX_SETTING_LABEL_LENGTH,
  SETTING_KEY_PATTERN,
  SETTING_KINDS,
  WRIT_BRIDGE_MODES,
} from "./constants.js";
import { WritError } from "./errors.js";
import { charCount, deepFreeze, describeValue, isPlainObject } from "./json.js";
import {
  isLinkedPackage,
  linkedAccessOfContract,
  packageDisplayName,
  packageSettings,
  requireRunTokens,
  validateLinkedOptions,
  validateLinkedPackage,
} from "./linked.js";
import { selectPackageFunction, validatePackage } from "./package.js";
import type {
  CallOptions,
  FunctionRequest,
  JsonObject,
  WritBridgeMode,
  WritCloudMapping,
  WritContract,
  WritContractFunction,
  WritContractInput,
  WritContractPackage,
  WritContractSetting,
  WritLinkedAccess,
  WritLinkedOptions,
  WritRecipeCache,
  WritSettingKind,
  WritSettingSuggestions,
  WritSettingValues,
} from "./types.js";
import { validateSuggestedSettings } from "./validate.js";

function invalid(message: string): WritError {
  return new WritError("INPUT_INVALID", message);
}

/**
 * Key segments a contract may not use: each segment becomes a property of the typed client,
 * and these would break it (`then` makes a namespace look like a promise to `await`).
 */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["then", "__proto__", "constructor", "prototype"]);

// ---------------------------------------------------------------------------------------------
// validateContract
// ---------------------------------------------------------------------------------------------

/**
 * Check a contract file and return a deep-frozen copy. Accepts the parsed JSON or its text.
 *
 * Rules: `format` is `"writ.contract/v1"`; every bundled package passes the same checks as
 * `definePackage()`, every linked one (`"writ.linked/v1"`, CONTRACT.md §11) the checks of its
 * entry (ids, publishable key, base, access, manifest, manifest hash), and each package id is
 * unique; every function key is valid, unique, made of
 * non-empty dot-separated segments, and is never both a function and a namespace of another key
 * (`"pos"` next to `"pos.receive"`); every function names one of `packages` and, when that
 * package has several functions, which one it calls; a function's `settings`, when present, are
 * settings its package declares, with the same `kind`.
 *
 * Throws a {@link WritError} `INPUT_INVALID` whose message names the field at fault.
 */
export function validateContract(json: unknown): WritContract {
  let parsed: unknown = json;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch (error) {
      throw new WritError("INPUT_INVALID", "The contract is not valid JSON.", { cause: error });
    }
  }
  if (!isPlainObject(parsed)) {
    throw invalid(`The contract must be an object { format: "${CONTRACT_FORMAT}", functions, packages }; got ${describeValue(parsed)}.`);
  }
  const value: Record<string, unknown> = parsed;
  if (value.format !== CONTRACT_FORMAT) {
    throw invalid(`contract.format must be "${CONTRACT_FORMAT}"; got ${describeValue(value.format)}.`);
  }

  const generatedAt = value.generated_at;
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) {
    throw invalid(`contract.generated_at must be an ISO 8601 date; got ${describeValue(generatedAt)}.`);
  }
  const generator = value.generator;
  if (typeof generator !== "string" || generator.trim() === "") {
    throw invalid(`contract.generator must name what produced the file (e.g. "writ-desktop/1.0.8"); got ${describeValue(generator)}.`);
  }

  const contract: WritContract = {
    format: CONTRACT_FORMAT,
    generated_at: generatedAt,
    generator,
    functions: [],
    packages: [],
  };

  const publisher = value.publisher;
  if (publisher !== undefined && publisher !== null) {
    if (!isPlainObject(publisher)) throw invalid("contract.publisher must be an object { name? }.");
    const name = publisher.name;
    if (name !== undefined && name !== null && typeof name !== "string") throw invalid("contract.publisher.name must be text.");
    contract.publisher = typeof name === "string" ? { name } : {};
  }

  // Packages first: functions point at them.
  const rawPackages = value.packages;
  if (!Array.isArray(rawPackages)) {
    throw invalid(`contract.packages must be an array of workflow packages; got ${describeValue(rawPackages)}.`);
  }
  const packages = new Map<string, WritContractPackage>();
  rawPackages.forEach((raw: unknown, index: number) => {
    const where = `contract.packages[${index}]`;
    const pkg: WritContractPackage = isLinkedPackage(raw) ? validateLinkedPackage(raw, where) : validatePackage(raw, where);
    if (packages.has(pkg.id)) throw invalid(`contract.packages[${index}].id "${pkg.id}" is used by another package; each id once.`);
    packages.set(pkg.id, pkg);
    contract.packages.push(pkg);
  });

  const rawFunctions = value.functions;
  if (!Array.isArray(rawFunctions) || rawFunctions.length === 0) {
    throw invalid("contract.functions must list at least one function.");
  }
  const keys = new Set<string>();
  rawFunctions.forEach((raw: unknown, index: number) => {
    const fn = validateContractFunction(raw, `contract.functions[${index}]`, packages);
    if (keys.has(fn.key)) throw invalid(`contract.functions[${index}].key "${fn.key}" is listed twice.`);
    keys.add(fn.key);
    contract.functions.push(fn);
  });
  checkNamespaces([...keys]);

  return deepFreeze(contract);
}

function validateContractFunction(
  raw: unknown,
  where: string,
  packages: ReadonlyMap<string, WritContractPackage>,
): WritContractFunction {
  if (!isPlainObject(raw)) throw invalid(`${where} must be an object { key, description, package, function, inputs, outputs }.`);

  const key = raw.key;
  if (typeof key !== "string" || !FUNCTION_KEY_PATTERN.test(key)) {
    throw invalid(
      `${where}.key ${describeValue(key)} is not valid: use 1 to 64 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.`,
    );
  }
  for (const segment of key.split(".")) {
    if (segment === "") {
      throw invalid(`${where}.key "${key}" has an empty segment; dots separate namespaces, as in "pos.receive".`);
    }
    if (RESERVED_SEGMENTS.has(segment)) {
      throw invalid(`${where}.key "${key}" uses "${segment}", which cannot be a method or namespace name of the typed client.`);
    }
  }

  const description = raw.description;
  if (typeof description !== "string") throw invalid(`${where}.description must be text.`);

  const packageId = raw.package;
  if (typeof packageId !== "string") throw invalid(`${where}.package must be the id of one of contract.packages.`);
  const pkg = packages.get(packageId);
  if (pkg === undefined) {
    throw invalid(`${where}.package is "${packageId}", but contract.packages has no package with that id.`);
  }
  const chosen = selectPackageFunction(pkg, raw.function, where);

  const inputs = validateContractInputs(raw.inputs, `${where}.inputs`);

  const outputs = raw.outputs;
  if (!Array.isArray(outputs) || !outputs.every((name: unknown) => typeof name === "string")) {
    throw invalid(`${where}.outputs must be an array of field names.`);
  }
  if (typeof raw.writes !== "boolean") throw invalid(`${where}.writes must be true or false.`);
  const localNetwork = raw.local_network;
  if (!Array.isArray(localNetwork) || !localNetwork.every((host: unknown) => typeof host === "string")) {
    throw invalid(`${where}.local_network must be an array of hosts (empty when it reaches none).`);
  }

  const fn: WritContractFunction = {
    key,
    description,
    package: packageId,
    function: chosen ?? null,
    inputs,
    outputs: [...(outputs as string[])],
    writes: raw.writes,
    local_network: [...(localNetwork as string[])],
  };

  // The package's settings, for the site's own form (CONTRACT.md §10): optional, kept when set.
  if (raw.settings !== undefined && raw.settings !== null) {
    fn.settings = validateContractSettings(raw.settings, `${where}.settings`, pkg);
  }

  // Writ Bridge fields (CONTRACT.md §12): optional, and kept only when set.
  const mode = raw.mode;
  if (mode !== undefined && mode !== null) {
    if (!isBridgeMode(mode)) {
      throw invalid(`${where}.mode must be "required", "recommended" or "cloud"; got ${describeValue(mode)}.`);
    }
    fn.mode = mode;
  }
  if (raw.cloud !== undefined) fn.cloud = validateCloudMapping(raw.cloud, `${where}.cloud`);
  return fn;
}

/** True for one of the Writ Bridge modes. */
export function isBridgeMode(value: unknown): value is WritBridgeMode {
  return typeof value === "string" && (WRIT_BRIDGE_MODES as readonly string[]).includes(value);
}

function validateCloudMapping(raw: unknown, where: string): WritCloudMapping | null {
  if (raw === null) return null;
  if (!isPlainObject(raw)) throw invalid(`${where} must be an object { workflow_id, function } or null.`);
  const workflowId = raw.workflow_id;
  const validId =
    (typeof workflowId === "number" && Number.isSafeInteger(workflowId) && workflowId > 0) ||
    (typeof workflowId === "string" && workflowId.trim() !== "");
  if (!validId) {
    throw invalid(`${where}.workflow_id must be the workflow's id in Writ Cloud; got ${describeValue(workflowId)}.`);
  }
  const fn = raw.function;
  if (fn !== undefined && fn !== null && (typeof fn !== "string" || fn.trim() === "")) {
    throw invalid(`${where}.function must be the workflow function's name, or null.`);
  }
  return { workflow_id: workflowId as number | string, function: typeof fn === "string" ? fn : null };
}

/** `{ key, label, kind }[]`: settings `pkg` declares, each once, with the kind it declares. */
function validateContractSettings(raw: unknown, where: string, pkg: WritContractPackage): WritContractSetting[] {
  if (!Array.isArray(raw)) throw invalid(`${where} must be an array of { key, label, kind }.`);
  if (raw.length > MAX_PACKAGE_SETTINGS) {
    throw invalid(`${where} has ${raw.length} entries; a package declares at most ${MAX_PACKAGE_SETTINGS} settings.`);
  }
  const declared = new Map(packageSettings(pkg).map((setting) => [setting.key, setting.kind ?? "text"] as const));
  const keys = new Set<string>();
  return raw.map((entry: unknown, index: number) => {
    const at = `${where}[${index}]`;
    if (!isPlainObject(entry)) throw invalid(`${at} must be an object { key, label, kind }.`);
    const key = entry.key;
    if (typeof key !== "string" || !SETTING_KEY_PATTERN.test(key)) {
      throw invalid(`${at}.key ${describeValue(key)} is not valid: use 1 to 64 ASCII letters, digits or "_".`);
    }
    if (keys.has(key)) throw invalid(`${at}.key "${key}" is listed twice.`);
    keys.add(key);
    const declaredKind = declared.get(key);
    if (declaredKind === undefined) {
      throw invalid(`${at}.key is "${key}", but package "${pkg.id}" declares no such setting.`);
    }
    const label = entry.label;
    if (typeof label !== "string" || label.trim() === "" || charCount(label) > MAX_SETTING_LABEL_LENGTH) {
      throw invalid(`${at}.label must be 1 to ${MAX_SETTING_LABEL_LENGTH} characters of text.`);
    }
    const kind = entry.kind;
    if (!isSettingKind(kind)) throw invalid(`${at}.kind must be "text" or "lan_host"; got ${describeValue(kind)}.`);
    if (kind !== declaredKind) {
      throw invalid(`${at}.kind is "${kind}", but package "${pkg.id}" declares "${key}" as "${declaredKind}".`);
    }
    return { key, label, kind };
  });
}

function isSettingKind(value: unknown): value is WritSettingKind {
  return typeof value === "string" && (SETTING_KINDS as readonly string[]).includes(value);
}

function validateContractInputs(raw: unknown, where: string): WritContractInput[] {
  if (!Array.isArray(raw)) throw invalid(`${where} must be an array of { name, required, description? }.`);
  const names = new Set<string>();
  return raw.map((entry: unknown, index: number) => {
    const at = `${where}[${index}]`;
    if (!isPlainObject(entry)) throw invalid(`${at} must be an object { name, required, description? }.`);
    const name = entry.name;
    if (typeof name !== "string" || name.trim() === "") throw invalid(`${at}.name must be a non-empty input name.`);
    if (names.has(name)) throw invalid(`${at}.name "${name}" is declared twice.`);
    names.add(name);
    if (typeof entry.required !== "boolean") throw invalid(`${at}.required must be true or false.`);
    const input: WritContractInput = { name, required: entry.required };
    if (entry.description !== undefined && entry.description !== null) {
      if (typeof entry.description !== "string") throw invalid(`${at}.description must be text.`);
      input.description = entry.description;
    }
    return input;
  });
}

/** A key may not be a function and a namespace at once: "pos" next to "pos.receive". */
function checkNamespaces(keys: readonly string[]): void {
  const leaves = new Set(keys);
  for (const key of keys) {
    const segments = key.split(".");
    for (let end = 1; end < segments.length; end += 1) {
      const prefix = segments.slice(0, end).join(".");
      if (leaves.has(prefix)) {
        throw invalid(
          `contract.functions has both "${prefix}" and "${key}": in the typed client "${prefix}" would be a method and a namespace at once. Rename one of them.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// contractFunctions
// ---------------------------------------------------------------------------------------------

/** Options of {@link contractFunctions}. */
export interface ContractFunctionsOptions {
  /**
   * Values to suggest for the packages' settings, by contract key then setting key (for
   * example, what the user typed in your own form). A value suggested for one key holds for
   * every key of the same package. Writ's consent window shows them pre-filled for the user to
   * confirm.
   */
  settings?: WritSettingSuggestions;
}

/**
 * The `functions` to pass to `connect()` for a contract: one request per key, each carrying
 * its package and the package function it calls, and `options.settings`' suggestions for its
 * package. Validates the contract first.
 *
 * Throws `INPUT_INVALID` for an invalid contract or suggestion, and `BAD_REQUEST` for a
 * suggestion under a key the contract does not have.
 */
export function contractFunctions(contract: WritContract, options: ContractFunctionsOptions = {}): FunctionRequest[] {
  const clean = validateContract(contract);
  if (!isPlainObject(options)) throw new WritError("BAD_REQUEST", "contractFunctions() takes (contract, { settings? }).");
  const suggestions =
    options.settings === undefined || options.settings === null
      ? new Map<string, WritSettingValues>()
      : suggestionsByPackage(clean, options.settings, "settings").byPackage;
  return contractRequests(clean, suggestions);
}

/**
 * @internal The connect requests of a validated contract, each with its package's suggested
 * settings (by package id).
 */
export function contractRequests(
  contract: WritContract,
  suggestions: ReadonlyMap<string, Readonly<WritSettingValues>>,
): FunctionRequest[] {
  const packages = new Map(contract.packages.map((pkg) => [pkg.id, pkg] as const));
  return contract.functions.map((fn) => {
    const pkg = packages.get(fn.package) as WritContractPackage;
    const request: FunctionRequest = {
      key: fn.key,
      description: consentDescription(fn.description, packageDisplayName(pkg), fn.key),
      writes: fn.writes,
      package: pkg,
    };
    if (fn.function !== null) request.function = fn.function;
    const values = suggestions.get(pkg.id);
    if (values !== undefined && Object.keys(values).length > 0) request.settings = { ...values };
    return request;
  });
}

/** What {@link suggestionsByPackage} answers. */
export interface ContractSuggestions {
  /** The suggested values, by package id. */
  readonly byPackage: Map<string, WritSettingValues>;
  /** The contract keys the suggestions were given for, in the order given. */
  readonly keys: readonly string[];
}

/**
 * @internal Suggested settings by contract key (`{ "pos.receive": { pos_host } }`), checked
 * against a validated contract and grouped by package: settings belong to a package, so two
 * keys of one package may not suggest different values for one setting. BAD_REQUEST for a shape
 * that is not `{ [key]: { ... } }` or a key the contract does not have (or `accept` refuses);
 * INPUT_INVALID for the values (`validateSuggestedSettings`).
 */
export function suggestionsByPackage(
  contract: WritContract,
  values: unknown,
  where: string,
  accept?: (fn: WritContractFunction) => void,
): ContractSuggestions {
  if (!isPlainObject(values)) {
    throw new WritError(
      "BAD_REQUEST",
      `${where} must be an object { [contract key]: { [setting key]: value } }, like { "pos.receive": { pos_host: "192.168.1.20:8080" } }; got ${describeValue(values)}.`,
    );
  }
  const functions = new Map(contract.functions.map((fn) => [fn.key, fn] as const));
  const packages = new Map(contract.packages.map((pkg) => [pkg.id, pkg] as const));
  const byPackage = new Map<string, WritSettingValues>();
  /** The key that first suggested each package's setting, for the message on a conflict. */
  const firstKeys = new Map<string, Map<string, string>>();
  const keys: string[] = [];
  for (const key of Object.keys(values)) {
    if (values[key] === undefined) continue;
    const fn = functions.get(key);
    if (fn === undefined) {
      throw new WritError("BAD_REQUEST", `${where} names "${key}", which is not a function of the contract.`);
    }
    accept?.(fn);
    const pkg = packages.get(fn.package) as WritContractPackage;
    const clean = validateSuggestedSettings(values[key], `${where}["${key}"]`, pkg);
    const merged = byPackage.get(pkg.id) ?? {};
    const first = firstKeys.get(pkg.id) ?? new Map<string, string>();
    for (const [name, value] of Object.entries(clean)) {
      const earlier = first.get(name);
      if (earlier === undefined) {
        first.set(name, key);
        // defineProperty keeps a "__proto__" key an own property.
        Object.defineProperty(merged, name, { value, enumerable: true, writable: true, configurable: true });
      } else if (merged[name] !== value) {
        throw invalid(
          `${where}["${key}"].${name} is ${JSON.stringify(value)}, but ${where}["${earlier}"].${name} is ${JSON.stringify(merged[name])}: both keys install package "${pkg.id}", which keeps one value per setting.`,
        );
      }
    }
    byPackage.set(pkg.id, merged);
    firstKeys.set(pkg.id, first);
    keys.push(key);
  }
  return { byPackage, keys };
}

/** The consent window shows at most 200 characters; an empty description falls back to the package name. */
function consentDescription(description: string, packageName: string, key: string): string {
  const text = description.trim() !== "" ? description.trim() : packageName.trim() !== "" ? packageName.trim() : key;
  if (charCount(text) <= MAX_DESCRIPTION_LENGTH && text.length <= MAX_DESCRIPTION_LENGTH) return text;
  return `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------------------------
// createWritClient
// ---------------------------------------------------------------------------------------------

/** The shape of one function in the generated `WritFunctions` interface. */
export interface WritFunctionSpec {
  inputs: object;
  outputs: unknown;
}

/**
 * A flat map of keys to function specs, as `writ-functions.d.ts` declares it. Written as a
 * self-referencing constraint so a generated `interface` fits (an interface has no index
 * signature, so it would not fit `Record<string, WritFunctionSpec>`).
 */
export type WritFunctionMap<F> = { [K in keyof F]: WritFunctionSpec };

/** One method of the typed client. Inputs may be left out when every input is optional. */
export type WritClientMethod<Fn extends WritFunctionSpec> = {} extends Fn["inputs"]
  ? (inputs?: Fn["inputs"], options?: CallOptions) => WritCall<Fn["outputs"]>
  : (inputs: Fn["inputs"], options?: CallOptions) => WritCall<Fn["outputs"]>;

/** @internal The first segment of a dotted key (`"pos"` of `"pos.receive"`). */
export type FirstSegment<K> = K extends `${infer Head}.${string}` ? Head : never;
/** @internal What follows `Head.` in a dotted key. */
export type AfterSegment<K, Head extends string> = K extends `${Head}.${infer Rest}` ? Rest : never;
/** @internal A key without a dot: a method at this level. */
export type LeafKey<K> = K extends `${string}.${string}` ? never : K;
/** @internal The keys under namespace `Head`, with `Head.` removed. */
export type Subtree<F, Head extends string> = { [K in keyof F as AfterSegment<K, Head>]: F[K] };
type MethodOf<S> = S extends WritFunctionSpec ? WritClientMethod<S> : never;

/**
 * The typed client for a flat function map: `"pos.receive"` becomes `client.pos.receive(...)`.
 */
export type WritTypedClient<F> = {
  readonly [K in keyof F as LeafKey<K>]: MethodOf<F[K]>;
} & {
  readonly [Head in FirstSegment<keyof F>]: WritTypedClient<Subtree<F, Head & string>>;
};

/**
 * The client when no `WritFunctions` type is given: any path, untyped inputs and outputs. Under
 * `noUncheckedIndexedAccess`, each step of a path may be `undefined`; pass the generated type
 * instead for exact paths.
 */
export interface WritDynamicClient {
  readonly [segment: string]: WritDynamicClient &
    ((inputs?: JsonObject, options?: CallOptions) => WritCall<unknown>);
}

/** {@link WritTypedClient} for a generated map, {@link WritDynamicClient} without one. */
export type WritClientFor<F> = string extends keyof F ? WritDynamicClient : WritTypedClient<F>;

/** Options of {@link createWritClient}: for the contract's linked workflows (CONTRACT.md §11). */
export type WritClientOptions = WritLinkedOptions;

/**
 * A client with one method per contract key; dotted keys nest (`"pos.receive"` is
 * `client.pos.receive(inputs, options)`). Each method checks `inputs` against the contract
 * (every required input present, nothing undeclared), throwing a {@link WritError}
 * `INPUT_INVALID` otherwise, then returns `session.call(key, inputs, options)`.
 *
 * Calls to a linked workflow carry `options.recipeCache` when you set it (else the session's
 * policy) and, in `token` mode, a run token from `options.getRunToken`, else from the session's
 * own `getRunToken` (the banner's, for its session). Throws `BAD_REQUEST` when the contract has a
 * linked workflow in token mode and neither has one.
 *
 * `F` is the `WritFunctions` interface Writ generates next to the contract
 * (`writ-functions.d.ts`).
 */
export function createWritClient<F extends WritFunctionMap<F> = Record<string, WritFunctionSpec>>(
  session: WritSession,
  contract: WritContract,
  options: WritClientOptions = {},
): WritClientFor<F> {
  if (typeof session !== "object" || session === null || typeof (session as { call?: unknown }).call !== "function") {
    throw new WritError("BAD_REQUEST", "createWritClient() needs the session from connect(), resume() or the banner's onReady.");
  }
  const clean = validateContract(contract);
  const linked = validateLinkedOptions(options, "createWritClient()");
  const access = linkedAccessOfContract(clean);
  const tokenSource = linked.getRunToken ?? sessionRunTokenSource(session);
  requireRunTokens(access, tokenSource !== null, "createWritClient()");
  const root: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const fn of clean.functions) {
    const segments = fn.key.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node[segment] as Record<string, unknown> | undefined;
      if (next === undefined) {
        next = Object.create(null) as Record<string, unknown>;
        node[segment] = next;
      }
      node = next;
    }
    const mode = access.get(fn.key);
    const defaults: LinkedCallDefaults | null =
      mode === undefined ? null : linkedCallDefaults(mode, tokenSource, linked.recipeCache);
    node[segments[segments.length - 1] as string] = makeMethod(session, fn, defaults);
  }

  return deepFreezeTree(root) as unknown as WritClientFor<F>;
}

/** What a typed client adds to each call of a linked workflow, unless the call sets it. */
interface LinkedCallDefaults {
  readonly token: (() => Promise<string>) | undefined;
  readonly recipeCache: WritRecipeCache | undefined;
}

function linkedCallDefaults(
  mode: WritLinkedAccess,
  tokenSource: (() => Promise<string>) | null,
  recipeCache: WritRecipeCache | undefined,
): LinkedCallDefaults {
  return { token: mode === "token" && tokenSource !== null ? tokenSource : undefined, recipeCache };
}

/** The session's own `getRunToken`, when it is a session this library made. */
function sessionRunTokenSource(session: WritSession): (() => Promise<string>) | null {
  const source = (session as { runTokenSource?: unknown }).runTokenSource;
  if (typeof source !== "function") return null;
  const value: unknown = source.call(session);
  return typeof value === "function" ? (value as () => Promise<string>) : null;
}

function makeMethod(
  session: WritSession,
  fn: WritContractFunction,
  linked: LinkedCallDefaults | null,
): (inputs?: object, options?: CallOptions) => WritCall<unknown> {
  const check = contractInputChecker(fn);
  const method = (inputs?: object, options?: CallOptions): WritCall<unknown> => {
    check(inputs);
    return session.call<unknown>(fn.key, inputs, linked === null ? options : withLinkedDefaults(options, linked));
  };
  Object.defineProperty(method, "name", { value: fn.key });
  return Object.freeze(method);
}

/** The call's own options, with the client's token and recipe policy where the call sets none. */
function withLinkedDefaults(options: CallOptions | undefined, linked: LinkedCallDefaults): CallOptions | undefined {
  // Anything but an options object goes through as is, for the session to refuse.
  if (options !== undefined && (typeof options !== "object" || options === null)) return options;
  const merged: CallOptions = { ...options };
  if (merged.token === undefined && linked.token !== undefined) merged.token = linked.token;
  if (merged.recipeCache === undefined && linked.recipeCache !== undefined) merged.recipeCache = linked.recipeCache;
  return merged;
}

/**
 * @internal A check of a call's inputs against a contract function: a plain object (or nothing),
 * every required input present, nothing undeclared. Throws INPUT_INVALID naming the input.
 */
export function contractInputChecker(fn: WritContractFunction): (inputs: unknown) => void {
  const declared = new Set(fn.inputs.map((input) => input.name));
  const required = fn.inputs.filter((input) => input.required).map((input) => input.name);
  return (inputs: unknown): void => {
    if (inputs !== undefined && !isPlainObject(inputs)) {
      throw invalid(`${fn.key}() takes a plain object of inputs; got ${describeValue(inputs)}.`);
    }
    const given = (inputs ?? {}) as Record<string, unknown>;
    for (const name of Object.keys(given)) {
      if (given[name] !== undefined && !declared.has(name)) {
        const known = fn.inputs.map((input) => `"${input.name}"`).join(", ");
        throw invalid(
          `${fn.key}() has no input "${name}"; ${known === "" ? "it takes no inputs" : `its inputs are ${known}`}.`,
        );
      }
    }
    const missing = required.filter((name) => given[name] === undefined);
    if (missing.length > 0) {
      throw invalid(`${fn.key}() needs ${missing.map((name) => `"${name}"`).join(", ")}.`);
    }
  };
}

/** @internal Freeze a namespace tree of methods (functions are frozen where they are made). */
export function deepFreezeTree(node: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (typeof child === "object" && child !== null) deepFreezeTree(child as Record<string, unknown>);
  }
  return Object.freeze(node);
}
