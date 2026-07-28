/**
 * Cloud tier tests (CloudApi): the Firecrawl-style credential fallback + routing —
 *   • keyless (no key)  → /v1/keyless/*  with an X-Writ-Client-Id header
 *   • metered (api key) → /api/crawl/*   with an Authorization: Bearer header
 *   • crawl WITHOUT a key throws WritApiKeyRequiredError before any network call
 *   • 429 maps to WritRateLimitedError (with resetAt)
 *
 * Uses CloudApi's injectable `fetch` — no daemon, no network.
 */
import { describe, expect, it } from "vitest";
import { CloudApi, WritApiKeyRequiredError, WritRateLimitedError } from "../src/index.js";

type Captured = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A fake fetch that records the request and returns a JSON Response with `status`. */
function fakeFetch(status: number, payload: unknown): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

describe("CloudApi keyless tier", () => {
  it("scrapes via /v1/keyless with a client-id header and no bearer", async () => {
    const { fetch, calls } = fakeFetch(200, {
      verb: "scrape",
      url: "https://x.test",
      title: "Hi",
      markdown: "# Hi",
      counts: { chars: 4 },
      quota: { tier: "keyless", requests_remaining: 9, pages_remaining: 19, reset_at: "2026-07-17T00:00:00Z" },
    });
    const cloud = new CloudApi({ fetch, clientId: "device-123" });
    expect(cloud.tier).toBe("keyless");

    const res = await cloud.scrape("https://x.test");
    expect(calls[0].url).toBe("https://api.usewrit.app/v1/keyless/scrape");
    expect(calls[0].headers["x-writ-client-id"]).toBe("device-123");
    expect(calls[0].headers["authorization"]).toBeUndefined();
    expect(res.tier).toBe("keyless");
    expect(res.markdown).toBe("# Hi");
    expect(res.quota?.requestsRemaining).toBe(9);
  });

  it("throws WritApiKeyRequiredError for crawl WITHOUT making a request", async () => {
    const { fetch, calls } = fakeFetch(200, {});
    const cloud = new CloudApi({ fetch, clientId: "device-123" });
    await expect(cloud.crawl({ url: "https://x.test" })).rejects.toBeInstanceOf(WritApiKeyRequiredError);
    expect(calls).toHaveLength(0);
  });

  it("maps a 429 to WritRateLimitedError with resetAt", async () => {
    const { fetch } = fakeFetch(429, {
      detail: {
        message: "used your keyless allowance",
        code: "keyless_rate_limited",
        reset_at: "2026-07-17T00:00:00Z",
        requests_remaining: 0,
      },
    });
    const cloud = new CloudApi({ fetch, clientId: "device-123" });
    await cloud.scrape("https://x.test").then(
      () => {
        throw new Error("expected rejection");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(WritRateLimitedError);
        expect((err as WritRateLimitedError).resetAt).toBe("2026-07-17T00:00:00Z");
      },
    );
  });
});

describe("CloudApi metered tier", () => {
  it("scrapes via /api/crawl with a bearer and no client-id", async () => {
    const { fetch, calls } = fakeFetch(200, {
      verb: "scrape",
      url: "https://x.test",
      title: "Hi",
      markdown: "# Hi",
      counts: {},
      tier: "metered",
    });
    const cloud = new CloudApi({ fetch, apiKey: "wt_secret" });
    expect(cloud.tier).toBe("metered");

    const res = await cloud.scrape("https://x.test");
    expect(calls[0].url).toBe("https://api.usewrit.app/api/crawl/scrape");
    expect(calls[0].headers["authorization"]).toBe("Bearer wt_secret");
    expect(calls[0].headers["x-writ-client-id"]).toBeUndefined();
    expect(res.tier).toBe("metered");
  });

  it("crawl posts to /api/crawl with the api key", async () => {
    const { fetch, calls } = fakeFetch(200, { id: 7, status: "queued" });
    const cloud = new CloudApi({ fetch, apiKey: "wt_secret" });
    const job = await cloud.crawl({ url: "https://x.test" });
    expect(calls[0].url).toBe("https://api.usewrit.app/api/crawl");
    expect(calls[0].headers["authorization"]).toBe("Bearer wt_secret");
    expect((job as { id: number }).id).toBe(7);
  });
});

describe("CloudApi credential fallback", () => {
  it("reads WRIT_API_KEY from the injected env", () => {
    const cloud = new CloudApi({ env: { WRIT_API_KEY: "wt_env" } });
    expect(cloud.tier).toBe("metered");
  });

  it("is keyless when no key is present", () => {
    const cloud = new CloudApi({ env: {} });
    expect(cloud.tier).toBe("keyless");
  });
});
