/** createWritBridge(): configuration refusals, the nested proxy, input validation. */

import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createWritBridge,
  isWritBridgeError,
  validateContract,
  type WritBridgeErrorCode,
  type WritCallResult,
  type WritContract,
} from "../src/index.js";
import { SECRET, contract, fakePage, rejectionOf, testBridge, type WritFunctions } from "./fixtures.js";

function refusal(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

/** The fixture contract as loose JSON, to break on purpose. */
type LooseContract = { functions: Record<string, unknown>[]; [field: string]: unknown };

/** The fixture contract with one change. */
function patched(mutate: (c: LooseContract) => void): WritContract {
  const c = JSON.parse(JSON.stringify(contract())) as LooseContract;
  mutate(c);
  return c as unknown as WritContract;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createWritBridge() refuses at creation", () => {
  const cases: [string, () => unknown, WritBridgeErrorCode][] = [
    ["an invalid contract", () => testBridge({ contract: { format: "writ.contract/v2" } }), "INPUT_INVALID"],
    [
      "a recommended function without a cloud mapping",
      () => testBridge({ contract: patched((c) => delete (c.functions[2] as Record<string, unknown>).cloud) }),
      "CLOUD_NOT_CONFIGURED",
    ],
    ["a cloud function without an API key", () => testBridge({ apiKey: "" }), "CLOUD_NOT_CONFIGURED"],
    [
      "a bridge-wide recommended mode over a function without a mapping",
      () => testBridge({ mode: "recommended" }),
      "CLOUD_NOT_CONFIGURED",
    ],
    [
      "a local-network function explicitly recommended",
      () => testBridge({ functionModes: { "pos.receive": "recommended" } }),
      "CONFIG_INVALID",
    ],
    [
      "a local-network function set to cloud in the contract",
      () => testBridge({ contract: patched((c) => Object.assign(c.functions[1] as object, { mode: "cloud", cloud: { workflow_id: 3, function: null } })) }),
      "CONFIG_INVALID",
    ],
    ["a secret shorter than 32 bytes", () => testBridge({ secret: "too-short" }), "CONFIG_INVALID"],
    ["an unknown mode", () => testBridge({ mode: "sometimes" as never }), "CONFIG_INVALID"],
    ["functionModes naming an unknown key", () => testBridge({ functionModes: { "nope.x": "cloud" } }), "CONFIG_INVALID"],
    ["pollSeconds out of range", () => testBridge({ pollSeconds: 0 }), "CONFIG_INVALID"],
    ["a plain-http cloudBase", () => testBridge({ cloudBase: "http://api.usewrit.app" }), "CONFIG_INVALID"],
    [
      "a key whose first segment is a bridge member",
      () => testBridge({ contract: patched((c) => ((c.functions[0] as Record<string, unknown>).key = "user.verify_login")) }),
      "CONFIG_INVALID",
    ],
    [
      "a key both a function and a namespace",
      () => testBridge({ contract: patched((c) => ((c.functions[0] as Record<string, unknown>).key = "orders")) }),
      "INPUT_INVALID",
    ],
    [
      "a mapping without a workflow id",
      () => testBridge({ contract: patched((c) => ((c.functions[2] as Record<string, unknown>).cloud = { function: "x" })) }),
      "INPUT_INVALID",
    ],
  ];

  for (const [name, build, code] of cases) {
    it(name, () => {
      const error = refusal(build);
      expect(isWritBridgeError(error, code), String(error)).toBe(true);
    });
  }

  it("no secret while a function can run on a user's computer", () => {
    vi.stubEnv("WRIT_BRIDGE_SECRET", "");
    const error = refusal(() => createWritBridge({ contract: contract(), apiKey: "wrk_x", cloudBase: "https://cloud.test" }));
    expect(isWritBridgeError(error, "CONFIG_INVALID")).toBe(true);
    expect((error as Error).message).toContain("WRIT_BRIDGE_SECRET");
  });

  it("reads WRIT_BRIDGE_SECRET and WRIT_API_KEY from the environment", () => {
    vi.stubEnv("WRIT_BRIDGE_SECRET", SECRET);
    vi.stubEnv("WRIT_API_KEY", "wrk_from_env");
    const bridge = createWritBridge({ contract: contract() });
    expect(bridge.modeOf("orders.list")).toBe("recommended");
    expect(typeof bridge.userToken("u1")).toBe("string");
  });

  it("a required-only bridge needs no API key at all", () => {
    vi.stubEnv("WRIT_API_KEY", "");
    const requiredOnly = patched((c) => {
      c.functions = c.functions.filter((fn) => fn.key === "auth.verify_login" || fn.key === "pos.receive");
    });
    const bridge = createWritBridge({ contract: requiredOnly, secret: SECRET });
    expect(bridge.modeOf("auth.verify_login")).toBe("required");
  });
});

describe("modes", () => {
  it("resolve config over contract over bridge, local network always required", () => {
    const bridge = testBridge({ mode: "required", functionModes: { "reports.export": "recommended" } });
    expect(bridge.modeOf("auth.verify_login")).toBe("required");
    expect(bridge.modeOf("pos.receive")).toBe("required");
    expect(bridge.modeOf("orders.list")).toBe("recommended");
    expect(bridge.modeOf("reports.export")).toBe("recommended");
    expect(() => bridge.modeOf("nope")).toThrow();
  });
});

describe("the nested proxy", () => {
  it("nests dotted keys, frozen, on the bridge and per user", () => {
    const bridge = testBridge();
    const user = bridge.user("u1");
    expect(typeof user.auth.verify_login).toBe("function");
    expect(typeof user.pos.receive).toBe("function");
    expect(typeof bridge.orders.list).toBe("function");
    expect(user.auth.verify_login.name).toBe("auth.verify_login");
    expect(Object.isFrozen(user)).toBe(true);
    expect(Object.isFrozen(user.auth)).toBe(true);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.isFrozen(bridge.orders)).toBe(true);
  });

  it("accepts numeric user ids and refuses empty ones", () => {
    const bridge = testBridge();
    expect(typeof bridge.user(42).auth.verify_login).toBe("function");
    expect(isWritBridgeError(refusal(() => bridge.user("")), "INPUT_INVALID")).toBe(true);
    expect(isWritBridgeError(refusal(() => bridge.userToken("a\nb")), "INPUT_INVALID")).toBe(true);
  });

  it("is typed from the generated WritFunctions", () => {
    const bridge = testBridge();
    expectTypeOf(bridge.user("u1").orders.list).returns.resolves.toEqualTypeOf<WritCallResult<{ orders: number }>>();
    expectTypeOf(bridge.reports.export).parameter(0).toEqualTypeOf<{ month: string }>();
  });
});

describe("input validation, before anything is routed", () => {
  const offline = { company: "acme" };

  it.each<[string, unknown]>([
    ["a missing required input", offline],
    ["an undeclared input", { company: "acme", username: "zoe", password: "hunter2" }],
    ["inputs that are not an object", ["acme", "zoe"]],
    ["a value JSON cannot carry", { company: "acme", username: () => "zoe" }],
  ])("refuses %s with INPUT_INVALID", async (_name, inputs) => {
    // The user never connected: a routed call would fail WRIT_REQUIRED instead.
    const call = (testBridge().user("u1").auth.verify_login as unknown as (inputs: unknown) => Promise<unknown>)(inputs);
    expect(isWritBridgeError(await rejectionOf(call), "INPUT_INVALID")).toBe(true);
  });

  it("refuses bad inputs before calling Writ Cloud", async () => {
    let calls = 0;
    const bridge = testBridge({
      fetch: (async () => {
        calls += 1;
        throw new Error("no");
      }) as unknown as typeof fetch,
    });
    const call = (bridge.reports.export as unknown as (inputs: unknown) => Promise<unknown>)({});
    expect(isWritBridgeError(await rejectionOf(call), "INPUT_INVALID")).toBe(true);
    expect(calls).toBe(0);
  });

  it("refuses bad call options with BAD_REQUEST", async () => {
    const bridge = testBridge();
    const inputs = { company: "a", username: "b" };
    expect(isWritBridgeError(await rejectionOf(bridge.user("u1").auth.verify_login(inputs, { timeoutMs: 10 })), "BAD_REQUEST")).toBe(true);
    expect(isWritBridgeError(await rejectionOf(bridge.user("u1").auth.verify_login(inputs, { waitForUserMs: -1 })), "BAD_REQUEST")).toBe(true);
  });

  it("drops undefined inputs as JSON would, and sends the rest", async () => {
    const bridge = testBridge();
    const page = fakePage(bridge, bridge.userToken("u1"));
    await page.hello({ ready: true, granted: ["auth.verify_login"] });
    const call = bridge.user("u1").auth.verify_login({ company: "acme", username: "zoe", ...({ note: undefined } as object) } as WritFunctions["auth.verify_login"]["inputs"]);
    const command = await page.nextCommand();
    expect(command.inputs).toEqual({ company: "acme", username: "zoe" });
    await page.answer(command, { ok: true, user: "zoe" });
    await call;
  });
});

describe("validateContract()", () => {
  it("returns a deep-frozen copy with modes and mappings", () => {
    const source = contract();
    const clean = validateContract(JSON.stringify(source));
    expect(clean).toEqual(source);
    expect(Object.isFrozen(clean.functions[2]?.cloud)).toBe(true);
  });

  it("keeps a function's package settings (CONTRACT.md §10), and refuses a malformed one", () => {
    const settings = [
      { key: "pos_host", label: "Your POS address", kind: "lan_host" },
      { key: "store_no", label: "Store number", kind: "text" },
    ];
    const clean = validateContract(patched((c) => ((c.functions[1] as Record<string, unknown>).settings = settings)));
    expect(clean.functions[1]?.settings).toEqual(settings);
    expect(Object.isFrozen(clean.functions[1]?.settings?.[0])).toBe(true);
    expect(clean.functions[0]).not.toHaveProperty("settings");

    for (const broken of [
      { pos_host: "lan_host" },
      [{ key: "pos-host", label: "POS", kind: "text" }],
      [{ key: "pos_host", label: "", kind: "text" }],
      [{ key: "pos_host", label: "POS", kind: "url" }],
      [settings[0], settings[0]],
    ]) {
      const error = refusal(() => validateContract(patched((c) => ((c.functions[1] as Record<string, unknown>).settings = broken))));
      expect(isWritBridgeError(error, "INPUT_INVALID")).toBe(true);
    }
  });

  it("accepts a numeric-string workflow id", () => {
    const clean = validateContract(patched((c) => ((c.functions[2] as Record<string, unknown>).cloud = { workflow_id: "12", function: "list_orders" })));
    expect(clean.functions[2]?.cloud).toEqual({ workflow_id: 12, function: "list_orders" });
  });

  it.each<[string, (c: LooseContract) => void]>([
    ["a missing local_network", (c) => delete (c.functions[0] as Record<string, unknown>).local_network],
    ["an unknown package", (c) => ((c.functions[0] as Record<string, unknown>).package = "nope")],
    ["a duplicate key", (c) => ((c.functions[1] as Record<string, unknown>).key = "auth.verify_login")],
    ["a reserved segment", (c) => ((c.functions[0] as Record<string, unknown>).key = "auth.then")],
    ["a bad mode", (c) => ((c.functions[0] as Record<string, unknown>).mode = "always")],
    ["duplicate inputs", (c) => ((c.functions[0] as Record<string, unknown>).inputs = [{ name: "a", required: true }, { name: "a", required: false }])],
  ])("refuses %s", (_name, mutate) => {
    expect(isWritBridgeError(refusal(() => validateContract(patched(mutate))), "INPUT_INVALID")).toBe(true);
  });
});
