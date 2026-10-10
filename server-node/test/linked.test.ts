/**
 * Linked workflows (CONTRACT.md §11): linked contract entries, and run tokens minted against the
 * golden file shared with Python (`sdks/fixtures/run_token_golden.json`).
 */

import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RUN_TOKEN_TTL_SECONDS,
  MAX_RUN_TOKEN_TTL_SECONDS,
  isWritBridgeError,
  mintRunToken,
  validateContract,
  type WritContract,
} from "../src/index.js";
import { contract, runTokenGolden, testBridge } from "./fixtures.js";

const PUBLICATION = "pub_0123456789abcdefABCDEF";

/** A linked entry for `app.orders`, as Writ Cloud writes it in a linked contract. */
function linkedOrders(): Record<string, unknown> {
  return {
    format: "writ.linked/v1",
    id: "app.orders",
    name: "Orders",
    publication: { id: PUBLICATION },
    key: "wpk_0123456789abcdef0123456789ABCDEF",
    access: "token",
    manifest: {
      format: "writ.manifest/v1",
      publication: PUBLICATION,
      name: "Orders",
      description: null,
      publisher: { name: "Arrivos" },
      functions: [{ name: "list_orders", inputs: [{ name: "status", required: false }], outputs: ["orders"], writes: false }],
      destinations: ["portal.example.com"],
      lan_hosts: [],
      lan_reason: null,
      credentials: [],
      settings: [],
      browser: false,
      scripts: false,
    },
    manifest_hash: "3f".repeat(32),
  };
}

function linkedContract(): WritContract {
  const doc = contract();
  doc.packages = doc.packages.map((pkg) => (pkg.id === "app.orders" ? (linkedOrders() as WritContract["packages"][number]) : pkg));
  return doc;
}

/**
 * The run token, computed the way the Python twin and `run_token_golden_gen.py` do, written out
 * independently of `mintRunToken`: the header and claims as literal compact JSON in their fixed
 * key order, base64url without padding, HMAC-SHA256 keyed with the secret key's UTF-8 bytes.
 */
function expectedToken(secret: string, claimsJson: string): string {
  const part = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
  const signingInput = `${part('{"alg":"HS256","typ":"JWT"}')}.${part(claimsJson)}`;
  return `${signingInput}.${createHmac("sha256", Buffer.from(secret, "utf8")).update(signingInput, "ascii").digest("base64url")}`;
}

/** Python's `json.dumps(claims, separators=(",", ":"), ensure_ascii=False)` for these claims. */
function claimsJson(pub: string, iat: number, exp: number, sub?: string): string {
  const head = `{"pub":${JSON.stringify(pub)},"iat":${iat},"exp":${exp}`;
  return sub === undefined ? `${head}}` : `${head},"sub":${JSON.stringify(sub)}}`;
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString("utf8")) as Record<string, unknown>;
}

function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("linked contracts", () => {
  it("keeps a linked package entry as given, next to bundled ones", () => {
    const clean = validateContract(linkedContract());
    expect(clean.packages.find((pkg) => pkg.id === "app.orders")).toEqual(linkedOrders());
    expect(clean.functions.find((fn) => fn.key === "orders.list")?.cloud).toEqual({ workflow_id: 12, function: "list_orders" });
  });

  it("routes a linked function by its mode and cloud mapping, as a bundled one", () => {
    const bridge = testBridge({ contract: linkedContract() });
    expect(bridge.modeOf("orders.list")).toBe("recommended");
    expect(bridge.modeOf("reports.export")).toBe("cloud");
  });
});

describe("mintRunToken(): the golden file", () => {
  const golden = runTokenGolden();

  it("reproduces the token with a sub, byte for byte", () => {
    const token = mintRunToken(golden.secret, {
      publication: golden.publication,
      sub: golden.with_sub.sub as string,
      ttlSeconds: golden.ttl_seconds,
      issuedAt: golden.iat,
    });
    expect(token).toBe(golden.with_sub.token);
  });

  it("reproduces the token without a sub", () => {
    const token = mintRunToken(golden.secret, { publication: golden.publication, ttlSeconds: golden.ttl_seconds, issuedAt: golden.iat });
    expect(token).toBe(golden.without_sub.token);
  });

  it("matches the file's own parts: header, claims in key order, signing input", () => {
    for (const vector of [golden.with_sub, golden.without_sub]) {
      expect(vector.header_json).toBe('{"alg":"HS256","typ":"JWT"}');
      const sub = vector.sub ?? undefined;
      expect(vector.payload_json).toBe(claimsJson(golden.publication, golden.iat, golden.iat + golden.ttl_seconds, sub));
      expect(vector.exp).toBe(golden.iat + golden.ttl_seconds);
      expect(vector.token.startsWith(`${vector.signing_input}.`)).toBe(true);
      expect(expectedToken(golden.secret, vector.payload_json)).toBe(vector.token);
      expect(Object.keys(claimsOf(vector.token))).toEqual(sub === undefined ? ["pub", "iat", "exp"] : ["pub", "iat", "exp", "sub"]);
    }
  });

  it("agrees with the Python algorithm on other inputs: non-ASCII sub, the longest ttl, an integer sub", () => {
    const cases: { sub?: string | number; ttl: number; text?: string }[] = [
      { sub: "Zoë 東京", ttl: 600 },
      { sub: 'quote " and \\ backslash', ttl: MAX_RUN_TOKEN_TTL_SECONDS },
      { sub: 42, ttl: 1, text: "42" },
      { ttl: 3_599 },
    ];
    for (const { sub, ttl, text } of cases) {
      const token = mintRunToken(golden.secret, { publication: PUBLICATION, sub, ttlSeconds: ttl, issuedAt: 1_791_550_000 });
      const subText = text ?? (typeof sub === "string" ? sub : undefined);
      expect(token).toBe(expectedToken(golden.secret, claimsJson(PUBLICATION, 1_791_550_000, 1_791_550_000 + ttl, subText)));
    }
  });
});

describe("mintRunToken(): defaults and refusals", () => {
  const SECRET = "wsk_0123456789abcdefghijABCDEFGHIJ0123456789";

  it("issues at the current second, for 600 seconds by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_791_550_000_400));
    const claims = claimsOf(mintRunToken(SECRET, { publication: PUBLICATION, sub: "u42" }));
    expect(claims).toEqual({ pub: PUBLICATION, iat: 1_791_550_000, exp: 1_791_550_000 + DEFAULT_RUN_TOKEN_TTL_SECONDS, sub: "u42" });
  });

  it("refuses a secret that is not a secret key with CONFIG_INVALID, never repeating it", () => {
    for (const secret of ["wpk_0123456789abcdef0123456789ABCDEF", "0123456789abcdefghijABCDEFGHIJ0123456789", "", `${SECRET}\n`, "wsk_ x"]) {
      const error = errorOf(() => mintRunToken(secret, { publication: PUBLICATION }));
      expect(isWritBridgeError(error, "CONFIG_INVALID"), JSON.stringify(secret)).toBe(true);
      if (secret !== "") expect((error as Error).message).not.toContain(secret.trim());
    }
    expect(isWritBridgeError(errorOf(() => mintRunToken(undefined as never, { publication: PUBLICATION })), "CONFIG_INVALID")).toBe(true);
  });

  it("refuses a ttl over 3600 seconds, or not a whole positive number, with BAD_REQUEST", () => {
    for (const ttlSeconds of [MAX_RUN_TOKEN_TTL_SECONDS + 1, 0, -5, 1.5, Number.NaN]) {
      expect(isWritBridgeError(errorOf(() => mintRunToken(SECRET, { publication: PUBLICATION, ttlSeconds })), "BAD_REQUEST"), String(ttlSeconds)).toBe(
        true,
      );
    }
    expect(() => mintRunToken(SECRET, { publication: PUBLICATION, ttlSeconds: MAX_RUN_TOKEN_TTL_SECONDS })).not.toThrow();
    expect(isWritBridgeError(errorOf(() => mintRunToken(SECRET, { publication: PUBLICATION, issuedAt: 1.5 })), "BAD_REQUEST")).toBe(true);
    expect(isWritBridgeError(errorOf(() => mintRunToken(SECRET, null as never)), "BAD_REQUEST")).toBe(true);
  });

  it("refuses a publication or sub that cannot be one with INPUT_INVALID", () => {
    for (const publication of ["pub_short", "PUB_0123456789abcdefABCDEF", "pub_0123456789abcdef-BCDEF", 42]) {
      expect(isWritBridgeError(errorOf(() => mintRunToken(SECRET, { publication: publication as string })), "INPUT_INVALID")).toBe(true);
    }
    for (const sub of ["", "tab\there", "x".repeat(257), "\ud800 lone", 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(isWritBridgeError(errorOf(() => mintRunToken(SECRET, { publication: PUBLICATION, sub: sub as string })), "INPUT_INVALID"), String(sub)).toBe(
        true,
      );
    }
  });
});
