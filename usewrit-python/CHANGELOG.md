# Changelog

All notable changes to `usewrit` are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-10

First release: the server side of the Writ Bridge for Python, the twin of `@usewrit/server`
([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §12).

### Added

- `create_writ_bridge(contract, mode, ...)`: modes `required`, `recommended` and `cloud`, per
  function through `function_modes` or the contract; `WRIT_BRIDGE_SECRET` and `WRIT_API_KEY` read
  from the environment; refusals at creation (`CLOUD_NOT_CONFIGURED`, `CONFIG_INVALID`), with
  local-network functions forced to `required`.
- `bridge.user(user_id).<nested.key>(inputs, timeout_ms=, wait_for_user_ms=, dry_run=)` and
  `bridge.<nested.key>(inputs)`, answering `BridgeResult(data, venue, receipt)`; inputs checked
  against the contract before routing.
- The page channel (hello, long-poll, result, run) as `bridge.asgi`, `bridge.fastapi_router()`
  and the framework-free `bridge.handle()`.
- `bridge.user_token()`, `bridge.challenge()`, `bridge.verify()` and `bridge.online()`.
- Signed receipt verification (Ed25519, RFC 8785 canonical JSON with ECMAScript number
  formatting), checked against the shared golden vectors.
- Writ Cloud runs through `POST /api/automation/workflows/{id}/run` and
  `GET /api/automation/tasks/{task_id}/results`, with backoff and error mapping.
- `MemoryStore` and `RedisStore` (the Node package's key layout), behind the `Store` protocol.
- Device pinning on by default: `pin_devices="first-use"` pins the first device whose receipt
  verifies for a user and refuses any other (`unknown_device`, or `RESULT_UNVERIFIED` with
  `details["unknown_device"]` / `details["device"]`) until `bridge.approve_device()`;
  `bridge.forget_devices()` resets a user. A function makes your own registry decide; `"off"`
  accepts any signer. Pins live in the store (`check_device` / `pin_device` / `forget_devices`;
  on Redis one atomic `EVAL`, byte-compatible with the Node store).
- `authorize_run` hook (page runs on Writ Cloud).
- `validate_contract()` accepts and keeps `functions[].settings` as `ContractFunction.settings`
  (`ContractSetting(key, label, kind)`, the package's settings for the site's own form,
  [contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §8, §10): keys `[A-Za-z0-9_]{1,64}` listed once, labels 1 to 80 characters,
  `kind` `"text"` or `"lan_host"`, at most 8. Settings are never call inputs.
- Linked workflows ([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §11): `mint_run_token(secret_key, publication, sub=None,
  ttl_seconds=600, *, issued_at=None)` mints the run token a token-mode publication needs (JWT,
  HS256, keyed with the `wsk_` secret key; claims `pub`, `iat`, `exp`, `sub?` in that order;
  `ttl_seconds` at most 3600), with the standard library only. `CONFIG_INVALID` for a secret that
  is not a `wsk_` key (never echoed), `INPUT_INVALID` for a bad publication or sub, `BAD_REQUEST`
  for a ttl outside 1 to 3600. Reproduces `sdks/fixtures/run_token_golden.json` byte for byte, as
  the Node twin does.
- Linked contract entries (`writ.linked/v1`) are accepted and kept as given, like bundled ones;
  the visitor codes `RECIPE_UNAVAILABLE` and `PUBLICATION_REVOKED` pass through instead of
  becoming `INTERNAL`.
