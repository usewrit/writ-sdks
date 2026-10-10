/** Packages and contracts shared by the package, contract and banner tests. */

import type { WritContract, WritLinkedAccess, WritLinkedPackage, WritManifest, WritPackage } from "../src/index.js";

/** The README example: receive a supplier invoice in a POS on the store network. */
export function posReceivePackage(): WritPackage {
  return {
    format: "writ.workflow/v1",
    id: "arrivos.pos-receive",
    version: "1.2.0",
    name: "Arrivos POS receive",
    description: "Marks a supplier invoice as received in the POS on your store network.",
    inputs: { invoice_no: { description: "Supplier invoice number", required: true } },
    credentials: [{ key: "pos_password", label: "POS password", secret: true, required: true }],
    local_network: { hosts: ["192.168.1.20:8080"], reason: "Your POS server on the store network" },
    steps: [
      {
        type: "api_call",
        config: {
          method: "POST",
          url: "http://192.168.1.20:8080/api/receivings",
          headers: { "X-Pos-Password": "{{secret:pos_password}}" },
          body_json: { invoice: "{{invoice_no}}" },
          side_effect: "write",
        },
      },
    ],
  };
}

/** One package, two functions (stamped steps): a key must say which one it calls. */
export function posPackage(): WritPackage {
  return {
    format: "writ.workflow/v1",
    id: "arrivos.pos",
    version: "2.0.0",
    name: "Arrivos POS",
    credentials: [{ key: "pos_password", label: "POS password" }],
    local_network: { hosts: ["192.168.1.20:8080"], reason: "Your POS server" },
    steps: [
      {
        type: "api_call",
        config: {
          function_name: "receive",
          method: "POST",
          url: "http://192.168.1.20:8080/api/receivings",
          headers: { "X-Pos-Password": "{{secret:pos_password}}" },
          body_json: { invoice: "{{invoice_no}}" },
        },
      },
      {
        type: "api_call",
        config: {
          function_name: "lookup",
          method: "GET",
          url: "http://192.168.1.20:8080/api/products?sku={{sku}}",
          headers: { "X-Pos-Password": "{{secret:pos_password}}" },
        },
      },
    ],
  };
}

/** A package whose whole workflow is its one callable. */
export function healthPackage(): WritPackage {
  return {
    format: "writ.workflow/v1",
    id: "arrivos.health",
    name: "Arrivos POS health",
    steps: [{ type: "api_call", config: { method: "GET", url: "http://192.168.1.20:8080/health" } }],
    local_network: { hosts: ["192.168.1.20:8080"] },
  };
}

/** A contract with two namespaced keys on one package and one top-level key on another. */
export function posContract(): WritContract {
  return {
    format: "writ.contract/v1",
    generated_at: "2026-10-09T12:00:00Z",
    generator: "writ-desktop/1.0.8",
    publisher: { name: "Arrivos" },
    functions: [
      {
        key: "pos.receive",
        description: "Receive a supplier invoice in your POS",
        package: "arrivos.pos",
        function: "receive",
        inputs: [{ name: "invoice_no", required: true, description: "Supplier invoice number" }],
        outputs: ["received", "lines"],
        writes: true,
        local_network: ["192.168.1.20:8080"],
      },
      {
        key: "pos.lookup",
        description: "Look up a product in your POS",
        package: "arrivos.pos",
        function: "lookup",
        inputs: [{ name: "sku", required: false }],
        outputs: ["name", "price"],
        writes: false,
        local_network: ["192.168.1.20:8080"],
      },
      {
        key: "health",
        description: "",
        package: "arrivos.health",
        function: null,
        inputs: [],
        outputs: ["ok"],
        writes: false,
        local_network: ["192.168.1.20:8080"],
      },
    ],
    packages: [posPackage(), healthPackage()],
  };
}

/**
 * A POS package for any store: each user gives their POS address once (`pos_host`, a setting),
 * and the recipe reaches it as `http://{{pos_host}}/...` (CONTRACT.md §8 "Settings").
 */
export function posSettingsPackage(): WritPackage {
  return {
    format: "writ.workflow/v1",
    id: "arrivos.pos-any",
    version: "1.0.0",
    name: "Arrivos POS (any store)",
    inputs: { invoice_no: { description: "Supplier invoice number" }, sku: { required: false } },
    credentials: [{ key: "pos_password", label: "POS password" }],
    settings: [
      {
        key: "pos_host",
        label: "Your POS address",
        description: "On the POS: Settings, then Network",
        kind: "lan_host",
        example: "192.168.1.20:8080",
      },
      { key: "store_no", label: "Store number", required: false },
    ],
    steps: [
      {
        type: "api_call",
        config: {
          function_name: "receive",
          method: "POST",
          url: "http://{{pos_host}}/api/receivings",
          headers: { "X-Pos-Password": "{{secret:pos_password}}" },
          body_json: { invoice: "{{invoice_no}}", store: "{{store_no}}" },
        },
      },
      {
        type: "api_call",
        config: {
          function_name: "lookup",
          method: "GET",
          url: "http://{{ input.pos_host }}/api/products?sku={{sku}}",
          headers: { "X-Pos-Password": "{{secret:pos_password}}" },
        },
      },
    ],
  };
}

/** A contract over {@link posSettingsPackage}: two keys, each listing the package's settings for the site's form. */
export function settingsContract(): WritContract {
  const settings = [
    { key: "pos_host", label: "Your POS address", kind: "lan_host" as const },
    { key: "store_no", label: "Store number", kind: "text" as const },
  ];
  return {
    format: "writ.contract/v1",
    generated_at: "2026-10-09T12:00:00Z",
    generator: "writ-desktop/1.0.8",
    publisher: { name: "Arrivos" },
    functions: [
      {
        key: "pos.receive",
        description: "Receive a supplier invoice in your POS",
        package: "arrivos.pos-any",
        function: "receive",
        inputs: [{ name: "invoice_no", required: true }],
        outputs: ["received"],
        writes: true,
        local_network: [],
        settings: settings.map((setting) => ({ ...setting })),
      },
      {
        key: "pos.lookup",
        description: "Look up a product in your POS",
        package: "arrivos.pos-any",
        function: "lookup",
        inputs: [{ name: "sku", required: false }],
        outputs: ["name", "price"],
        writes: false,
        local_network: [],
        settings: settings.map((setting) => ({ ...setting })),
      },
    ],
    packages: [posSettingsPackage()],
  };
}

/** A supplier portal on the public web: two functions Writ Cloud can run as well as the visitor. */
export function portalPackage(): WritPackage {
  return {
    format: "writ.workflow/v1",
    id: "arrivos.portal",
    version: "1.0.0",
    name: "Arrivos supplier portal",
    credentials: [{ key: "portal_password", label: "Portal password" }],
    steps: [
      {
        type: "api_call",
        config: {
          function_name: "verify_login",
          method: "POST",
          url: "https://portal.example.com/api/login",
          headers: { "X-Portal-Password": "{{secret:portal_password}}" },
          body_json: { company: "{{company}}", username: "{{username}}" },
        },
      },
      {
        type: "api_call",
        config: {
          function_name: "list_orders",
          method: "GET",
          url: "https://portal.example.com/api/orders",
          headers: { "X-Portal-Password": "{{secret:portal_password}}" },
        },
      },
    ],
  };
}

/**
 * A Writ Bridge contract (CONTRACT.md §12): two portal functions with their Writ Cloud mapping,
 * and, with `withPos`, the POS function that reaches the store network (always `required`).
 */
export function bridgeContract(options: { withPos?: boolean } = {}): WritContract {
  const contract: WritContract = {
    format: "writ.contract/v1",
    generated_at: "2026-10-09T12:00:00Z",
    generator: "writ-cloud",
    publisher: { name: "Arrivos" },
    functions: [
      {
        key: "auth.verify_login",
        description: "Check your supplier portal login",
        package: "arrivos.portal",
        function: "verify_login",
        inputs: [
          { name: "company", required: true },
          { name: "username", required: true },
        ],
        outputs: ["ok"],
        writes: false,
        local_network: [],
        cloud: { workflow_id: 812, function: "verify_login" },
      },
      {
        key: "orders.list",
        description: "List your open orders",
        package: "arrivos.portal",
        function: "list_orders",
        inputs: [],
        outputs: ["orders"],
        writes: false,
        local_network: [],
        cloud: { workflow_id: 812, function: "list_orders" },
      },
    ],
    packages: [portalPackage()],
  };
  if (options.withPos === true) {
    const pos = posContract();
    contract.functions.push(pos.functions[0] as WritContract["functions"][number]);
    contract.packages.push(posPackage());
  }
  return contract;
}

// ---------------------------------------------------------------------------------------------
// Linked workflows (CONTRACT.md §11)
// ---------------------------------------------------------------------------------------------

/** The publication of the linked fixtures: `pub_` + 22 letters or digits. */
export const PUBLICATION_ID = "pub_0123456789abcdefABCDEF";

/** Its publishable key: `wpk_` + 32 letters or digits. */
export const PUBLISHABLE_KEY = "wpk_0123456789abcdef0123456789ABCDEF";

/** The manifest Writ Cloud computes for the supplier portal (the page never hashes it). */
export function portalManifest(): WritManifest {
  return {
    format: "writ.manifest/v1",
    publication: PUBLICATION_ID,
    name: "Arrivos supplier portal",
    description: null,
    publisher: { name: "Arrivos" },
    functions: [
      {
        name: "verify_login",
        inputs: [
          { name: "company", required: true },
          { name: "username", required: true },
        ],
        outputs: ["ok"],
        writes: false,
      },
      { name: "list_orders", inputs: [], outputs: ["orders"], writes: false },
    ],
    destinations: ["portal.example.com"],
    lan_hosts: [],
    lan_reason: null,
    credentials: [{ key: "portal_password", label: "Portal password", secret: true, required: true }],
    settings: [],
    browser: false,
    scripts: false,
  };
}

/** The supplier portal as a linked workflow: its recipe stays in the developer's Writ Cloud. */
export function linkedPortalPackage(access: WritLinkedAccess = "public"): WritLinkedPackage {
  return {
    format: "writ.linked/v1",
    id: "arrivos.portal",
    name: "Arrivos supplier portal",
    publication: { id: PUBLICATION_ID },
    key: PUBLISHABLE_KEY,
    access,
    publisher: { name: "Arrivos" },
    manifest: portalManifest(),
    manifest_hash: "3f".repeat(32),
  };
}

/**
 * The linked contract Writ Cloud hands out for {@link bridgeContract}'s functions: the same keys,
 * each with its `cloud` mapping, over the linked package instead of the bundled one.
 */
export function linkedContract(access: WritLinkedAccess = "public"): WritContract {
  const contract = bridgeContract();
  contract.packages = [linkedPortalPackage(access)];
  return contract;
}

/** A JWT shaped like a run token (unsigned: the page never verifies one). Claims as UTF-8 JSON. */
export function runTokenWith(claims: Record<string, unknown>): string {
  const part = (value: unknown): string =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.c2lnbmF0dXJl`;
}
