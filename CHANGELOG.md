# Changelog

All notable changes to the Writ SDKs are documented here. The four packages
version independently; each entry names the SDKs it affects. This project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-07-27

First public release of all four SDKs.

### Added

- **TypeScript** `@usewrit/agent-sdk` — zero runtime dependencies, Node ≥18
  built-in `fetch`.
- **Python** `writ-agent` (import `writ_agent`) — sync `WritAgent` and
  `AsyncWritAgent`, `httpx` only.
- **Go** `github.com/usewrit/writ-sdks/go` (package `writ`) — standard library
  only, `iter.Seq2` SSE, race-clean.
- **Rust** `writ-client` — `reqwest`, no `tokio` in the library's dependencies.

All four implement one contract ([`DESIGN.md`](./DESIGN.md)) over two surfaces:

- the **local `writ-agentd` daemon** — workflows, runs, data, monitors,
  automations, secrets, files, personas, recording;
- **Writ Cloud** (`.cloud`) — `scrape`, `map`, `crawl`, `crawl_status`, `quota`,
  across a free keyless tier and an authenticated metered tier, with typed
  errors for rate limiting, key-required and insufficient-credit conditions.

Shared behaviour, identical in every language and covered by tests:

- **Discovery** — `WRIT_API_URL`/`WRIT_TOKEN`, then `$WRIT_HOME/runtime.json`,
  then `~/.writ/active_profile` → that profile's descriptor, then
  `~/.writ/runtime.json`, then a bounded scan of `~/.writ/profiles/*` (cap 32),
  each candidate liveness-probed before use.
- **Uniform pagination** — the daemon's three list envelopes (bare array,
  `{data,count}`, `{data,count,total}`) normalize to one `Page` type.
- **SSE run events** with a polling fallback when the stream drops, and
  `run_and_wait` that times out *without* cancelling the run.
- **Typed errors** mapped from the daemon's several error shapes.

### Security

- The base URL is composed from the **port** in `runtime.json`, never from a URL
  in it, so a tampered descriptor cannot redirect the local token to a remote
  host.
- Profile ids are validated (non-empty, not `local`, ≤128 chars, `[A-Za-z0-9_-]`,
  anchored at both ends) before being used in a filesystem path.
- The library code contains no logging, so the token cannot reach a log.
- The keyless cloud tier persists a pseudonymous client id at `~/.writ/client_id`
  and sends it with keyless requests. This is disclosed in
  [`SECURITY.md`](./SECURITY.md); it is not created unless you make a keyless
  cloud call.

### Fixed

- **All four:** each package now ships its `LICENSE`. Every SDK declared MIT
  while shipping no licence text — for TypeScript the `files` list would have
  omitted it from the npm tarball entirely.
- **Python:** `Homepage` pointed at `https://usewrit.com`, which does not
  resolve — the project's domain is `usewrit.app`. It now points at the
  repository.
- **Go:** the live smoke test logged `total=%v` on a `*int`, printing a pointer
  address where the run count belongs — the smoke log is the evidence a
  maintainer reads, and it was showing `0xc000123456` instead of `0`.
- **Rust:** `cargo package` had no `include` list, so a publish would have swept
  in whatever sat in the directory — `target/` alone is over a gigabyte here.
- **TypeScript:** the dev toolchain carried 5 advisories (1 critical) via
  `vitest` → `vite`/`esbuild`. Bumped to `vitest` 3. These never shipped to
  users, but a compromised build tool writes the `dist/` that does.

### Known limitations

- **Writ Cloud is not live.** `https://api.usewrit.app`, the default cloud base
  URL, does not resolve yet. The local daemon surface is fully usable; `.cloud`
  calls will fail until the service launches or `WRIT_CLOUD_URL` is pointed
  elsewhere.
- OAuth, MCP, OpenAI-compatible and AI-assist surfaces are out of scope for
  0.1.x.
