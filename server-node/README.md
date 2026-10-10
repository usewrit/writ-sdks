# @usewrit/server

The server side of the **Writ Bridge** for Node. Call the workflows you built in Writ from your
backend, for a signed-in user, and have them run **on that user's own computer** (their network,
their IP, their signed-in sessions), with a signed receipt proving it. Or run them on **Writ
Cloud** with your API key. One typed object, one route to mount, and the same code in every mode.

Guides, the public wire contract and runnable examples: [usewrit/writ-for-websites](https://github.com/usewrit/writ-for-websites).

- `bridge.user(userId).pos.receive({ invoice_no })`, typed from the contract file
- One route (`bridge.handler`) that your pages poll, with adapters for Express and Next.js
- Every result from a user's computer is checked against a signed Writ receipt before you see it
- Single-use challenges and `bridge.verify()` for page-initiated gates (a login, a check)
- Writ Cloud runs through the existing run API, with typed errors
- In-memory store by default, Redis for several instances
- Zero runtime dependencies (`node:crypto` and `fetch`), ESM with full type declarations

Requirements: Node 18 or later. The page side is
[`@usewrit/web`](../web/README.md)'s `createWritBridge`, on the same origin as your route.

## Install

```sh
npm install @usewrit/server
```

## Quick start

1. **Build your workflows in Writ** and download `writ-contract.json` (with its typings
   `writ-functions.d.ts`). For `recommended` or `cloud` functions, publish them from Writ Cloud
   first, so the contract carries their Writ Cloud mapping.
2. **Set two environment variables:**

```sh
WRIT_BRIDGE_SECRET=$(openssl rand -base64 48)   # signs user tokens and challenges; never sent to the page
WRIT_API_KEY=wrk_...                            # only for recommended / cloud functions
```

3. **Create the bridge and mount its one route:**

```ts
import express from "express";
import { createWritBridge, isWritBridgeError } from "@usewrit/server";
import contract from "./writ-contract.json" with { type: "json" };
import type { WritFunctions } from "./writ-functions";

export const bridge = createWritBridge<WritFunctions>({ contract, mode: "required" });

const app = express();
app.all("/writ-bridge", bridge.express());   // before express.json(), or on a path it skips

// Give each signed-in page its token (it carries the user id, signed with WRIT_BRIDGE_SECRET).
app.get("/api/session", requireLogin, (req, res) => {
  res.json({ writToken: bridge.userToken(req.user.id) });
});
```

The page passes that token to its own bridge (`@usewrit/web`):

```ts
const bridge = createWritBridge<WritFunctions>({ contract, app: "Arrivos", mode: "required", endpoint: "/writ-bridge", userToken });
```

4. **Call a function for a user, from anywhere in your backend:**

```ts
try {
  const { data, venue, receipt } = await bridge.user(userId).pos.receive({ invoice_no: "F-1029" });
  // venue: "user" (ran on their computer, receipt verified) or "cloud"
} catch (error) {
  if (isWritBridgeError(error, "USER_OFFLINE")) return askUserToOpenArrivos();
  if (isWritBridgeError(error, "WRIT_REQUIRED")) return showWritSetupHelp();
  throw error;
}
```

Dotted contract keys nest (`"pos.receive"` is `.pos.receive(...)`); since the same functions also
hang off the bridge itself, a key may not start with one of its members (`handler`, `express`,
`next`, `user`, `challenge`, `verify`, `online`, `contract`, `close`). Each method checks the inputs
against the contract first (every required input present, nothing undeclared, plain JSON, at most
1 MB) and throws `INPUT_INVALID` before anything is sent. Options: `{ timeoutMs = 120000,
waitForUserMs = 0, dryRun }`. `waitForUserMs` waits, in `required` mode, for one of the user's
pages to connect with Writ ready, and is not counted in `timeoutMs`.

### Next.js (App Router)

```ts
// app/writ-bridge/route.ts
import { bridge } from "@/lib/writ";
export const runtime = "nodejs";            // node:crypto
export const dynamic = "force-dynamic";
export const { GET, POST } = bridge.next();
```

`bridge.handler` is a plain fetch-API handler, `(request: Request) => Promise<Response>`, for
any other framework that speaks `Request`/`Response` (Hono, Remix, Bun, Deno). Called as
`(req, res, next)`, it also works directly as Express middleware.

## Modes

Switching is one line, `mode: "required" | "recommended" | "cloud"`; the calls do not change.

| mode | user's pages connected, Writ ready, function granted | otherwise |
|---|---|---|
| `required` (default) | runs on the user's computer | `USER_OFFLINE`, or `WRIT_REQUIRED` if they never reported Writ ready, or `NOT_GRANTED` |
| `recommended` | runs on the user's computer | runs on Writ Cloud (your account and plan) |
| `cloud` | runs on Writ Cloud | runs on Writ Cloud |

- **`required` needs no Writ Cloud account:** no API key, no published workflow.
- **Per function:** `functions[].mode` in the contract, or `functionModes: { "orders.list": "cloud" }`
  in the bridge options (which wins).
- **The local network is `required`, always.** A function whose contract lists `local_network`
  hosts runs only on the user's computer, since Writ Cloud cannot reach their network. Setting it
  to another mode explicitly is refused at creation.
- **Calls without a user**, `bridge.orders.list(inputs)`, run on Writ Cloud (`recommended`,
  `cloud`) or fail with `WRIT_REQUIRED` (`required`).
- **Checked at creation, not on the first call:** a `recommended` or `cloud` function without a
  Writ Cloud mapping, or without `WRIT_API_KEY`, throws `CLOUD_NOT_CONFIGURED`; a missing or short
  `WRIT_BRIDGE_SECRET` throws `CONFIG_INVALID`.

## A login gate: `challenge()` and `verify()`

When the page itself starts a call, and your server must know the result really came from the
user's Writ (a login that the user's PC has to check first):

```ts
// 1. Server: one challenge per attempt (single use, 120 s by default).
app.post("/login/start", (req, res) => {
  const attempt = newAttemptId();
  res.json({ attempt, challenge: bridge.challenge({ subject: attempt, key: "auth.verify_login" }) });
});

// 2. Page (@usewrit/web): run the function with that challenge, send back data and receipt.
//    const r = await writ.auth.verify_login({ company, username }, { challenge });
//    await fetch("/login/finish", { method: "POST", body: JSON.stringify({ attempt, data: r.data, receipt: r.receipt }) });

// 3. Server: verify before trusting anything.
app.post("/login/finish", express.json({ limit: "2mb" }), async (req, res) => {
  const { attempt, data, receipt } = req.body;
  const check = await bridge.verify(receipt, {
    challenge: challengeOf(attempt),        // the exact string you minted
    key: "auth.verify_login",
    subject: attempt,
    origin: "https://app.example.com",
    data,
  });
  if (!check.ok) return res.status(403).json({ error: check.reason });
  // check.device.kid identifies the user's Writ install for this site.
  return signIn(req, data);
});
```

`verify()` answers `{ ok, outcome, reason?, device }` and never throws for a bad receipt. `ok` is
true only when the signature verifies, the receipt names this function and carries exactly this
challenge, the challenge was minted here, for this key (and subject), and is unexpired and unused,
the origin matches (when given), the data hashes to the receipt's `data_hash` (when given), and the
call succeeded. A challenge is spent by the first receipt that answers it.

## Several server instances: Redis

The default store keeps presence, queued commands, pending results and spent challenges in
memory: right for one process. Behind a load balancer, or on serverless hosts, a page's poll and
your call can land on different instances; share the state in Redis (6.2 or later). No Redis
library is bundled; pass yours:

```ts
import Redis from "ioredis";
import { createWritBridge, redisStore } from "@usewrit/server";

const redis = new Redis(process.env.REDIS_URL);
const sub = redis.duplicate();                       // a subscribed connection runs nothing else
const store = redisStore(redis, {
  prefix: "writ:bridge:",
  subscribe: async (channel, onMessage) => {
    sub.on("message", (from, message) => { if (from === channel) onMessage(message); });
    await sub.subscribe(channel);
  },
});
export const bridge = createWritBridge<WritFunctions>({ contract, mode: "recommended", store });
```

With node-redis (v4 or later): `redisStore(client, { subscribe: (channel, onMessage) => sub.subscribe(channel, onMessage) })`
with `sub = await client.duplicate().connect()`. Without `subscribe`, waits re-read Redis every
250 ms (`pollIntervalMs`). The store never blocks your connection (no `BLPOP`). Any other backend:
implement the `WritBridgeStore` interface.

## The page channel

The one route serves the page ([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §12.3), with `Authorization: Writ <userToken>` on
every request (401 otherwise):

| request | body | answer |
|---|---|---|
| `POST` | `{ hello: { ready, granted, writ_version } }` | `204`: the page's readiness, re-sent on change and every 60 s |
| `GET ?wait=25` | none | `200 { commands }`, a long poll of at most `pollSeconds` (25) |
| `POST` | `{ result: { id, ok, data, receipt } }` or `{ result: { id, ok: false, error, receipt? } }` | `204` |
| `POST` | `{ run: { key, inputs, options } }` | `200 { data, venue: "cloud" }` (`recommended` / `cloud` functions only) |

A user counts as online for 90 s after their last hello or poll. A command no page picks up within
15 s is taken back (the tab was closed): `USER_OFFLINE` in `required` mode, Writ Cloud in
`recommended`. Errors answer `{ error: { code, message } }`.

## Run tokens

A linked workflow ([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §11) keeps its recipe in your Writ Cloud. Published in `token`
mode, it is handed out only to calls that carry a run token your backend minted, so only your
signed-in users can run it. The page's `getRunToken` (`@usewrit/web`) fetches one from a route of
yours:

```ts
import { mintRunToken } from "@usewrit/server";

// Page: getRunToken: () => fetch("/api/writ-token").then((r) => r.text())
app.get("/api/writ-token", requireUser, (req, res) => {
  const token = mintRunToken(process.env.WRIT_PUBLICATION_SECRET!, {
    publication: "pub_0123456789abcdefABCDEF", // the publication's id
    sub: req.user.id,                          // optional: who it is for
    ttlSeconds: 600,                           // default 600, at most 3600
  });
  res.set("Cache-Control", "no-store").type("text/plain").send(token);
});
```

- **The secret key** is the publication's `wsk_...`, which Writ Cloud shows once when you publish
  or rotate it; not `WRIT_BRIDGE_SECRET`, and never the publishable `wpk_...` key. It stays on
  your server. Put the route behind your own sign-in: whoever gets a token can run the workflow
  until it expires.
- **The token** is a JWT, HS256, keyed with the secret key's UTF-8 bytes: header
  `{"alg":"HS256","typ":"JWT"}`, claims `{"pub","iat","exp","sub"?}` in that key order, compact
  JSON, base64url without padding. Python's `mint_run_token` mints the same bytes
  (`sdks/fixtures/run_token_golden.json`). No dependency: `node:crypto` only.
- **Refusals:** `CONFIG_INVALID` for a secret that is not a `wsk_` key, or that holds spaces or a
  line break (an environment variable read with its newline; the message never repeats the
  secret); `INPUT_INVALID` for a bad `publication` or `sub`; `BAD_REQUEST` for `ttlSeconds` outside
  1 to 3600.
- The page keeps a token in memory until a minute before its `exp`, so a 600 s token means one
  request to this route every 9 minutes or so per visitor.

## Errors

Every failure is a `WritBridgeError` with a stable `code`. Branch with `isWritBridgeError(error, code)`.

| code | when |
|---|---|
| `WRIT_REQUIRED` | a `required` function, and the user never reported Writ ready (or a call without a user) |
| `USER_OFFLINE` | a `required` function, and none of the user's pages is connected |
| `NOT_GRANTED` | the user has not granted that function to your site; or Writ Cloud refused `WRIT_API_KEY` (401/403) |
| `RESULT_UNVERIFIED` | a result came back without a receipt that verifies for that call: forged, replayed, altered, or from an unpinned device |
| `TIMEOUT` | the call did not finish within `timeoutMs` |
| `CLOUD_NOT_CONFIGURED` | no Writ Cloud mapping or no `WRIT_API_KEY`; or the mapped workflow or function does not exist |
| `CLOUD_UNAVAILABLE` | Writ Cloud could not be reached, or answered 5xx |
| `QUOTA_EXCEEDED` | your Writ Cloud plan is out of runs (402), or of linked workflow deliveries |
| `RUN_FAILED` | the run failed, on the user's computer or on Writ Cloud |
| `INPUT_INVALID` | inputs refused (missing, undeclared, not JSON, over 1 MB), or an invalid contract |
| `BAD_REQUEST` | invalid call options |
| `CONFIG_INVALID` | invalid bridge options, a missing or short secret, a local-network function in a cloud mode |
| any visitor code | what the user's Writ answered: `CONSENT_DENIED`, `VAULT_LOCKED`, `LAN_NOT_ALLOWED`, `RATE_LIMITED`, `CANCELLED`, and for linked workflows `RECIPE_UNAVAILABLE`, `PUBLICATION_REVOKED`, `GRANT_STALE`, ... (an unknown one becomes `INTERNAL`, kept in `details.visitorCode`) |

A visitor error that came with a receipt carries it in `error.details.receipt`.

## Security

- **The secret never leaves your server.** User tokens and challenges are HMAC-SHA256 signed
  with `WRIT_BRIDGE_SECRET` (at least 32 bytes); the page only holds its own user's token. Keep
  token lifetimes short (`ttlSeconds`, default 1 hour) and re-issue them with your session.
- **Results are verified, not trusted.** Each command carries a challenge minted for its id, key
  and user. A result is accepted only with an Ed25519 receipt, signed by the user's Writ, that
  carries that exact challenge and key and hashes the posted data; anything else is
  `RESULT_UNVERIFIED`. Script or console forgery, replays and swapped results fail.
- **Devices are pinned per user, by default.** A receipt carries the key that signed it, so the
  bridge remembers the first device that answers for each user (`pinDevices: "first-use"`) and
  refuses any other (`unknownDevice: true`, `RESULT_UNVERIFIED` for commands) until you call
  `bridge.approveDevice(userId, device)`. Approve a new computer only after confirming it is the
  user's (an email link, say), never on the page's word. Pins live in the store: use `redisStore`
  (or `pinDevices: (userId, device) => yourRegistry.has(userId, device.public_key)`) in production,
  since the memory store forgets them on restart. `pinDevices: "off"` accepts any signer, and with
  it forged results; use it only where nothing is gated. What a receipt cannot prove is that the
  user did not modify their own Writ.
- **Guard Writ Cloud page calls.** `POST { run }` spends your plan for any signed-in user. Use
  `authorizeRun: (userId, key, inputs) => ...` to decide who may; at most 4 run at once per user
  per instance.
- **Treat `data` like user input**, even when verified: it is what the user's computer returned.
- **The page must be same-origin with the route**, and served over https. Mount the route behind
  your own authentication if you like; the user token is checked either way.
- **Results are hashed as RFC 8785 canonical JSON.** Numbers, fractions included, are printed as
  JavaScript prints them, by Writ and by this SDK alike. An integer beyond 2^53 is hashed as the
  double JSON carries, so return such values (and exact money amounts, if you need them exact) as
  strings.

## Lower level

`canonicalJson`, `dataHash`, `verifyReceiptSignature`, `parseReceipt`, `kidOf`, `signToken`,
`openToken`, `mintUserToken`, `mintChallenge`, `readUserToken` and `readChallenge` are exported
for tests and other runtimes; they, and `mintRunToken`, reproduce the shared golden vectors
(`sdks/fixtures/bridge_tokens_golden.json`, `sdks/fixtures/run_token_golden.json`, the daemon's
`receipt_golden.json`) byte for byte.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build        # tsc (ESM + .d.ts)
```

The receipt tests read `test/fixtures/receipt_golden.json`, a byte-for-byte copy of the Writ
engine's receipt golden file; set `WRIT_RECEIPT_GOLDEN` to the engine's file to test against it and
prove the copy has not drifted.

The wire contract is [docs/contract.md in usewrit/writ-for-websites](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md): §10 (the
contract file) and §12 (the Writ Bridge: receipts, server-minted values, the page channel, this
API). How the parts fit together: [docs/how-it-works.md](https://github.com/usewrit/writ-for-websites/blob/main/docs/how-it-works.md).

## License

MIT, see [`LICENSE`](./LICENSE).
