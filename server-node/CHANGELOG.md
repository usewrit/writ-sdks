# Changelog

All notable changes to `@usewrit/server` are documented here. This package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-10

First release: the server side of the Writ Bridge ([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §10, §12;
[how it works](https://github.com/usewrit/writ-for-websites/blob/main/docs/how-it-works.md)).

### Added

- Linked workflows ([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §11): `mintRunToken(secretKey, { publication, sub?, ttlSeconds =
  600, issuedAt? })` mints the run token a token-mode publication needs (JWT, HS256, keyed with the
  `wsk_` secret key; claims `pub`, `iat`, `exp`, `sub?` in that order; `ttlSeconds` at most 3600).
  `CONFIG_INVALID` for a secret that is not a `wsk_` key (never echoed), `INPUT_INVALID` for a bad
  publication or sub, `BAD_REQUEST` for a ttl outside 1 to 3600. Reproduces
  `sdks/fixtures/run_token_golden.json` byte for byte, as the Python SDK does. Linked contract
  entries (`writ.linked/v1`) are accepted and kept as given, like bundled ones; the visitor codes
  `RECIPE_UNAVAILABLE` and `PUBLICATION_REVOKED` pass through instead of becoming `INTERNAL`.
  Constants `DEFAULT_RUN_TOKEN_TTL_SECONDS`, `MAX_RUN_TOKEN_TTL_SECONDS`.
- `createWritBridge<WritFunctions>({ contract, mode, functionModes?, secret, apiKey, store,
  pollSeconds, cloudBase, pinDevices?, authorizeRun?, cloudPoll?, maxBodyBytes?, fetch?, now? })`.
  `secret` and `apiKey` default to `WRIT_BRIDGE_SECRET` and `WRIT_API_KEY`. Refuses at creation:
  an invalid contract (`INPUT_INVALID`); a `recommended` / `cloud` function without a Writ Cloud
  mapping or without an API key (`CLOUD_NOT_CONFIGURED`); a local-network function explicitly in
  a cloud mode, a secret under 32 bytes, or no secret while a function can run on a user's
  computer (`CONFIG_INVALID`). A local-network function that inherits a cloud mode runs `required`.
- Modes `required` (default), `recommended`, `cloud`, per bridge, per function in the contract
  (`functions[].mode`) or in `functionModes`; `bridge.modeOf(key)`.
- `bridge.user(userId).<nested.key>(inputs, { timeoutMs, waitForUserMs, dryRun })` resolving
  `{ data, venue: "user" | "cloud", receipt? }`: runs on the user's computer when one of their pages
  is connected with Writ ready and the key granted, else by mode (`USER_OFFLINE`, `WRIT_REQUIRED`,
  `NOT_GRANTED`, or Writ Cloud). A command no page picks up within 15 s is withdrawn.
- `bridge.<nested.key>(inputs, { timeoutMs, dryRun })` without a user: Writ Cloud, or `WRIT_REQUIRED`.
- Typed proxies from the flat generated `WritFunctions` map (`WritNestedFunctions`,
  `WritFunctionsFor`), untyped without it; inputs checked against the contract before routing.
- The page channel `bridge.handler` (fetch API): `hello` readiness (90 s presence), `GET ?wait=N`
  long-poll, `result` accepted only with a verified receipt (else `RESULT_UNVERIFIED`), `run` for
  page calls to Writ Cloud. Adapters `bridge.express()` and `bridge.next()`; `bridge.handler`
  also works directly as `(req, res, next)` middleware. `bridge.online(userId)`.
- `bridge.userToken(userId, { ttlSeconds })`, `bridge.challenge({ subject, key, ttlSeconds })`
  (single use) and `bridge.verify(receipt, { challenge, key, origin?, data?, subject? })` answering
  `{ ok, outcome, reason?, device }`; optional device pinning.
- Writ Cloud runs through `POST /api/automation/workflows/{id}/run` and
  `GET /api/automation/tasks/{id}/results` with a 1 s to 5 s backoff; failures map to `NOT_GRANTED`,
  `QUOTA_EXCEEDED`, `CLOUD_NOT_CONFIGURED`, `INPUT_INVALID`, `RATE_LIMITED`, `CLOUD_UNAVAILABLE`,
  `RUN_FAILED`, `TIMEOUT`, `CANCELLED`. `dryRun` sends `mutation_mode: "dry_run"`.
- Stores: `memoryStore()` (default) and `redisStore(client, { prefix, subscribe?, pollIntervalMs? })`
  for ioredis, node-redis or a plain function; the `WritBridgeStore` interface for any other.
- RFC 8785 canonical JSON (`canonicalJson`, `dataHash`), receipt checks (`verifyReceiptSignature`,
  `parseReceipt`, `kidOf`), token helpers (`signToken`, `openToken`, `mintUserToken`,
  `mintChallenge`, `readUserToken`, `readChallenge`), all matching the shared golden vectors.
- `WritBridgeError` with stable codes, `isWritBridgeError(error, code | codes)`, `WRIT_BRIDGE_ERROR_CODES`.
- `validateContract()` accepts and keeps `functions[].settings` (`{ key, label, kind: "text" |
  "lan_host" }[]`, the package's settings for the site's own form, [contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §8, §10): keys
  `[A-Za-z0-9_]{1,64}` listed once, labels 1 to 80 characters, at most 8. Settings are never call
  inputs. Type `WritContractSetting`.
