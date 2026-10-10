/** Installable workflows (CONTRACT.md §8): definePackage() and what connect() checks. */

import { describe, expect, it } from "vitest";
import {
  MAX_PACKAGE_BYTES,
  connectWrit,
  definePackage,
  isWritError,
  type FunctionRequest,
  type WritClient,
  type WritPackage,
} from "../src/index.js";
import { FakeProvider, FakeWindow, installDirect } from "./fake-provider.js";
import { posPackage, posReceivePackage, posSettingsPackage } from "./fixtures.js";

/** A package with some fields replaced (or removed, with `undefined`). */
function withPackage(patch: Record<string, unknown>): unknown {
  return { ...posReceivePackage(), ...patch };
}

function withStep(step: Record<string, unknown>): unknown {
  return withPackage({ steps: [step] });
}

function hosts(...list: unknown[]): unknown {
  return withPackage({ local_network: { hosts: list } });
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

async function client(provider = new FakeProvider()): Promise<WritClient> {
  const win = new FakeWindow();
  installDirect(win, provider);
  const writ = await connectWrit({ window: win });
  if (!writ.available) throw new Error("expected a client");
  return writ;
}

describe("definePackage()", () => {
  it("returns a deep-frozen copy equal to the package", () => {
    const source = posReceivePackage();
    const pkg = definePackage(source);
    expect(pkg).toEqual(source);
    expect(pkg).not.toBe(source);
    expect(Object.isFrozen(pkg)).toBe(true);
    expect(Object.isFrozen(pkg.steps)).toBe(true);
    expect(Object.isFrozen((pkg.steps[0] as { config: object }).config)).toBe(true);
    expect(Object.isFrozen(pkg.credentials?.[0])).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
  });

  it("is structured-clone safe", () => {
    const pkg = definePackage(posReceivePackage());
    expect(structuredClone(pkg)).toEqual(pkg);
  });

  it("drops undefined properties, as JSON would", () => {
    const pkg = definePackage({ ...posReceivePackage(), description: undefined });
    expect("description" in pkg).toBe(false);
  });

  const accepted: [string, unknown][] = [
    ["the smallest package", { format: "writ.workflow/v1", id: "a", name: "A", steps: [{ type: "wait" }] }],
    ["the longest id", withPackage({ id: `a${"b".repeat(63)}` })],
    ["a 120-character name", withPackage({ name: "n".repeat(120) })],
    ["a 32-character version", withPackage({ version: "v".repeat(32) })],
    ["500 steps", withPackage({ steps: Array.from({ length: 500 }, () => ({ type: "wait" })) })],
    // The fixture's step reads {{secret:pos_password}}, so it stays among the ten.
    ["10 credentials", withPackage({ credentials: [{ key: "pos_password", label: "POS password" }, ...Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `Key ${i}` }))] })],
    ["8 hosts", hosts(...Array.from({ length: 8 }, (_, i) => `192.168.1.${i + 1}`))],
    ["a host given as a URL", hosts("http://192.168.1.20:8080/api")],
    ["a host name with a port", hosts("pos.local:8443")],
    ["a bracketed IPv6 host", hosts("[fd12::5]:443")],
    ["a link-local IPv6 host", hosts("fe80::1")],
    ["no local network", withPackage({ local_network: undefined })],
    ["a vault reference to a declared credential", withStep({ type: "api_call", config: { url: "http://192.168.1.20/{{vault:pos_password}}" } })],
    ["a secret field reference", withStep({ type: "api_call", config: { body_json: { p: "{{secret:pos_password.user}}" } } })],
    ["null optional fields", withPackage({ version: null, description: null, functions: null, auth_config: null })],
    ["an https entry_url", withPackage({ entry_url: "https://pos.example.com/start" })],
  ];

  it.each(accepted)("accepts %s", (_label, pkg) => {
    expect(() => definePackage(pkg as WritPackage)).not.toThrow();
  });

  const refused: [string, unknown, string][] = [
    ["a non-object", "writ.workflow/v1", "must be an object"],
    ["an array", [], "must be an object"],
    ["another format", withPackage({ format: "writ.workflow/v2" }), 'format must be "writ.workflow/v1"'],
    ["an uppercase id", withPackage({ id: "Arrivos" }), "package.id"],
    ["an id starting with a dot", withPackage({ id: ".pos" }), "package.id"],
    ["a 65-character id", withPackage({ id: "a".repeat(65) }), "package.id"],
    ["a 33-character version", withPackage({ version: "v".repeat(33) }), "package.version is 33 characters"],
    ["a numeric version", withPackage({ version: 2 }), "package.version must be text"],
    ["no name", withPackage({ name: undefined }), "package.name is required"],
    ["a blank name", withPackage({ name: "   " }), "package.name is required"],
    ["a 121-character name", withPackage({ name: "n".repeat(121) }), "package.name is 121 characters"],
    ["a 1001-character description", withPackage({ description: "d".repeat(1001) }), "package.description is 1001"],
    ["an ftp entry_url", withPackage({ entry_url: "ftp://pos.example.com" }), "entry_url must be an http(s) address"],
    ["no steps", withPackage({ steps: [] }), "a package has 1 to 500"],
    ["steps not an array", withPackage({ steps: { type: "wait" } }), "package.steps must be an array"],
    ["501 steps", withPackage({ steps: Array.from({ length: 501 }, () => ({ type: "wait" })) }), "501 steps"],
    ["a step without a type", withStep({ config: {} }), "package.steps[0] has no type"],
    ["a step that is not an object", withPackage({ steps: ["wait"] }), "package.steps[0] must be a step object"],
    ["an upload step", withStep({ type: "upload" }), "never touch the visitor's files"],
    ["a download step", withStep({ type: "wait_for_download" }), "never touch the visitor's files"],
    ["an AI step", withStep({ type: "ai_fill_form" }), "AI steps would spend"],
    ["an AI navigation step", withStep({ type: "ai_navigate" }), "AI steps would spend"],
    ["a codegen step", withStep({ type: "codegen" }), "no generated code"],
    ["functions not an array", withPackage({ functions: {} }), "package.functions must be an array"],
    ["api_functions an array", withPackage({ api_functions: [] }), "package.api_functions must be an object"],
    ["auth_config text", withPackage({ auth_config: "login" }), "package.auth_config must be an object"],
    ["inputs an array", withPackage({ inputs: ["invoice_no"] }), "package.inputs must be an object"],
    ["an input name with a space", withPackage({ inputs: { "invoice no": {} } }), "package.inputs has the name"],
    ["a reserved input name", withPackage({ inputs: { persona_id: {} } }), '"persona_id" is reserved'],
    ["a secret: input name", withPackage({ inputs: { "secret:x": {} } }), "package.inputs has the name"],
    ["an input spec that is text", withPackage({ inputs: { invoice_no: "required" } }), "package.inputs.invoice_no must be an object"],
    ["required not a boolean", withPackage({ inputs: { invoice_no: { required: "yes" } } }), "required must be true or false"],
    ["65 inputs", withPackage({ inputs: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`i${i}`, {}])) }), "at most 64"],
    ["credentials an object", withPackage({ credentials: { key: "pos_password" } }), "package.credentials must be an array"],
    ["11 credentials", withPackage({ credentials: Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, label: "L" })) }), "at most 10"],
    ["a credential key with a dash", withPackage({ credentials: [{ key: "pos-password", label: "POS" }] }), "credentials[0].key"],
    ["a repeated credential key", withPackage({ credentials: [{ key: "k", label: "A" }, { key: "k", label: "B" }] }), 'credentials[1].key "k" is declared twice'],
    ["a credential without a label", withPackage({ credentials: [{ key: "pos_password" }] }), "needs a label"],
    ["an 81-character credential label", withPackage({ credentials: [{ key: "k", label: "l".repeat(81) }] }), "label is 81 characters"],
    ["secret not a boolean", withPackage({ credentials: [{ key: "pos_password", label: "POS", secret: 1 }] }), "secret must be true or false"],
    ["local_network.hosts missing", withPackage({ local_network: { reason: "POS" } }), "hosts must be an array"],
    ["9 hosts", hosts(...Array.from({ length: 9 }, (_, i) => `192.168.1.${i + 1}`)), "at most 8"],
    ["a host that is not text", hosts(192), "hosts[0] must be text"],
    ["an IPv4 range", hosts("192.168.1.0/24"), "is a range"],
    ["an IPv6 range", hosts("fd12::/64"), "is a range"],
    ["loopback", hosts("127.0.0.1:3000"), "this computer itself"],
    ["localhost", hosts("localhost:3000"), "this computer itself"],
    ["a .localhost name", hosts("pos.localhost:8080"), "this computer itself"],
    ["IPv6 loopback", hosts("[::1]:8080"), "this computer itself"],
    ["mapped IPv4 loopback", hosts("::ffff:127.0.0.1"), "this computer itself"],
    ["a wildcard", hosts("*.local"), "not a single host"],
    ["an ftp URL", hosts("ftp://192.168.1.20"), "only http(s)"],
    ["a URL with a user name", hosts("http://admin@192.168.1.20"), "remove the user name"],
    ["a bad port", hosts("192.168.1.20:99999"), "invalid port"],
    ["a 201-character reason", withPackage({ local_network: { hosts: [], reason: "r".repeat(201) } }), "reason is 201"],
    ["a file reference", withStep({ type: "api_call", config: { body_json: { f: "{{file:invoice.pdf}}" } } }), "refers to a local file"],
    ["a spaced file reference", withStep({ type: "api_call", config: { url: "{{ file : a }}" } }), "refers to a local file"],
    ["a payment field", withStep({ type: "api_call", config: { payment_mode: "card" } }), "payment fields"],
    ["a pay placeholder", withStep({ type: "fill", config: { value: "{{__pay_card_number}}" } }), "payment fields"],
    ["an undeclared secret", withStep({ type: "api_call", config: { url: "http://x/{{secret:admin_token}}" } }), "{{secret:admin_token}} without declaring it"],
    ["an undeclared vault entry", withStep({ type: "api_call", config: { url: "http://x/{{vault:bank}}" } }), "{{secret:bank}} without declaring it"],
    ["a secret inside the sign-in recipe", withPackage({ auth_config: { password: "{{secret:other}}" } }), "package.auth_config uses {{secret:other}}"],
    ["a Date", withStep({ type: "wait", at: new Date(0) }), "a Date"],
    ["a function", withStep({ type: "wait", run: () => 1 }), "is a function"],
    ["NaN", withStep({ type: "wait", ms: Number.NaN }), "only finite numbers"],
    ["a cycle", (() => { const step: Record<string, unknown> = { type: "wait" }; step.self = step; return withStep(step); })(), "circular reference"],
    ["more than 512 KB", withStep({ type: "api_call", config: { body_json: { blob: "x".repeat(MAX_PACKAGE_BYTES) } } }), "a package is at most 524288 bytes"],
  ];

  it.each(refused)("refuses %s with INPUT_INVALID", (_label, pkg, message) => {
    const error = errorOf(() => definePackage(pkg as WritPackage));
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect((error as Error).message).toContain(message);
  });
});

describe("connect() with packages", () => {
  const receive = (pkg: unknown, extra: Partial<FunctionRequest> = {}): FunctionRequest => ({
    key: "pos.receive",
    description: "Receive an invoice in your POS",
    writes: true,
    package: pkg as WritPackage,
    ...extra,
  });

  it("refuses an invalid package with INPUT_INVALID before calling the extension", async () => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    const error: unknown = await writ
      .connect({ app: "Arrivos", functions: [receive(withPackage({ id: "Not Valid" }))] })
      .catch((e: unknown) => e);
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect((error as Error).message).toContain("functions[0].package.id");
    expect(provider.requests).toEqual([]);
  });

  it("passes a valid package through untouched and structured-clone safe", async () => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    const pkg = posReceivePackage();
    await writ.connect({ app: "Arrivos", functions: [receive(pkg)] });
    const [sent] = provider.sent("writ_connect") as { functions: FunctionRequest[] }[];
    expect(sent?.functions[0]?.package).toEqual(posReceivePackage());
    expect(sent?.functions[0]).not.toHaveProperty("function");
    expect(structuredClone(sent)).toEqual(sent);
    expect(pkg).toEqual(posReceivePackage());
  });

  it("accepts a package from definePackage()", async () => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    const pkg = definePackage(posReceivePackage());
    await writ.connect({ app: "Arrivos", functions: [receive(pkg)] });
    const [sent] = provider.sent("writ_connect") as { functions: FunctionRequest[] }[];
    expect(sent?.functions[0]?.package).toEqual(pkg);
  });

  it("needs `function` when the package has several functions", async () => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    const error: unknown = await writ.connect({ app: "Arrivos", functions: [receive(posPackage())] }).catch((e: unknown) => e);
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect((error as Error).message).toContain('has 2 functions ("receive", "lookup")');
    expect(provider.requests).toEqual([]);
  });

  it("sends the chosen function, trimmed, and lets two keys share one package", async () => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    await writ.connect({
      app: "Arrivos",
      functions: [
        receive(posPackage(), { function: " receive " }),
        { key: "pos.lookup", description: "Look up a product", package: posPackage(), function: "lookup" },
      ],
    });
    const [sent] = provider.sent("writ_connect") as { functions: FunctionRequest[] }[];
    expect(sent?.functions.map((fn) => fn.function)).toEqual(["receive", "lookup"]);
  });

  it("refuses a function the package does not have", async () => {
    const writ = await client();
    await expect(
      writ.connect({ app: "Arrivos", functions: [receive(posPackage(), { function: "refund" })] }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID", message: expect.stringContaining('no such function; it has "receive", "lookup"') });
  });

  it("refuses `function` for a package whose whole workflow is the callable", async () => {
    const writ = await client();
    await expect(
      writ.connect({ app: "Arrivos", functions: [receive(posReceivePackage(), { function: "receive" })] }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID", message: expect.stringContaining("declares no functions") });
  });

  it("refuses `function` without a package", async () => {
    const writ = await client();
    await expect(
      writ.connect({ app: "Arrivos", functions: [{ key: "pos.receive", description: "Receive", function: "receive" }] }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID", message: expect.stringContaining("has no `package`") });
  });

  it("refuses two different packages under one id", async () => {
    const writ = await client();
    const other = { ...posReceivePackage(), name: "Something else" };
    await expect(
      writ.connect({
        app: "Arrivos",
        functions: [receive(posReceivePackage()), { key: "pos.again", description: "Again", package: other }],
      }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID", message: expect.stringContaining('same id "arrivos.pos-receive"') });
  });

  it("counts functions as the engine does: declarations, stamps and API specs, minus sign-in and disabled ones", async () => {
    const writ = await client();
    const signInPlusOne = {
      ...posReceivePackage(),
      functions: [
        { name: "sign_in", is_auth: true },
        { name: "receive", step_indices: [0] },
      ],
    };
    await expect(writ.connect({ app: "Arrivos", functions: [receive(signInPlusOne)] })).resolves.toBeDefined();

    const disabledPlusOne = { ...posReceivePackage(), functions: [{ name: "old", enabled: false }, { name: "receive" }] };
    await expect(writ.connect({ app: "Arrivos", functions: [receive(disabledPlusOne)] })).resolves.toBeDefined();

    const loginStamp = {
      ...posPackage(),
      steps: [
        { type: "login_post", config: { function_name: "login", url: "http://192.168.1.20:8080/login" } },
        ...posPackage().steps.slice(0, 1),
      ],
    };
    await expect(writ.connect({ app: "Arrivos", functions: [receive(loginStamp)] })).resolves.toBeDefined();

    const apiTwo = { ...posReceivePackage(), api_functions: { receive: { request: {} }, lookup: { request: {} } } };
    await expect(writ.connect({ app: "Arrivos", functions: [receive(apiTwo)] })).rejects.toMatchObject({
      code: "INPUT_INVALID",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Settings: values each user gives once (CONTRACT.md §8)
// ---------------------------------------------------------------------------------------------

/** The settings package with some fields replaced (or removed, with `undefined`). */
function withSettingsPackage(patch: Record<string, unknown>): unknown {
  return { ...posSettingsPackage(), ...patch };
}

function withSettings(...settings: unknown[]): unknown {
  return withSettingsPackage({ settings });
}

/** The settings package whose one step calls `url` (the setting `pos_host` stays declared). */
function calling(url: string, extra: Record<string, unknown> = {}): unknown {
  return withSettingsPackage({ steps: [{ type: "api_call", config: { method: "GET", url, ...extra } }] });
}

describe("definePackage(): settings", () => {
  it("keeps the settings as given", () => {
    const pkg = definePackage(posSettingsPackage());
    expect(pkg.settings).toEqual(posSettingsPackage().settings);
    expect(Object.isFrozen(pkg.settings?.[0])).toBe(true);
  });

  const accepted: [string, unknown][] = [
    ["8 settings", withSettings(...["pos_host", ...Array.from({ length: 7 }, (_, i) => `s${i}`)].map((key) => ({ key, label: key })))],
    ["a text setting with only a key and a label", withSettings({ key: "pos_host", label: "POS" })],
    ["null optional fields", withSettings({ key: "pos_host", label: "POS", description: null, kind: null, example: null })],
    ["an 80-character label", withSettings({ key: "pos_host", label: "l".repeat(80) })],
    ["a 120-character example", withSettings({ key: "pos_host", label: "POS", example: "e".repeat(120) })],
    ["no settings", withSettingsPackage({ settings: undefined, steps: posReceivePackage().steps })],
  ];

  it.each(accepted)("accepts %s", (_label, pkg) => {
    expect(() => definePackage(pkg as WritPackage)).not.toThrow();
  });

  const refused: [string, unknown, string][] = [
    ["settings that are not an array", withSettingsPackage({ settings: { pos_host: {} } }), "package.settings must be an array"],
    ["9 settings", withSettings(...Array.from({ length: 9 }, (_, i) => ({ key: `s${i}`, label: "S" }))), "at most 8"],
    ["a setting that is text", withSettings("pos_host"), "package.settings[0] must be an object"],
    ["a key with a dash", withSettings({ key: "pos-host", label: "POS" }), "package.settings[0].key"],
    ["a key with a dot", withSettings({ key: "pos.host", label: "POS" }), "package.settings[0].key"],
    ["a 65-character key", withSettings({ key: "k".repeat(65), label: "POS" }), "package.settings[0].key"],
    ["a reserved key", withSettings({ key: "persona_id", label: "Persona" }), '"persona_id" is reserved'],
    ["a key declared twice", withSettings({ key: "pos_host", label: "A" }, { key: "pos_host", label: "B" }), 'settings[1].key "pos_host" is declared twice'],
    ["a key that is also an input", withSettings({ key: "pos_host", label: "POS" }, { key: "invoice_no", label: "Invoice" }), '"invoice_no" is also declared in package.inputs'],
    ["a key that is also a credential", withSettings({ key: "pos_host", label: "POS" }, { key: "pos_password", label: "Password" }), '"pos_password" is also declared in package.credentials'],
    ["no label", withSettings({ key: "pos_host" }), 'package.settings[0] ("pos_host") needs a label'],
    ["a blank label", withSettings({ key: "pos_host", label: "  " }), "needs a label"],
    ["an 81-character label", withSettings({ key: "pos_host", label: "l".repeat(81) }), "label is 81 characters"],
    ["a 201-character description", withSettings({ key: "pos_host", label: "POS", description: "d".repeat(201) }), "description is 201 characters"],
    ["a 121-character example", withSettings({ key: "pos_host", label: "POS", example: "e".repeat(121) }), "example is 121 characters"],
    ["an unknown kind", withSettings({ key: "pos_host", label: "POS", kind: "url" }), 'kind must be "text" or "lan_host"'],
    ["required not a boolean", withSettings({ key: "pos_host", label: "POS", required: "yes" }), "required must be true or false"],
  ];

  it.each(refused)("refuses %s with INPUT_INVALID", (_label, pkg, message) => {
    const error = errorOf(() => definePackage(pkg as WritPackage));
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect((error as Error).message).toContain(message);
  });
});

describe("definePackage(): a URL's scheme and host come from a setting, never a call input", () => {
  const accepted: [string, unknown][] = [
    ["a setting as the host", calling("http://{{pos_host}}/api/receivings")],
    ["a setting with its port", calling("http://{{pos_host}}:8080/api")],
    ["a setting read as {{input.name}}, with spaces", calling("http://{{ input.pos_host }}/api")],
    ["a setting as the whole address", calling("{{pos_host}}")],
    ["a response value as the host", calling("{{extracted:next_url}}")],
    ["a response value inside the host", calling("https://{{extracted:region}}.pos.example.com/api")],
    ["a declared credential before the path", calling("{{secret:pos_password}}/api")],
    ["a literal host", calling("http://192.168.1.20:8080/api")],
    ["inputs in the path, query and fragment", calling("http://192.168.1.20/api/{{invoice_no}}?sku={{sku}}#{{sku}}")],
    ["an input in a relative path", calling("/api/receivings/{{invoice_no}}")],
    ["an input in a field that is not a URL", calling("http://{{pos_host}}/api", { host: "{{invoice_no}}", body_json: { href: "{{sku}}" } })],
  ];

  it.each(accepted)("accepts %s", (_label, pkg) => {
    expect(() => definePackage(pkg as WritPackage)).not.toThrow();
  });

  const refused: [string, unknown, string][] = [
    ["a declared input as the host", calling("http://{{invoice_no}}/api"), "package.steps[0].config.url takes its address from {{invoice_no}}, a function input"],
    ["an input read as {{input.name}}", calling("http://{{input.sku}}:8080/api"), "takes its address from {{input.sku}}"],
    ["an undeclared placeholder", calling("https://{{host}}/api"), 'Declare "host" in package.settings'],
    ["an input as part of the host", calling("https://{{tenant}}.example.com/api"), "{{tenant}}"],
    ["an input as the scheme", calling("{{scheme}}://192.168.1.20/api"), "{{scheme}}"],
    ["an input as the whole address", calling("{{target}}"), "{{target}}"],
    ["an input before the path, without a scheme", calling("{{base}}/api/receivings"), "{{base}}"],
    ["a protocol-relative address", calling("//{{host}}/api"), "{{host}}"],
    ["a setting next to an input in the host", calling("http://{{pos_host}}.{{zone}}/api"), "{{zone}}"],
    ["an input in a *_url field", calling("http://{{pos_host}}/api", { callback_url: "https://{{hook_host}}/done" }), "package.steps[0].config.callback_url takes its address from {{hook_host}}"],
    [
      "an input in an API spec's URL",
      withSettingsPackage({ api_functions: { receive: { request: { url: "http://{{invoice_no}}/x" } } } }),
      "package.api_functions.receive.request.url",
    ],
    [
      "an input in the sign-in recipe's URL",
      withSettingsPackage({ auth_config: { login_url: "https://{{portal}}/login" } }),
      "package.auth_config.login_url",
    ],
  ];

  it.each(refused)("refuses %s with INPUT_INVALID", (_label, pkg, message) => {
    const error = errorOf(() => definePackage(pkg as WritPackage));
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect((error as Error).message).toContain(message);
  });

  it("names the input and the setting it should be", () => {
    const error = errorOf(() => definePackage(calling("http://{{pos_ip}}:8080/api") as WritPackage));
    expect((error as Error).message).toBe(
      'package.steps[0].config.url takes its address from {{pos_ip}}, a function input: a website could aim the visitor\'s Writ anywhere, call by call. Declare "pos_ip" in package.settings (a value each user gives once, in Writ\'s consent window), or write the host out.',
    );
  });
});

describe("connect() with suggested settings", () => {
  const receive = (settings: unknown, extra: Partial<FunctionRequest> = {}): FunctionRequest => ({
    key: "pos.receive",
    description: "Receive an invoice in your POS",
    writes: true,
    package: posSettingsPackage(),
    function: "receive",
    settings: settings as FunctionRequest["settings"],
    ...extra,
  });

  it("sends the suggestions to writ_connect, trimmed, and drops undefined ones", async () => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    await writ.connect({
      app: "Arrivos",
      functions: [receive({ pos_host: " 192.168.1.20:8080 ", store_no: undefined })],
    });
    const [sent] = provider.sent("writ_connect") as { functions: FunctionRequest[] }[];
    expect(sent?.functions[0]?.settings).toEqual({ pos_host: "192.168.1.20:8080" });
    expect(structuredClone(sent)).toEqual(sent);
  });

  it("sends nothing for an empty object, and lets two keys of one package suggest the same value", async () => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    await writ.connect({
      app: "Arrivos",
      functions: [
        receive({ pos_host: "pos.local" }),
        receive({ pos_host: "pos.local", store_no: "12" }, { key: "pos.lookup", function: "lookup" }),
        receive({}, { key: "pos.again" }),
      ],
    });
    const [sent] = provider.sent("writ_connect") as { functions: FunctionRequest[] }[];
    expect(sent?.functions.map((fn) => fn.settings)).toEqual([{ pos_host: "pos.local" }, { pos_host: "pos.local", store_no: "12" }, undefined]);
  });

  const refused: [string, FunctionRequest[], string][] = [
    ["suggestions without a package", [{ key: "pos.receive", description: "Receive", settings: { pos_host: "pos.local" } }], "has no `package`"],
    ["suggestions that are not an object", [receive("pos.local")], "functions[0].settings must be an object"],
    ["9 suggestions", [receive(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, "x"])))], "has 9 entries; at most 8"],
    ["a setting the package does not declare", [receive({ pos_ip: "192.168.1.20" })], 'names "pos_ip", but package "arrivos.pos-any" has no such setting; its settings are "pos_host", "store_no"'],
    ["a value that is not text", [receive({ pos_host: 8080 })], "functions[0].settings.pos_host must be text"],
    ["an empty value", [receive({ pos_host: "   " })], "functions[0].settings.pos_host is empty"],
    ["a 201-character value", [receive({ store_no: "1".repeat(201) })], "store_no is 201 characters; at most 200"],
    ["a control character", [receive({ pos_host: "192.168.1.20\u0007" })], "contains control characters"],
    ["a line break", [receive({ store_no: "12\n13" })], "contains control characters"],
    ["a bidirectional override", [receive({ store_no: "\u202e21" })], "contains control characters"],
    [
      "two keys of one package suggesting different values",
      [receive({ pos_host: "pos.local" }), receive({ pos_host: "10.0.0.5" }, { key: "pos.lookup", function: "lookup" })],
      'functions[1].settings.pos_host is "10.0.0.5", but functions[0].settings.pos_host is "pos.local"',
    ],
  ];

  it.each(refused)("refuses %s with INPUT_INVALID, sending nothing", async (_label, functions, message) => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    const error: unknown = await writ.connect({ app: "Arrivos", functions }).catch((e: unknown) => e);
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect((error as Error).message).toContain(message);
    expect(provider.requests).toEqual([]);
  });

  it("accepts 200 characters, and a lan_host suggestion the window will check itself", async () => {
    const provider = new FakeProvider();
    const writ = await client(provider);
    await writ.connect({ app: "Arrivos", functions: [receive({ store_no: "1".repeat(200), pos_host: "http://192.168.1.20:8080/" })] });
    const [sent] = provider.sent("writ_connect") as { functions: FunctionRequest[] }[];
    expect(sent?.functions[0]?.settings?.store_no).toHaveLength(200);
  });
});
