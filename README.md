<div align="center">
  <img src="./assets/banner.svg" alt="Writ SDKs — TypeScript, Python, Go and Rust clients for Writ" width="100%">

  <br/>

  <p align="center">
    <a href="https://github.com/usewrit/writ-sdks/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/usewrit/writ-sdks/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
    <a href="https://www.npmjs.com/package/@usewrit/agent-sdk"><img src="https://img.shields.io/npm/v/@usewrit/agent-sdk?style=flat-square&color=FF4A24&label=npm" alt="npm"></a>
    <a href="https://pypi.org/project/writ-agent/"><img src="https://img.shields.io/pypi/v/writ-agent?style=flat-square&color=FF4A24&label=pypi" alt="PyPI"></a>
    <a href="https://crates.io/crates/writ-client"><img src="https://img.shields.io/crates/v/writ-client?style=flat-square&color=FF4A24&label=crates.io" alt="crates.io"></a>
    <a href="https://pkg.go.dev/github.com/usewrit/writ-sdks/go"><img src="https://img.shields.io/badge/pkg.go.dev-reference-007D9C?style=flat-square&logo=go&logoColor=white" alt="pkg.go.dev"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-FF4A24?style=flat-square" alt="License: MIT"></a>
  </p>

  <h3 align="center">Four languages. One contract.</h3>

  <p align="center">
    <a href="#install"><b>Install</b></a> ·
    <a href="#the-two-surfaces"><b>Surfaces</b></a> ·
    <a href="#quick-start"><b>Quick start</b></a> ·
    <a href="./DESIGN.md"><b>Contract</b></a> ·
    <a href="./SECURITY.md"><b>Security</b></a> ·
    <a href="./CONTRIBUTING.md"><b>Contributing</b></a>
  </p>
</div>

---

Official SDKs for [Writ](https://github.com/usewrit/writ). They drive the
**`writ-agentd` daemon on your own machine** — run saved browser workflows, read
the data they collect, manage monitors and automations, record new ones — and
**Writ Cloud** — scrape a page to clean markdown, map a site, run a crawl.

All four implement the same specification, so an example translates almost line
for line between them.

## Install

| Language | Package | Install |
|---|---|---|
| **TypeScript** | [`@usewrit/agent-sdk`](https://www.npmjs.com/package/@usewrit/agent-sdk) | `npm i @usewrit/agent-sdk` |
| **Python** | [`writ-agent`](https://pypi.org/project/writ-agent/) | `pip install writ-agent` |
| **Go** | [`github.com/usewrit/writ-sdks/go`](https://pkg.go.dev/github.com/usewrit/writ-sdks/go) | `go get github.com/usewrit/writ-sdks/go` |
| **Rust** | [`writ-client`](https://crates.io/crates/writ-client) | `cargo add writ-client` |

Requirements: Node ≥18 · Python ≥3.10 · Go ≥1.23 · Rust stable.

Other languages: [`codegen/`](codegen/) generates raw REST bindings for Java, C#,
Ruby and PHP from the OpenAPI spec. Those are unsupported and lack discovery and
`run_and_wait` — see [`DESIGN.md`](DESIGN.md) §4/§8 to port those helpers.

## The two surfaces

**Local — your machine.** The client discovers a running `writ-agentd` and talks
to it over loopback (`127.0.0.1:8131`, HTTPS twin on `:8132`). Nothing leaves the
machine. Workflows, runs with live SSE events, data, monitors, selectors and
extractors, automations, personas, secrets, files, crawls and API keys.

**Cloud — the `.cloud` namespace.** `scrape`, `map`, `crawl`, `crawl_status`,
`quota`. Works with a Writ Cloud API key on the *metered* tier, or **with no key
at all** on a free daily-capped *keyless* tier.

> **Writ Cloud has not launched yet.** `https://api.usewrit.app` — the default
> cloud base URL — does not resolve, so `.cloud` calls currently fail with a
> connection error. The local surface works today. Point `WRIT_CLOUD_URL` at your
> own endpoint if you are running one.

> **Keyless calls send a persistent id.** Enforcing a free daily cap requires
> recognising the caller across runs, so the first keyless cloud call mints a
> random id at `~/.writ/client_id` and sends it thereafter. Purely local usage
> never creates it. Details and how to reset it: [`SECURITY.md`](./SECURITY.md).

## Quick start

Discovery is automatic: the SDK locates the running daemon and its token via
`WRIT_API_URL`/`WRIT_TOKEN`, then `$WRIT_HOME/runtime.json`, then your `~/.writ`
profile — probing each candidate before use.

**TypeScript**

```ts
import { WritAgent } from "@usewrit/agent-sdk";

const writ = await WritAgent.discover();

const workflows = await writ.workflows.list();
const run = await writ.workflows.runAndWait(workflows.data[0].id, {
  inputs: { query: "espresso" },
});
console.log(run.status);

const page = await writ.cloud.scrape("https://example.com");
console.log(page.markdown);
```

**Python**

```python
from writ_agent import WritAgent

writ = WritAgent()                      # discovers the running agent + token

workflows = writ.workflows.list()
run = writ.workflows.run_and_wait(workflows.data[0]["id"], inputs={"query": "espresso"})
print(run.status)

page = writ.cloud.scrape("https://example.com")
print(page["markdown"])
```

`AsyncWritAgent` is the same API with `await`.

**Go**

```go
client, err := writ.New(ctx)
if err != nil { log.Fatal(err) }

workflows, err := client.Workflows.List(ctx, nil)
run, err := client.Workflows.RunAndWait(ctx, workflows.Data[0].ID, nil)
fmt.Println(run.Status)

page, err := client.Cloud.Scrape(ctx, "https://example.com")
fmt.Println(page.Markdown)
```

**Rust**

```rust
let client = WritClient::discover().await?;

let workflows = client.workflows().list(None).await?;
let run = client.workflows().run_and_wait(workflows.data[0].id, None).await?;
println!("{}", run.status);

let page = client.cloud().scrape("https://example.com").await?;
println!("{}", page.markdown);
```

> Method names follow each language's conventions — `runAndWait` / `run_and_wait`
> / `RunAndWait`. Consult the SDK's own README for exact signatures.

## What's shared

Because these implement one contract rather than four independent clients:

- **Discovery**, identical everywhere: explicit config → `WRIT_API_URL` /
  `WRIT_TOKEN` → `$WRIT_HOME/runtime.json` → `~/.writ/active_profile` → that
  profile's descriptor → `~/.writ/runtime.json` → a bounded profile scan. Each
  candidate is liveness-probed with `GET /v1/agent` before it is trusted.
- **Uniform pagination.** The daemon returns three different list envelopes (a
  bare array, `{data,count}`, `{data,count,total}`). All three normalize to one
  `Page {data, count, total?}`, so you never branch on which endpoint you called.
- **Uniform errors**, mapped from the daemon's several error shapes — including
  its plain-text framework rejections — plus the cloud's quota and billing
  conditions.
- **Live run events** over SSE (`started` / `step` / `progress` / `finished` /
  `error`), with a polling fallback if the stream drops.
- **`run_and_wait`** that times out *without cancelling the run* — the run
  continues server-side; the timeout bounds your wait, not its lifetime.

The binding specification is [`DESIGN.md`](DESIGN.md); the wire is documented in
[`openapi/writ-agent.yaml`](openapi/writ-agent.yaml) (OpenAPI 3.1, 56 paths, 81
operations). It documents wire truth **including the inconsistencies** — that is
why the SDKs can paper over them. **When a document and the daemon disagree, the
daemon wins.**

## Repository layout

```
typescript/   @usewrit/agent-sdk         zero runtime dependencies
python/       writ-agent                 httpx
go/           .../writ-sdks/go           standard library only
rust/         writ-client                reqwest + serde
openapi/      writ-agent.yaml            OpenAPI 3.1 description of the wire
codegen/      generate.sh                Java/C#/Ruby/PHP via openapi-generator
DESIGN.md                                the binding cross-language contract
```

## Not covered in 0.1.x

OAuth authorization-server endpoints (the SDKs consume tokens, they don't mint
them), the `/mcp` JSON-RPC surface — use
[`writ-mcp`](https://github.com/usewrit/writ-mcp) for that — OpenAI-compatible
routes, marketplace routes, backup/update/network/TLS administration, and the AI
surfaces. The record and AI-preview WebSockets are covered only as ticket minting.

## Development

Each SDK is independent — you can work on one without installing the others.

```bash
cd typescript && npm ci && npm test
cd python     && pip install -e ".[dev]" && python -m pytest -q
cd go         && go test -race ./...
cd rust       && cargo test
```

Every SDK also carries a **live smoke test** that discovers a real `writ-agentd`
and makes read-only calls, skipped unless `WRIT_SMOKE=1`. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) — note the two rules there: a behaviour
change belongs in **all four** SDKs in one pull request, and TypeScript and Go
stay at **zero runtime dependencies**.

## The rest of Writ

| | |
|---|---|
| [**usewrit/writ**](https://github.com/usewrit/writ) | The self-host coordinator — web UI, API, your data. |
| [**usewrit/writ-agent**](https://github.com/usewrit/writ-agent) | The Rust agent these SDKs talk to. |
| [**usewrit/writ-mcp**](https://github.com/usewrit/writ-mcp) | Connect Claude Code, Claude Desktop or Cursor to Writ over MCP. |

## License

**MIT** — see [`LICENSE`](./LICENSE).
