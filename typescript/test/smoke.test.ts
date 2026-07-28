/**
 * Env-gated live smoke test (DESIGN.md §9): set WRIT_SMOKE=1 to run against a
 * real, discovered daemon. Read-only — status + two list calls. Skipped by
 * default.
 */

import { describe, expect, it } from "vitest";
import { WritAgent } from "../src/index.js";

const smoke = process.env.WRIT_SMOKE === "1";

describe.skipIf(!smoke)("live smoke (WRIT_SMOKE=1)", () => {
  it("discovers the daemon and answers status + workflows + runs", async () => {
    const client = await WritAgent.discover();

    const status = await client.agent.status();
    expect(status.status).toBe("ok");
    expect(typeof status.version).toBe("string");

    const workflows = await client.workflows.list();
    expect(Array.isArray(workflows.data)).toBe(true);
    expect(workflows.count).toBe(workflows.data.length);

    const runs = await client.runs.list({ limit: 1 });
    expect(Array.isArray(runs.data)).toBe(true);
    expect(runs.data.length).toBeLessThanOrEqual(1);
    expect(runs.total === null || typeof runs.total === "number").toBe(true);
  });
});
