/**
 * Env-gated LIVE test: drives `client.cloud.monitors` and `client.cloud.crawl`
 * against a REAL running coordinator. No mocks — this is the test that would
 * have caught a wrong path, a wrong casing or a scope the route map never mapped.
 *
 * ```sh
 * WRIT_E2E=1 WRIT_CLOUD_URL=http://localhost:8000 WRIT_API_KEY=wt_… npx vitest run test/cloud-monitors-live.test.ts
 * ```
 *
 * The key needs monitors:read/write/execute/delete and crawl:read/execute.
 * Skipped (not failed) when WRIT_E2E is unset, so `npm test` stays hermetic.
 */
import { afterAll, describe, expect, it } from "vitest";
import { CloudApi, WritApiError } from "../src/index.js";

const LIVE = process.env["WRIT_E2E"] === "1";
/** Each of these makes ~10 sequential round-trips against a REAL coordinator.
 *  Vitest's 5s default made the monitor lifecycle flaky at ~9s — this is a
 *  network budget, not a performance assertion. */
const LIVE_TIMEOUT_MS = 60_000;
const cloudUrl = process.env["WRIT_CLOUD_URL"] ?? "http://localhost:8000";
const apiKey = process.env["WRIT_API_KEY"] ?? "";

// example.com is the one URL guaranteed to exist and answer 200 — the API
// fetches the page to establish a baseline, so a 404 seed is rejected outright.
const SEED = "https://example.com";

describe.skipIf(!LIVE)("cloud monitors against a live coordinator", () => {
  const cloud = new CloudApi({ apiKey, cloudUrl });
  let created: number | undefined;

  afterAll(async () => {
    // Never leave a monitor behind, even if an expectation blew up mid-test.
    if (created !== undefined) {
      await cloud.monitors.delete(created).catch(() => undefined);
    }
  });

  it("runs the full monitor lifecycle", async () => {
    expect(cloud.tier).toBe("metered");

    const mon = await cloud.monitors.create({
      url: SEED,
      check_type: "content",
      selector: "h1",
      check_period_ms: 300_000,
    });
    created = mon.id;
    // The types in cloud.ts claim camelCase — assert the server agrees.
    expect(mon.checkPeriodMs).toBe(300_000);
    expect(mon.selector).toBe("h1");
    expect(mon.enabled).toBe(true);

    const listed = await cloud.monitors.list({ limit: 100 });
    expect(listed.some((m) => m.id === created)).toBe(true);

    const got = await cloud.monitors.get(mon.id);
    expect(got.url).toBe(SEED);

    const updated = await cloud.monitors.update(mon.id, { check_period_ms: 600_000 });
    expect(updated.checkPeriodMs).toBe(600_000);

    expect((await cloud.monitors.toggle(mon.id, false)).enabled).toBe(false);
    expect((await cloud.monitors.toggle(mon.id, true)).enabled).toBe(true);

    const run = await cloud.monitors.run(mon.id);
    expect(typeof run.ok).toBe("boolean");
    expect(typeof run.dispatched).toBe("number");

    expect(Array.isArray(await cloud.monitors.changes(mon.id, { limit: 5 }))).toBe(true);
    expect(Array.isArray(await cloud.monitors.recentChanges({ limit: 5 }))).toBe(true);

    await cloud.monitors.delete(mon.id);
    const after = await cloud.monitors.list({ limit: 100 });
    expect(after.some((m) => m.id === created)).toBe(false);
    created = undefined;
  }, LIVE_TIMEOUT_MS);

  it("surfaces the plan interval floor as an error instead of clamping", async () => {
    // plan_enforcer REJECTS a sub-floor interval; it must not come back as a
    // quietly slowed-down monitor the caller never asked for.
    await expect(cloud.monitors.create({ url: SEED, check_period_ms: 1000 })).rejects.toBeInstanceOf(
      WritApiError,
    );
  }, LIVE_TIMEOUT_MS);

  it("starts and polls a real crawl", async () => {
    const job = await cloud.crawl({ url: SEED, max_depth: 0, page_budget: 1 });
    expect(typeof job.id).toBe("number");
    const status = await cloud.crawlStatus(job.id);
    expect(status.seed_url).toContain("example.com");
  });
});

describe.skipIf(!LIVE)("cloud automations + personas against a live coordinator", () => {
  const cloud = new CloudApi({ apiKey, cloudUrl });

  it("runs the automation lifecycle", async () => {
    // SELF-HEALING: a live tenant is not a fixture; a crashed run must not
    // poison every run after it.
    for (const stale of await cloud.automations.list()) {
      if (stale.name === "ts-e2e-automation") await cloud.automations.delete(stale.id);
    }
    const a = await cloud.automations.create({
      name: "ts-e2e-automation",
      event_type: "change_detected",
      actions: [{ type: "notification", config: { channels: ["email"] } }],
    });
    try {
      expect(a.enabled).toBe(true);
      expect(a.actions[0]?.type).toBe("notification");
      expect((await cloud.automations.list()).some((x) => x.id === a.id)).toBe(true);
      expect((await cloud.automations.get(a.id)).name).toBe("ts-e2e-automation");
      expect((await cloud.automations.update(a.id, { description: "e2e" })).description).toBe("e2e");
      // toggle FLIPS — it takes no value.
      expect((await cloud.automations.toggle(a.id)).enabled).toBe(false);
      expect((await cloud.automations.toggle(a.id)).enabled).toBe(true);
      expect(Array.isArray(await cloud.automations.executions(a.id, { limit: 5 }))).toBe(true);
      expect(Array.isArray(await cloud.automations.forMonitor(999_999))).toBe(true);
    } finally {
      await cloud.automations.delete(a.id);
    }
  }, LIVE_TIMEOUT_MS);

  it("keeps persona secrets write-only", async () => {
    for (const stale of await cloud.personas.list()) {
      if (stale.name === "ts-e2e-persona") await cloud.personas.delete(stale.id);
    }
    const p = await cloud.personas.create({ name: "ts-e2e-persona", target_domain: "example.com" });
    try {
      expect(p.has_password).toBe(false);
      expect((p as unknown as Record<string, unknown>)["password"]).toBeUndefined();

      const updated = await cloud.personas.update(p.id, { password: "e2e-not-a-real-credential" });
      expect(updated.has_password).toBe(true);
      // The VALUE must never come back, only the boolean.
      expect((updated as unknown as Record<string, unknown>)["password"]).toBeUndefined();

      expect((await cloud.personas.get(p.id)).name).toBe("ts-e2e-persona");
      expect((await cloud.personas.validateTotp("JBSWY3DPEHPK3PXP")).valid_base32).toBe(true);
    } finally {
      await cloud.personas.delete(p.id);
    }
  }, LIVE_TIMEOUT_MS);
});
