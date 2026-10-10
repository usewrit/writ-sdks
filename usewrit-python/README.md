# usewrit

The server side of the **Writ Bridge** for Python. Your website calls its Writ functions from the
server, and each call runs where you chose: on the signed-in visitor's own computer (through the
Writ browser extension and Writ desktop, with a signed receipt), or on Writ Cloud with your API
key. One object, one route to mount.

Guides, the public wire contract and runnable examples: [usewrit/writ-for-websites](https://github.com/usewrit/writ-for-websites).

- The same API as the Node package `@usewrit/server`, in snake_case; both produce the same bytes
  (tokens, challenges, canonical JSON).
- FastAPI router, a framework-free ASGI app, and a plain `handle()` core for anything else.
- In-memory state by default; Redis for several workers.
- Runtime dependencies: [`cryptography`](https://cryptography.io/) (Ed25519) and
  [`httpx`](https://www.python-httpx.org/) (Writ Cloud).

```bash
pip install usewrit              # core
pip install "usewrit[fastapi]"   # + FastAPI router helper
pip install "usewrit[redis]"     # + RedisStore for several workers
```

Requires Python 3.10 or later.

## Quick start (FastAPI)

1. Build your workflows in Writ and download `writ-contract.json`.
2. Set `WRIT_BRIDGE_SECRET` (at least 32 bytes: `openssl rand -base64 48`). For the cloud modes,
   also set `WRIT_API_KEY`.

```python
from pathlib import Path

from fastapi import Depends, FastAPI
from usewrit import create_writ_bridge

bridge = create_writ_bridge(Path("writ-contract.json"), mode="required")

app = FastAPI()
app.include_router(bridge.fastapi_router("/writ-bridge"))     # the one route to mount


@app.get("/api/writ-token")
async def writ_token(user=Depends(current_user)):
    # Hand this to the page's bridge. It identifies the user; the secret never leaves the server.
    return {"token": bridge.user_token(user.id)}


@app.post("/api/invoices/{invoice_no}/receive")
async def receive(invoice_no: str, user=Depends(current_user)):
    result = await bridge.user(user.id).pos.receive({"invoice_no": invoice_no}, wait_for_user_ms=10_000)
    return {"received": result.data, "ran_on": result.venue}       # venue: "user" or "cloud"
```

The page creates its side with `@usewrit/web` and the token:

```ts
import { createWritBridge } from '@usewrit/web'
const bridge = createWritBridge({ contract, app: 'Arrivos', mode: 'required', endpoint: '/writ-bridge', userToken })
```

Dotted contract keys nest: `"pos.receive"` is `bridge.user(uid).pos.receive(...)`. A key whose
segments are not Python names is reached by item: `bridge.user(uid)["orders.import"](...)`.

## Switching mode is one line

```python
bridge = create_writ_bridge(Path("writ-contract.json"), mode="recommended")   # or "required", "cloud"
```

The rest of your code does not change. `required` needs no Writ Cloud account; `recommended` and
`cloud` read `WRIT_API_KEY` and need a contract published from Writ Cloud (it carries each
function's `cloud: {workflow_id, function}` mapping).

| mode | The user's page is connected, Writ is ready and the function is granted | Otherwise |
|---|---|---|
| `required` | Runs on the user's computer | `USER_OFFLINE` (their pages went away), `NOT_GRANTED`, or `WRIT_REQUIRED` (Writ not set up), after an optional `wait_for_user_ms` |
| `recommended` | Runs on the user's computer | Runs on Writ Cloud (your account and plan) |
| `cloud` | Runs on Writ Cloud | Runs on Writ Cloud |

- `bridge.pos.lookup({...})` without a user runs on Writ Cloud (`recommended` / `cloud`) and
  raises `WRIT_REQUIRED` in `required` mode.
- A function whose contract lists `local_network` hosts always runs as `required`: Writ Cloud
  cannot reach your user's network. Setting it to another mode is refused when the bridge is created.
- Per function: `function_modes={"pos.lookup": "cloud"}`, or `mode` on the contract entry.

`create_writ_bridge` refuses at creation what would fail later: a `recommended` / `cloud`
function with no cloud mapping or no `WRIT_API_KEY` (`CLOUD_NOT_CONFIGURED`), a secret shorter
than 32 bytes or missing while a function can run on a user's computer, and a contract key whose
first segment is a member of the bridge (`CONFIG_INVALID`).

## Calls

```python
result = await bridge.user(user_id).auth.verify_login(
    {"company": company, "username": username},
    timeout_ms=60_000,          # 1000 to 900000; default 120000
    wait_for_user_ms=5_000,     # required mode: wait this long for the user's page; default 0
    dry_run=False,              # preview a write without sending it, where the function supports it
)
result.data      # the function's data
result.venue     # "user" or "cloud"
result.receipt   # the verified Writ receipt, when it ran on the user's computer
```

Inputs are checked against the contract before anything is routed: every required input present,
nothing undeclared, JSON only, at most 1 MB (`INPUT_INVALID`). `await bridge.online(user_id)`
tells whether one of the user's pages is connected with Writ ready.

## A login gate: challenge and verify

When the page itself calls a function (for example, before a login, to prove the visitor's
computer checked something), mint a single-use challenge, let the page pass it to its call, and
verify the receipt the page relays:

```python
@app.post("/api/login/challenge")
async def login_challenge(body: LoginStart, session=Depends(session)):
    session["writ_challenge"] = bridge.challenge(body.username, "auth.verify_login", ttl_seconds=120)
    return {"challenge": session["writ_challenge"]}


@app.post("/api/login")
async def login(body: LoginFinish, session=Depends(session)):
    check = await bridge.verify(
        body.receipt,
        challenge=session.pop("writ_challenge"),
        key="auth.verify_login",
        origin="https://app.example.com",
        data=body.data,                       # the data the page reports; its hash must match
    )
    if not check.ok:
        raise HTTPException(401, check.reason)
    ...
```

`verify` never raises for a bad receipt; it answers
`VerifyResult(ok, outcome, reason, device, unknown_device)`. `ok` is true only when the receipt's
Ed25519 signature is genuine, its signer is a device pinned for the challenge's subject (see
[Device pins](#device-pins)), it names your challenge and function, the challenge was minted by
this server, is unexpired and was never used before, the origin and data match when given, and
the call succeeded. A challenge is spent once a genuine receipt from a pinned device answers it,
whatever the outcome. Pass `data=None` to check JSON `null`; leave `data` out to skip the data
check.

## Device pins

A receipt carries the public key that signed it, so a valid signature alone says nothing about
who signed: anyone can make an Ed25519 key and sign a receipt that claims success. Pinning ties
receipts to the user's own Writ. `pin_devices` decides:

| `pin_devices` | Accepted signers |
|---|---|
| `"first-use"` (default) | The first device whose receipt verifies for a user is pinned to that user; afterwards only pinned devices verify |
| a function `(user_id, device) -> bool` (may be async) | Your own registry decides |
| `"off"` | Any signer. Receipts then stop replays and cross-site reuse, but not forgery: use it only where the result gates nothing |

A receipt from another device is refused with `unknown_device=True` (`verify()`), or, for a
call through `bridge.user(...)`, `RESULT_UNVERIFIED` with `details["unknown_device"] = True`
and `details["device"]`. When you have confirmed that computer is the user's (an email link, a
signed-in confirmation on a known device), approve it:

```python
try:
    result = await bridge.user(user.id).pos.receive({"invoice_no": invoice_no})
except WritBridgeError as error:
    if error.code == "RESULT_UNVERIFIED" and error.details.get("unknown_device"):
        await send_device_confirmation_email(user, error.details["device"])  # your flow
    raise

# Later, once the user confirmed it:
await bridge.approve_device(user.id, device)          # the device mapping, or its public_key
await bridge.forget_devices(user.id)                  # a lost computer: the next one pins anew
```

Pins live in the bridge's store and never expire. `MemoryStore` forgets them on restart (and the
next device to answer pins anew), so in production use a durable store (`RedisStore`) or your own
registry as a function.

## Several workers: Redis

The default `MemoryStore` serves one process. With `uvicorn --workers N`, gunicorn, several
instances behind a load balancer, or serverless hosts, the page's poll and your call can land in
different processes: share state through Redis (6.2 or later).

```python
import redis.asyncio as redis
from usewrit import RedisStore, create_writ_bridge

store = RedisStore(redis.from_url(os.environ["REDIS_URL"]))      # or RedisStore(url=...)
bridge = create_writ_bridge(Path("writ-contract.json"), mode="recommended", store=store)
```

Keys live under `writ:bridge:` (the Node package's layout, so a Node and a Python server can share
one Redis); device pins are sets under `writ:bridge:devices:<user>` with no expiry, and the
first-use pin is one atomic `EVAL`, so the server must allow Lua scripting. Waits use `BLPOP`, which holds one connection of the client's pool while a page polls
(up to `poll_seconds`) or a call waits: leave `socket_timeout` unset and the pool large enough for
your concurrent pollers. To plug in another store, implement `usewrit.Store`.

## Other frameworks

```python
# Starlette
Route("/writ-bridge", bridge.asgi, methods=["GET", "POST"])

# Any ASGI server, the bridge as the whole app
uvicorn.run(bridge.asgi)

# Anything else: the framework-free core
status, headers, body = await bridge.handle(method, headers, query_string, body_bytes)
```

`bridge.asgi` watches for the page leaving while a poll waits, so a closed tab never takes a
command with it. With `handle()`, pass `disconnected=asyncio.Event()` and set it when the client
goes away, if your framework can tell.

## Run tokens

A linked workflow ([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §11) keeps its recipe in your Writ Cloud. Published in `token`
mode, it is handed out only to calls that carry a run token your backend minted, so only your
signed-in users can run it. The page's `getRunToken` (`@usewrit/web`) fetches one from a route of
yours:

```python
from fastapi.responses import PlainTextResponse
from usewrit import mint_run_token

# Page: getRunToken: () => fetch("/api/writ-token").then((r) => r.text())
@app.get("/api/writ-token", response_class=PlainTextResponse)
def writ_token(user: User = Depends(current_user)) -> PlainTextResponse:
    token = mint_run_token(
        os.environ["WRIT_PUBLICATION_SECRET"],
        "pub_0123456789abcdefABCDEF",   # the publication's id
        sub=str(user.id),               # optional: who it is for
        ttl_seconds=600,                # default 600, at most 3600
    )
    return PlainTextResponse(token, headers={"Cache-Control": "no-store"})
```

- **The secret key** is the publication's `wsk_...`, which Writ Cloud shows once when you publish
  or rotate it; not `WRIT_BRIDGE_SECRET`, and never the publishable `wpk_...` key. It stays on
  your server. Put the route behind your own sign-in: whoever gets a token can run the workflow
  until it expires.
- **The token** is a JWT, HS256, keyed with the secret key's UTF-8 bytes: header
  `{"alg":"HS256","typ":"JWT"}`, claims `{"pub","iat","exp","sub"?}` in that key order, compact
  JSON, base64url without padding. The Node twin's `mintRunToken` mints the same bytes
  (`sdks/fixtures/run_token_golden.json`). Standard library only (`hmac`, `hashlib`, `base64`).
- **Refusals:** `CONFIG_INVALID` for a secret that is not a `wsk_` key, or that holds spaces or a
  line break (an environment variable read with its newline; the message never repeats the
  secret); `INPUT_INVALID` for a bad `publication` or `sub`; `BAD_REQUEST` for `ttl_seconds`
  outside 1 to 3600.
- The page keeps a token in memory until a minute before its `exp`, so a 600 s token means one
  request to this route every 9 minutes or so per visitor.

## Errors

Every failure is a `WritBridgeError` with a stable `code` (branch on it, never on the message)
and `details` (the receipt of a failed call, the Writ Cloud task id).

| code | when |
|---|---|
| `WRIT_REQUIRED` | the function runs only on the user's computer, and Writ is not set up there (or no user was given) |
| `USER_OFFLINE` | none of the user's pages is connected (it was before) |
| `NOT_GRANTED` | the user has not granted the function; or Writ Cloud refused `WRIT_API_KEY` (401/403) |
| `RESULT_UNVERIFIED` | the page answered without a receipt that verifies for this call |
| `TIMEOUT` | the call did not finish in `timeout_ms` |
| `CLOUD_NOT_CONFIGURED` | no cloud mapping or API key; the mapped workflow or function does not exist |
| `CLOUD_UNAVAILABLE` | Writ Cloud could not be reached, or answered 5xx |
| `QUOTA_EXCEEDED` | your Writ Cloud plan is out of runs (402), or of linked workflow deliveries |
| `RATE_LIMITED` | Writ Cloud is limiting runs (429), or too many page runs at once for one user |
| `RUN_FAILED` | the run failed |
| `INPUT_INVALID` / `BAD_REQUEST` | inputs or call options refused |
| `CONFIG_INVALID` | the bridge configuration is invalid |
| others | any code from the visitor's side (`VAULT_LOCKED`, `CONSENT_DENIED`, `GRANT_STALE`, and for linked workflows `RECIPE_UNAVAILABLE`, `PUBLICATION_REVOKED`, ...) |

The page channel answers errors as `{"error": {"code", "message"}}`.

## Security notes

- **The secret stays on the server.** `WRIT_BRIDGE_SECRET` signs user tokens and challenges
  (HMAC-SHA256 over RFC 8785 canonical JSON). Rotate it to log every page out of the bridge.
- **User tokens identify the user to the channel.** Mint them only for the signed-in user, keep
  their lifetime short (`ttl_seconds`, default 3600), and serve the route on the same origin as
  the page: the page bridge refuses any other endpoint, and the channel answers no CORS.
- **Results from a user's computer are verified before you see them.** Each command carries a
  challenge minted for its id; the result must come with a Writ receipt whose Ed25519 signature
  verifies, from a device pinned for that user, that names that challenge and function, and
  whose data hash matches the posted data. A page that alters a result, replays one, or signs one
  with a fresh key gets `RESULT_UNVERIFIED`.
- **Device pinning is on by default (`"first-use"`).** A signature only proves that some key
  signed; pinning is what proves it was the user's own Writ. Keep pins in a durable store (Redis)
  or your own registry (`pin_devices=` a function) in production: a `MemoryStore` restart lets the
  next device pin itself. Approve another computer with `approve_device()` only after confirming
  it out of band; never on the page's word alone, since the page is what an attacker controls.
  `pin_devices="off"` removes the protection against forged results.
- **What a receipt cannot prove:** that the visitor did not run a modified Writ on their own
  pinned computer. It stops script and console forgery, replay and device swaps; it is not a
  proof about the upstream site.
- **Page calls routed to Writ Cloud spend your plan.** Gate them with
  `authorize_run=lambda user_id, key, inputs: ...`; at most 4 run at once per user per process.
- **Hashed data:** numbers are printed as RFC 8785 says (JavaScript's `JSON.stringify` form), so
  the bytes match the Writ engine's and the Node package's; `NaN` and infinities cannot be hashed.
- `WRIT_API_KEY` is used only server-side, sent only to `cloud_base` (https, or http on localhost).

## Development

```bash
pip install -e ".[dev]" && python -m pytest -q
```

The tests read the golden vectors shared with the Writ engine and the Node package: the
repository's `fixtures/bridge_tokens_golden.json`, and the Writ engine's receipt golden file when
`WRIT_RECEIPT_GOLDEN` names it; otherwise the byte-for-byte copies in `tests/fixtures/`, which a
test keeps in step with the shared files whenever they are at hand.

## License

MIT
