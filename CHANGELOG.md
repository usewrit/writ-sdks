# Changelog

All notable changes to the Writ SDKs are documented here. The four packages
version independently; each entry names the SDKs it affects. This project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] — 2026-08-20 — TypeScript, Python, Go, Rust

### Added

- **Scrape a page that is behind a login, or that blocks datacenter IPs.** `scrape` takes two new
  optional arguments, and the crawl parameters gain the same pair:
  - `persona_id` / `personaId` / `PersonaID` — scrape as a saved identity, so a page only visible
    to a signed-in user can be read. Metered tier only, and it forces that identity's own
    residential exit so the request comes from where the identity normally appears.
  - `use_residential` / `useResidential` / `UseResidential` — route through the platform
    residential network for sites that refuse datacenter addresses. Money-safe: it degrades to a
    direct fetch when it cannot be funded rather than failing the call.

  Both are ignored on the keyless tier, which is always direct, and both default off — an existing
  call behaves exactly as before.


## [1.2.0] — 2026-08-15 — TypeScript, Python, Go, Rust

### Added

- **List the original documents a crawl captured.** A crawl's dataset holds the
  extracted *text*; these return the source files it came from — PDFs, office
  documents, images and CSVs the crawler reached. Each entry carries the file
  metadata plus a short-TTL `download_url` that needs no further auth, so it can be
  streamed straight to disk.
  - `crawlFiles` / `crawl_files` / `CrawlFiles` — one crawl run's documents.
  - `savedCrawlFiles` / `saved_crawl_files` / `SavedCrawlFiles` — a saved crawl's
    recent completed run(s). The default is the latest run, i.e. the current
    version of every document; raise `runs` to reach older versions from earlier
    runs.

  Both require an API key and refuse on the keyless tier **before** any network
  call. `version` counts captures of a source URL whose bytes changed across
  re-crawls, and `crawl_ids` lists every crawl referencing that exact version —
  re-crawl dedupe links one file to many crawls rather than storing it twice.

### Note

- **TypeScript 1.1.1 was never published to npm.** Its Node 18 webhook-crypto fix
  ships here, so 1.2.0 is the first npm release carrying it. Nothing is lost by
  skipping 1.1.1.


## [1.1.1] — 2026-08-14 — TypeScript only

### Fixed

- **Webhook signing and verification threw on Node 18**, which `engines` declares
  as supported. `globalThis.crypto` only became a global in **Node 19**; on Node 18
  Web Crypto exists solely as `node:crypto`'s `webcrypto`, so every call into
  `verifyWebhook` / `signWebhookRequest` failed with "Web Crypto is unavailable" —
  and the thrown message itself said "Node 18+", pointing away from the cause.

  Web Crypto is now reached through a single seam (`src/webcrypto.ts`) that falls
  back to `node:crypto` when the global is absent. The import is dynamic and
  guarded, so bundles for browsers and workers — where a static `node:` import
  fails to resolve — are unaffected.

  Verified on Node 18, 20, 22 and 24: on 18 `globalThis.crypto` is `undefined` and
  signing, v1 verification and tamper rejection all pass.

## [1.1.0] — 2026-08-11

1.0.0 shipped the core: discovery, workflows, runs with SSE, data, monitors,
pagination and typed errors. Everything below has landed since and is released
here together. All of it is additive — no 1.0.0 API changed shape, so upgrading
is a version bump.

### Added

**Production behaviour, in all four SDKs.**

- **Retries that cannot duplicate work.** Transient failures (429, 408/425,
  502/503/504, dropped sockets) retry with exponential backoff and full jitter,
  honouring `Retry-After` — except when the server asks for longer than the SDK
  will sleep, where you get the real response, which carries the reset time.
  `GET`/`HEAD`/`OPTIONS` always retry; `POST`/`PUT`/`PATCH` retry **only** where
  the server honours `Idempotency-Key` (Writ Cloud, self-hosted coordinator), and
  every attempt of one logical call reuses the same key. Against the local agent,
  which has no such lane, an unsafe method is never retried — a second `POST`
  there is a second monitor.
- **`monitors.watch()`** — detected changes as a continuous stream, in detection
  order, with no gaps and no repeats. Polling that feed by hand is harder than it
  looks: the newest-first view silently drops changes when more than `limit` land
  between polls, and a change row is *updated* rather than re-inserted when the
  same difference recurs, so an id you already processed can resurface. `watch()`
  drives the server's keyset cursor, and a resurfaced id arrives as what it
  actually is — a fresh detection.
- **Webhook verification and signing.** `verify_webhook` / `verifyWebhook` /
  `VerifyWebhook` authenticates a delivery in constant time and enforces the
  replay window. `X-Writ-Signature-V1` covers `"{timestamp}." + body`; the
  body-only `X-Writ-Signature` is refused by default, because nothing ties it to
  a point in time.
- **`max_age` freshness**, one contract on the workflow and crawl sides: "an
  answer collected within this many seconds is acceptable, otherwise go get it
  again". Every answer carries `_cache.hit` / `_cache.age_seconds` in the BODY,
  not only in headers — an SDK caller receives a decoded payload and would never
  see a header. Omit it and nothing changes: work always runs.
- **Auto-pagination** over `limit`/`offset` endpoints.

**Cloud and self-host surfaces.** Monitors (including `run` and `watch`),
automations, personas and builds, plus **saved crawls**: a crawl row is one RUN
whose id dies with it, so `crawl.save(...)` stores the settings under a stable
slug, `crawl.run_saved(...)` re-runs exactly those (or returns what it already
collected when `max_age` allows), and `crawl.saved_data(...)` reads at any age
and never crawls. These speak the coordinator's own API, so they run against a
self-hosted instance exactly as they do against Writ Cloud.

**File assets.** All four SDKs already sent the run body's `files` map, but a
caller had no way to learn which keys were valid, and no typed view of what a run
downloaded. Both are now answerable without a round trip:

- **All four** — `fileSlots(workflow)` / `file_slots(workflow)` / `FileSlots(wf)`
  reports a workflow's file inputs: the valid keys for the run's `files` map,
  each with the file pinned on the step as its default. Every `upload` step is an
  input — one that names a `file_slot` must be bound by the caller; one that only
  pins a file is keyed `step:<step id>` and runs untouched, so binding it is an
  override rather than a requirement. Derived from `workflow.steps` on the
  client, so it works against any daemon version.
- **All four** — `outputFiles(run)` / `output_files(run)` / `OutputFiles(payload)`
  returns the files a run CAPTURED via `wait_for_download`, typed as
  `OutputFile { file_id, filename, size, content_type, output_key? }`. Reads the
  terminal run document, its `result_data`, or a results payload. The bytes come
  back through the ordinary files API.
- **OpenAPI** — documented the `OutputFile` schema and noted that a run's `data`
  carries `output_files` when the recipe downloads anything.

### Fixed

- **TypeScript, Python** — the internal version constants (`src/version.ts`,
  `_version.py`) still read `0.1.0` after the 1.0.0 release, so both packages
  sent a `User-Agent` two majors behind themselves. Both are now bumped with
  the manifest, and the tests that assert the header derive it from the
  constant instead of hardcoding the digits, so a release can no longer ship
  with them out of step.
- **Python** — `CacheStamp` was imported twice in `writ_agent/__init__.py`.

## [1.0.0] — 2026-08-06

First public release of all four SDKs.

Versioned 1.0.0 to match [`writ`](https://github.com/usewrit/writ) and
[`writ-mcp`](https://www.npmjs.com/package/writ-mcp): the coordinator, the agent
and the clients are one product, so a single number answers "which version goes
with which". An earlier 0.1.0 was tagged in this changelog but never reached npm,
PyPI or crates.io, so no published version is being skipped.

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

- OAuth, MCP, OpenAI-compatible and AI-assist surfaces are out of scope for
  1.0.x.
