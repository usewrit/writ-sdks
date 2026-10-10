/**
 * Linked workflows (CONTRACT.md §11, docs/browser-extension/LINKED_WORKFLOWS_DESIGN.md): the
 * contract carries a manifest and a link, and the visitor's Writ fetches the signed recipe from
 * the developer's Writ Cloud for each run, keeping it in memory only.
 *
 * The page never sees a recipe. These checks catch a broken contract entry early, with a message
 * that names the field; the visitor's Writ fetches the manifest itself, compares its hash, and
 * checks every recipe against it. They are never the security boundary.
 *
 * Your code is the same for bundled and linked workflows: the contract decides. Only a linked
 * workflow in `token` mode asks one thing more of the page, `getRunToken`.
 */

import {
  DEFAULT_PUBLICATION_BASE,
  LINKED_ACCESS_MODES,
  LINKED_PACKAGE_FORMAT,
  MANIFEST_FORMAT,
  MANIFEST_HASH_PATTERN,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_DEPTH,
  MAX_PACKAGE_NAME_LENGTH,
  PACKAGE_ID_PATTERN,
  PUBLICATION_ID_PATTERN,
  PUBLISHABLE_KEY_PATTERN,
  RECIPE_CACHE_MODES,
  SETTING_KEY_PATTERN,
  SETTING_KINDS,
} from "./constants.js";
import { WritError } from "./errors.js";
import { charCount, cloneJsonObject, describeValue, isPlainObject, utf8Length } from "./json.js";
import type {
  FunctionRequest,
  WritContract,
  WritContractPackage,
  WritLinkedAccess,
  WritLinkedPackage,
  WritRecipeCache,
  WritSetting,
} from "./types.js";

function invalid(message: string): WritError {
  return new WritError("INPUT_INVALID", message);
}

function badRequest(message: string): WritError {
  return new WritError("BAD_REQUEST", message);
}

// ---------------------------------------------------------------------------------------------
// Contract entries
// ---------------------------------------------------------------------------------------------

/** True for a linked package (`format: "writ.linked/v1"`), checked or not. */
export function isLinkedPackage(pkg: unknown): pkg is WritLinkedPackage {
  return isPlainObject(pkg) && pkg.format === LINKED_PACKAGE_FORMAT;
}

/**
 * Validate a linked contract entry and return a fresh plain-JSON copy of it. INPUT_INVALID on any
 * problem, naming the field.
 *
 * Rules (CONTRACT.md §11 "Contract entry"): `format` is `"writ.linked/v1"`; `id` is a package id;
 * `name` is 1 to 120 characters; `publication.id` is `pub_` + 22 letters or digits, `base` (when
 * set) is `https://host[:port]`, or `http://` to this computer for development, and `version`
 * (when set) a positive integer; `key` is a publishable key `wpk_` + 32 letters or digits;
 * `access` is `"public"` or `"token"`; `manifest` is a `"writ.manifest/v1"` object for the same
 * publication, with `functions` and `settings`; `manifest_hash` is 64 lowercase hex characters.
 */
export function validateLinkedPackage(value: unknown, path = "package"): WritLinkedPackage {
  if (!isPlainObject(value)) {
    throw invalid(
      `${path} must be an object { format: "${LINKED_PACKAGE_FORMAT}", id, name, publication, key, access, manifest, manifest_hash }; got ${describeValue(value)}.`,
    );
  }
  const pkg = cloneJsonObject(value, path, MAX_PACKAGE_DEPTH);
  const bytes = utf8Length(JSON.stringify(pkg));
  if (bytes > MAX_PACKAGE_BYTES) {
    throw invalid(`${path} is ${bytes} bytes as JSON; a package is at most ${MAX_PACKAGE_BYTES} bytes (512 KB).`);
  }

  if (pkg.format !== LINKED_PACKAGE_FORMAT) {
    throw invalid(`${path}.format must be "${LINKED_PACKAGE_FORMAT}"; got ${describeValue(pkg.format)}.`);
  }
  if (typeof pkg.id !== "string" || !PACKAGE_ID_PATTERN.test(pkg.id)) {
    throw invalid(
      `${path}.id ${describeValue(pkg.id)} is not valid: use 1 to 64 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.`,
    );
  }
  const name = pkg.name;
  if (typeof name !== "string" || name.trim() === "" || charCount(name) > MAX_PACKAGE_NAME_LENGTH) {
    throw invalid(`${path}.name must be 1 to ${MAX_PACKAGE_NAME_LENGTH} characters, shown in the consent window.`);
  }

  const publication = pkg.publication;
  if (!isPlainObject(publication)) {
    throw invalid(`${path}.publication must be an object { id, base?, version? }; got ${describeValue(publication)}.`);
  }
  const publicationId = publication.id;
  if (typeof publicationId !== "string" || !PUBLICATION_ID_PATTERN.test(publicationId)) {
    throw invalid(`${path}.publication.id ${describeValue(publicationId)} is not a publication: "pub_" and 22 letters or digits.`);
  }
  const base = publication.base;
  if (base !== undefined && base !== null && (typeof base !== "string" || !isPublicationBase(base))) {
    throw invalid(
      `${path}.publication.base ${describeValue(base)} is not a Writ Cloud address: use https://host[:port] (no path, query or user name), or http://localhost for development. Leave it out for ${DEFAULT_PUBLICATION_BASE}.`,
    );
  }
  const version = publication.version;
  if (version !== undefined && version !== null && !(typeof version === "number" && Number.isSafeInteger(version) && version >= 1)) {
    throw invalid(`${path}.publication.version must be a published version, 1 or more; got ${describeValue(version)}.`);
  }

  if (typeof pkg.key !== "string" || !PUBLISHABLE_KEY_PATTERN.test(pkg.key)) {
    throw invalid(
      `${path}.key must be the publication's publishable key, "wpk_" and 32 letters or digits; got ${describeValue(pkg.key)}. Never put the secret key (wsk_) in a page.`,
    );
  }
  const access = pkg.access;
  if (typeof access !== "string" || !(LINKED_ACCESS_MODES as readonly string[]).includes(access)) {
    throw invalid(`${path}.access must be "public" or "token"; got ${describeValue(access)}.`);
  }

  const publisher = pkg.publisher;
  if (publisher !== undefined && publisher !== null) {
    if (!isPlainObject(publisher)) throw invalid(`${path}.publisher must be an object { name? }.`);
    const publisherName = publisher.name;
    if (publisherName !== undefined && publisherName !== null && typeof publisherName !== "string") {
      throw invalid(`${path}.publisher.name must be text.`);
    }
  }

  validateManifest(pkg.manifest, `${path}.manifest`, publicationId);

  if (typeof pkg.manifest_hash !== "string" || !MANIFEST_HASH_PATTERN.test(pkg.manifest_hash)) {
    throw invalid(
      `${path}.manifest_hash must be the sha256 of the manifest, 64 lowercase hex characters; got ${describeValue(pkg.manifest_hash)}.`,
    );
  }

  return pkg as unknown as WritLinkedPackage;
}

/**
 * The manifest, as far as the page reads it: its format, its publication, its functions (which a
 * contract key picks) and its settings (which the site may suggest). The visitor's Writ checks
 * the rest against Writ Cloud's own copy.
 */
function validateManifest(raw: unknown, where: string, publicationId: string): void {
  if (!isPlainObject(raw)) {
    throw invalid(`${where} must be the manifest object Writ Cloud computed; got ${describeValue(raw)}.`);
  }
  if (raw.format !== MANIFEST_FORMAT) {
    throw invalid(`${where}.format must be "${MANIFEST_FORMAT}"; got ${describeValue(raw.format)}.`);
  }
  if (raw.publication !== publicationId) {
    throw invalid(
      `${where}.publication is ${describeValue(raw.publication)}, but the entry links to "${publicationId}": the manifest belongs to another publication.`,
    );
  }

  const functions = raw.functions;
  if (!Array.isArray(functions) || functions.length === 0) {
    throw invalid(`${where}.functions must list the published functions, at least one.`);
  }
  functions.forEach((entry: unknown, index: number) => {
    const at = `${where}.functions[${index}]`;
    if (!isPlainObject(entry)) throw invalid(`${at} must be an object { name, inputs, outputs, writes }.`);
    const fnName = entry.name;
    if (fnName !== null && (typeof fnName !== "string" || fnName.trim() === "")) {
      throw invalid(`${at}.name must be the function's name, or null for a workflow that is one callable.`);
    }
    const inputs = entry.inputs;
    if (!Array.isArray(inputs)) throw invalid(`${at}.inputs must be an array of { name, required }.`);
    inputs.forEach((input: unknown, inputIndex: number) => {
      if (!isPlainObject(input) || typeof input.name !== "string" || typeof input.required !== "boolean") {
        throw invalid(`${at}.inputs[${inputIndex}] must be an object { name, required, description? }.`);
      }
    });
    const outputs = entry.outputs;
    if (!Array.isArray(outputs) || !outputs.every((output: unknown) => typeof output === "string")) {
      throw invalid(`${at}.outputs must be an array of field names.`);
    }
    if (typeof entry.writes !== "boolean") throw invalid(`${at}.writes must be true or false.`);
  });

  const settings = raw.settings;
  if (settings !== undefined && settings !== null) {
    if (!Array.isArray(settings)) throw invalid(`${where}.settings must be an array of { key, label, kind? }.`);
    const keys = new Set<string>();
    settings.forEach((entry: unknown, index: number) => {
      const at = `${where}.settings[${index}]`;
      if (!isPlainObject(entry)) throw invalid(`${at} must be an object { key, label, kind? }.`);
      const key = entry.key;
      if (typeof key !== "string" || !SETTING_KEY_PATTERN.test(key)) {
        throw invalid(`${at}.key ${describeValue(key)} is not valid: use 1 to 64 ASCII letters, digits or "_".`);
      }
      if (keys.has(key)) throw invalid(`${at}.key "${key}" is listed twice.`);
      keys.add(key);
      if (typeof entry.label !== "string" || entry.label.trim() === "") throw invalid(`${at}.label must be text.`);
      const kind = entry.kind;
      if (kind !== undefined && kind !== null && !(typeof kind === "string" && (SETTING_KINDS as readonly string[]).includes(kind))) {
        throw invalid(`${at}.kind must be "text" or "lan_host"; got ${describeValue(kind)}.`);
      }
    });
  }
}

/**
 * A base the visitor's Writ may talk to, as it reads one: `https://host[:port]` anywhere, or plain
 * `http://` only to this computer (a development Writ Cloud); no user name, path, query or
 * fragment. The visitor's Writ also checks it is one of its allowed bases.
 */
export function isPublicationBase(raw: string): boolean {
  const text = raw.trim();
  if (text.includes("?") || text.includes("#")) return false;
  if (typeof URL !== "function") {
    return (
      /^https:\/\/[^/@\s]+\/?$/i.test(text) ||
      /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/?$/i.test(text)
    );
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (!(url.protocol === "https:" || (url.protocol === "http:" && local))) return false;
  if (url.username !== "" || url.password !== "") return false;
  return url.pathname === "/" || url.pathname === "";
}

/** The names of a linked workflow's functions, in manifest order; empty when it is one callable. */
export function linkedFunctionNames(pkg: WritLinkedPackage): string[] {
  const names: string[] = [];
  for (const fn of pkg.manifest.functions) {
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The name to show for a package: a linked one's manifest name, which Writ Cloud vouches for
 * (the entry's own `name` and `publisher` are whatever the site wrote), else its `name`.
 */
export function packageDisplayName(pkg: WritContractPackage): string {
  if (isLinkedPackage(pkg)) {
    const vouched = typeof pkg.manifest.name === "string" ? pkg.manifest.name.trim() : "";
    if (vouched !== "") return vouched;
  }
  return pkg.name.trim();
}

/** The settings a package declares: a bundled package's own, a linked one's manifest's. */
export function packageSettings(pkg: WritContractPackage): readonly WritSetting[] {
  return isLinkedPackage(pkg) ? (pkg.manifest.settings ?? []) : (pkg.settings ?? []);
}

// ---------------------------------------------------------------------------------------------
// Run tokens and the recipe cache: the options wherever sessions are made
// ---------------------------------------------------------------------------------------------

/** `getRunToken` and `recipeCache`, validated. `recipeCache` stays undefined when not given. */
export interface CleanLinkedOptions {
  readonly getRunToken: (() => Promise<string>) | null;
  readonly recipeCache: WritRecipeCache | undefined;
}

/** Validate `{ getRunToken?, recipeCache? }` of `where` (`"connect()"`, ...). BAD_REQUEST. */
export function validateLinkedOptions(options: unknown, where: string): CleanLinkedOptions {
  if (options === undefined || options === null) return { getRunToken: null, recipeCache: undefined };
  if (typeof options !== "object") throw badRequest(`${where} takes an options object.`);
  const { getRunToken, recipeCache } = options as { getRunToken?: unknown; recipeCache?: unknown };
  if (getRunToken !== undefined && getRunToken !== null && typeof getRunToken !== "function") {
    throw badRequest(
      `${where}: \`getRunToken\` must be a function resolving with a run token your backend minted, like () => fetch("/api/writ-token").then((r) => r.text()).`,
    );
  }
  return {
    getRunToken: typeof getRunToken === "function" ? (getRunToken as () => Promise<string>) : null,
    recipeCache: validateRecipeCache(recipeCache, `${where}: \`recipeCache\``),
  };
}

/** `"session"`, `"call"`, or undefined when not given. BAD_REQUEST otherwise. */
export function validateRecipeCache(value: unknown, what: string): WritRecipeCache | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(RECIPE_CACHE_MODES as readonly string[]).includes(value)) {
    throw badRequest(`${what} must be "session" or "call"; got ${describeValue(value)}.`);
  }
  return value as WritRecipeCache;
}

/** The access mode of each key whose package is linked, from connect requests. */
export function linkedAccessOfRequests(functions: readonly FunctionRequest[]): Map<string, WritLinkedAccess> {
  const out = new Map<string, WritLinkedAccess>();
  for (const fn of functions) {
    if (fn.package !== undefined && isLinkedPackage(fn.package)) out.set(fn.key, fn.package.access);
  }
  return out;
}

/** The access mode of each contract key whose package is linked. */
export function linkedAccessOfContract(contract: WritContract): Map<string, WritLinkedAccess> {
  const packages = new Map(contract.packages.map((pkg) => [pkg.id, pkg] as const));
  const out = new Map<string, WritLinkedAccess>();
  for (const fn of contract.functions) {
    const pkg = packages.get(fn.package);
    if (pkg !== undefined && isLinkedPackage(pkg)) out.set(fn.key, pkg.access);
  }
  return out;
}

/**
 * A linked workflow in `token` mode needs a run token on every call: refuse to create anything
 * that would call one without a way to get it. BAD_REQUEST naming the first such key.
 */
export function requireRunTokens(
  access: ReadonlyMap<string, WritLinkedAccess>,
  hasSource: boolean,
  where: string,
): void {
  if (hasSource) return;
  for (const [key, mode] of access) {
    if (mode !== "token") continue;
    throw badRequest(
      `${where}: "${key}" is a linked workflow in token mode, so every call needs a run token your backend mints (mintRunToken in @usewrit/server, mint_run_token in usewrit). Pass getRunToken, like getRunToken: () => fetch("/api/writ-token").then((r) => r.text()).`,
    );
  }
}

/** @internal What a session knows about the linked workflows it calls. */
export interface LinkedSessionConfig {
  /** Contract key -> its linked package's access mode. */
  readonly access: ReadonlyMap<string, WritLinkedAccess>;
  readonly getRunToken: (() => Promise<string>) | null;
  /** Sent on every call to a linked key, unless the call sets its own. */
  readonly recipeCache: WritRecipeCache;
}

/** A session that knows no linked workflow. */
export const NO_LINKED_WORKFLOWS: LinkedSessionConfig = Object.freeze({
  access: new Map<string, WritLinkedAccess>(),
  getRunToken: null,
  recipeCache: "session" as const,
});

/**
 * The linked config of a session made from `functions` with `options` (`connect()`, `resume()`):
 * options validated, and refused (BAD_REQUEST) when a token-mode key has no `getRunToken`.
 */
export function linkedSessionConfig(
  options: unknown,
  functions: readonly FunctionRequest[],
  where: string,
): LinkedSessionConfig {
  const clean = validateLinkedOptions(options, where);
  const access = linkedAccessOfRequests(functions);
  requireRunTokens(access, clean.getRunToken !== null, where);
  if (access.size === 0 && clean.getRunToken === null && clean.recipeCache === undefined) return NO_LINKED_WORKFLOWS;
  return Object.freeze({ access, getRunToken: clean.getRunToken, recipeCache: clean.recipeCache ?? "session" });
}
