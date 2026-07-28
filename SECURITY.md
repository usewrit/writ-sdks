# Security

These SDKs speak to **two** things, and the distinction matters for every claim
below:

1. **`writ-agentd`, a daemon on your own machine**, over loopback — workflows,
   runs, monitors, recording, secrets. Authenticated with a local agent token
   read off disk.
2. **Writ Cloud** (`https://api.usewrit.app` by default) — `scrape`, `map`,
   `crawl`, `quota`, under the `.cloud` namespace. Authenticated with a Writ
   Cloud API key, **or with no key at all** on the free keyless tier.

Everything that leaves your machine leaves through (2).

## Reporting a vulnerability

Report privately through **GitHub Security Advisories**: use the
**"Report a vulnerability"** button under the
[Security tab of this repository](https://github.com/usewrit/writ-sdks/security/advisories/new).
Do **not** open a public issue for an undisclosed vulnerability.

- **Acknowledgement** within 3 business days.
- **Initial assessment** (severity + affected SDKs) within 7 business days.
- Reporters are credited in the published advisory unless they prefer otherwise.

Issues in the **daemon itself** belong in
[`usewrit/writ-agent`](https://github.com/usewrit/writ-agent/security/advisories/new);
issues in the coordinator belong in
[`usewrit/writ`](https://github.com/usewrit/writ/security/advisories/new).

### Supported versions

Fixes land on the latest release line of each SDK only.

| Package | Supported |
|---|---|
| `@usewrit/agent-sdk`, `writ-agent`, `writ-client`, `.../writ-sdks/go` — latest 0.x | Yes |
| Anything older | No — please upgrade |

---

## Threat model

**What the SDKs are trusted with:** the local agent token (read off disk), and
whatever the daemon's API can do with it — which is a great deal, including
driving a browser and reading stored credentials.

**Who they talk to:** `http://127.0.0.1:<port>` for the local API — loopback
only — and the configured cloud base URL for `.cloud` calls. Nothing else. No
telemetry, no analytics, no update check.

**Where the token comes from** (identical in all four SDKs — see `DESIGN.md` §4):

1. `WRIT_API_URL` / `WRIT_TOKEN` environment variables
2. `$WRIT_HOME/runtime.json`
3. `~/.writ/active_profile` → `~/.writ/profiles/<id>/runtime.json`
4. `~/.writ/runtime.json`
5. a bounded scan of `~/.writ/profiles/*` (cap 32)

## How the token is protected

- **The discovered base URL is built from the port, never from a URL in the
  file.** `runtime.json` contributes a port number; the SDK composes
  `http://127.0.0.1:<port>` itself. A tampered or corrupted descriptor therefore
  cannot redirect your token to a remote host — the worst it can do is point at
  another port on your own machine. Only an explicit `WRIT_API_URL` (which you
  set) can send the token elsewhere.
- **Profile ids are validated before they reach a filesystem path** — non-empty,
  not `local`, at most 128 characters, `[A-Za-z0-9_-]` only, anchored at both
  ends. This mirrors the daemon's own rule and closes path traversal via
  `active_profile`. All four SDKs implement it identically and test it.
- **The profile scan is bounded** at 32 directories, so a hostile `~/.writ` full
  of entries cannot stall startup.
- **The token is never logged.** The library code contains no print/log
  statements at all; diagnostics are returned as typed errors for the caller to
  handle.
- **A liveness probe runs before the token is used in anger**, so a stale
  descriptor produces a clear discovery error rather than a confusing 401 later.

## The cloud surface — what leaves your machine

`.cloud` calls go to `https://api.usewrit.app` (override with `WRIT_CLOUD_URL`).
They carry the URL you asked to scrape, map or crawl, and one of:

- **Your Writ Cloud API key**, on the *metered* tier — sent as a bearer
  credential to the cloud base URL and nowhere else.
- **A persistent client id**, on the free *keyless* tier — see below.

### The keyless client id (please read)

With no API key set, cloud calls resolve to a free daily-capped tier. Enforcing
that cap requires identifying the caller across runs, so **the SDK mints a random
identifier on first use and persists it to `~/.writ/client_id`**, then sends it
with every keyless cloud request.

Being explicit about the consequences:

- It is a **stable pseudonymous identifier**. Keyless requests from this machine
  are linkable to each other by whoever operates the cloud endpoint.
- It is created **without a prompt**, the first time you make a keyless cloud
  call. Purely local calls never create or send it.
- To reset it, delete `~/.writ/client_id` — a fresh one is minted next time.
- To avoid it entirely, either set an API key (the metered tier identifies you by
  the key instead) or do not use the `.cloud` namespace.
- On a read-only filesystem the SDK falls back to an ephemeral, in-memory id
  rather than failing.

`client_id` is in `.gitignore` alongside `runtime.json` — do not commit it.

### Cloud error handling

Non-2xx cloud responses map to typed errors rather than raw status codes, so
quota and billing conditions are distinguishable in code: `429` → rate limited,
`402 api_key_required` → key required, other `402` → insufficient credits.

## Dependency surface

Kept deliberately small, because these libraries hold a credential:

| SDK | Runtime dependencies |
|---|---|
| TypeScript | **none** — Node ≥18 built-in `fetch` |
| Go | **none** — standard library only |
| Python | `httpx` |
| Rust | `reqwest`, `serde`, `serde_json`, `thiserror`, `futures-core`, `futures-util`, `bytes` |

CI runs `npm audit`, `pip-audit`, `govulncheck` and `cargo deny` on every push.

## Things to know when you use them

- **Loopback is not a permission boundary.** Any process running as your user
  can read `~/.writ/runtime.json` and reach the daemon. The SDKs do not — and
  cannot — protect against a hostile local process.
- **Do not commit `runtime.json`, `local_token` or `client_id`.** The first two
  contain a live token, the third is a tracking identifier; `.gitignore`
  excludes all three.
- **Scope cloud API keys.** Give a key only the scopes you actually use.
- **`https://api.usewrit.app` does not currently resolve.** Writ Cloud has not
  launched. Until it does, `.cloud` calls fail with a connection error and only
  the local surface is usable. Point `WRIT_CLOUD_URL` at your own endpoint if you
  are running one.
