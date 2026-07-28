# writ-client

Official Rust SDK for the **Writ local agent** (`writ-agentd`) — the loopback HTTP
API your workflows, monitors, runs, personas, secrets, and files live behind
(`http://127.0.0.1:8131`, all routes under `/v1`).

Async-only, built on `reqwest`. The full wire contract lives in
[`sdks/openapi/writ-agent.yaml`](../openapi/writ-agent.yaml); the cross-language SDK
contract is [`sdks/DESIGN.md`](../DESIGN.md).

## Install

```toml
[dependencies]
writ-client = "0.1.0"
tokio = { version = "1", features = ["rt-multi-thread", "macros"] } # or any reqwest-compatible runtime
```

## Quickstart

```rust
use writ_client::{RunOptions, WritAgent};

#[tokio::main]
async fn main() -> Result<(), writ_client::WritError> {
    let agent = WritAgent::discover().await?;               // find the running daemon
    let workflows = agent.workflows().list().await?;        // uniform Page<Workflow>
    let wf = &workflows.data[0];
    let outcome = agent.workflows().run_and_wait(wf.id, &RunOptions::default()).await?;
    let rows = agent.runs().data(outcome.run.row_id().unwrap()).await?;
    println!("{} → {}: {}", wf.name, outcome.run.status, rows.data);
    Ok(())
}
```

## Auth & discovery

Every request carries `Authorization: Bearer <token>`. Tokens are opaque strings:
`wlt_` (runtime token, full access), `wlk_` (scoped API key), `wlo_` (OAuth access
token).

`WritAgent::discover()` finds a running daemon the same way the daemon's own tools
do:

1. **Env overrides** — `WRIT_API_URL` (base URL) and `WRIT_TOKEN` (bearer). Both
   set ⇒ done; one set ⇒ it pins that field and the rest is discovered.
2. **`runtime.json` candidates**, first *live* one wins (each is probed with a 2 s
   `GET /v1/agent`; stale descriptors from crashed daemons fall through):
   1. `$WRIT_HOME/runtime.json` (when `WRIT_HOME` is set — always first)
   2. `~/.writ/active_profile` → `~/.writ/profiles/<id>/runtime.json`
   3. `~/.writ/runtime.json`
   4. every `~/.writ/profiles/*/runtime.json` (capped at 32)

Explicit configuration always wins, and `build()` does no discovery or network I/O:

```rust
use std::time::Duration;
use writ_client::WritAgent;

let agent = WritAgent::builder()
    .base_url("http://127.0.0.1:8131")   // trailing '/' ok; no trailing /v1
    .token("wlk_...")                     // or rely on WRIT_TOKEN
    .timeout(Duration::from_secs(30))     // per-request; default 30 s
    .ca_pem_file("/Users/me/.writ/tls/ca.pem") // only for the HTTPS twin port 8132
    .build()?;
# Ok::<(), writ_client::WritError>(())
```

## Errors

Three kinds, one enum ([`WritError`]): `Api { status, code, message, body }` for
non-2xx responses (JSON `{error, code}` bodies and axum's plain-text rejections are
both normalized), `Connection` for network failures/timeouts, `Discovery` when no
live daemon can be found at construction. No automatic retries in v1.

```rust
use writ_client::WritError;

match agent.workflows().get(999_999).await {
    Ok(wf) => println!("{}", wf.name),
    Err(WritError::Api { status: 404, .. }) => println!("no such workflow"),
    Err(WritError::Api { code, message, .. }) => eprintln!("daemon said {code}: {message}"),
    Err(WritError::Connection(msg)) => eprintln!("daemon unreachable: {msg}"),
    Err(WritError::Discovery(msg)) => eprintln!("no daemon: {msg}"),
}
```

One deliberate exception: `runs().cancel()` / `workflows().cancel()` return
`Ok(CancelOutcome)` for **both** `202 cancel_requested` and `409 not_running` — a
run that already finished is an answer, not an error.

## Lists are always a `Page`

The daemon mixes `{data, count}`, `{data, count, total}`, and bare-array envelopes
on the wire. Every list method here returns the same
`Page<T> { data, count, total: Option<u64> }` regardless. Models type the stable
scalar fields and keep unknown wire fields in an `extra` map, so newer daemons never
break deserialization.

## Live run events (SSE)

`runs().events(run_id)` streams typed [`RunEvent`]s (`Started`, `Step`, `Progress`,
then a stream-closing `Finished` or `Error`; unknown future frames arrive as
`RunEvent::Unknown`). Keep-alive comment frames are handled inside the parser.

```rust
use futures_util::StreamExt;
use writ_client::RunEvent;

let mut events = agent.runs().events(run_id).await?;
while let Some(ev) = events.next().await {
    match ev? {
        RunEvent::Step { index, step_type, status, .. } => {
            println!("step {index} {step_type}: {status}")
        }
        RunEvent::Finished { status, .. } => println!("done: {status}"),
        RunEvent::Error { message, .. } => println!("failed: {message}"),
        _ => {}
    }
}
```

`workflows().run_and_wait(id, &opts)` wraps the whole lifecycle: start the run,
follow SSE, fall back to 1 s polling if the stream drops, enforce an overall
deadline (`RunOptions::wait_timeout`, default 600 s). On timeout the run is **not**
cancelled — it keeps executing on the daemon. Set `include_results: true` to fetch
`runs().results()` alongside the final run row.

## Waiting: three ways

The daemon's run endpoint is **async by default** and you choose how to wait:

| You want | Call | You get |
| --- | --- | --- |
| A handle to watch yourself | `workflows().run(id, &opts)` | `202 {run_id}` — stream `runs().events(..)` |
| Just the answer, one request | `workflows().run_wait(id, &opts, timeout)` | `RunCompleted` |
| Live events + the enriched feed item | `workflows().run_and_wait(id, &opts)` | `RunOutcome` |

`run_wait` is the **server-side** wait (`?wait=true`): the daemon blocks and answers
with the run's own result — no SSE, no poll loop.

```rust
let done = agent
    .workflows()
    .run_wait(id, &RunOptions::default(), Some(Duration::from_secs(60)))
    .await?;
match done.status.as_str() {
    "success" => println!("{:?}", done.data),
    _ => eprintln!("{:?}", done.error),   // a FAILED run is Ok — check status
}
```

A run that fails is an `Ok` value, not an `Err`. Only an expired budget is an error,
and it carries the still-valid run id so you collect the run rather than retry (a retry
starts a *second* run):

```rust
match agent.workflows().run_wait(id, &opts, Some(Duration::from_secs(30))).await {
    Err(WritError::RunTimeout { run_id, .. }) => { /* observe it; do not re-run */ }
    other => { other?; }
}
```

`timeout` is clamped server-side to 1–3600 s (default 120). Reach for `run_and_wait`
when you want live progress or a longer deadline than the daemon's own ceiling.

## Surface

`agent()`, `workflows()`, `runs()`, `monitors()`, `selectors()`, `extractors()`,
`automations()`, `personas()`, `secrets()` (metadata only — secret values never
cross the API), `vault()`, `files()` (multipart upload + raw byte download),
`data()` (queries + CSV/JSON exports), `keys()` (mint scoped `wlk_` keys),
`crawl()` (Dragnet whole-site crawls), plus `ws_ticket(route, channel)` for
single-use WebSocket tickets.

`crawl().list()` returns a `CrawlList { crawls }` (this endpoint answers a named
object, not a `Page`); `crawl().start(CrawlStartParams { url, .. })` kicks off a
crawl whose pages aggregate under the synthetic `CrawlJob::data_workflow_id`
workflow — read them back with `data().workflow_data(data_workflow_id, &[])`.

Out of scope for v1 (roadmap): OAuth AS endpoints, `/mcp` JSON-RPC, OpenAI-compat
routes, cloud-link surfaces, backup/update/network/TLS/settings/diagnostics/
notifications, the AI surfaces (`ai-assist`, `ai-sessions`, `ai-concierge`,
streaming sessions), relay, webhooks, and opening WebSockets.

## Cloud tier

`CloudClient` is a **separate surface** from `WritAgent`: `scrape`, `map`, and
whole-site `crawl` that run on **Writ Cloud**, never on the local daemon. The
credential decides the tier (Firecrawl-style fallback):

- **Metered** — an API key (builder `api_key` → `WRIT_API_KEY`) → the authed
  `/api/crawl/*` surface, billed per page. `scrape`, `map`, AND `crawl`.
- **Keyless** — no key → the free `/v1/keyless/*` tier, daily-capped per install
  (a stable `~/.writ/client_id` device header) and per IP. `scrape` + `map` only;
  `crawl` returns `WritError::ApiKeyRequired` **before any network call**.

```rust
use writ_client::{CloudClient, CloudTier, MapOptions, WritError};

# async fn demo() -> Result<(), writ_client::WritError> {
let cloud = CloudClient::from_env()?;   // metered if WRIT_API_KEY is set, else keyless
// or: CloudClient::builder().api_key("wt_...").cloud_url("https://api.usewrit.app").build()?

let page = cloud.scrape("https://example.com").await?;
println!("[{}] {}", cloud.tier(), page.markdown);   // tier() → CloudTier::{Keyless,Metered}

let sitemap = cloud.map("https://example.com", &MapOptions {
    search: Some("pricing".into()),
    limit: Some(20),
    ..Default::default()
}).await?;
println!("{} urls", sitemap.urls.len());

match cloud.crawl(&writ_client::CrawlStartParams { url: "https://example.com".into(), ..Default::default() }).await {
    Ok(job) => println!("crawl {}", job.id),
    Err(WritError::ApiKeyRequired { .. }) => println!("crawl needs an API key — scrape/map are keyless-ok"),
    Err(e) => return Err(e),
}

if let Some(q) = cloud.quota().await? {          // keyless only; None when metered
    println!("{} requests / {} pages left today", q.requests_remaining, q.pages_remaining);
}
# Ok(())
# }
```

Config resolves per field: builder value → env (`WRIT_API_KEY`, `WRIT_CLOUD_URL`,
`WRIT_CLIENT_ID`) → default (`https://api.usewrit.app`; the client id is loaded/minted
at `~/.writ/client_id`, ephemeral on a read-only fs). Cloud errors map to
`WritError::RateLimited` (429, carries `reset_at` + remaining allowances),
`ApiKeyRequired` (402 `api_key_required`), and `InsufficientCredits` (other 402s);
everything else is the generic `Api` variant.

## Testing

`cargo test` runs everything against an in-process stub server. An env-gated smoke
test talks to your real daemon:

```sh
WRIT_SMOKE=1 cargo test --test live_smoke -- --nocapture
```

## License

MIT
