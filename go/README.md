# Writ Agent SDK for Go

The official Go client for the **Writ local agent** (`writ-agentd`) — the loopback
HTTP daemon that runs and monitors your workflows on `127.0.0.1:8131`.

- Module: `github.com/usewrit/writ-sdks/go`, package `writ`
- Go ≥ 1.23, **zero dependencies** (stdlib only)
- License: MIT

```sh
go get github.com/usewrit/writ-sdks/go
```

## Quickstart

```go
client, err := writ.Discover(ctx)                       // find the running agent
page, _ := client.Workflows.List(ctx, nil)              // list workflows
item, _ := client.Workflows.RunAndWait(ctx, page.Data[0].ID, nil) // run + wait
rowID, _ := item.RowID()
csv, _ := client.Runs.DataCSV(ctx, rowID)               // extracted rows as CSV
fmt.Println(item.Status, "\n", csv)
```

## Auth & discovery

Every request carries `Authorization: Bearer <token>`. The token is an opaque
string (`wlt_` runtime token, `wlk_` scoped API key, or `wlo_` OAuth token).

`writ.Discover(ctx)` (and the lazy first-request discovery of `writ.New()`)
resolves the endpoint exactly like the daemon's own tooling:

1. **Env overrides** — `WRIT_API_URL` (base URL) and `WRIT_TOKEN` (bearer).
   Both set → done. One set → it fills that field, the rest is discovered.
2. **`runtime.json` descriptors**, first live one wins:
   `$WRIT_HOME/runtime.json` → the active desktop profile
   (`~/.writ/active_profile` → `~/.writ/profiles/<id>/runtime.json`) →
   `~/.writ/runtime.json` → every `~/.writ/profiles/*/runtime.json`.
3. Each candidate is **liveness-probed** (`GET /v1/agent`, 2 s budget); a
   stale descriptor from a crashed daemon falls through to the next one.

Explicit options always win:

```go
client := writ.New(
    writ.WithBaseURL("http://127.0.0.1:8131"),
    writ.WithToken(os.Getenv("WRIT_TOKEN")),
    writ.WithTimeout(15*time.Second),          // default 30s per request
    // writ.WithCAFile("~/.writ/tls/ca.pem"),  // for the HTTPS twin port :8132
    // writ.WithHTTPClient(custom),            // full transport control
)
```

`writ.New` never performs I/O; if it cannot resolve a token, the first request
returns a `*writ.DiscoveryError` explaining how to fix it.

## Services

`client.Agent`, `client.Workflows`, `client.Runs`, `client.Monitors`,
`client.Selectors`, `client.Extractors`, `client.Automations`,
`client.Personas`, `client.Secrets`, `client.Vault`, `client.Files`,
`client.Data`, `client.Keys`, `client.Crawl`, `client.Cloud`
(the tiered Writ Cloud surface — see below), plus
`client.WSTicket(ctx, route, channel)`.

Every method takes a `context.Context` first. All list methods return a
uniform `writ.Page[T]{Data, Count, Total}` regardless of the daemon's wire
envelope, except `client.Crawl.List` (the Dragnet crawl), which returns the
daemon's `{crawls: [...]}` object as a `*writ.CrawlList`. Query parameters
pass through as `url.Values`.

## Error handling

Three error kinds, all `errors.As`-friendly and satisfying `writ.Error`:

```go
_, err := client.Workflows.Get(ctx, 999999)
var apiErr *writ.APIError
var connErr *writ.ConnectionError
var discErr *writ.DiscoveryError
switch {
case errors.As(err, &apiErr):
    fmt.Println(apiErr.Status, apiErr.Code, apiErr.Message) // 404 not_found ...
case errors.As(err, &connErr):
    // daemon down mid-session / timeout
case errors.As(err, &discErr):
    // no live agent found at construction
}
```

Cancel endpoints treat the daemon's `409 {"status":"not_running"}` as a normal
result: `client.Runs.Cancel` returns a `*writ.CancelResult`, not an error.

## Cloud tier (scrape / map / crawl)

`client.Cloud` is the tiered **Writ Cloud** surface — `Scrape`, `Map`, and
whole-site `Crawl`. Unlike the rest of this SDK (which talks to the local
daemon), these run on the cloud, never on the calling machine, with a
Firecrawl-style credential fallback:

- **Metered** — an API key (`WithAPIKey` → `WRIT_API_KEY`) → the authed
  `/api/crawl/*` endpoints (`Authorization: Bearer <key>`), billed per page.
  `Scrape`, `Map`, **and** `Crawl` all work.
- **Keyless** — no key → the free `/v1/keyless/*` tier, daily-capped per install
  (a stable `X-Writ-Client-Id` device id read/minted at `~/.writ/client_id`).
  `Scrape` + `Map` only; `Crawl` returns `*writ.APIKeyRequiredError` **before any
  network call**.

```go
client := writ.New(
    writ.WithAPIKey(os.Getenv("WRIT_API_KEY")), // omit → keyless tier
    // writ.WithCloudURL("https://api.usewrit.app"), // else WRIT_CLOUD_URL / default
    // writ.WithClientID("device-abc"),           // else WRIT_CLIENT_ID / ~/.writ/client_id
)

page, _ := client.Cloud.Scrape(ctx, "https://example.com")     // markdown, both tiers
fmt.Println(client.Cloud.Tier(), page.Markdown)                // "metered" | "keyless"

sitemap, _ := client.Cloud.Map(ctx, "https://example.com",     // ranked URLs
    &writ.CloudMapOptions{Search: "pricing", Limit: ptr(20)})

job, err := client.Cloud.Crawl(ctx, writ.CrawlStartParams{URL: "https://example.com"})
var keyErr *writ.APIKeyRequiredError
if errors.As(err, &keyErr) {
    // keyless tier — add an API key to crawl
}
status, _ := client.Cloud.CrawlStatus(ctx, job.ID)             // metered only
quota, _ := client.Cloud.Quota(ctx)                            // keyless only; nil when metered
```

Cloud errors map by status: `429` → `*writ.RateLimitedError` (carrying
`ResetAt` / `RequestsRemaining` / `PagesRemaining`), `402` `api_key_required` →
`*writ.APIKeyRequiredError`, other `402` → `*writ.InsufficientCreditsError`,
everything else → `*writ.APIError`. All embed `APIError` and are
`errors.As`-friendly.

## Run events (SSE)

`client.Runs.Events` streams the run lifecycle as a Go 1.23 range-over-func
sequence; it ends after the terminal `finished`/`error` event:

```go
started, _ := client.Workflows.Run(ctx, id, &writ.RunOptions{
    Inputs: map[string]any{"city": "Paris"},
})
for ev, err := range client.Runs.Events(ctx, started.RunID) {
    if err != nil { log.Fatal(err) }
    fmt.Printf("%s: step=%d %s %s\n", ev.Event, ev.Index, ev.StepType, ev.Status)
}
```

`client.Workflows.RunAndWait(ctx, id, opts)` wraps this: SSE first, transparent
1 s polling fallback if the stream drops, overall deadline
`opts.WaitTimeout` (default 600 s). **On timeout the run is NOT cancelled** —
it keeps executing in the daemon; call `client.Runs.Cancel` to stop it.

## Waiting: three ways

The daemon's run endpoint is **async by default** and you choose how to wait:

| You want | Call | You get |
| --- | --- | --- |
| A handle to watch yourself | `Workflows.Run(ctx, id, nil)` | `202 {run_id}` — stream `Runs.Events` |
| Just the answer, one request | `Workflows.RunWait(ctx, id, opts)` | `*RunCompleted` |
| Live events + the enriched feed item | `Workflows.RunAndWait(ctx, id, opts)` | `*RunFeedItem` |

`RunWait` is the **server-side** wait (`?wait=true`): the daemon blocks and answers
with the run's own result — no SSE, no poll loop.

```go
done, err := client.Workflows.RunWait(ctx, id, &writ.RunOptions{
    Inputs:  map[string]any{"sku": "B0C123"},
    Timeout: 60 * time.Second,
})
```

A run that FAILS comes back as `err == nil` with `done.Status == "failed"` — check it.
Only an expired budget is an error, and it carries the still-valid run id so you collect
the run rather than retry (a retry starts a *second* run):

```go
var timeout *writ.RunTimeoutError
if errors.As(err, &timeout) {
    events, _ := client.Runs.Events(ctx, timeout.RunID)
    // …observe it; do not call RunWait again
}
```

`Timeout` is clamped server-side to 1–3600 s (default 120). Reach for `RunAndWait` when
you want live progress or a longer deadline than the daemon's own ceiling.

## More lanes

```go
csv, _ := client.Runs.DataCSV(ctx, runID)                    // CSV string
blob, _ := client.Files.Content(ctx, "file_ab12")            // raw bytes
f, _ := client.Files.Upload(ctx, "report.csv", data,         // multipart
    &writ.UploadOptions{ContentType: "text/csv"})
```

## Testing

```sh
go test ./...              # hermetic (httptest servers)
WRIT_SMOKE=1 go test ./... # plus a read-only smoke test against a live daemon
```

## Spec

The wire contract shared by every Writ SDK lives in
[`sdks/DESIGN.md`](../DESIGN.md); the OpenAPI description is
[`sdks/openapi/writ-agent.yaml`](../openapi/writ-agent.yaml).

Out of scope for v1 (roadmap): OAuth AS endpoints, `/mcp` JSON-RPC,
OpenAI-compat routes, cloud/backup/update/network/TLS/settings/diagnostics/
notifications surfaces, AI surfaces (ai-assist / ai-sessions / ai-concierge /
streaming sessions), relay, webhooks ingress, and opening WebSockets (the SDK
mints `ws-ticket`s only).
