# @usewrit/agent-sdk

Official TypeScript SDK for the **Writ local agent** (`writ-agentd`) — the loopback
HTTP API (`http://127.0.0.1:8131/v1/…`) served by the Writ desktop app and the
self-hosted daemon.

- Zero runtime dependencies (Node ≥ 18, global `fetch`)
- ESM with full type declarations, TypeScript strict mode
- Automatic daemon discovery (`~/.writ/runtime.json`), typed errors, uniform
  list pages, typed SSE run events, `runAndWait`

## Install

```sh
npm install @usewrit/agent-sdk
```

## Quickstart

```ts
import { WritAgent, runRowId } from "@usewrit/agent-sdk";

const client = new WritAgent(); // discovers the running agent + token
const { data: workflows } = await client.workflows.list();
const run = await client.workflows.runAndWait(workflows[0].id, { inputs: { city: "Paris" } });
const { data: rows } = await client.runs.data(runRowId(run));
console.log(run.status, rows);
```

(Run-feed ids are composite strings like `"workflow-3"`; the exported
`runRowId(run)` helper extracts the numeric row id that
`runs.get/data/cancel/events` take.)

## Auth & discovery

Every request carries `Authorization: Bearer <token>`. The token families are
`wlt_` (runtime token, full access), `wlk_` (scoped API key minted via
`client.keys.create`), and `wlo_` (OAuth access token) — the SDK treats them as
opaque strings.

If you pass nothing, the client discovers a live daemon on first use
(single-flight, cached for the client's lifetime):

1. **Env overrides** — `WRIT_API_URL` (base URL) and `WRIT_TOKEN` (bearer). Both
   set → discovery is done. One set → it fills that field, the rest is discovered.
2. **`runtime.json` descriptors**, in order, first *live* one wins:
   1. `$WRIT_HOME/runtime.json`
   2. `~/.writ/active_profile` → `~/.writ/profiles/<id>/runtime.json`
   3. `~/.writ/runtime.json`
   4. every `~/.writ/profiles/<id>/runtime.json` (capped, deduped)
3. Each candidate is **liveness-probed** (`GET /v1/agent`, 2 s budget); a stale
   descriptor from a crashed daemon falls through to the next candidate.

Explicit options always win over discovery:

```ts
const client = new WritAgent({
  baseUrl: "http://127.0.0.1:8131", // no trailing /v1
  token: process.env.MY_WRIT_KEY!,  // e.g. a scoped wlk_ key
  timeout: 30_000,                  // per-request, ms (default 30 s)
});
```

Discovery is filesystem-based and desktop-only. In a browser (or any non-Node
runtime) you must pass `baseUrl` + `token` explicitly — otherwise construction
of the first request throws a `WritDiscoveryError` telling you so. For the
HTTPS twin port (`https://127.0.0.1:8132`, local CA at `~/.writ/tls/ca.pem`),
pass a custom `fetch` wired to your TLS setup via the `fetch` option.

Prefer failing fast? `await WritAgent.discover()` (or `client.connect()`)
resolves and probes eagerly instead of on the first call.

## Errors

Three kinds, one base class — no automatic retries in v1:

```ts
import { WritApiError, WritConnectionError, WritDiscoveryError } from "@usewrit/agent-sdk";

try {
  await client.workflows.get(999999);
} catch (err) {
  if (err instanceof WritApiError) {
    // err.status === 404, err.code === "not_found",
    // err.message === "not found: workflow 999999", err.body = parsed JSON
  } else if (err instanceof WritConnectionError) {
    // daemon went away mid-session / request timed out
  } else if (err instanceof WritDiscoveryError) {
    // no live daemon found — is the Writ agent running? set WRIT_TOKEN, or pass token
  }
}
```

Domain errors are JSON `{"error", "code"}`; plain-text rejections (e.g. axum
body-deserialize) map to a status-derived `code` (`400→bad_request`,
`404→not_found`, `409→conflict`, `422→unprocessable`, `5xx→internal`, …).

One deliberate non-error: `runs.cancel(id)` / `workflows.cancel(id)` return the
daemon's **409 `{status: "not_running"}` as a result**, not an exception — an
already-finished run is a valid answer to "cancel".

## Lists are always a `Page`

The daemon mixes three list envelopes; every SDK list method normalizes them:

```ts
const page = await client.runs.list({ limit: 20, status: "failed" });
page.data;  // T[]
page.count; // items in this page
page.total; // number | null (only the runs feed reports a total)
```

## Run events (SSE)

`runs.events(runId)` is a typed async iterator over the daemon's
`text/event-stream` (`started | step | progress | finished | error`); it
completes after the terminal event. Keep-alive comments are handled for you.

```ts
const { run_id } = await client.workflows.run(3, { inputs: { q: "writ" } });
for await (const ev of client.runs.events(run_id)) {
  if (ev.event === "step") console.log(`step ${ev.index} (${ev.step_type}): ${ev.status}`);
  if (ev.event === "finished") console.log("done:", ev.status);
  if (ev.event === "error") console.error("failed:", ev.message);
}
```

`workflows.runAndWait(id, opts)` wraps the whole dance: start the run, follow
the SSE stream, fall back to 1 s polling if the stream drops, and return the
final run (optionally with `includeResults: true`). The default deadline is
**600 s** (`waitTimeout`, ms); on expiry it throws — **the run itself is not
cancelled** (call `runs.cancel(runId)` if you want that).

## Waiting: three ways

The daemon's run endpoint is **async by default** and you choose how to wait:

| You want | Call | You get |
| --- | --- | --- |
| A handle to watch yourself | `workflows.run(id)` | `202 {run_id}` — stream `runs.events(run_id)` |
| Just the answer, one request | `workflows.run(id, { wait: true })` | The terminal run document |
| Live events + the enriched feed item | `workflows.runAndWait(id)` | Final `RunFeedItem` (+ `results`) |

`wait: true` is the **server-side** wait (`?wait=true`) — the daemon blocks and
answers with the run's own result. No SSE, no poll loop:

```ts
const done = await client.workflows.run(3, { wait: true, timeout: 60 });
if (done.status === "success") console.log(done.data);
else console.error(done.error);          // a FAILED run resolves — check status
```

A run that fails is a **result**, not an exception. Only an expired budget rejects,
as a `WritRunTimeoutError` carrying the still-valid run id — the run keeps going, so
collect it rather than retrying (a retry starts a *second* run):

```ts
import { WritRunTimeoutError } from "@usewrit/agent";

try {
  await client.workflows.run(3, { wait: true, timeout: 30 });
} catch (err) {
  if (err instanceof WritRunTimeoutError) {
    for await (const ev of client.runs.events(err.runId)) { /* … */ }
  }
}
```

Reach for `runAndWait` when you want live progress or a deadline longer than the
daemon's own ceiling (`timeout` is clamped server-side to 1–3600 s, default 120).

## Surface

| Namespace            | Endpoints                                                                 |
| -------------------- | ------------------------------------------------------------------------- |
| `client.agent`       | `status()`, `health()`                                                     |
| `client.workflows`   | `list, create, get, update, delete, run, cancel, session, clearSession, runAndWait` |
| `client.runs`        | `list, get, results, data, dataCsv, events, cancel`                        |
| `client.monitors`    | `list, create, get, update, delete, run, changes, capacity, recentChanges` |
| `client.selectors`   | `list, create, get, update, delete, toggle, test, setBaseline, clearBaseline` (under a monitor) |
| `client.extractors`  | `list, create, get, update, delete, toggle, test`                          |
| `client.automations` | `list, create, get, update, delete, enable, run`                           |
| `client.personas`    | `list, create, get, update, delete, runs, validateTotp, test2fa`           |
| `client.secrets`     | `list, set, get, delete` — metadata only; values never come back           |
| `client.vault`       | `status, lock, unlock`                                                     |
| `client.files`       | `list, upload (multipart), fromData, get, delete, content (bytes)`         |
| `client.data`        | `query, workflowData, deleteWorkflowData, facets, export, dataRuns`        |
| `client.crawl`       | `list, start, get, cancel` — the "Dragnet" whole-site crawl (local daemon) |
| `client.cloud`       | `scrape, map, crawl, crawlStatus, quota` — the tiered **cloud** surface     |
| `client.keys`        | `list, create (plaintext key shown once), get, delete` — needs `wlt_`      |
| `client.wsTicket`    | mint a single-use WS ticket (`record` / `ai-preview`)                      |

### Cloud tier (`client.cloud`) — scrape / map / crawl

These three verbs run on **Writ Cloud**, never on the calling machine, with a Firecrawl-style tier
resolved from your credential:

```ts
// Metered: pass an API key (or set WRIT_API_KEY) → billed per page, uncapped by your plan.
const client = new WritAgent({ apiKey: "wt_…" });
const page = await client.cloud.scrape("https://example.com");   // { markdown, tier: "metered", … }
const job  = await client.cloud.crawl({ url: "https://example.com" });

// Keyless: no key → free, daily-capped per install (X-Writ-Client-Id) and per IP. scrape + map only.
const anon = new WritAgent();
const p = await anon.cloud.scrape("https://example.com");        // { markdown, tier: "keyless", quota }
await anon.cloud.crawl({ url: "…" });                            // throws WritApiKeyRequiredError
```

Credential precedence: `apiKey` → `WRIT_API_KEY` → keyless. Errors: `429 → WritRateLimitedError`
(`resetAt`), `402 api_key_required → WritApiKeyRequiredError`, other `402 → WritInsufficientCreditsError`.

Secret hygiene mirrors the daemon: workflow credentials, persona passwords and
vault secret values are sealed daemon-side and are **never** present in any
response this SDK returns.

The full wire contract lives in [`../openapi/writ-agent.yaml`](../openapi/writ-agent.yaml)
and the cross-language rules in [`../DESIGN.md`](../DESIGN.md).

## Roadmap (not in v1)

OAuth AS endpoints, `/mcp` JSON-RPC, the OpenAI-compat routes, cloud/* surfaces,
backup/update/network/tls/settings/diagnostics/notifications, AI surfaces
(ai-assist / ai-sessions / ai-concierge / streaming sessions), relay, hooks,
and a WebSocket convenience for opening the recorder socket (the SDK mints the
ticket; opening the socket is up to you for now).

## Development

```sh
npm install
npm run build     # tsc → dist/
npm test          # vitest against an in-process mock daemon
WRIT_SMOKE=1 npm test   # additionally smoke-test against a real, running agent
```

MIT © Writ
