import { describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { CloudApi, WritAgent, signWebhookRequest, verifyWebhook } from "../src/index.js";
import { WritWebhookVerificationError } from "../src/webhook.js";
import { autoPage } from "../src/types.js";

/** Spin up a throwaway HTTP server and hand back its base URL. */
async function serve(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const FAST_RETRY = { baseDelayMs: 1, maxDelayMs: 5 };

describe("retry", () => {
  it("rides out a transient 503 instead of surfacing it", async () => {
    let hits = 0;
    const s = await serve((_req, res) => {
      hits++;
      if (hits < 3) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(`{"id":1}`);
    });
    try {
      const client = new WritAgent({ baseUrl: s.url, token: "wlt_x", retry: FAST_RETRY });
      await expect(client.monitors.get(1)).resolves.toMatchObject({ id: 1 });
      expect(hits).toBe(3);
    } finally {
      await s.close();
    }
  });

  it("never retries a POST against the local daemon", async () => {
    // The daemon has no Idempotency-Key lane, so a second attempt is a second
    // monitor — the one failure mode a retry must never introduce.
    let hits = 0;
    const s = await serve((_req, res) => {
      hits++;
      res.writeHead(503).end();
    });
    try {
      const client = new WritAgent({ baseUrl: s.url, token: "wlt_x", retry: FAST_RETRY });
      await expect(client.monitors.create({ url: "https://example.com" })).rejects.toThrow();
      expect(hits).toBe(1);
    } finally {
      await s.close();
    }
  });

  it("retries an unsafe cloud call under ONE stable Idempotency-Key", async () => {
    const keys: (string | undefined)[] = [];
    let hits = 0;
    const s = await serve((req, res) => {
      keys.push(req.headers["idempotency-key"] as string | undefined);
      hits++;
      if (hits < 2) {
        res.writeHead(502).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(`{"id":7}`);
    });
    try {
      const cloud = new CloudApi({ apiKey: "wt_test", cloudUrl: s.url, env: {}, retry: FAST_RETRY });
      await expect(cloud.monitors.create({ url: "https://example.com" })).resolves.toMatchObject({ id: 7 });
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBeTruthy();
      // If the key changed between attempts the server would execute twice.
      expect(keys[0]).toBe(keys[1]);
    } finally {
      await s.close();
    }
  });

  it("does not sleep on a Retry-After that will not clear", async () => {
    let hits = 0;
    const s = await serve((_req, res) => {
      hits++;
      res
        .writeHead(429, { "retry-after": "36000", "content-type": "application/json" })
        .end(`{"detail":{"code":"rate_limited","message":"daily allowance spent"}}`);
    });
    try {
      const cloud = new CloudApi({ apiKey: "wt_test", cloudUrl: s.url, env: {} });
      const started = Date.now();
      await expect(cloud.monitors.list()).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2000);
      expect(hits).toBe(1);
    } finally {
      await s.close();
    }
  });
});

describe("change feed types", () => {
  it("decodes the GLOBAL feed's real shape — snake_case with integer ids", async () => {
    // The regression this guards: the global feed used to be typed as the
    // per-monitor camelCase shape, so every field read back undefined.
    const s = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify([
          {
            id: 9,
            target_id: 412,
            target_url: "https://example.com/pricing",
            target_selector_id: null,
            selector_name: null,
            diff_snippet: "-$1,199 +$1,099",
            first_detected_at: "2026-08-05T00:00:00+00:00",
            last_detected_at: "2026-08-05T00:01:00+00:00",
          },
        ]),
      );
    });
    try {
      const cloud = new CloudApi({ apiKey: "wt_test", cloudUrl: s.url, env: {} });
      const [change] = await cloud.monitors.recentChanges({ limit: 1 });
      expect(change!.id).toBe(9);
      expect(change!.target_id).toBe(412);
      expect(change!.target_url).toBe("https://example.com/pricing");
      expect(change!.diff_snippet).toBe("-$1,199 +$1,099");
      // The cursor field: without it a watcher has nothing to advance on.
      expect(change!.last_detected_at).toBe("2026-08-05T00:01:00+00:00");
    } finally {
      await s.close();
    }
  });
});

describe("watch", () => {
  /** A keyset feed that mirrors the server's own semantics. */
  function feedServer(rows: Array<{ id: number; ts: string }>) {
    return serve((req, res) => {
      const url = new URL(req.url!, "http://x");
      const since = url.searchParams.get("since");
      const sinceId = Number(url.searchParams.get("since_id") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);

      // Mirror the server exactly: NO cursor means the newest-first browsing
      // view; a cursor means an oldest-first keyset walk.
      const matched = since
        ? rows.filter((r) => r.ts > since || (r.ts === since && r.id > sinceId))
        : [...rows].reverse();
      const out = matched
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          target_id: 1,
          target_url: "https://a",
          target_selector_id: null,
          selector_name: null,
          diff_snippet: null,
          first_detected_at: r.ts,
          last_detected_at: r.ts,
        }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
  }

  it("walks the cursor with no gaps and no repeats across page boundaries", async () => {
    const rows = [
      { id: 1, ts: "2026-08-05T00:00:01Z" },
      { id: 2, ts: "2026-08-05T00:00:02Z" },
      { id: 3, ts: "2026-08-05T00:00:03Z" },
      { id: 4, ts: "2026-08-05T00:00:04Z" },
      { id: 5, ts: "2026-08-05T00:00:05Z" },
    ];
    const s = await feedServer(rows);
    try {
      const cloud = new CloudApi({ apiKey: "wt_test", cloudUrl: s.url, env: {} });
      const seen: number[] = [];
      // pageSize 2 forces three pages: the exact case a naive newest-first
      // poller drops rows on.
      for await (const change of cloud.monitors.watch({
        pageSize: 2,
        intervalMs: 5,
        replayHistory: true,
      })) {
        seen.push(change.id);
        if (seen.length === 5) break;
      }
      expect(seen).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await s.close();
    }
  });

  it("breaks ties on id so two changes in the same instant both arrive", async () => {
    const sameInstant = "2026-08-05T00:00:01Z";
    const s = await feedServer([
      { id: 1, ts: sameInstant },
      { id: 2, ts: sameInstant },
      { id: 3, ts: sameInstant },
    ]);
    try {
      const cloud = new CloudApi({ apiKey: "wt_test", cloudUrl: s.url, env: {} });
      const seen: number[] = [];
      for await (const change of cloud.monitors.watch({
        pageSize: 1,
        intervalMs: 5,
        replayHistory: true,
      })) {
        seen.push(change.id);
        if (seen.length === 3) break;
      }
      // Without the since_id tie-break this loops forever on id 1.
      expect(seen).toEqual([1, 2, 3]);
    } finally {
      await s.close();
    }
  });

  it("starts at the head, not the archive", async () => {
    const s = await feedServer([
      { id: 1, ts: "2026-08-05T00:00:01Z" },
      { id: 2, ts: "2026-08-05T00:00:02Z" },
    ]);
    try {
      const cloud = new CloudApi({ apiKey: "wt_test", cloudUrl: s.url, env: {} });
      const ctrl = new AbortController();
      const seen: number[] = [];
      setTimeout(() => ctrl.abort(), 150);
      for await (const change of cloud.monitors.watch({ intervalMs: 20, signal: ctrl.signal })) {
        seen.push(change.id);
      }
      expect(seen).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

describe("autoPage", () => {
  it("keeps walking past the first page", async () => {
    const pages = [
      { data: [1, 2], count: 2, total: null },
      { data: [3, 4], count: 2, total: null },
      { data: [5], count: 1, total: null },
    ];
    let call = 0;
    const list = vi.fn(async () => pages[call++]!);
    const seen: number[] = [];
    for await (const row of autoPage(list as never, { limit: 2 })) seen.push(row as number);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe("verifyWebhook", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ event: "change_detected", target: { id: 42 } });

  async function v1Headers(ts: string): Promise<Record<string, string>> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`));
    const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
    return { "x-writ-timestamp": ts, "x-writ-signature-v1": `sha256=${hex}` };
  }

  it("accepts a valid V1 delivery", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    await expect(verifyWebhook(await v1Headers(ts), body, secret)).resolves.toBeUndefined();
  });

  it("rejects a tampered body and a wrong secret", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const headers = await v1Headers(ts);
    await expect(verifyWebhook(headers, body + " ", secret)).rejects.toMatchObject({
      reason: "signature_mismatch",
    });
    await expect(verifyWebhook(headers, body, "nope")).rejects.toMatchObject({
      reason: "signature_mismatch",
    });
  });

  it("rejects a correctly signed but stale delivery — that is a replay", async () => {
    const hourAgo = (Math.floor(Date.now() / 1000) - 3600).toString();
    await expect(verifyWebhook(await v1Headers(hourAgo), body, secret)).rejects.toMatchObject({
      reason: "stale",
    });
  });

  it("refuses a body-only signature unless explicitly allowed", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
    const headers = { "x-writ-signature": `sha256=${hex}` };

    await expect(verifyWebhook(headers, body, secret)).rejects.toBeInstanceOf(
      WritWebhookVerificationError,
    );
    await expect(
      verifyWebhook(headers, body, secret, { allowLegacyBodyOnly: true }),
    ).resolves.toBeUndefined();
  });

  it("signs an inbound call in the same scheme the server verifies", async () => {
    const headers = await signWebhookRequest(body, secret);
    // The inbound scheme IS V1's scheme — one recipe for both directions.
    await expect(
      verifyWebhook(
        {
          "x-writ-timestamp": headers["X-Writ-Timestamp"]!,
          "x-writ-signature-v1": headers["X-Writ-Signature"]!,
        },
        body,
        secret,
      ),
    ).resolves.toBeUndefined();
  });

  it("reads headers from a Headers object as well as a plain bag", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const bag = await v1Headers(ts);
    const headers = new Headers(bag);
    await expect(verifyWebhook(headers, body, secret)).resolves.toBeUndefined();
  });
});
