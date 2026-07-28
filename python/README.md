# writ-agent

Official Python SDK for the **Writ local agent** (`writ-agentd`) — the loopback
daemon that runs your workflows, monitors, and automations on your own machine.

- Sync **and** async clients (`WritAgent`, `AsyncWritAgent`), same surface.
- Automatic daemon discovery (env → `runtime.json` → liveness probe).
- Typed run events over SSE, `run_and_wait` with SSE→polling fallback.
- One runtime dependency: [`httpx`](https://www.python-httpx.org/).

```bash
pip install writ-agent
```

Requires Python ≥ 3.10 and a running Writ agent (the desktop app's daemon, or
`writ-agentd` standalone).

## Quickstart (sync)

```python
from writ_agent import WritAgent, run_row_id

with WritAgent() as client:                      # discovers the local daemon
    for wf in client.workflows.list():
        print(wf["id"], wf["name"])

    run = client.workflows.run_and_wait(3, inputs={"city": "Paris"})
    print(run["status"], run["rows_extracted"])
    print(client.runs.data(run_row_id(run))["data"])   # extracted rows
```

## Quickstart (async)

```python
import asyncio
from writ_agent import AsyncWritAgent, run_row_id

async def main():
    async with AsyncWritAgent() as client:
        workflows = await client.workflows.list()
        run = await client.workflows.run_and_wait(workflows[0]["id"])
        data = await client.runs.data(run_row_id(run))
        print(run["status"], data["data"])

asyncio.run(main())
```

On `AsyncWritAgent` every resource method returns an awaitable of the same
shape the sync client returns, and `runs.events` is an async generator.

## Auth & discovery

The agent serves plain HTTP on `127.0.0.1:8131` (HTTPS twin on `:8132`) and
requires `Authorization: Bearer <token>` on every request. Tokens are opaque
strings (`wlt_` runtime token, `wlk_` scoped API key, or `wlo_` OAuth token).

When you construct a client without `base_url`/`token`, the SDK discovers a
live daemon:

1. **Env overrides** — `WRIT_API_URL` (base URL) and `WRIT_TOKEN` (bearer). If
   both are set, discovery is done; one alone fills that field and the rest is
   discovered.
2. **`runtime.json` candidates**, in order (first live one wins):
   1. `$WRIT_HOME/runtime.json` (when `WRIT_HOME` is set)
   2. `~/.writ/active_profile` → `~/.writ/profiles/<id>/runtime.json`
   3. `~/.writ/runtime.json`
   4. every `~/.writ/profiles/*/runtime.json` (capped at 32)
3. Each candidate is **probed** (`GET /v1/agent`, 2 s budget); a stale
   descriptor from a crashed daemon falls through to the next candidate.

Explicit options always win: `WritAgent("http://127.0.0.1:8131", "wlt_…")`.
`WritAgent` runs discovery in its constructor; `AsyncWritAgent` defers it to
`async with` entry (or the first request) so the constructor never blocks —
that's also where `WritDiscoveryError` may be raised on the async client.

For the HTTPS twin port pass the per-install CA: `WritAgent(ca_file="~/.writ/tls/ca.pem")`.

## Error handling

```python
from writ_agent import WritAgent, WritApiError, WritConnectionError, WritDiscoveryError

try:
    with WritAgent() as client:
        client.workflows.get(999999)
except WritDiscoveryError as e:
    print("no daemon:", e)                     # not running / no token found
except WritConnectionError as e:
    print("daemon went away:", e)              # network failure / timeout
except WritApiError as e:
    print(e.status, e.code, e.message)         # 404 not_found not found: workflow 999999
    print(e.body)                              # parsed JSON body (or raw text)
```

`code` is a stable machine code — the daemon's own (`not_found`,
`vault_locked`, `device_capacity`, …) or derived from the status for plain-text
responses (`400→bad_request`, `409→conflict`, `5xx→internal`, …).

Special case: `runs.cancel` / `workflows.cancel` return the response body for
**both** 202 (`{"status": "cancel_requested"}`) and 409
(`{"status": "not_running"}`) — a 409 there is a valid answer, not an exception.

## Streaming run events (SSE)

```python
started = client.workflows.run(3, inputs={"city": "Paris"})
for event in client.runs.events(started["run_id"]):
    match event["event"]:
        case "started":  print("steps:", event["total_steps"])
        case "step":     print(event["index"], event["step_type"], event["status"])
        case "progress": print(f'{event["completed"]}/{event["total"]}')
        case "finished": print("done:", event["status"])
        case "error":    print("failed:", event["message"])
```

The iterator ends after the stream-closing `finished`/`error` event; a run
that already finished yields exactly one terminal frame. On the async client
use `async for`.

`workflows.run_and_wait(id, inputs=…, wait_timeout=600, poll_interval=1.0,
include_results=False)` wraps this: it subscribes to SSE and, if the stream
fails or drops pre-terminal, falls back to polling `runs.get` — and raises
`WritTimeoutError` after `wait_timeout` **without cancelling the run**.


## Waiting: three ways

The daemon's run endpoint is **async by default** and you choose how to wait:

| You want | Call | You get |
| --- | --- | --- |
| A handle to watch yourself | `workflows.run(id)` | `202 {run_id}` — stream `runs.events(run_id)` |
| Just the answer, one request | `workflows.run(id, wait=True)` | The terminal run document |
| Live events + the enriched feed item | `workflows.run_and_wait(id)` | Final `RunFeedItem` (+ results) |

`wait=True` is the **server-side** wait (`?wait=true`): the daemon blocks and answers
with the run's own result — no SSE, no poll loop.

```python
done = client.workflows.run(3, wait=True, timeout=60)
if done["status"] == "success":
    print(done["data"])
else:
    print(done.get("error"))      # a FAILED run RETURNS — check status
```

A run that fails is a **result**, not an exception. Only an expired budget raises
`WritRunTimeoutError`, which carries the still-valid `run_id` — the run keeps going,
so collect it rather than retrying (a retry starts a *second* run):

```python
from writ_agent import WritRunTimeoutError

try:
    client.workflows.run(3, wait=True, timeout=30)
except WritRunTimeoutError as err:
    for event in client.runs.events(err.run_id):
        ...
```

Both clients share one decode path, so `await async_client.workflows.run(3, wait=True)`
behaves identically. Reach for `run_and_wait` when you want live progress or a deadline
longer than the daemon's own ceiling (`timeout` is clamped server-side to 1–3600 s,
default 120).

## Surface

Namespaces on both clients (all list methods return a uniform
`Page(data, count, total)` — iterable and `len()`-able — regardless of the
wire envelope):

| Namespace | Highlights |
|---|---|
| `client.agent` | `status()`, `health()` |
| `client.workflows` | `list/create/get/update/delete`, `run`, `run_and_wait`, `cancel`, `session`, `clear_session` |
| `client.runs` | `list/get`, `results`, `data`, `data_csv` (str), `events` (SSE), `cancel` |
| `client.monitors` | CRUD, `run`, `changes`, `capacity`, `recent_changes` |
| `client.selectors` | per-monitor CRUD, `toggle`, `test`, `set_baseline`, `clear_baseline` |
| `client.extractors` | CRUD, `toggle`, `test` |
| `client.automations` | CRUD, `enable`, `run` |
| `client.personas` | CRUD, `runs`, `validate_totp`, `test_2fa` |
| `client.secrets` | `list`, `set`, `get` (metadata only — values never come back), `delete` |
| `client.vault` | `status`, `lock`, `unlock` (app-lock; locked → 423 `vault_locked`) |
| `client.files` | `list`, `upload` (multipart), `from_data`, `get`, `delete`, `content` (bytes) |
| `client.data` | `query`, `workflow_data`, `delete_workflow_data`, `facets`, `export`, `data_runs` |
| `client.crawl` | `list` (→ `{crawls:[…]}`, not a `Page`), `start`, `get`, `cancel` (Dragnet whole-site crawl) |
| `client.cloud` | `scrape`, `map`, `crawl`, `crawl_status`, `quota` — the tiered **cloud** surface |
| `client.keys` | `list`, `create` (plaintext `wlk_` key shown once), `get`, `delete` |
| `client.ws_ticket(route, channel=None)` | mint a single-use WebSocket ticket |

### Cloud tier (`client.cloud`) — scrape / map / crawl

Runs on **Writ Cloud** (not the local daemon), Firecrawl-style, tier resolved from your credential:

```python
# Metered: pass api_key (or set WRIT_API_KEY) → billed per page.
client = WritAgent(api_key="wt_…")
page = client.cloud.scrape("https://example.com")      # {"markdown": …, "tier": "metered"}
job  = client.cloud.crawl("https://example.com", page_budget=200)

# Keyless: no key → free, daily-capped per install (X-Writ-Client-Id) + per IP; scrape + map only.
anon = WritAgent()
p = anon.cloud.scrape("https://example.com")            # {"markdown": …, "tier": "keyless", "quota": {…}}
anon.cloud.crawl("https://example.com")                 # raises WritApiKeyRequiredError
```

Precedence `api_key` → `WRIT_API_KEY` → keyless. Errors: `429 → WritRateLimitedError` (`.reset_at`),
`402 api_key_required → WritApiKeyRequiredError`, other `402 → WritInsufficientCreditsError`. The async
client (`AsyncWritAgent`) exposes the same `client.cloud` with awaitable methods.

Responses are plain dicts (annotated with `TypedDict`s) — new daemon fields
pass straight through. `run_row_id(item)` extracts the numeric row id from a
run feed item's composite `"workflow-3"` id.

The machine-readable spec lives at
[`sdks/openapi/writ-agent.yaml`](../openapi/writ-agent.yaml).

**Roadmap (not in v1):** OAuth AS endpoints, `/mcp` JSON-RPC, OpenAI-compat
routes, cloud link surfaces, backup/update/network/TLS/settings/diagnostics/
notifications, AI surfaces (ai-assist / ai-sessions / ai-concierge / streaming
sessions), relay, webhooks, opening WebSockets.

## Development

```bash
pip install -e '.[dev]'
pytest                      # unit tests (mock transport + loopback stubs)
WRIT_SMOKE=1 pytest         # + live smoke test against your running daemon
```

MIT license.
