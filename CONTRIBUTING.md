# Contributing to the Writ SDKs

Four SDKs, one contract. That framing drives everything below.

## The contract comes first

[`DESIGN.md`](./DESIGN.md) is the **binding cross-language specification**:
discovery order, error mapping, the `Page` shape, SSE semantics, `run_and_wait`.
[`openapi/writ-agent.yaml`](./openapi/writ-agent.yaml) documents the wire.

**When a document and the daemon disagree, the daemon wins.** Wire truth lives
in `writ-agent`'s `src/local/`. The spec describes what the daemon *does*,
including the inconsistencies — some list endpoints return a bare array while
others return `{data,count[,total]}`, and the SDKs normalize that rather than
pretending it isn't so.

**A behaviour change belongs in all four SDKs, in one pull request.** That is
the entire reason they share a repository: a wire change that breaks four
languages should break them in the same CI run, not three of them silently and
months apart. A PR that changes one SDK's behaviour without the other three will
be asked for the rest.

Fixing a typo, a doc, or one language's idiom is of course fine on its own.

## Setup

Each SDK is independent — work on one without installing the others.

```bash
# TypeScript — Node >= 18
cd typescript && npm ci && npm test

# Python — 3.10+
cd python && pip install -e ".[dev]" && python -m pytest -q

# Go — 1.23+
cd go && go test -race ./...

# Rust
cd rust && cargo test
```

## Testing against a real daemon

The unit suites run against mock servers. Each SDK also has a **live smoke test**
that discovers a real `writ-agentd` and makes read-only calls. It is skipped
unless `WRIT_SMOKE=1`, and you should point `WRIT_HOME` at a throwaway directory
so it never touches your real profile:

```bash
export WRIT_HOME=/tmp/writ-smoke
writ-agentd &            # or the bundled binary, with WRIT_PORT=8231 WRIT_TLS_PORT=0

WRIT_SMOKE=1 npm test                                   # typescript
WRIT_SMOKE=1 python -m pytest -q                        # python
WRIT_SMOKE=1 go test -count=1 -run Smoke -v ./...       # go
WRIT_SMOKE=1 cargo test --test live_smoke -- --nocapture # rust
```

The smoke tests are **read-only by design**. Do not add a step that mutates
state — someone will eventually run these against a daemon that matters.

## What a good pull request looks like

- **A test that fails before your change.** Every SDK drives a mock server over
  the real transport rather than stubbing internals, because the wire behaviour
  *is* the contract.
- **Comments that justify, not narrate.** Explain why a decision was made — the
  existing code does.
- **A `CHANGELOG.md` entry** under `## [Unreleased]`, naming which SDKs changed.
- **Consistency across languages**, in behaviour. Not in style: each SDK should
  read as idiomatic in its own language (Go returns `(T, error)`, Rust returns
  `Result`, Python raises, TypeScript rejects).

## The dependency rule

These libraries hold a credential that can drive a browser and read stored
secrets. Every dependency is third-party code with access to it.

- **TypeScript and Go must stay at zero runtime dependencies.**
- **Python and Rust:** a new runtime dependency needs a reason in the PR
  description. `httpx` and the `reqwest`/`serde` stack are the whole budget.

Dev dependencies are held to a lower bar, but not none — a compromised build tool
writes the `dist/` that gets published.

## Releasing (maintainers)

Each package has its own tag prefix, so releases are independent:

| Package | Tag | Publishes to |
|---|---|---|
| `@usewrit/agent-sdk` | `typescript-v0.1.0` | npm |
| `writ-agent` | `python-v0.1.0` | PyPI |
| `writ-client` | `rust-v0.1.0` | crates.io |
| `github.com/usewrit/writ-sdks/go` | `go/v0.1.0` | the Go module proxy |

1. Move `## [Unreleased]` entries into a version section in `CHANGELOG.md`.
2. Bump the version in that SDK's manifest.
3. Push the tag.

Each release workflow refuses to publish if the tag and the manifest disagree.

> **The Go tag prefix is mandatory.** For a module in a subdirectory, a plain
> `v0.1.0` tag publishes nothing for `.../writ-sdks/go` while appearing to
> succeed. It must be `go/v0.1.0`. `release-go.yml` checks this.

Run a `workflow_dispatch` with `dry_run: true` first — it builds and verifies the
artifact without publishing, and registry versions are immutable.

## Security issues

Do not open a public issue. See [`SECURITY.md`](./SECURITY.md).

## License

Contributions are licensed under the [MIT License](./LICENSE), the same terms as
the rest of this repository.
