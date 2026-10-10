/**
 * Installable workflows (CONTRACT.md §8): `definePackage()` and the checks `connect()` runs on
 * every package it is given.
 *
 * The Writ engine (`site_package::parse`) enforces the same rules again when the visitor
 * installs the package. These checks exist to fail fast, with a message that names the exact
 * field, before anything reaches the extension. They are never the security boundary.
 */

import {
  CREDENTIAL_KEY_PATTERN,
  FORBIDDEN_INPUT_PREFIXES,
  MAX_CREDENTIAL_LABEL_LENGTH,
  MAX_LOCAL_NETWORK_HOSTS,
  MAX_LOCAL_NETWORK_REASON_LENGTH,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_CREDENTIALS,
  MAX_PACKAGE_DEPTH,
  MAX_PACKAGE_DESCRIPTION_LENGTH,
  MAX_PACKAGE_ENTRY_URL_LENGTH,
  MAX_PACKAGE_INPUT_DESCRIPTION_LENGTH,
  MAX_PACKAGE_INPUTS,
  MAX_PACKAGE_NAME_LENGTH,
  MAX_PACKAGE_SETTINGS,
  MAX_PACKAGE_STEPS,
  MAX_PACKAGE_VERSION_LENGTH,
  MAX_SETTING_DESCRIPTION_LENGTH,
  MAX_SETTING_EXAMPLE_LENGTH,
  MAX_SETTING_LABEL_LENGTH,
  PACKAGE_FORMAT,
  PACKAGE_ID_PATTERN,
  PACKAGE_INPUT_NAME_PATTERN,
  REFUSED_PACKAGE_STEP_TYPES,
  RESERVED_INPUT_NAMES,
  SETTING_KEY_PATTERN,
  SETTING_KINDS,
} from "./constants.js";
import { WritError } from "./errors.js";
import { charCount, cloneJsonObject, deepFreeze, describeValue, isPlainObject, utf8Length } from "./json.js";
import { isLinkedPackage, linkedFunctionNames } from "./linked.js";
import type { JsonObject, JsonValue, WritContractPackage, WritPackage } from "./types.js";

function invalid(message: string): WritError {
  return new WritError("INPUT_INVALID", message);
}

/**
 * Check a workflow package and return a deep-frozen copy, ready to pass as
 * `functions[].package` to `connect()` or `mountWritBanner()`.
 *
 * Throws a {@link WritError} `INPUT_INVALID` whose message names the field at fault.
 *
 * ```ts
 * const receive = definePackage({
 *   format: "writ.workflow/v1",
 *   id: "arrivos.pos-receive",
 *   name: "Receive invoices in your POS",
 *   steps: [{ type: "api_call", config: { method: "POST", url: "http://192.168.1.20:8080/api/receive" } }],
 *   local_network: { hosts: ["192.168.1.20:8080"], reason: "Your POS server" },
 * });
 * ```
 */
export function definePackage(pkg: WritPackage): WritPackage {
  if (isLinkedPackage(pkg)) {
    throw invalid(
      'package is a linked workflow ("writ.linked/v1"): it comes from the contract file Writ Cloud generated, so load that contract (validateContract(), or `contract` in mountWritBanner() and createWritBridge()) instead of definePackage().',
    );
  }
  return deepFreeze(validatePackage(pkg, "package"));
}

/**
 * Validate a package and return a fresh plain-JSON copy of it (nothing trimmed or renamed: the
 * copy is the package as given, minus `undefined` properties). INPUT_INVALID on any problem.
 */
export function validatePackage(value: unknown, path = "package"): WritPackage {
  if (!isPlainObject(value)) {
    throw invalid(
      `${path} must be an object { format: "${PACKAGE_FORMAT}", id, name, steps }; got ${describeValue(value)}.`,
    );
  }
  const pkg = cloneJsonObject(value, path, MAX_PACKAGE_DEPTH);

  const bytes = utf8Length(JSON.stringify(pkg));
  if (bytes > MAX_PACKAGE_BYTES) {
    throw invalid(`${path} is ${bytes} bytes as JSON; a package is at most ${MAX_PACKAGE_BYTES} bytes (512 KB).`);
  }

  if (pkg.format !== PACKAGE_FORMAT) {
    throw invalid(`${path}.format must be "${PACKAGE_FORMAT}"; got ${describeValue(pkg.format)}.`);
  }
  if (typeof pkg.id !== "string" || !PACKAGE_ID_PATTERN.test(pkg.id)) {
    throw invalid(
      `${path}.id ${describeValue(pkg.id)} is not valid: use 1 to 64 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit (e.g. "arrivos.pos-receive").`,
    );
  }
  optionalText(pkg, "version", MAX_PACKAGE_VERSION_LENGTH, path);
  if (optionalText(pkg, "name", MAX_PACKAGE_NAME_LENGTH, path) === null) {
    throw invalid(`${path}.name is required: 1 to ${MAX_PACKAGE_NAME_LENGTH} characters, shown in the install window.`);
  }
  optionalText(pkg, "description", MAX_PACKAGE_DESCRIPTION_LENGTH, path);
  const entryUrl = optionalText(pkg, "entry_url", MAX_PACKAGE_ENTRY_URL_LENGTH, path);
  if (entryUrl !== null && !isHttpUrl(entryUrl)) {
    throw invalid(`${path}.entry_url must be an http(s) address; got ${describeValue(entryUrl)}.`);
  }

  validateSteps(pkg.steps, path);
  optionalArray(pkg, "functions", path);
  optionalObject(pkg, "api_functions", path);
  optionalObject(pkg, "auth_config", path);
  const inputs = validateInputs(pkg.inputs, path);
  const credentials = validateCredentials(pkg.credentials, path);
  const settings = validateSettings(pkg.settings, inputs, credentials, path);
  validateLocalNetwork(pkg.local_network, path);
  validateText(pkg, credentials, path);
  validateUrlAuthorities(pkg, settings, path);

  return pkg as unknown as WritPackage;
}

/**
 * The names of the functions a package offers to a website, as the engine counts them: step
 * groups stamped with `config.function_name`, declarations in `functions[]`, and specs in
 * `api_functions`, minus sign-in and disabled ones. Empty when the whole workflow is its one
 * callable.
 */
export function packageFunctionNames(pkg: WritPackage): string[] {
  const total = pkg.steps.length;
  const found = new Map<string, { auth: boolean; disabled: boolean }>();
  const stamped: boolean[] = [];

  // 1) Steps stamped with a function name, in first-seen order.
  pkg.steps.forEach((raw, index) => {
    const step: Record<string, unknown> = isPlainObject(raw) ? raw : {};
    const name = stepFunction(step);
    stamped[index] = name !== null;
    if (name === null) return;
    const entry = found.get(name) ?? { auth: false, disabled: false };
    entry.auth ||= stepIsAuth(step);
    entry.disabled ||= step.enabled === false;
    found.set(name, entry);
  });

  // 2) Declared functions no step is stamped with: they own their declared positions.
  for (const raw of (pkg.functions ?? []) as unknown[]) {
    if (!isPlainObject(raw)) continue;
    const name = trimmedText(raw.name);
    if (name === null || found.has(name)) continue;
    const entry = { auth: raw.is_auth === true, disabled: raw.enabled === false };
    for (const index of declaredStepIndices(raw, total)) {
      if (stamped[index] === true) continue;
      const step = pkg.steps[index];
      if (!isPlainObject(step)) continue;
      entry.auth ||= stepIsAuth(step);
      entry.disabled ||= step.enabled === false;
    }
    found.set(name, entry);
  }

  // 3) API specs with neither steps nor a declaration.
  const api = pkg.api_functions;
  if (isPlainObject(api)) {
    for (const name of Object.keys(api)) {
      const spec = api[name];
      if (found.has(name) || !isPlainObject(spec)) continue;
      found.set(name, { auth: spec.is_auth === true, disabled: spec.enabled === false });
    }
  }

  const names: string[] = [];
  for (const [name, entry] of found) if (!entry.auth && !entry.disabled) names.push(name);
  return names;
}

/**
 * Which function of `pkg` a key calls: the trimmed `requested` name, or undefined when the
 * package has a single callable and none was named. INPUT_INVALID when the package has several
 * and none was named, or when the name is not one of them. `where` prefixes messages.
 *
 * A linked package's functions are those its manifest lists (CONTRACT.md §11).
 */
export function selectPackageFunction(pkg: WritContractPackage, requested: unknown, where: string): string | undefined {
  const names = isLinkedPackage(pkg) ? linkedFunctionNames(pkg) : packageFunctionNames(pkg);
  const listed = names.map((name) => `"${name}"`).join(", ");
  if (requested === undefined || requested === null) {
    if (names.length >= 2) {
      throw invalid(
        `${where} installs "${pkg.id}", which has ${names.length} functions (${listed}); set \`function\` to the one this key calls.`,
      );
    }
    return undefined;
  }
  if (typeof requested !== "string" || requested.trim() === "") {
    throw invalid(`${where}.function must name one of the functions of package "${pkg.id}"; got ${describeValue(requested)}.`);
  }
  const name = requested.trim();
  if (names.includes(name)) return name;
  if (names.length === 0) {
    throw invalid(
      `${where}.function is "${name}", but package "${pkg.id}" declares no functions: the whole workflow is its one callable, so leave \`function\` out.`,
    );
  }
  throw invalid(`${where}.function is "${name}", but package "${pkg.id}" has no such function; it has ${listed}.`);
}

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

/** A text field that may be absent or null; returns it trimmed, or null when absent or blank. */
function optionalText(record: Record<string, unknown>, field: string, max: number, path: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid(`${path}.${field} must be text; got ${describeValue(value)}.`);
  const length = charCount(value);
  if (length > max) throw invalid(`${path}.${field} is ${length} characters; at most ${max} are allowed.`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function optionalArray(record: JsonObject, field: string, path: string): void {
  const value = record[field];
  if (value === undefined || value === null || Array.isArray(value)) return;
  throw invalid(`${path}.${field} must be an array; got ${describeValue(value)}.`);
}

function optionalObject(record: JsonObject, field: string, path: string): void {
  const value = record[field];
  if (value === undefined || value === null || isPlainObject(value)) return;
  throw invalid(`${path}.${field} must be an object; got ${describeValue(value)}.`);
}

function validateSteps(steps: JsonValue | undefined, path: string): void {
  if (!Array.isArray(steps)) {
    throw invalid(`${path}.steps must be an array of Writ workflow steps; got ${describeValue(steps)}.`);
  }
  if (steps.length === 0 || steps.length > MAX_PACKAGE_STEPS) {
    throw invalid(`${path}.steps has ${steps.length} steps; a package has 1 to ${MAX_PACKAGE_STEPS}.`);
  }
  steps.forEach((step, index) => {
    const where = `${path}.steps[${index}]`;
    if (!isPlainObject(step)) throw invalid(`${where} must be a step object { type, config }; got ${describeValue(step)}.`);
    const type = step.type;
    if (typeof type !== "string" || type === "") throw invalid(`${where} has no type.`);
    if (REFUSED_PACKAGE_STEP_TYPES.includes(type)) throw invalid(`${where} is a "${type}" step, ${refusedReason(type)}`);
  });
}

function refusedReason(type: string): string {
  if (type === "upload" || type === "wait_for_download") {
    return "which a website's workflow cannot use: installed site workflows never touch the visitor's files.";
  }
  if (type === "codegen") return "which a website's workflow cannot use: packages carry no generated code.";
  return "which a website's workflow cannot use: AI steps would spend the visitor's own AI key.";
}

/** Returns the declared input names. */
function validateInputs(inputs: JsonValue | undefined, path: string): Set<string> {
  const declared = new Set<string>();
  if (inputs === undefined || inputs === null) return declared;
  if (!isPlainObject(inputs)) {
    throw invalid(`${path}.inputs must be an object { [name]: { description?, required? } }; got ${describeValue(inputs)}.`);
  }
  const names = Object.keys(inputs);
  if (names.length > MAX_PACKAGE_INPUTS) {
    throw invalid(`${path}.inputs declares ${names.length} inputs; a package declares at most ${MAX_PACKAGE_INPUTS}.`);
  }
  for (const name of names) {
    const where = `${path}.inputs.${name}`;
    if (!PACKAGE_INPUT_NAME_PATTERN.test(name)) {
      throw invalid(
        `${path}.inputs has the name ${describeValue(name)}: use 1 to 64 ASCII letters, digits, "_", "." or "-".`,
      );
    }
    const lower = name.toLowerCase();
    if (RESERVED_INPUT_NAMES.includes(name) || FORBIDDEN_INPUT_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      throw invalid(`${where}: "${name}" is reserved; a website can never pass it, so a package cannot declare it.`);
    }
    declared.add(name);
    const spec = inputs[name];
    if (spec === null) continue;
    if (!isPlainObject(spec)) throw invalid(`${where} must be an object { description?, required? }; got ${describeValue(spec)}.`);
    optionalText(spec, "description", MAX_PACKAGE_INPUT_DESCRIPTION_LENGTH, where);
    if (spec.required !== undefined && typeof spec.required !== "boolean") {
      throw invalid(`${where}.required must be true or false.`);
    }
  }
  return declared;
}

/** Returns the declared credential keys. */
function validateCredentials(credentials: JsonValue | undefined, path: string): Set<string> {
  const keys = new Set<string>();
  if (credentials === undefined || credentials === null) return keys;
  if (!Array.isArray(credentials)) {
    throw invalid(`${path}.credentials must be an array of { key, label }; got ${describeValue(credentials)}.`);
  }
  if (credentials.length > MAX_PACKAGE_CREDENTIALS) {
    throw invalid(
      `${path}.credentials has ${credentials.length} entries; a package asks for at most ${MAX_PACKAGE_CREDENTIALS}.`,
    );
  }
  credentials.forEach((raw, index) => {
    const where = `${path}.credentials[${index}]`;
    if (!isPlainObject(raw)) throw invalid(`${where} must be an object { key, label, secret?, required? }.`);
    const key = raw.key;
    if (typeof key !== "string" || !CREDENTIAL_KEY_PATTERN.test(key)) {
      throw invalid(
        `${where}.key ${describeValue(key)} is not valid: use 1 to 64 ASCII letters, digits or "_" (the KEY of {{secret:KEY}}).`,
      );
    }
    if (keys.has(key)) throw invalid(`${where}.key "${key}" is declared twice.`);
    keys.add(key);
    if (optionalText(raw, "label", MAX_CREDENTIAL_LABEL_LENGTH, where) === null) {
      throw invalid(`${where} ("${key}") needs a label: the user reads it next to the field they type into.`);
    }
    for (const flag of ["secret", "required"] as const) {
      if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") throw invalid(`${where}.${flag} must be true or false.`);
    }
  });
  return keys;
}

/**
 * Settings: values each user gives once (CONTRACT.md §8). A key is unique and never also an
 * input (passed on each call) or a credential (a secret). Returns the declared setting keys.
 */
function validateSettings(
  settings: JsonValue | undefined,
  inputs: ReadonlySet<string>,
  credentials: ReadonlySet<string>,
  path: string,
): Set<string> {
  const keys = new Set<string>();
  if (settings === undefined || settings === null) return keys;
  if (!Array.isArray(settings)) {
    throw invalid(`${path}.settings must be an array of { key, label }; got ${describeValue(settings)}.`);
  }
  if (settings.length > MAX_PACKAGE_SETTINGS) {
    throw invalid(`${path}.settings has ${settings.length} entries; a package declares at most ${MAX_PACKAGE_SETTINGS}.`);
  }
  settings.forEach((raw, index) => {
    const where = `${path}.settings[${index}]`;
    if (!isPlainObject(raw)) {
      throw invalid(`${where} must be an object { key, label, description?, kind?, example?, required? }.`);
    }
    const key = raw.key;
    if (typeof key !== "string" || !SETTING_KEY_PATTERN.test(key)) {
      throw invalid(
        `${where}.key ${describeValue(key)} is not valid: use 1 to 64 ASCII letters, digits or "_" (the KEY of {{KEY}}).`,
      );
    }
    if (RESERVED_INPUT_NAMES.includes(key)) {
      throw invalid(`${where}.key: "${key}" is reserved; a website can never set it, so a package cannot declare it.`);
    }
    if (keys.has(key)) throw invalid(`${where}.key "${key}" is declared twice.`);
    if (inputs.has(key)) {
      throw invalid(
        `${where}.key "${key}" is also declared in ${path}.inputs: a setting is given once by each user, an input on each call. Keep one of them.`,
      );
    }
    if (credentials.has(key)) {
      throw invalid(
        `${where}.key "${key}" is also declared in ${path}.credentials: a credential is a secret, a setting a plain value. Keep one of them.`,
      );
    }
    keys.add(key);
    if (optionalText(raw, "label", MAX_SETTING_LABEL_LENGTH, where) === null) {
      throw invalid(`${where} ("${key}") needs a label: the user reads it next to the field in Writ's consent window.`);
    }
    optionalText(raw, "description", MAX_SETTING_DESCRIPTION_LENGTH, where);
    optionalText(raw, "example", MAX_SETTING_EXAMPLE_LENGTH, where);
    const kind = raw.kind;
    if (kind !== undefined && kind !== null && !(typeof kind === "string" && (SETTING_KINDS as readonly string[]).includes(kind))) {
      throw invalid(`${where}.kind must be "text" or "lan_host"; got ${describeValue(kind)}.`);
    }
    if (raw.required !== undefined && typeof raw.required !== "boolean") {
      throw invalid(`${where}.required must be true or false.`);
    }
  });
  return keys;
}

function validateLocalNetwork(network: JsonValue | undefined, path: string): void {
  if (network === undefined || network === null) return;
  const where = `${path}.local_network`;
  if (!isPlainObject(network)) throw invalid(`${where} must be an object { hosts, reason? }; got ${describeValue(network)}.`);
  const hosts = network.hosts;
  if (!Array.isArray(hosts)) throw invalid(`${where}.hosts must be an array of single hosts, like ["192.168.1.20:8080"].`);
  if (hosts.length > MAX_LOCAL_NETWORK_HOSTS) {
    throw invalid(`${where}.hosts has ${hosts.length} entries; a package asks for at most ${MAX_LOCAL_NETWORK_HOSTS}.`);
  }
  hosts.forEach((host, index) => {
    if (typeof host !== "string") throw invalid(`${where}.hosts[${index}] must be text, like "192.168.1.20:8080".`);
    checkLocalHost(host, `${where}.hosts[${index}]`);
  });
  optionalText(network, "reason", MAX_LOCAL_NETWORK_REASON_LENGTH, where);
}

const CIDR_LIKE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[?[0-9a-f]*:[0-9a-f:.]*\]?)\/\d+$/i;

/** One local-network entry: a single host, never a range, never this computer itself. */
function checkLocalHost(raw: string, where: string): void {
  let text = raw.trim().toLowerCase();
  if (text === "") throw invalid(`${where} is empty; name one host, like "192.168.1.20:8080".`);

  const scheme = text.indexOf("://");
  if (scheme >= 0) {
    const protocol = text.slice(0, scheme);
    if (protocol !== "http" && protocol !== "https") {
      throw invalid(`${where} (${JSON.stringify(raw)}): only http(s) addresses can be approved.`);
    }
    const rest = text.slice(scheme + 3);
    const end = rest.search(/[/?#]/);
    text = end < 0 ? rest : rest.slice(0, end);
    if (text.includes("@")) throw invalid(`${where} (${JSON.stringify(raw)}): remove the user name from the address.`);
  } else if (CIDR_LIKE.test(text)) {
    throw invalid(`${where} (${JSON.stringify(raw)}) is a range; a website may only ask for single hosts.`);
  } else {
    const end = text.search(/[/?#]/);
    if (end >= 0) text = text.slice(0, end);
  }
  if (text === "") throw invalid(`${where} (${JSON.stringify(raw)}) names no host.`);

  let host: string;
  let port: string | undefined;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) throw invalid(`${where} (${JSON.stringify(raw)}) is not a valid address.`);
    host = text.slice(1, close);
    const after = text.slice(close + 1);
    if (after.startsWith(":")) port = after.slice(1);
    else if (after !== "") throw invalid(`${where} (${JSON.stringify(raw)}) is not a valid address.`);
  } else if ((text.match(/:/g) ?? []).length > 1) {
    host = text;
  } else {
    const colon = text.indexOf(":");
    host = colon < 0 ? text : text.slice(0, colon);
    if (colon >= 0) port = text.slice(colon + 1);
  }

  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535)) {
    throw invalid(`${where} (${JSON.stringify(raw)}) has an invalid port; use 1 to 65535.`);
  }
  host = host.replace(/\.$/, "");
  if (host === "" || /[\s*,;]/.test(host)) {
    throw invalid(`${where} (${JSON.stringify(raw)}) is not a single host; name one address or host name.`);
  }
  if (isLoopback(host)) {
    throw invalid(`${where} (${JSON.stringify(raw)}) is this computer itself; a website cannot ask for it.`);
  }
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4 !== null) return Number(v4[1]) === 127;
  if (!host.includes(":")) return false;
  // IPv6 ::1 in any spelling: every group zero but the last, which is 1.
  const halves = host.split("::");
  if (halves.length > 2) return false;
  let groups = splitGroups(host);
  if (halves.length === 2) {
    const left = splitGroups(halves[0] ?? "");
    const right = splitGroups(halves[1] ?? "");
    const zeros = 8 - left.length - right.length;
    if (zeros < 1) return false;
    groups = [...left, ...Array<string>(zeros).fill("0"), ...right];
  }
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return false;
  return groups.slice(0, 7).every((group) => Number.parseInt(group, 16) === 0) && Number.parseInt(groups[7] ?? "", 16) === 1;
}

function splitGroups(text: string): string[] {
  return text === "" ? [] : text.split(":");
}

// ---------------------------------------------------------------------------------------------
// Text the engine refuses inside steps, functions, API specs and the sign-in recipe
// ---------------------------------------------------------------------------------------------

const FILE_REFERENCE = /\{\{\s*file\s*:/;
const SECRET_REFERENCE = /\{\{\s*(?:secret|vault)\s*:\s*([^}|\s]+)/g;

function validateText(pkg: JsonObject, credentials: ReadonlySet<string>, path: string): void {
  const parts: [string, JsonValue | undefined][] = [];
  (pkg.steps as JsonValue[]).forEach((step, index) => parts.push([`${path}.steps[${index}]`, step]));
  parts.push([`${path}.functions`, pkg.functions]);
  parts.push([`${path}.api_functions`, pkg.api_functions]);
  parts.push([`${path}.auth_config`, pkg.auth_config]);

  for (const [where, value] of parts) {
    if (value === undefined || value === null) continue;
    const text = JSON.stringify(value);
    if (FILE_REFERENCE.test(text)) {
      throw invalid(`${where} refers to a local file ({{file:...}}), which a website's workflow cannot use.`);
    }
    if (text.includes("payment_mode") || text.includes("__pay_")) {
      throw invalid(`${where} carries payment fields, which a website's workflow cannot use.`);
    }
    for (const match of text.matchAll(SECRET_REFERENCE)) {
      const key = (match[1] ?? "").split(".")[0] ?? "";
      if (!credentials.has(key)) {
        throw invalid(
          `${where} uses {{secret:${key}}} without declaring it: add { key: "${key}", label } to ${path}.credentials. A website's workflow never reads the visitor's vault.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Where a request may go: a URL's scheme and host come from a setting, never a call input
// ---------------------------------------------------------------------------------------------

/** A placeholder that reads a value given with the run (`{{name}}`, `{{input.name}}`), as the engine finds inputs. */
const VALUE_PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * Every `url` / `*_url` string in the package (steps, functions, API specs, the sign-in recipe,
 * `entry_url`), collected as the engine collects them: a placeholder in its scheme or host must
 * be a declared setting, a value the user confirmed once. A function input there would let the
 * website aim the visitor's Writ anywhere, call by call. Namespaced placeholders
 * (`{{secret:K}}`, `{{extracted:x}}`) are not inputs, and a value read from a response may still
 * name the host.
 */
function validateUrlAuthorities(pkg: JsonObject, settings: ReadonlySet<string>, path: string): void {
  checkUrls(pkg, path, settings, path);
}

function checkUrls(value: unknown, where: string, settings: ReadonlySet<string>, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkUrls(item, `${where}[${index}]`, settings, path));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    const child = value[key];
    const at = `${where}.${key}`;
    if (typeof child === "string" && (key === "url" || key.endsWith("_url"))) checkUrlAuthority(child, at, settings, path);
    else checkUrls(child, at, settings, path);
  }
}

function checkUrlAuthority(url: string, where: string, settings: ReadonlySet<string>, path: string): void {
  const end = authorityEnd(url);
  for (const match of url.matchAll(VALUE_PLACEHOLDER)) {
    if ((match.index ?? 0) >= end) break;
    const raw = match[1] ?? "";
    const name = raw.startsWith("input.") && raw.length > "input.".length ? raw.slice("input.".length) : raw;
    if (settings.has(name)) continue;
    throw invalid(
      `${where} takes its address from ${match[0]}, a function input: a website could aim the visitor's Writ anywhere, call by call. Declare "${name}" in ${path}.settings (a value each user gives once, in Writ's consent window), or write the host out.`,
    );
  }
}

/**
 * Where a URL's scheme and authority end, as the engine reads it (`net_policy::authority_span`): at
 * the first `/`, `?` or `#` after `://`, or after a leading `//` (protocol-relative); without
 * either, at the end of the first segment, which may hold a whole address (`{{base}}/api`), while a
 * path (`/api/{{id}}`) has none.
 */
function authorityEnd(url: string): number {
  const scheme = url.indexOf("://");
  const start = scheme >= 0 ? scheme + 3 : url.startsWith("//") ? 2 : 0;
  const rest = url.slice(start).search(/[/?#]/);
  return rest < 0 ? url.length : start + rest;
}

// ---------------------------------------------------------------------------------------------
// Step helpers, as the engine reads a stored workflow
// ---------------------------------------------------------------------------------------------

/** A step's settings: its `config` object, or the step itself for a flat step. */
function stepConfig(step: Record<string, unknown>): Record<string, unknown> {
  const config = step.config;
  return isPlainObject(config) ? config : step;
}

function stepFunction(step: Record<string, unknown>): string | null {
  return trimmedText(stepConfig(step).function_name);
}

function stepIsAuth(step: Record<string, unknown>): boolean {
  return stepConfig(step).is_auth === true || step.type === "login_post";
}

function trimmedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The step positions a declaration names: `step_indices`, else the `step_range` [from, to). */
function declaredStepIndices(declaration: Record<string, unknown>, total: number): number[] {
  const out = new Set<number>();
  const indices = declaration.step_indices;
  if (Array.isArray(indices)) {
    for (const raw of indices as unknown[]) {
      const index =
        typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw.trim()) : NaN;
      if (Number.isInteger(index) && index >= 0) out.add(index);
    }
  }
  if (out.size === 0) {
    const range = declaration.step_range;
    if (Array.isArray(range) && range.length === 2) {
      const [from, to] = range as unknown[];
      if (Number.isInteger(from) && Number.isInteger(to) && (from as number) >= 0 && (to as number) >= (from as number)) {
        for (let i = from as number; i < (to as number); i += 1) out.add(i);
      }
    }
  }
  return [...out].filter((index) => index < total).sort((a, b) => a - b);
}

function isHttpUrl(text: string): boolean {
  if (typeof URL !== "function") return /^https?:\/\/[^/\s]+/i.test(text);
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
