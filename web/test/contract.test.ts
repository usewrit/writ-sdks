/** The contract file and the typed client (CONTRACT.md §10). */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  contractFunctions,
  createWritClient,
  isWritError,
  validateContract,
  type CallOptions,
  type WritCall,
  type WritContract,
  type WritPackage,
  type WritSession,
} from "../src/index.js";
import { connected } from "./fake-provider.js";
import { healthPackage, posContract, posPackage, posSettingsPackage, settingsContract } from "./fixtures.js";

/** The interface Writ generates next to the contract (`writ-functions.d.ts`). */
interface WritFunctions {
  "pos.receive": { inputs: { invoice_no: string }; outputs: { received: boolean; lines: number } };
  "pos.lookup": { inputs: { sku?: string }; outputs: { name: string; price: number } };
  health: { inputs: Record<string, never>; outputs: { ok: boolean } };
}

/** A contract with one field changed. */
function patched(mutate: (contract: Record<string, unknown> & { functions: Record<string, unknown>[] }) => void): unknown {
  const contract = JSON.parse(JSON.stringify(posContract())) as Record<string, unknown> & {
    functions: Record<string, unknown>[];
  };
  mutate(contract);
  return contract;
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

/** A session double that records calls. */
function recordingSession(): { session: WritSession; calls: { key: string; inputs: unknown; options: unknown }[]; result: object } {
  const calls: { key: string; inputs: unknown; options: unknown }[] = [];
  const result = { recorded: true };
  const session = {
    call(key: string, inputs?: object, options?: CallOptions) {
      calls.push({ key, inputs, options });
      return result;
    },
  } as unknown as WritSession;
  return { session, calls, result };
}

describe("validateContract()", () => {
  it("accepts a contract and returns a deep-frozen copy", () => {
    const source = posContract();
    const contract = validateContract(source);
    expect(contract).toEqual(source);
    expect(contract).not.toBe(source);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.functions[0]?.inputs)).toBe(true);
    expect(Object.isFrozen((contract.packages[0] as WritPackage | undefined)?.steps)).toBe(true);
  });

  it("accepts the file's text", () => {
    expect(validateContract(JSON.stringify(posContract()))).toEqual(posContract());
  });

  it("treats a missing function as null", () => {
    const contract = validateContract(
      patched((c) => {
        const health = c.functions[2];
        if (health !== undefined) delete health.function;
      }),
    );
    expect(contract.functions[2]?.function).toBeNull();
  });

  const refused: [string, unknown, string][] = [
    ["text that is not JSON", "{ nope", "not valid JSON"],
    ["a non-object", [], "must be an object"],
    ["another format", patched((c) => (c.format = "writ.contract/v2")), 'contract.format must be "writ.contract/v1"'],
    ["a bad generated_at", patched((c) => (c.generated_at = "yesterday")), "generated_at must be an ISO 8601 date"],
    ["no generator", patched((c) => delete c.generator), "contract.generator"],
    ["a publisher that is text", patched((c) => (c.publisher = "Arrivos")), "contract.publisher must be an object"],
    ["packages not an array", patched((c) => (c.packages = {})), "contract.packages must be an array"],
    ["a repeated package id", patched((c) => (c.packages = [healthPackage(), healthPackage()])), 'contract.packages[1].id "arrivos.health" is used by another package'],
    ["an invalid package", patched((c) => (c.packages = [{ ...posPackage(), steps: [{ type: "upload" }] }, healthPackage()])), "contract.packages[0].steps[0]"],
    ["no functions", patched((c) => (c.functions = [])), "at least one function"],
    ["a bad key", patched((c) => (c.functions[0]!.key = "POS.receive")), "contract.functions[0].key"],
    ["a repeated key", patched((c) => (c.functions[1]!.key = "pos.receive")), 'contract.functions[1].key "pos.receive" is listed twice'],
    ["an empty key segment", patched((c) => (c.functions[0]!.key = "pos..receive")), "has an empty segment"],
    ["a trailing dot", patched((c) => (c.functions[0]!.key = "pos.")), "has an empty segment"],
    ["a `then` segment", patched((c) => (c.functions[0]!.key = "pos.then")), 'uses "then"'],
    ["a key that is also a namespace", patched((c) => (c.functions[2]!.key = "pos")), 'both "pos" and "pos.receive"'],
    ["a deeper collision", patched((c) => (c.functions[2]!.key = "pos.receive.now")), 'both "pos.receive" and "pos.receive.now"'],
    ["a description that is not text", patched((c) => (c.functions[0]!.description = 5)), "description must be text"],
    ["an unknown package", patched((c) => (c.functions[0]!.package = "arrivos.other")), 'package is "arrivos.other", but contract.packages has no package'],
    ["no function on a two-function package", patched((c) => (c.functions[0]!.function = null)), "set `function`"],
    ["a function the package lacks", patched((c) => (c.functions[0]!.function = "refund")), 'no such function; it has "receive", "lookup"'],
    ["inputs not an array", patched((c) => (c.functions[0]!.inputs = {})), "contract.functions[0].inputs must be an array"],
    ["an input without required", patched((c) => (c.functions[0]!.inputs = [{ name: "invoice_no" }])), "inputs[0].required must be true or false"],
    ["a repeated input", patched((c) => (c.functions[0]!.inputs = [{ name: "a", required: true }, { name: "a", required: false }])), 'inputs[1].name "a" is declared twice'],
    ["outputs that are not names", patched((c) => (c.functions[0]!.outputs = [1])), "outputs must be an array of field names"],
    ["writes not a boolean", patched((c) => (c.functions[0]!.writes = "yes")), "writes must be true or false"],
    ["local_network not an array", patched((c) => (c.functions[0]!.local_network = "192.168.1.20")), "local_network must be an array"],
  ];

  it.each(refused)("refuses %s with INPUT_INVALID", (_label, contract, message) => {
    const error = errorOf(() => validateContract(contract));
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect((error as Error).message).toContain(message);
  });
});

describe("contractFunctions()", () => {
  it("attaches each key's package and function", () => {
    const requests = contractFunctions(posContract());
    expect(requests.map((r) => r.key)).toEqual(["pos.receive", "pos.lookup", "health"]);
    expect(requests[0]).toEqual({
      key: "pos.receive",
      description: "Receive a supplier invoice in your POS",
      writes: true,
      package: posPackage(),
      function: "receive",
    });
    expect(requests[1]?.function).toBe("lookup");
    expect(requests[1]?.package).toBe(requests[0]?.package);
    expect(requests[2]).not.toHaveProperty("function");
    expect(requests[2]?.package).toEqual(healthPackage());
  });

  it("falls back to the package name for an empty description and keeps descriptions to 200 characters", () => {
    const requests = contractFunctions(
      patched((c) => (c.functions[1]!.description = "d".repeat(260))) as WritContract,
    );
    expect(requests[2]?.description).toBe("Arrivos POS health");
    expect(requests[1]?.description).toHaveLength(200);
    expect(requests[1]?.description.endsWith("…")).toBe(true);
  });

  it("refuses an invalid contract", () => {
    const error = errorOf(() => contractFunctions(patched((c) => (c.format = "x")) as WritContract));
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
  });
});

describe("createWritClient()", () => {
  it("builds one method per key, with dotted keys nested", () => {
    const { session } = recordingSession();
    const client = createWritClient<WritFunctions>(session, posContract());
    expect(typeof client.pos.receive).toBe("function");
    expect(typeof client.pos.lookup).toBe("function");
    expect(typeof client.health).toBe("function");
    expect(Object.keys(client).sort()).toEqual(["health", "pos"]);
    expect(Object.keys(client.pos).sort()).toEqual(["lookup", "receive"]);
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(client.pos)).toBe(true);
    // A namespace is never a thenable: `await client.pos` is the namespace itself.
    expect("then" in client.pos).toBe(false);
  });

  it("forwards to session.call with the full key, inputs and options", () => {
    const { session, calls, result } = recordingSession();
    const client = createWritClient<WritFunctions>(session, posContract());
    const controller = new AbortController();
    const call = client.pos.receive({ invoice_no: "F-1029" }, { timeoutMs: 30_000, signal: controller.signal });
    expect(call).toBe(result);
    expect(calls).toEqual([
      { key: "pos.receive", inputs: { invoice_no: "F-1029" }, options: { timeoutMs: 30_000, signal: controller.signal } },
    ]);
    client.pos.lookup();
    client.health();
    expect(calls.map((c) => c.key)).toEqual(["pos.receive", "pos.lookup", "health"]);
  });

  it("refuses a missing required input with INPUT_INVALID, before calling", () => {
    const { session, calls } = recordingSession();
    const client = createWritClient<WritFunctions>(session, posContract());
    const error = errorOf(() => {
      // @ts-expect-error invoice_no is required
      client.pos.receive({});
    });
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect((error as Error).message).toBe('pos.receive() needs "invoice_no".');
    expect(calls).toEqual([]);
  });

  it("refuses an undeclared input with INPUT_INVALID, before calling", () => {
    const { session, calls } = recordingSession();
    const client = createWritClient<WritFunctions>(session, posContract());
    const error = errorOf(() => {
      // @ts-expect-error store is not an input of pos.receive
      client.pos.receive({ invoice_no: "F-1", store: "Lyon" });
    });
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect((error as Error).message).toContain('has no input "store"; its inputs are "invoice_no"');
    expect((errorOf(() => client.health({ x: 1 } as never)) as Error).message).toContain("it takes no inputs");
    expect(calls).toEqual([]);
  });

  it("refuses inputs that are not a plain object", () => {
    const { session } = recordingSession();
    const client = createWritClient<WritFunctions>(session, posContract());
    expect(isWritError(errorOf(() => client.pos.lookup(["sku"] as never)), "INPUT_INVALID")).toBe(true);
  });

  it("ignores undefined optional inputs and accepts null for a required one", () => {
    const { session, calls } = recordingSession();
    const client = createWritClient<WritFunctions>(session, posContract());
    client.pos.lookup({ sku: undefined });
    expect(() => client.pos.receive({ invoice_no: null as never })).not.toThrow();
    expect(calls).toHaveLength(2);
  });

  it("calls through a real session to writ_call with the contract key", async () => {
    const { provider, session } = await connected();
    const client = createWritClient<WritFunctions>(session, posContract());
    const call = client.pos.receive({ invoice_no: "F-1029" });
    await call.callId;
    expect(provider.sent("writ_call")).toEqual([{ key: "pos.receive", inputs: { invoice_no: "F-1029" } }]);
    await call.cancel();
  });

  it("refuses a session that is not one, and an invalid contract", () => {
    expect(isWritError(errorOf(() => createWritClient({} as WritSession, posContract())), "BAD_REQUEST")).toBe(true);
    const { session } = recordingSession();
    const collision = patched((c) => (c.functions[2]!.key = "pos")) as WritContract;
    expect(isWritError(errorOf(() => createWritClient(session, collision)), "INPUT_INVALID")).toBe(true);
  });

  it("types methods from the generated WritFunctions interface", () => {
    const { session } = recordingSession();
    const client = createWritClient<WritFunctions>(session, posContract());
    expectTypeOf(client.pos.receive).parameter(0).toEqualTypeOf<{ invoice_no: string }>();
    expectTypeOf(client.pos.receive).returns.toEqualTypeOf<WritCall<{ received: boolean; lines: number }>>();
    expectTypeOf(client.pos.lookup).returns.toEqualTypeOf<WritCall<{ name: string; price: number }>>();
    expectTypeOf(client.health).returns.toEqualTypeOf<WritCall<{ ok: boolean }>>();

    // Without F every path is allowed; under noUncheckedIndexedAccess each step may be undefined.
    const untyped = createWritClient(session, posContract());
    expectTypeOf(untyped.pos!.receive!).returns.toEqualTypeOf<WritCall<unknown>>();
  });
});

// ---------------------------------------------------------------------------------------------
// Settings (CONTRACT.md §8, §10 `functions[].settings`)
// ---------------------------------------------------------------------------------------------

/** The settings contract with one change. */
function patchedSettings(mutate: (contract: { functions: Record<string, unknown>[]; packages: Record<string, unknown>[] }) => void): unknown {
  const contract = JSON.parse(JSON.stringify(settingsContract())) as {
    functions: Record<string, unknown>[];
    packages: Record<string, unknown>[];
  };
  mutate(contract);
  return contract;
}

describe("validateContract(): functions[].settings", () => {
  it("keeps each function's settings, through the file's text too", () => {
    const source = settingsContract();
    const contract = validateContract(JSON.stringify(source));
    expect(contract).toEqual(source);
    expect(contract.functions[0]?.settings).toEqual([
      { key: "pos_host", label: "Your POS address", kind: "lan_host" },
      { key: "store_no", label: "Store number", kind: "text" },
    ]);
    expect(Object.isFrozen(contract.functions[0]?.settings?.[0])).toBe(true);
    expect(validateContract(posContract()).functions[0]).not.toHaveProperty("settings");
  });

  it("keeps only key, label and kind, and accepts a subset of the package's settings", () => {
    const contract = validateContract(
      patchedSettings((c) => (c.functions[0]!.settings = [{ key: "store_no", label: "Store", kind: "text", example: "12" }])),
    );
    expect(contract.functions[0]?.settings).toEqual([{ key: "store_no", label: "Store", kind: "text" }]);
  });

  const refused: [string, unknown, string][] = [
    ["settings that are not an array", patchedSettings((c) => (c.functions[0]!.settings = { pos_host: "lan_host" })), "contract.functions[0].settings must be an array"],
    ["an entry that is not an object", patchedSettings((c) => (c.functions[0]!.settings = ["pos_host"])), "settings[0] must be an object"],
    ["a bad key", patchedSettings((c) => (c.functions[0]!.settings = [{ key: "pos-host", label: "POS", kind: "text" }])), "settings[0].key"],
    ["a setting the package lacks", patchedSettings((c) => (c.functions[0]!.settings = [{ key: "pos_ip", label: "POS", kind: "text" }])), 'package "arrivos.pos-any" declares no such setting'],
    ["a setting listed twice", patchedSettings((c) => (c.functions[1]!.settings = [{ key: "store_no", label: "S", kind: "text" }, { key: "store_no", label: "S", kind: "text" }])), 'settings[1].key "store_no" is listed twice'],
    ["no label", patchedSettings((c) => (c.functions[0]!.settings = [{ key: "store_no", kind: "text" }])), "settings[0].label must be 1 to 80 characters"],
    ["an unknown kind", patchedSettings((c) => (c.functions[0]!.settings = [{ key: "store_no", label: "S", kind: "number" }])), 'settings[0].kind must be "text" or "lan_host"'],
    ["no kind", patchedSettings((c) => (c.functions[0]!.settings = [{ key: "store_no", label: "S" }])), 'settings[0].kind must be "text" or "lan_host"'],
    ["a kind the package does not declare", patchedSettings((c) => (c.functions[0]!.settings = [{ key: "pos_host", label: "POS", kind: "text" }])), 'declares "pos_host" as "lan_host"'],
    ["a package URL whose host is an input", patchedSettings((c) => (c.packages[0]!.settings = [{ key: "store_no", label: "S" }])), "contract.packages[0].steps[0].config.url takes its address from {{pos_host}}"],
  ];

  it.each(refused)("refuses %s with INPUT_INVALID", (_label, contract, message) => {
    const error = errorOf(() => validateContract(contract));
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect((error as Error).message).toContain(message);
  });
});

describe("contractFunctions(): suggested settings", () => {
  it("attaches none without suggestions", () => {
    expect(contractFunctions(settingsContract()).map((r) => r.settings)).toEqual([undefined, undefined]);
  });

  it("attaches a suggestion to every key of the package, as a fresh copy", () => {
    const requests = contractFunctions(settingsContract(), { settings: { "pos.receive": { pos_host: " 192.168.1.20:8080 " } } });
    expect(requests.map((r) => r.settings)).toEqual([{ pos_host: "192.168.1.20:8080" }, { pos_host: "192.168.1.20:8080" }]);
    expect(requests[0]?.settings).not.toBe(requests[1]?.settings);
    expect(requests[0]?.package).toEqual(posSettingsPackage());
  });

  it("merges suggestions given under several keys of one package", () => {
    const requests = contractFunctions(settingsContract(), {
      settings: { "pos.receive": { pos_host: "pos.local" }, "pos.lookup": { pos_host: "pos.local", store_no: "12" } },
    });
    expect(requests[1]?.settings).toEqual({ pos_host: "pos.local", store_no: "12" });
  });

  it("refuses a key the contract does not have with BAD_REQUEST", () => {
    const error = errorOf(() => contractFunctions(settingsContract(), { settings: { "pos.void": { pos_host: "pos.local" } } }));
    expect(isWritError(error, "BAD_REQUEST")).toBe(true);
    expect((error as Error).message).toContain('"pos.void", which is not a function of the contract');
    expect(isWritError(errorOf(() => contractFunctions(settingsContract(), { settings: "pos.local" as never })), "BAD_REQUEST")).toBe(true);
  });

  it("refuses an invalid value, an undeclared setting and two values for one setting with INPUT_INVALID", () => {
    const tooLong = errorOf(() => contractFunctions(settingsContract(), { settings: { "pos.receive": { store_no: "1".repeat(201) } } }));
    expect(isWritError(tooLong, "INPUT_INVALID")).toBe(true);
    expect((tooLong as Error).message).toContain('settings["pos.receive"].store_no is 201 characters');

    const undeclared = errorOf(() => contractFunctions(settingsContract(), { settings: { "pos.receive": { pos_ip: "x" } } }));
    expect(isWritError(undeclared, "INPUT_INVALID")).toBe(true);

    const conflict = errorOf(() =>
      contractFunctions(settingsContract(), { settings: { "pos.receive": { pos_host: "a.local" }, "pos.lookup": { pos_host: "b.local" } } }),
    );
    expect(isWritError(conflict, "INPUT_INVALID")).toBe(true);
    expect((conflict as Error).message).toContain('settings["pos.lookup"].pos_host is "b.local", but settings["pos.receive"].pos_host is "a.local"');
  });

  it("leaves the typed client alone: a setting is never a call input", () => {
    const { session, calls } = recordingSession();
    const client = createWritClient(session, settingsContract());
    const error = errorOf(() => client.pos!.receive!({ invoice_no: "F-1", pos_host: "pos.local" }));
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect((error as Error).message).toContain('has no input "pos_host"');
    expect(calls).toEqual([]);
  });
});
