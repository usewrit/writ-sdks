# Writ Agent SDKs — cross-language contract

This document is the **single source of truth** for every hand-written Writ agent SDK
(`sdks/typescript`, `sdks/python`, `sdks/go`, `sdks/rust`) and for the OpenAPI spec
(`sdks/openapi/writ-agent.yaml`). Every SDK implements the same surface, the same
discovery algorithm, the same error model, and the same helper semantics. Language
idioms differ; wire behavior must not.

The wire truth is the Rust daemon: `writ-agent/src/local/` (axum). When
this doc and the Rust source disagree, **the Rust source wins** — fix this doc.

---

## 1. What we are wrapping

The **Writ agent** (`writ-agentd`) is a local daemon serving a loopback HTTP API:

- Plain HTTP on `127.0.0.1:8131` (default; env `WRIT_PORT`).
- HTTPS twin on `127.0.0.1:8132` (per-install local CA at `~/.writ/tls/ca.pem`); optional.
- All resource routes live under the `/v1` prefix.
- Auth: `Authorization: Bearer <token>` on every request. Token families:
  `wlt_` (runtime token from `runtime.json`, full access), `wlk_` (scoped API key),
  `wlo_` (OAuth 2.1 access token, `run` scope). SDKs treat the token as an opaque string.
- The daemon enforces a DNS-rebind guard: `Host`/`Origin` must be loopback. SDKs talk to
  `127.0.0.1` (not `localhost`) by default.

Route registration: `src/local/server.rs` + `src/local/api/v1/*.rs`.
Row models: `src/local/store/*.rs`.

## 2. Packages & naming

| Language   | Package name            | Module/import                | Client type(s)                     | Version |
|------------|-------------------------|------------------------------|------------------------------------|---------|
| TypeScript | `@usewrit/agent-sdk`    | `@usewrit/agent-sdk`         | `WritAgent`                        | 0.1.0   |
| Python     | `writ-agent`            | `writ_agent`                 | `WritAgent`, `AsyncWritAgent`      | 0.1.0   |
| Go         | `github.com/usewrit/writ-sdks/go` | package `writ`     | `writ.Client` via `writ.New()`     | v0.1.0  |
| Rust       | `writ-client`           | `writ_client`                | `WritAgent` (async)                | 0.1.0   |

- User-Agent header: `writ-sdk-<lang>/<version>` (e.g. `writ-sdk-python/0.1.0`).
- Method naming: resource groups as namespaces — `client.workflows.list()`,
  `client.runs.get(id)`, etc. Go uses `client.Workflows.List(ctx, ...)`.
- License: MIT (matches the OSS split). Each package gets its own README with a quickstart.

## 3. Client construction & configuration

Options (every language, idiomatic casing):

| Option      | Default                        | Notes |
|-------------|--------------------------------|-------|
| `base_url`  | discovered (see §4)            | e.g. `http://127.0.0.1:8131`. No trailing `/v1` — SDK appends path prefixes itself. Accept and strip a trailing `/`. |
| `token`     | discovered (see §4)            | opaque bearer string |
| `timeout`   | 30 s per request               | run-and-wait helper manages its own deadline |
| `ca_file` / custom transport | none          | for the HTTPS twin port: Python `verify=`, Go `RootCAs`, Rust `add_root_certificate`, TS custom `fetch` |

Explicit options always win over discovery. If a token cannot be resolved at all,
construction fails with a **discovery error** whose message says how to fix it
("is the Writ agent running? pass token=... or set WRIT_TOKEN").

## 4. Daemon discovery (canonical algorithm)

Mirrors the daemon's own CLI/MCP discovery
(`src/local/cli/mcp_stdio.rs::daemon_candidate_homes`, `src/local/app/runtime_file.rs`).

1. **Env overrides**: `WRIT_API_URL` (base URL) and `WRIT_TOKEN` (bearer). If both are
   set, discovery is done. If only one is set, it fills that field and the rest is discovered.
2. **runtime.json candidates**, in order (first live one wins):
   1. `$WRIT_HOME/runtime.json` (if `WRIT_HOME` env set — always wins over the rest)
   2. `~/.writ/active_profile` → read profile id `p`; if non-empty, `p != "local"`,
      `len(p) <= 128`, chars ∈ `[A-Za-z0-9_-]` → `~/.writ/profiles/<p>/runtime.json`
   3. `~/.writ/runtime.json`
   4. every directory under `~/.writ/profiles/*/runtime.json` (cap 32, dedupe vs above)
3. `runtime.json` shape: `{"pid": u32, "port": u16, "token": "wlt_…", "version": str,
   "started_at": rfc3339}`. Base URL = `http://127.0.0.1:<port>`.
4. **Liveness probe**: a candidate counts only if `GET /v1/agent` with its token answers
   2xx within 2 s. A stale descriptor (crashed daemon) falls through to the next candidate.
   If exactly one candidate exists, still probe it — better a clear discovery error at
   construction than a confusing 401 later. (Languages where constructor I/O is
   unidiomatic — Go, Rust — may defer the probe to a `Connect()`/`connect()` factory;
   plain constructors then skip the probe but keep the candidate order.)
5. Discovery is **filesystem-based and desktop-only**: the browser build of the TS SDK
   requires explicit `baseUrl` + `token` (no `fs` access; throw a clear error).

## 5. Error model

Three error kinds per SDK, one shared base (`WritError`):

- **`WritApiError`** — non-2xx HTTP response. Fields: `status` (int), `code` (string),
  `message` (string), `body` (parsed JSON value or raw text).
  - Domain errors are JSON `{"error": "<msg>", "code": "<code>"}` (e.g.
    `{"error":"unauthorized","code":"unauthorized"}`, `{"error":"not found: workflow 999999","code":"not_found"}`).
  - Some axum rejections are **plain text** (e.g. body-deserialize: `Failed to deserialize
    the JSON body into the target type: missing field 'url'` with 4xx). Parse JSON if
    possible; else `message` = raw text (truncate to ~500 chars), `code` derived from
    status (`400→bad_request, 401→unauthorized, 403→forbidden, 404→not_found,
    409→conflict, 422→unprocessable, 429→rate_limited, 5xx→internal`).
  - `message` resolution from a JSON body: `error` → `detail` → `message` → status text.
- **`WritConnectionError`** — network failure / timeout (daemon down mid-session).
- **`WritDiscoveryError`** — no live daemon found at construction (see §4).

No automatic retries in v1 (loopback; the desktop UI's 401-refetch dance is not our
concern — an SDK token is static for the process lifetime).

## 6. List envelopes & the `Page` shape

The daemon is inconsistent (mirrors `frontend-desktop/src/api/client.ts::unwrapList`):

- `{"data": [...], "count": n}` — workflows, personas, secrets, files, keys, ai-sessions…
- `{"data": [...], "count": n, "total": n}` — runs
- **bare array** — monitors, automations (and some sub-lists like selectors/changes —
  verify per endpoint in source)

Every SDK list method returns a uniform **`Page`**: `{ data: [...], count: int,
total: int|null }`. For bare arrays synthesize `count = len(data)`, `total = null`.
Never expose the raw envelope difference to users.

## 7. Resource surface (v1)

All paths below are relative to the base URL. Query params pass through as given.
Request/response **field-level shapes come from the Rust source** — each SDK author must
read the listed files; do not invent fields. Dynamic/JSON-ish fields (workflow `steps`,
`form_data`, run `result`, etc.) are loosely typed (`unknown`/`Any`/`json.RawMessage`/
`serde_json::Value`); stable scalar fields are strongly typed.

### agent — `api/v1/…` root (`server.rs`)
| Method | Endpoint | SDK method |
|---|---|---|
| GET `/v1/agent` | lightweight status | `agent.status()` |
| GET `/v1/health` | deep health | `agent.health()` |

### workflows — `api/v1/workflows.rs`, model `store/workflows.rs`
| GET `/v1/workflows` | `workflows.list(params?)` → Page\<Workflow\> |
| POST `/v1/workflows` | `workflows.create(body)` |
| GET `/v1/workflows/:id` | `workflows.get(id)` |
| PATCH `/v1/workflows/:id` | `workflows.update(id, patch)` |
| DELETE `/v1/workflows/:id` | `workflows.delete(id)` |
| POST `/v1/workflows/:id/run` | `workflows.run(id, opts?)` → 202 `{run_id, status:"running"}`; `dry_run:true` → 200 dry-run report |
| POST `/v1/workflows/:id/cancel` | `workflows.cancel(id)` |
| GET `/v1/workflows/:id/session` | `workflows.session(id)` |
| DELETE `/v1/workflows/:id/session` | `workflows.clearSession(id)` |

`run` body: `{ inputs?: object, persona_id?: int, dry_run?: bool, files?: {slot: file_id} }`
(`form_data` is an accepted alias for `inputs` — SDKs expose only `inputs`).

Workflow rows are `redact()`ed by the daemon: no `credentials_encrypted`; adds
`has_credentials`, `credential_keys`, `placeholders`, `has_login`. Type the important
scalars (`id`, `name`, `description`, `entry_url`, `is_active`, `workflow_type`,
`schedule_*`, `last_run_*`, `created_at`, `updated_at`, …) and keep the rest open.

### runs — `api/v1/runs.rs` (read + control)
| GET `/v1/runs` | `runs.list(params?)` → Page\<RunFeedItem\> (filters: `entity_id`, `workflow_id`, `run_type`, `status`, `limit`, `offset`) |
| GET `/v1/runs/:id` | `runs.get(runId)` — **numeric row id** |
| GET `/v1/runs/:id/results` | `runs.results(runId)` → `{run_id, status, result}` |
| GET `/v1/runs/:id/data` | `runs.data(runId)` → extracted rows; `runs.dataCsv(runId)` → CSV string (`?format=csv`) |
| GET `/v1/runs/:id/events` | `runs.events(runId)` → SSE stream (§8) |
| POST `/v1/runs/:id/cancel` | `runs.cancel(runId)` → 202 `{run_id,status:"cancel_requested"}` or **409** `{status:"not_running"}` (409 here is a valid answer — return it, don't throw; model as a result) |

`RunFeedItem.id` is a **composite string** `"<run_type>-<row_id>"` (e.g. `"workflow-3"`);
the numeric id for `get/cancel/events` is the row id (the part after the last dash).
Provide `RunFeedItem.run_id`-style accessor/helper per language. Statuses: `running`,
`success`, `failed`, `cancelled`, `timeout`, `captcha_required`, `twofa_required`
(serde snake_case of `engine/mod.rs::RunStatus`) — treat as open string enums.

### monitors — `api/v1/monitors.rs`, model `store/targets.rs`
list/create/get/update/delete + `POST /v1/monitors/:id/run`, `GET /v1/monitors/:id/changes`,
`GET /v1/monitors/capacity`, `GET /v1/changes/recent` (`monitors.recentChanges()`).
Create requires non-empty `url`; a 409 `device_capacity` is a normal `WritApiError`.
`changes(id)` is NOT a plain list — it returns
`{monitor_id, limit, offset, has_more, changes: [...], uptime_checks: [...]}`; expose it
as that object, not a Page.

### selectors — `api/v1/selectors.rs` (nested under monitors)
`list(monitorId)`, `create(monitorId, body)`, `get/update/delete(monitorId, selectorId)`,
`toggle`, `test`, `setBaseline`, `clearBaseline` (all `POST /v1/monitors/:id/selectors/:sid/…`).

### extractors — `api/v1/extractors.rs`
`list(selectorId)` (`GET /v1/selectors/:sid/extractors`), `create(body)`
(`POST /v1/extractors`), `get/update/delete(extractorId)`, `toggle` (PATCH), `test` (POST).

### automations — `api/v1/automations.rs`
list/create/get/update/delete + `enable(id)`, `run(id)`.

### personas — `api/v1/personas.rs`
list/create/get/update/delete + `runs(id)`, `validateTotp(body)`, `test2fa(id)`.
(Skip the authenticator-import endpoints in v1.)

### secrets — `api/v1/secrets.rs`
`list()`, `set(...)` (POST `/v1/secrets`; body is `name` (legacy alias `key`) plus ONE of
`value` | `username`+`password` | `card` — duplicate name is a **400**, not 409),
`get(key)` (returns **metadata**, never the value), `delete(key)`.
Secrets and persona write/test routes return **423** `vault_locked` when the app-lock
vault is locked — a normal `WritApiError`.

### vault — `api/v1/vault.rs`
`status()`, `lock()`, `unlock(body)`.

### files — `api/v1/files.rs`
`list()`, `upload(...)` (multipart POST `/v1/files`), `fromData(body)`
(`POST /v1/files/from-data`), `get(id)`, `delete(id)`, `content(id)` → raw bytes.

### data — `api/v1/data.rs`
`listDataWorkflows()` (`GET /v1/data` — takes NO query params; returns `{workflows: [...]}`,
not a Page), `workflowData(id, params)`, `deleteWorkflowData(id)`, `facets(id)`,
`export(id, params)` (raw bytes/string), `dataRuns(id)`. Note: some lens-param 400s on
these routes use FastAPI-shaped `{"detail": ...}` bodies — the §5 message-resolution
chain (`error`→`detail`→`message`) handles them.

### crawl — `api/v1/crawl.rs`, model `store/crawl_jobs.rs`
The **Dragnet** whole-site crawl. One crawl fans a seed URL across a bounded in-process
worker pool; extracted pages aggregate under a synthetic per-crawl workflow, read back
through the Data API (`/v1/workflows/{data_workflow_id}/data`).

| Method | Endpoint | SDK method |
|---|---|---|
| GET `/v1/crawl` | `crawl.list(params?)` — `?limit` (default 50, max 500) |
| POST `/v1/crawl` | `crawl.start(body)` → the queued crawl view |
| GET `/v1/crawl/:id` | `crawl.get(id)` (404 if missing) |
| POST `/v1/crawl/:id/cancel` | `crawl.cancel(id)` (404 if missing) |

`list` does **NOT** return a `Page` — it returns `{"crawls": [CrawlJob…]}` (mirror the
`data.listDataWorkflows()` non-Page shape). Expose it as that object (or unwrap to the
`crawls` array per idiom), never as a `Page`.

`start` body: `{ url (required, empty → 400), name?, extract_mode? ("markdown"|"schema",
default "markdown"), extract_schema? (object), persona_id? (int), include_paths?:
string[], exclude_paths?: string[], max_depth? (default 3), page_budget? (default 500),
max_concurrent? (default 4), delay_ms? (default 250), respect_robots? (default true),
same_domain? (default true), allow_subdomains? (default true) }`. `include_paths`/
`exclude_paths` are path-regex allow/deny lists.

`cancel` returns the refreshed view plus a `cancel_requested_now: bool` (true iff this
call flipped it to `stopping`; false if already terminal). Not a 409 — always the view.

**`CrawlJob` view** (`to_view()`): type the scalars — `id`, `name`, `seed_url`,
`include_paths` (string[]), `exclude_paths` (string[]), `max_depth`, `same_domain` (0/1
int), `allow_subdomains` (0/1), `extract_mode`, `extract_schema` (object|null),
`persona_id`, `respect_robots` (0/1), `delay_ms`, `max_concurrent`, `page_budget`,
`workflow_id`, `data_workflow_id` (alias of `workflow_id`), `concierge_session_id`,
`status`, `pages_discovered`, `pages_done`, `pages_failed`, `pages_skipped`,
`workers_active`, `current_depth`, `error`, `cancel_requested` (0/1), `brand`
(`"Dragnet"`), `is_terminal` (bool), `created_at`, `updated_at`, `started_at`,
`completed_at`. Booleans arrive as `0/1` ints from SQLite — keep them typed as ints, do
not coerce (mirror the monitor rows). `status` ∈ `queued | mapping | crawling | stopping
| completed | failed | cancelled` (terminal: the last three) — treat as an open string
enum.

### cloud — the tiered `scrape` / `map` / `crawl` surface (CLOUD, not the daemon)
A separate namespace (`client.cloud`) that talks to **Writ Cloud** (`https://api.usewrit.app`, override
`WRIT_CLOUD_URL`), NOT the local daemon. Firecrawl-style tiering resolved from the credential:

- **Metered** — an API key (`apiKey` option → `WRIT_API_KEY` env) → `POST /api/crawl/scrape`,
  `POST /api/crawl/map`, `POST /api/crawl` (+ `GET /api/crawl/:id`), `Authorization: Bearer <key>`,
  billed per page. `scrape` + `map` + `crawl` all work.
- **Keyless** — no key → `POST /v1/keyless/scrape`, `POST /v1/keyless/map`, `GET /v1/keyless/quota`,
  identified by an `X-Writ-Client-Id` header (a stable per-install id minted/persisted at
  `~/.writ/client_id`; overridable via option or `WRIT_CLIENT_ID`). Free but **daily-capped** per
  device AND per IP. `scrape` + `map` only.

| Method | Tier | SDK method |
|---|---|---|
| `scrape(url)` | both | one page → `{ url, title, format, markdown, counts, tier, quota? }` |
| `map(url, {search?, limit?})` | both | ranked URLs → `{ url, host?, urls[], counts, tier, quota? }` |
| `crawl(url/body)` | **metered only** | starts a Dragnet crawl → `CrawlJob`. Keyless → `WritApiKeyRequiredError` (thrown BEFORE any request) |
| `crawlStatus(id)` | metered only | poll a crawl |
| `quota()` | keyless only | remaining daily allowance (`null` when metered) |

`tier` is `"keyless" | "metered"`. On the keyless tier every result carries `quota`
(`requests_remaining`, `pages_remaining`, `reset_at`, …). Error mapping (from the cloud's
`{detail:{message,code,reset_at,…}}`): 429 → **`WritRateLimitedError`** (`resetAt`,
`requestsRemaining`, `pagesRemaining`); 402 `api_key_required` → **`WritApiKeyRequiredError`**; other
402 → **`WritInsufficientCreditsError`**. Credential precedence: constructor `apiKey` → `WRIT_API_KEY`
→ keyless (the same chain scales an anonymous test to a metered key with no call-site change).

### keys — `api/v1/keys.rs` (requires `manage` scope, i.e. `wlt_`)
`list()`, `create(body)` → the plaintext `wlk_` key appears **only** in this response,
`get(id)`, `delete(id)`.

### ws-ticket — `api/v1/ws_ticket.rs`
`wsTicket(route, channel?)` → `{ticket: "wtk_…", expires_in_secs}`. Route ∈
`"record" | "ai-preview"`; ai-preview requires `channel`. (SDKs mint tickets; actually
opening the WS is out of scope for v1 except TS, which may ship a `openRecordSocket`
convenience since the desktop already has `daemonWs.ts` semantics.)

**Out of scope for v1** (document in README as roadmap): OAuth AS endpoints, `/mcp`
JSON-RPC, OpenAI-compat routes, cloud/* (feature-gated), backup/update/network/tls/
settings/diagnostics/notifications, AI surfaces (`ai-assist`, `ai-sessions`,
`ai-concierge`, streaming sessions), relay, hooks.

## 8. Run events (SSE) & `run_and_wait`

`GET /v1/runs/:id/events` is **Server-Sent Events** (`text/event-stream`):

- Frames are **named** SSE events: `event: <name>` + `data: <json>`, name ∈
  `started | step | progress | finished | error`. The JSON also carries the same
  discriminant in an `"event"` field (serde tag), so parsing `data` alone is sufficient.
- Payloads (from `engine/events.rs::RunEvent`, all snake_case):
  - `started {run_id, total_steps}`
  - `step {run_id, index, step_type, status}` with status ∈ `running|succeeded|failed|skipped`
  - `progress {run_id, completed, total}`
  - `finished {run_id, status}` — **stream-closing**
  - `error {run_id, message}` — **stream-closing**
- Keep-alive comment frames (`:` lines) every 15 s — must be ignored by the parser.
- A run that is already finished yields exactly one terminal frame, then the stream closes.
- SDK shape: an iterator/async-iterator/callback of typed `RunEvent`s that ends after a
  terminal event. Implement a minimal SSE parser in-package (split on blank line;
  accumulate multi-`data:` lines; ignore `:` comments and `id:`/`retry:` fields). No
  reconnect logic in v1 (terminal events close cleanly; a dropped stream surfaces as a
  connection error the `run_and_wait` fallback handles).

**`workflows.run_and_wait(id, opts)`** (TS `runAndWait`, Go `RunAndWait`):
1. `run(id, opts)` → `run_id` (reject `dry_run` here).
2. Subscribe to `runs.events(run_id)`; resolve on `finished`/`error`.
3. If the SSE connection fails or drops pre-terminal → **poll** `runs.get(run_id)` every
   1 s until `status != "running"`.
4. Overall deadline: `wait_timeout` option, default **600 s**, then a timeout error
   (the run itself is NOT cancelled — say so in the docstring).
5. Return the final `RunFeedItem` (fetch once after terminal event). Convenience flag
   `include_results` fetches `runs.results()` too where idiomatic.

## 9. Testing bar (every SDK)

Unit tests run against an **in-process mock HTTP server** (node:http / pytest+httpx
MockTransport / httptest / wiremock-rs or a tokio hyper stub). Required coverage:

1. Discovery: temp home dir with `active_profile` + `profiles/<id>/runtime.json` resolves
   port+token; stale-candidate fallthrough; env override wins; missing → discovery error.
2. Auth header + User-Agent on the wire.
3. Envelope normalization: `{data,count}`, `{data,count,total}`, bare array → same `Page`.
4. Error mapping: JSON `{error,code}`; plain-text 4xx; connection refused.
5. `run` → 202 shape; `run_and_wait` happy path over SSE (started→step→finished) **and**
   the SSE-drop → polling fallback; keep-alive comments ignored.
6. CSV lane (`runs.dataCsv`) returns raw text; `files.content` returns bytes.
7. Multipart upload sends a well-formed body (files.upload).

Plus an env-gated **live smoke test** (`WRIT_SMOKE=1`) that discovers the real daemon and
calls `agent.status()` + `workflows.list()` + `runs.list(limit=1)` — skipped by default.

## 10. Docs bar

Each package README: install, 5-line quickstart (construct → list workflows → run and
wait → print extracted rows), auth/discovery explanation (incl. `WRIT_API_URL`/
`WRIT_TOKEN`/`WRIT_HOME`), error handling example, SSE example, link to
`sdks/openapi/writ-agent.yaml`. Keep the tone of the repo (`ENGINEERING_GUIDELINES.md`).
