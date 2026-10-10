/**
 * The contract file (`writ-contract.json`, docs/browser-extension/CONTRACT.md §10), as the server
 * reads it: the functions, their inputs, where each may run (`mode`) and, for Writ Cloud, which
 * published workflow answers (`cloud`).
 */

import {
  CONTRACT_FORMAT,
  FUNCTION_KEY_PATTERN,
  MAX_INPUT_BYTES,
  MAX_JSON_DEPTH,
  MAX_PACKAGE_SETTINGS,
  MAX_SETTING_LABEL_LENGTH,
  SETTING_KEY_PATTERN,
} from "./constants.js";
import { WritBridgeError } from "./errors.js";
import { cloneJsonValue, deepFreeze, describeValue, isPlainObject, utf8Length, type JsonObject } from "./json.js";
import type { WritReceipt } from "./receipt.js";

/** Where a function runs (CONTRACT.md §12, WRIT_BRIDGE_DESIGN.md §2). */
export type WritBridgeMode = "required" | "recommended" | "cloud";

/** The modes, in order. */
export const WRIT_BRIDGE_MODES: readonly WritBridgeMode[] = Object.freeze(["required", "recommended", "cloud"]);

/** The Writ Cloud workflow that answers a function, filled when the contract is published. */
export interface WritCloudMapping {
  /** The workflow id in the developer's Writ Cloud account. */
  workflow_id: number;
  /** The workflow function to run, or `null` for the whole workflow. */
  function: string | null;
}

/** One declared input. */
export interface WritContractInput {
  name: string;
  required: boolean;
  description?: string;
}

/**
 * One setting of a function's package (CONTRACT.md §8): a value each user gives once in Writ's
 * consent window, never a call input. Listed for the site's own form.
 */
export interface WritContractSetting {
  key: string;
  label: string;
  kind: "text" | "lan_host";
}

/** One function of the contract. */
export interface WritContractFunction {
  /** `[a-z0-9][a-z0-9._-]{0,63}`, unique; dots make namespaces. */
  key: string;
  description: string;
  /** The id of one of `packages`. */
  package: string;
  /** The package function this key calls. */
  function: string | null;
  inputs: WritContractInput[];
  outputs: string[];
  writes: boolean;
  /** Hosts on the visitor's network this function reaches; any forces `required`. */
  local_network: string[];
  /** The package's settings, for the site's own form. Never call inputs. */
  settings?: WritContractSetting[];
  /** This function's own mode, over the bridge's. */
  mode?: WritBridgeMode;
  /** Its Writ Cloud workflow, required for `recommended` and `cloud`. */
  cloud?: WritCloudMapping;
}

/**
 * A package entry, as far as the server needs it (the visitor's Writ checks the rest): a bundled
 * package (`format: "writ.workflow/v1"`, CONTRACT.md §8) or a linked one (`"writ.linked/v1"`,
 * §11), kept as given. A linked contract from a Writ Cloud workflow carries each function's
 * `cloud` mapping, so `recommended` and `cloud` route it like a bundled one.
 */
export interface WritContractPackage {
  id: string;
  [field: string]: unknown;
}

/** A contract file. */
export interface WritContract {
  format: "writ.contract/v1";
  /** ISO 8601. */
  generated_at: string;
  /** `"writ-desktop/<version>"` or `"writ-cloud"`. */
  generator: string;
  publisher?: { name?: string };
  functions: WritContractFunction[];
  packages: WritContractPackage[];
}

function invalid(message: string): WritBridgeError {
  return new WritBridgeError("INPUT_INVALID", message);
}

/**
 * Key segments a contract may not use: each becomes a property of a typed proxy, and these would
 * break it (`then` makes a namespace look like a promise to `await`).
 */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["then", "__proto__", "constructor", "prototype"]);

/**
 * Check a contract file and return a deep-frozen copy. Accepts the parsed JSON or its text.
 *
 * Rules: `format` is `"writ.contract/v1"`; packages (bundled or linked, kept as given) have
 * unique ids; every function key is valid,
 * unique, made of non-empty dot-separated segments, and never both a function and a namespace
 * (`"pos"` next to `"pos.receive"`); every function names one of `packages`; inputs are unique
 * `{ name, required }`; `settings`, when present, are unique `{ key, label, kind }`; `mode`, when
 * present, is a mode; `cloud`, when present, is `{ workflow_id, function }`.
 *
 * Throws a {@link WritBridgeError} `INPUT_INVALID` whose message names the field at fault.
 */
export function validateContract(json: unknown): WritContract {
  let parsed: unknown = json;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch (error) {
      throw new WritBridgeError("INPUT_INVALID", "The contract is not valid JSON.", { cause: error });
    }
  }
  if (!isPlainObject(parsed)) {
    throw invalid(`The contract must be an object { format: "${CONTRACT_FORMAT}", functions, packages }; got ${describeValue(parsed)}.`);
  }
  const value = parsed;
  if (value.format !== CONTRACT_FORMAT) {
    throw invalid(`contract.format must be "${CONTRACT_FORMAT}"; got ${describeValue(value.format)}.`);
  }
  const generatedAt = value.generated_at;
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) {
    throw invalid(`contract.generated_at must be an ISO 8601 date; got ${describeValue(generatedAt)}.`);
  }
  const generator = value.generator;
  if (typeof generator !== "string" || generator.trim() === "") {
    throw invalid(`contract.generator must name what produced the file (e.g. "writ-cloud"); got ${describeValue(generator)}.`);
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

  const rawPackages = value.packages;
  if (!Array.isArray(rawPackages)) {
    throw invalid(`contract.packages must be an array of workflow packages; got ${describeValue(rawPackages)}.`);
  }
  const packageIds = new Set<string>();
  rawPackages.forEach((raw: unknown, index: number) => {
    if (!isPlainObject(raw)) throw invalid(`contract.packages[${index}] must be a package object.`);
    const id = raw.id;
    if (typeof id !== "string" || id === "") throw invalid(`contract.packages[${index}].id must be a non-empty id.`);
    if (packageIds.has(id)) throw invalid(`contract.packages[${index}].id "${id}" is used by another package; each id once.`);
    packageIds.add(id);
    contract.packages.push(cloneJsonValue(raw, `contract.packages[${index}]`, MAX_JSON_DEPTH) as WritContractPackage);
  });

  const rawFunctions = value.functions;
  if (!Array.isArray(rawFunctions) || rawFunctions.length === 0) {
    throw invalid("contract.functions must list at least one function.");
  }
  const keys = new Set<string>();
  rawFunctions.forEach((raw: unknown, index: number) => {
    const fn = validateFunction(raw, `contract.functions[${index}]`, packageIds);
    if (keys.has(fn.key)) throw invalid(`contract.functions[${index}].key "${fn.key}" is listed twice.`);
    keys.add(fn.key);
    contract.functions.push(fn);
  });
  checkNamespaces([...keys]);

  return deepFreeze(contract);
}

function validateFunction(raw: unknown, where: string, packageIds: ReadonlySet<string>): WritContractFunction {
  if (!isPlainObject(raw)) throw invalid(`${where} must be an object { key, description, package, function, inputs, outputs }.`);

  const key = raw.key;
  if (typeof key !== "string" || !FUNCTION_KEY_PATTERN.test(key)) {
    throw invalid(
      `${where}.key ${describeValue(key)} is not valid: use 1 to 64 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.`,
    );
  }
  for (const segment of key.split(".")) {
    if (segment === "") throw invalid(`${where}.key "${key}" has an empty segment; dots separate namespaces, as in "pos.receive".`);
    if (RESERVED_SEGMENTS.has(segment)) {
      throw invalid(`${where}.key "${key}" uses "${segment}", which cannot be a method or namespace name.`);
    }
  }

  const description = raw.description;
  if (typeof description !== "string") throw invalid(`${where}.description must be text.`);

  const packageId = raw.package;
  if (typeof packageId !== "string" || !packageIds.has(packageId)) {
    throw invalid(`${where}.package must be the id of one of contract.packages; got ${describeValue(packageId)}.`);
  }
  const rawFunction = raw.function ?? null;
  if (rawFunction !== null && (typeof rawFunction !== "string" || rawFunction === "")) {
    throw invalid(`${where}.function must be a package function name, or null.`);
  }
  const fnName: string | null = typeof rawFunction === "string" ? rawFunction : null;

  const inputs = validateInputs(raw.inputs, `${where}.inputs`);

  const outputs = raw.outputs;
  if (!Array.isArray(outputs) || !outputs.every((name: unknown) => typeof name === "string")) {
    throw invalid(`${where}.outputs must be an array of field names.`);
  }
  const writes = raw.writes;
  if (typeof writes !== "boolean") throw invalid(`${where}.writes must be true or false.`);
  // Required, never defaulted: a function that reaches the visitor's network must say so, or it
  // could be routed to Writ Cloud, which cannot reach it.
  const localNetwork = raw.local_network;
  if (!Array.isArray(localNetwork) || !localNetwork.every((host: unknown) => typeof host === "string")) {
    throw invalid(`${where}.local_network must be an array of hosts (empty when it reaches none).`);
  }

  const fn: WritContractFunction = {
    key,
    description,
    package: packageId,
    function: fnName,
    inputs,
    outputs: [...(outputs as string[])],
    writes,
    local_network: [...(localNetwork as string[])],
  };

  if (raw.settings !== undefined && raw.settings !== null) {
    fn.settings = validateSettings(raw.settings, `${where}.settings`);
  }
  if (raw.mode !== undefined && raw.mode !== null) {
    if (typeof raw.mode !== "string" || !(WRIT_BRIDGE_MODES as readonly string[]).includes(raw.mode)) {
      throw invalid(`${where}.mode must be "required", "recommended" or "cloud"; got ${describeValue(raw.mode)}.`);
    }
    fn.mode = raw.mode as WritBridgeMode;
  }
  if (raw.cloud !== undefined && raw.cloud !== null) {
    fn.cloud = validateCloudMapping(raw.cloud, `${where}.cloud`);
  }
  return fn;
}

function validateCloudMapping(raw: unknown, where: string): WritCloudMapping {
  if (!isPlainObject(raw)) throw invalid(`${where} must be { workflow_id, function }.`);
  let workflowId: unknown = raw.workflow_id;
  if (typeof workflowId === "string" && /^[1-9][0-9]{0,15}$/.test(workflowId)) workflowId = Number(workflowId);
  if (typeof workflowId !== "number" || !Number.isSafeInteger(workflowId) || workflowId <= 0) {
    throw invalid(`${where}.workflow_id must be the positive id of a Writ Cloud workflow; got ${describeValue(raw.workflow_id)}.`);
  }
  const rawFunction = raw.function ?? null;
  if (rawFunction !== null && (typeof rawFunction !== "string" || rawFunction.trim() === "")) {
    throw invalid(`${where}.function must be the workflow function to run, or null for the whole workflow.`);
  }
  return { workflow_id: workflowId, function: typeof rawFunction === "string" ? rawFunction : null };
}

/**
 * `{ key, label, kind }[]`, each key once. The visitor's Writ checks them against the package at
 * install; the server only keeps them.
 */
function validateSettings(raw: unknown, where: string): WritContractSetting[] {
  if (!Array.isArray(raw)) throw invalid(`${where} must be an array of { key, label, kind }.`);
  if (raw.length > MAX_PACKAGE_SETTINGS) {
    throw invalid(`${where} has ${raw.length} entries; a package declares at most ${MAX_PACKAGE_SETTINGS} settings.`);
  }
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
    const label = entry.label;
    if (typeof label !== "string" || label.trim() === "" || [...label].length > MAX_SETTING_LABEL_LENGTH) {
      throw invalid(`${at}.label must be 1 to ${MAX_SETTING_LABEL_LENGTH} characters of text.`);
    }
    const kind = entry.kind;
    if (kind !== "text" && kind !== "lan_host") {
      throw invalid(`${at}.kind must be "text" or "lan_host"; got ${describeValue(kind)}.`);
    }
    return { key, label, kind };
  });
}

function validateInputs(raw: unknown, where: string): WritContractInput[] {
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
          `contract.functions has both "${prefix}" and "${key}": "${prefix}" would be a method and a namespace at once. Rename one of them.`,
        );
      }
    }
  }
}

/**
 * Check `inputs` against a function's declared inputs, and return a plain-JSON copy: a plain
 * object, every required input present, nothing undeclared, JSON only, at most 1 MB.
 */
export function checkInputs(fn: WritContractFunction, inputs: unknown): JsonObject {
  if (inputs !== undefined && inputs !== null && !isPlainObject(inputs)) {
    throw invalid(`${fn.key}() takes a plain object of inputs; got ${describeValue(inputs)}.`);
  }
  const given = (inputs ?? {}) as Record<string, unknown>;
  const declared = new Set(fn.inputs.map((input) => input.name));
  for (const name of Object.keys(given)) {
    if (given[name] !== undefined && !declared.has(name)) {
      const known = fn.inputs.map((input) => `"${input.name}"`).join(", ");
      throw invalid(`${fn.key}() has no input "${name}"; ${known === "" ? "it takes no inputs" : `its inputs are ${known}`}.`);
    }
  }
  const missing = fn.inputs.filter((input) => input.required && given[input.name] === undefined).map((input) => `"${input.name}"`);
  if (missing.length > 0) throw invalid(`${fn.key}() needs ${missing.join(", ")}.`);
  const copy = cloneJsonValue(given, "inputs", MAX_JSON_DEPTH) as JsonObject;
  if (utf8Length(JSON.stringify(copy)) > MAX_INPUT_BYTES) {
    throw invalid(`${fn.key}() inputs are larger than ${MAX_INPUT_BYTES} bytes as JSON.`);
  }
  return copy;
}

// ---------------------------------------------------------------------------------------------
// Types: the generated flat `WritFunctions` map, nested by dotted keys
// ---------------------------------------------------------------------------------------------

/** The shape of one function in the generated `WritFunctions` interface. */
export interface WritFunctionSpec {
  inputs: object;
  outputs: unknown;
}

/**
 * A flat map of keys to function specs, as `writ-functions.d.ts` declares it. Written as a
 * self-referencing constraint so a generated `interface` fits.
 */
export type WritFunctionMap<F> = { [K in keyof F]: WritFunctionSpec };

type FirstSegment<K> = K extends `${infer Head}.${string}` ? Head : never;
type AfterSegment<K, Head extends string> = K extends `${Head}.${infer Rest}` ? Rest : never;
type LeafKey<K> = K extends `${string}.${string}` ? never : K;
type Subtree<F, Head extends string> = { [K in keyof F as AfterSegment<K, Head>]: F[K] };

/** What every call resolves to. */
export interface WritCallResult<T = unknown> {
  /** The function's data: what the page received on the user's computer, or the Writ Cloud run's. */
  data: T;
  /** Where it ran. */
  venue: "user" | "cloud";
  /** The verified receipt, when it ran on the user's computer. */
  receipt?: WritReceipt;
}

/** One typed method. Inputs may be left out when every input is optional. */
export type WritBridgeMethod<Fn extends WritFunctionSpec, Options> = {} extends Fn["inputs"]
  ? (inputs?: Fn["inputs"], options?: Options) => Promise<WritCallResult<Fn["outputs"]>>
  : (inputs: Fn["inputs"], options?: Options) => Promise<WritCallResult<Fn["outputs"]>>;

type MethodOf<S, Options> = S extends WritFunctionSpec ? WritBridgeMethod<S, Options> : never;

/** A flat function map turned into nested methods: `"pos.receive"` becomes `.pos.receive(...)`. */
export type WritNestedFunctions<F, Options> = {
  readonly [K in keyof F as LeafKey<K>]: MethodOf<F[K], Options>;
} & {
  readonly [Head in FirstSegment<keyof F>]: WritNestedFunctions<Subtree<F, Head & string>, Options>;
};

/** Any path, untyped inputs and outputs: what you get without a generated `WritFunctions` type. */
export interface WritDynamicFunctions<Options> {
  readonly [segment: string]: WritDynamicFunctions<Options> &
    ((inputs?: JsonObject, options?: Options) => Promise<WritCallResult<unknown>>);
}

/** {@link WritNestedFunctions} for a generated map, {@link WritDynamicFunctions} without one. */
export type WritFunctionsFor<F, Options> = string extends keyof F ? WritDynamicFunctions<Options> : WritNestedFunctions<F, Options>;

/**
 * Build a frozen tree from dotted keys: each leaf is `makeMethod(fn)`. Shared by the user proxy
 * and the bridge's own Writ Cloud methods.
 */
export function buildTree(
  functions: readonly WritContractFunction[],
  makeMethod: (fn: WritContractFunction) => (...args: never[]) => unknown,
): Record<string, unknown> {
  const root = Object.create(null) as Record<string, unknown>;
  for (const fn of functions) {
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
    const method = makeMethod(fn);
    Object.defineProperty(method, "name", { value: fn.key });
    node[segments[segments.length - 1] as string] = Object.freeze(method);
  }
  return freezeTree(root);
}

function freezeTree(node: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (typeof child === "object" && child !== null) freezeTree(child as Record<string, unknown>);
  }
  return Object.freeze(node);
}
