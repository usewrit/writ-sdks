# Changelog

All notable changes to `@usewrit/web` are documented here. This package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-10

The first release published to npm. Installable workflows, the contract file, a typed client and
a drop-in banner ([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §8, §9, §10). Still protocol 1.

The install links point at the Writ extension's Chrome Web Store listing. Edge visitors use it too
(Edge installs Chrome Web Store extensions) until the Edge Add-ons listing exists.

### Added

- Linked workflows ([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §11): the recipe stays in the developer's Writ Cloud, and the
  page code is the same as for bundled ones; the contract decides.
  - `validateContract()` accepts `packages[]` entries with `format: "writ.linked/v1"` and checks
    them: package id, name, `publication.id` (`pub_` + 22), `publication.base` (https, or http to
    this computer; no path, query or user name), `publication.version` (1 or more), the
    publishable key (`wpk_` + 32; a `wsk_` secret is refused), `access` (`public` | `token`), the
    manifest (`writ.manifest/v1`, the same publication, `functions`, `settings`) and
    `manifest_hash` (64 lowercase hex). A key picks a function from the manifest.
    `contractFunctions()`, `connect()` and the banner pass linked entries as
    `FunctionRequest.package`. `definePackage()` stays for bundled packages.
  - `getRunToken?: () => Promise<string>` on `writ.connect()` / `writ.resume()` sessions,
    `createWritClient(session, contract, options)`, `createWritBridge()` and `mountWritBanner()`.
    A call to a token-mode linked workflow gets a run token first and sends it as `token`; the
    token is kept in memory only, until 60 s before its JWT `exp` (read, never verified), shared
    by concurrent calls, never reused after `NOT_GRANTED`. A token-mode workflow without
    `getRunToken` is a `BAD_REQUEST` at creation. `CallOptions.token` passes one per call.
  - `recipeCache: "session" | "call"` (default `"session"`), sent as `recipe_cache` on calls to
    linked workflows; per session, client, bridge, banner, or call.
  - `refreshRecipes()` on the client from `connectWrit()`, the session and the bridge, through
    `request({ method: "writ_refresh_recipes" })`. `refreshRecipes` is reserved as a bridge member
    name.
  - The banner and consent descriptions name a linked workflow by its manifest's `name` (vouched
    for by Writ Cloud), never by the entry's unverified `name` / `publisher`.
  - Error codes `RECIPE_UNAVAILABLE`, `PUBLICATION_REVOKED` and `QUOTA_EXCEEDED`.
  - Banner: after `onReady` it watches the session's linked calls. `GRANT_STALE` brings it back
    with "Update" (reopens consent); `PUBLICATION_REVOKED` shows "Unavailable";
    `RECIPE_UNAVAILABLE` shows "Unavailable" with Retry (refreshes the recipes, then hides). A
    connect that cannot fetch the manifest shows the same states. English, French and Spanish.
  - Types `WritLinkedPackage`, `WritManifest`, `WritManifestFunction`, `WritPublicationRef`,
    `WritLinkedAccess`, `WritContractPackage`, `WritRecipeCache`, `WritLinkedOptions`,
    `ResumeOptions`, `WritClientOptions`; constants `LINKED_PACKAGE_FORMAT`, `MANIFEST_FORMAT`,
    `DEFAULT_PUBLICATION_BASE`, `PUBLICATION_ID_PATTERN`, `PUBLISHABLE_KEY_PATTERN`,
    `RECIPE_CACHE_MODES`, `RUN_TOKEN_REFRESH_MARGIN_MS`.
- Package settings ([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §8 "Settings"): values each user gives once, in Writ's consent
  window, such as their POS address, which every run reuses as `{{key}}`.
  - `WritPackage.settings: WritSetting[]` (`{ key, label, description?, kind?: "text" | "lan_host",
    example?, required? }`, at most 8). `definePackage()` checks them: keys `[A-Za-z0-9_]{1,64}`,
    unique, never also an input or a credential; label 1 to 80, description 200, example 120
    characters.
  - `definePackage()` refuses a `url` / `*_url` whose scheme or host comes from a function input
    (`{{name}}`, `{{input.name}}`): it must be a declared setting. Namespaced placeholders
    (`{{secret:K}}`, `{{extracted:x}}`) and literal hosts are allowed.
  - `FunctionRequest.settings` suggests values the consent window shows pre-filled: at most 8
    per key, 1 to 200 characters, no control characters, only settings the package declares, and
    one value per setting across the keys of a package (`INPUT_INVALID`). `connect()` and
    `mountWritBanner()` pass them to `writ_connect`.
  - `validateContract()` keeps and checks `functions[].settings` (`{ key, label, kind }[]`).
    `contractFunctions(contract, { settings })` attaches suggestions, by contract key, to every
    key of the package.
  - `createWritBridge({ settings })` merges suggestions into the connect of each key, and
    `bridge.suggestSettings(values)` suggests them later: it re-runs the connect for those keys
    (the consent window opens as an update) and resolves once the user confirmed, or rejects with
    `CONSENT_DENIED`. Before the visitor is connected, the banner's install carries them.
    `suggestSettings` is reserved as a bridge member name.
  - Types `WritSetting`, `WritSettingKind`, `WritSettingValues`, `WritSettingSuggestions`,
    `WritContractSetting`; constants `MAX_PACKAGE_SETTINGS`, `SETTING_KEY_PATTERN`,
    `SETTING_KINDS`, `MAX_SUGGESTED_SETTINGS`, `MAX_SETTING_VALUE_LENGTH`.
- `createWritBridge<WritFunctions>({ contract, app, mode, endpoint, userToken, banner, timeoutMs })`:
  the Writ Bridge in the page ([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §12). One typed object, nested by dotted keys, with
  `ready()`, `status()`, `venue(key)` and `destroy()`. Each call resolves with
  `{ data, venue: "user" | "cloud", receipt, runId, callId }`.
  - Modes: `required` runs on the visitor's PC and waits for a banner that cannot be closed;
    `recommended` runs there when Writ is ready and granted, else on Writ Cloud through
    `POST {endpoint} { run }`, with a banner that can be closed; `cloud` always goes to the
    endpoint and shows no banner. A function's own contract `mode` overrides the bridge's.
    There is never an automatic fallback.
  - A function with `local_network` hosts is always `required`. A mode that says otherwise
    throws `INPUT_INVALID` when the bridge is created.
  - The page channel, with a `userToken`: `hello` at start, on change and every 60 s; a long
    poll `GET {endpoint}?wait=25` while the visitor's Writ is ready, paused after 5 minutes
    hidden; commands run only for granted keys (else `NOT_GRANTED`), with the server's
    challenge, at most 4 at once per tab; results posted with their receipts; backoff from 1 s
    to 30 s; it stops on 401/403 and on `destroy()`. The endpoint must be same-origin
    (`BAD_REQUEST` otherwise).
- `CallOptions.challenge` (at most 2 048 characters, sent as `writ_call` `challenge`),
  `CallResult.receipt` and `WritError.details.receipt`. The `WritReceipt` type follows §12.1.
- `WritContractFunction.mode` and `WritContractFunction.cloud` (`{ workflow_id, function }`):
  `validateContract()` keeps and checks them.
- Error codes `WRIT_REQUIRED`, `USER_OFFLINE`, `RESULT_UNVERIFIED` and `CLOUD_NOT_CONFIGURED`,
  which a server bridge can answer.
- The banner states why it is shown under the bridge (required / optional, in en, fr, es).
- `WritWeb.createWritBridge` in the script-tag build.
- `definePackage(pkg)`: checks a `writ.workflow/v1` package the way the Writ engine does
  (`site_package::parse`) and returns a deep-frozen copy. Failures throw `INPUT_INVALID` with
  the exact field at fault. It checks format, id, name, version, description, `entry_url`, 1 to
  500 steps, at most 512 KB, inputs, credentials (at most 10, keys `[A-Za-z0-9_]{1,64}`),
  local-network hosts (at most 8 single hosts, no ranges, no loopback), refused step types (file,
  AI, codegen), `{{file:...}}`, payment fields, and undeclared `{{secret:K}}` / `{{vault:K}}`.
- `FunctionRequest.package` and `FunctionRequest.function`: `connect()` installs a site's
  workflow in the same click. `connect()` validates every package, and requires `function` when
  a package has several callable functions, counted as the engine counts them.
- Types `WritPackage`, `WritPackageInput`, `WritPackageCredential`, `WritPackageLocalNetwork`.
- `validateContract(json)`, `contractFunctions(contract)` and the types `WritContract`,
  `WritContractFunction`, `WritContractInput` for `writ-contract.json` (`writ.contract/v1`).
- `createWritClient<WritFunctions>(session, contract)`: one method per key, with dotted keys
  nested (`client.pos.receive(inputs, options)`). Each method checks required and undeclared
  inputs before calling.
- `mountWritBanner({ app, functions | contract, onReady, position?, locale?, container? })`: a
  framework-free banner in a closed shadow root. It walks the visitor through the extension,
  Writ desktop and the engine, then installs or connects with one click. It is accessible,
  localized (en, fr, es), dismissible per page session, and never shown to a connected visitor.
- `GrantedFunction.package` (`{ id, version } | null`) when the extension reports which package
  a key is bound to; the banner uses it to offer updates.
- `WritWeb.mountWritBanner`, `createWritClient`, `validateContract`, `contractFunctions` and
  `definePackage` in the script-tag build.

### Changed

- `connect()` and `mountWritBanner()` reject an invalid package with `INPUT_INVALID` (a malformed
  request stays `BAD_REQUEST`).

## [0.1.0] — not published

Never published to npm: 0.2.0 is the first release and includes all of it. Speaks protocol 1 of
the Writ browser extension ([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §1).

### Added

- `connectWrit({ timeoutMs?, window? })`: race-free discovery of the extension's `window.writ`
  provider (`writ:announceProvider` / `writ:requestProvider`), answering a client or
  `{ available: false, reason, installUrl, browser, error }`. SSR-safe.
- `installUrl` picks the Chrome Web Store or Edge Add-ons from `userAgentData` / `userAgent`;
  `detectBrowser()` and `installUrlFor()` are exported. The store URLs are placeholders until the
  listings exist.
- Client: `status()`, `connect({ app, functions })`, `resume()`.
- Session: `origin`, `functions`, `function(key)`, `call()`, `refresh()`, `disconnect()`.
- Call handles: `result`, `callId`, `on` / `off` (`started`, `progress`, `needsUser`,
  `finished`, `error`), `cancel()`, `status`, `runId`; `AbortSignal` support; a timeout guard
  5 s past the call's own timeout; events that arrive before `writ_call` answers are held.
- Validation before sending: function keys, app name and description lengths, plain-JSON inputs
  up to 1 MB, no `secret:` / `file:` / reserved input names.
- `WritError` with contract codes, `isWritError(error, code | codes)`, `WRIT_ERROR_CODES`.
- Script-tag build `dist/writ-web.iife.js` defining `window.WritWeb`.
