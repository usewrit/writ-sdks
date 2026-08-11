/**
 * Cloud monitors tests (`client.cloud.monitors`) — the metered `/api/targets/*`
 * surface that mirrors the local daemon's `client.monitors`:
 *   • every verb routes to the real backend path and method
 *   • unset query params are omitted entirely (`?limit=` would 422 a typed int)
 *   • DELETE answers 204 with no body and must not throw on the empty parse
 *   • the keyless tier refuses BEFORE any network call — there is no account to own a monitor
 *
 * Uses CloudApi's injectable `fetch` — no cloud, no network.
 */
import { describe, expect, it } from "vitest";
import {
  CloudApi,
  WritApiKeyRequiredError,
  WritInsufficientCreditsError,
  WritPlanLimitError,
  crawlBrandName,
} from "../src/index.js";

type Captured = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A fake fetch that records requests; 204s come back with a genuinely empty body. */
function fakeFetch(payload: unknown, status = 200): { fetch: typeof fetch; calls: Captured[] } {
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
    if (status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const MONITOR = {
  id: 412,
  url: "https://example.com/pricing",
  checkType: "content",
  selector: ".price",
  checkPeriodMs: 300000,
  enabled: true,
  changesCount: 0,
};

describe("cloud monitors routing", () => {
  it("creates a monitor with a bearer key on POST /api/targets", async () => {
    const { fetch, calls } = fakeFetch(MONITOR);
    const cloud = new CloudApi({ fetch, apiKey: "wt_test" });

    const mon = await cloud.monitors.create({
      url: "https://example.com/pricing",
      check_type: "content",
      selector: ".price",
      check_period_ms: 300000,
    });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.usewrit.app/api/targets");
    expect(calls[0].headers["authorization"]).toBe("Bearer wt_test");
    // The cloud ACCEPTS snake_case and ANSWERS camelCase — assert both halves.
    expect(calls[0].body).toEqual({
      url: "https://example.com/pricing",
      check_type: "content",
      selector: ".price",
      check_period_ms: 300000,
    });
    expect(mon.checkPeriodMs).toBe(300000);
  });

  it("omits unset query params on list", async () => {
    const { fetch, calls } = fakeFetch([MONITOR]);
    const cloud = new CloudApi({ fetch, apiKey: "wt_test" });

    await cloud.monitors.list();
    expect(calls[0].url).toBe("https://api.usewrit.app/api/targets");

    await cloud.monitors.list({ limit: 50, enabled_only: true, check_type: undefined });
    expect(calls[1].url).toBe("https://api.usewrit.app/api/targets?limit=50&enabled_only=true");
  });

  it("routes get/update/toggle/run/changes to their real paths", async () => {
    const { fetch, calls } = fakeFetch(MONITOR);
    const cloud = new CloudApi({ fetch, apiKey: "wt_test" });

    await cloud.monitors.get(412);
    await cloud.monitors.update(412, { check_period_ms: 600000 });
    await cloud.monitors.toggle(412, false);
    await cloud.monitors.run(412);
    await cloud.monitors.changes(412, { limit: 25 });
    await cloud.monitors.recentChanges({ limit: 10 });
    await cloud.monitors.recentChanges();

    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.usewrit.app", "")}`)).toEqual([
      "GET /api/targets/412",
      "PATCH /api/targets/412",
      "PATCH /api/targets/412/toggle?enabled=false",
      "POST /api/targets/412/run",
      "GET /api/targets/412/changes?limit=25",
      "GET /api/targets/changes/recent?limit=10",
      "GET /api/targets/changes/recent",
    ]);
    expect(calls[1].body).toEqual({ check_period_ms: 600000 });
  });

  it("survives the 204 that DELETE answers with", async () => {
    const { fetch, calls } = fakeFetch(null, 204);
    const cloud = new CloudApi({ fetch, apiKey: "wt_test" });

    await expect(cloud.monitors.delete(412)).resolves.toBeUndefined();
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://api.usewrit.app/api/targets/412");
  });
});

describe("cloud monitors on the keyless tier", () => {
  it("refuses every verb before making a request", async () => {
    const { fetch, calls } = fakeFetch(MONITOR);
    const cloud = new CloudApi({ fetch, clientId: "device-123" });
    expect(cloud.tier).toBe("keyless");

    await expect(cloud.monitors.list()).rejects.toBeInstanceOf(WritApiKeyRequiredError);
    await expect(cloud.monitors.create({ url: "https://x.test" })).rejects.toBeInstanceOf(
      WritApiKeyRequiredError,
    );
    await expect(cloud.monitors.get(1)).rejects.toBeInstanceOf(WritApiKeyRequiredError);
    await expect(cloud.monitors.update(1, {})).rejects.toBeInstanceOf(WritApiKeyRequiredError);
    await expect(cloud.monitors.delete(1)).rejects.toBeInstanceOf(WritApiKeyRequiredError);
    await expect(cloud.monitors.toggle(1, true)).rejects.toBeInstanceOf(WritApiKeyRequiredError);
    await expect(cloud.monitors.run(1)).rejects.toBeInstanceOf(WritApiKeyRequiredError);
    await expect(cloud.monitors.changes(1)).rejects.toBeInstanceOf(WritApiKeyRequiredError);
    await expect(cloud.monitors.recentChanges()).rejects.toBeInstanceOf(WritApiKeyRequiredError);

    expect(calls).toHaveLength(0);
  });
});

describe("402 is not one error", () => {
  it("splits a PLAN CEILING from a wallet balance", async () => {
    // The backend sends plan denials FLAT: {"detail": "<reason>", code, current,
    // limit, upgrade_hint}. Reading only the (string) `detail` used to
    // black-hole every machine-readable field.
    const planBody = {
      detail: "Check interval too short. Minimum for your plan: 10s.",
      code: "interval_too_short",
      current: 1000,
      limit: 10000,
      upgrade_hint: "growth",
    };
    const { fetch } = fakeFetch(planBody, 402);
    const cloud = new CloudApi({ fetch, apiKey: "wt_test" });

    await expect(
      cloud.monitors.create({ url: "https://x.test", check_period_ms: 1000 }),
    ).rejects.toBeInstanceOf(WritPlanLimitError);

    const err = await cloud.monitors
      .create({ url: "https://x.test", check_period_ms: 1000 })
      .catch((e: unknown) => e as WritPlanLimitError);
    expect(err.code).toBe("interval_too_short");
    expect(err.limit).toBe(10000);
    expect(err.current).toBe(1000);
    expect(err.upgradeHint).toBe("growth");
  });

  it("leaves a wallet 402 as insufficient credits", async () => {
    const { fetch } = fakeFetch(
      { detail: { message: "allotment spent", code: "insufficient_credits" } },
      402,
    );
    const cloud = new CloudApi({ fetch, apiKey: "wt_test" });
    await expect(cloud.scrape("https://x.test")).rejects.toBeInstanceOf(
      WritInsufficientCreditsError,
    );
  });
});

describe("crawl brand", () => {
  it("reads both the daemon string and the cloud object", () => {
    // The daemon sends "Dragnet"; the cloud sends {crawl, agent}.
    expect(crawlBrandName("Dragnet")).toBe("Dragnet");
    expect(crawlBrandName({ crawl: "Dragnet", agent: "Scribe" })).toBe("Dragnet");
  });
});
