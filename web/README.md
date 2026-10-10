# @usewrit/web

Ship the workflows you built in Writ with your website, and run them **on each visitor's own
computer**, through the Writ browser extension for Chrome and Edge. A run happens on the user's
machine: it can reach their local network (a POS on `192.168.x.x`, a NAS, an intranet) and it
leaves from their own IP. The data comes back to your page. No secret ever does, and no Writ
server sits in the middle.

Guides, the public wire contract and runnable examples: [usewrit/writ-for-websites](https://github.com/usewrit/writ-for-websites).

- The Writ Bridge: one object with the same calls your server has, and one line (`mode`) that
  decides whether each function runs on the visitor's PC, on Writ Cloud, or on the PC when it can
- A drop-in banner that gets each visitor set up: the extension, Writ desktop, then a one-click
  install of your workflows
- A typed client generated from one contract file: `pos.pos.receive({ invoice_no })`
- Installable workflow packages with client-side checks that match the Writ engine's
- Typed calls: progress, "waiting for the user" events, `AbortSignal`, cancel, typed errors
- Zero runtime dependencies, ESM with full type declarations, plus a script-tag build; safe to
  import during server rendering

Requirements: Chrome or Edge 111+ on a desktop computer, the Writ extension, and Writ desktop
(or the `writ` CLI) on the same computer. Your page must be served over `https` and call from the
top frame.

## Install

```sh
npm install @usewrit/web
```

Or with a script tag, which defines `window.WritWeb` (and never touches `window.writ`, which
belongs to the extension):

```html
<script src="https://unpkg.com/@usewrit/web@0.2.0/dist/writ-web.iife.js"></script>
<script>
  fetch("/writ-contract.json")
    .then((response) => response.json())
    .then((contract) => WritWeb.mountWritBanner({ app: "Arrivos", contract, onReady: start }));
</script>
```

## Writ Bridge (the recommended way)

One object in your page, with the same calls as your server bridge (`@usewrit/server` for Node,
`usewrit` for Python). You choose where functions run. The bridge shows the banner by itself and
routes every call.

```ts
import { createWritBridge } from "@usewrit/web";
import contract from "./writ-contract.json";
import type { WritFunctions } from "./writ-functions";

const bridge = createWritBridge<WritFunctions>({
  contract,
  app: "Arrivos",
  mode: "required",           // "required" | "recommended" | "cloud"
  endpoint: "/writ-bridge",   // your server bridge's route on this origin (the default)
  userToken,                  // optional: minted by your server; turns on the page channel
});

const { data, venue, receipt } = await bridge.pos.receive({ invoice_no: "F-1029" });
```

**Switching mode is one line.** Your code stays the same; only `mode` changes.

| `mode` | The visitor has Writ and granted your functions | The visitor doesn't | What the visitor sees |
|---|---|---|---|
| `required` | Runs on the visitor's PC | The call waits until they are set up | A banner that cannot be closed: add Writ, install your workflows (one click), allow |
| `recommended` | Runs on the visitor's PC | Runs on Writ Cloud, through your server | A banner suggesting Writ. Closing it keeps your site working on Writ Cloud |
| `cloud` | Runs on Writ Cloud, through your server | The same | Nothing |

- **There is never an automatic fallback.** A call that fails on the visitor's PC rejects with
  its error; it is never re-run on Writ Cloud behind your back.
- **A function can set its own `mode`** in the contract. Otherwise it uses the bridge's.
- **Functions that reach the local network are always `required`.** Writ Cloud cannot reach
  the visitor's network, so `createWritBridge` throws `INPUT_INVALID` when a function whose
  contract entry lists `local_network` hosts would run under `recommended` or `cloud`. A
  `required` function in the bridge also makes the banner one that cannot be closed.
- **`required` needs no Writ Cloud account.** `recommended` and `cloud` need your server bridge
  with `WRIT_API_KEY`, and a contract published from Writ Cloud. Those page calls go to
  `POST {endpoint} { run: { key, inputs, options } }`, and your server runs them with your key.
  The page never holds the key.

Each call resolves with `{ data, venue: "user" | "cloud", receipt, runId, callId }`. `receipt` is
the run's signed receipt when it ran on the visitor's PC, and null on Writ Cloud. The options are
those of [`session.call()`](#calls), plus `challenge`. A failure is a `WritError` whose
`details.venue` says where it ran, with `details.receipt` when Writ signed the failed run.

The bridge's own methods:

- `bridge.ready()` resolves once every function can run where its mode says. With a `required`
  function, that is once the visitor is set up; otherwise, once the bridge has looked for their
  Writ.
- `bridge.venue(key)` answers `"user"`, `"cloud"`, or `null` while a call would wait.
- `bridge.status()` answers `{ mode, ready, local, granted, writVersion, channel, destroyed }`.
- `bridge.suggestSettings({ [key]: { [setting]: value } })` suggests values for your packages'
  [settings](#settings-values-each-user-gives-once), such as the visitor's POS address. The user
  confirms them in Writ's consent window.
- `bridge.refreshRecipes()` makes the visitor's Writ fetch your [linked workflows](#linked-workflows)'
  recipes again on their next call.
- `bridge.destroy()` removes the banner, stops the page channel and cancels running calls.

**The banner.** `banner: { container, position, locale }` places it, and `banner: false` turns it
off. Without the banner, connect the visitor yourself (for example with `mountWritBanner`); the
bridge picks the connection up when the window gets focus back. `timeoutMs` is how long each
check waits for the extension (default 1.5 s).

### The page channel: your server runs functions on the visitor's PC

With a `userToken`, your server can call the user's own computer while one of their pages is
open. The token comes from your server bridge, which signs it with `WRIT_BRIDGE_SECRET`; the
secret never reaches the page.

```ts
// server (Node, @usewrit/server; Python `usewrit` has the same names in snake_case)
import { createWritBridge } from "@usewrit/server";

const bridge = createWritBridge<WritFunctions>({ contract, mode: "required" });
app.all("/writ-bridge", bridge.express());                       // the one route to mount
app.get("/app", (req, res) => res.render("app", { userToken: bridge.userToken(req.user.id) }));

const { data, receipt } = await bridge.user(userId).pos.receive({ invoice_no }); // runs on their PC
```

While the page is open, the page bridge:

- posts its readiness (`{ hello: { ready, granted, writ_version } }`) at start, on every change,
  and every 60 s while it polls;
- long-polls `GET {endpoint}?wait=25` while the visitor's Writ is ready. It pauses after the page
  has been hidden for 5 minutes, and resumes when the page is shown again;
- runs each command on the visitor's PC only when they granted that key, and answers
  `NOT_GRANTED` otherwise. The command's `challenge` goes with the call, so the receipt is bound
  to it. At most 4 calls run at once per tab, the page's own calls included (the extension's
  limit); the rest wait in line;
- posts each outcome with its receipt (`{ result: { id, ok, data, receipt } }`);
- backs off from 1 s to 30 s while your server is unreachable. If your server refuses the token
  (401 or 403), it stops: create the bridge again with a fresh token.

The endpoint must be on the page's own origin; any other origin is refused with `BAD_REQUEST`.
No Writ server is involved. `bridge.status().channel` is `off` (no token), `idle` (waiting for
Writ), `polling`, `retrying`, `paused`, `unauthorized` or `stopped`.

### Login gate: a check only the visitor's PC can make

Your server mints a single-use challenge. The page runs the check on the visitor's PC, bound to
that challenge. The server then trusts the result only if Writ signed it.

```ts
// server: a challenge for this user and this function
app.post("/login/challenge", (req, res) =>
  res.json({ challenge: bridge.challenge({ subject: req.body.username, key: "auth.verify_login" }) }));

// page: run the check on the visitor's PC, bound to the challenge
const { challenge } = await postJson("/login/challenge", { username });
const { data, receipt } = await bridge.auth.verify_login({ company, username }, { challenge });
await postJson("/login", { username, challenge, data, receipt });

// server: verify before trusting the result
app.post("/login", (req, res) => {
  const { challenge, data, receipt } = req.body;
  const check = bridge.verify(receipt, { challenge, key: "auth.verify_login", data });
  if (!check.ok) return res.status(403).end();   // forged, replayed, altered or another device
  // data.ok came from the visitor's own Writ
});
```

Only a run on the visitor's PC has a receipt. A gate like this one belongs to a `required`
function.

## Quick start: from your Writ workflows to your website

1. **Build the workflows in Writ** (Writ desktop or Writ Cloud), and prove them on real inputs.
2. **Download one contract file.** In Writ desktop, open Connect, then Websites, then
   "Add to your website", pick the workflows and functions, and download `writ-contract.json`
   with its typings `writ-functions.d.ts`. From a terminal:
   `writ package export <workflow> --out writ-contract.json`.
3. **Ship both files with your site.**
4. **Load them with `@usewrit/web`:**

```ts
import { createWritClient, isWritError, mountWritBanner, validateContract } from "@usewrit/web";
import contractJson from "./writ-contract.json";
import type { WritFunctions } from "./writ-functions";

const contract = validateContract(contractJson); // checked once, and typed

mountWritBanner({
  app: "Arrivos",
  contract,
  onReady(session) {
    const pos = createWritClient<WritFunctions>(session, contract);

    receiveButton.onclick = async () => {
      try {
        const { data } = await pos.pos.receive({ invoice_no: "F-1029" }).result;
        showReceived(data.lines);
      } catch (error) {
        if (isWritError(error, "CONSENT_DENIED")) showNotice("Receiving was not confirmed.");
        else throw error;
      }
    };
  },
});
```

The banner gets the visitor set up (see [Drop-in banner](#drop-in-banner)). Once they are
connected, `onReady` gets the session and the typed client calls each function **on the
visitor's own computer**.

Take Arrivos, an invoice app for restaurants. It receives supplier invoices into the restaurant's
Auphan POS, which sits on the restaurant's own network at `192.168.1.20`. With this package, each
`pos.receive` call goes from the restaurant's PC straight to the POS. Arrivos's servers never
reach the POS and never see its password, and no Writ server takes part in the call.

### The typed client

`createWritClient<F>(session, contract)` builds one method per contract key. Dotted keys nest:
`"pos.receive"` becomes `client.pos.receive(inputs, options)`. Every method:

- checks `inputs` against the contract before anything is sent: every required input present,
  nothing undeclared. A problem throws a `WritError` with code `INPUT_INVALID`;
- returns the same call handle as `session.call()` (see [Calls](#calls)).

`F` is the `WritFunctions` interface Writ generates next to the contract:

```ts
// writ-functions.d.ts (generated)
export interface WritFunctions {
  "pos.receive": { inputs: { invoice_no: string }; outputs: { received: boolean; lines: number } };
  "pos.lookup": { inputs: { sku?: string }; outputs: { name: string; price: number } };
}
```

Without `F`, the client still works, untyped (`WritCall<unknown>`).

### The contract file

`writ-contract.json` (`format: "writ.contract/v1"`) lists the `packages` to install and the
`functions` your site calls. Each function names its package and the package function it runs,
with its declared `inputs`, `outputs`, `writes` and `local_network` hosts.

- `validateContract(json)` checks a contract (the parsed JSON or its text) and returns a
  deep-frozen copy. It throws `INPUT_INVALID` with the field at fault. It checks the format, that
  keys are valid and unique, that every function names a package of the file, every package
  (with the same rules as `definePackage()`), and that no key is both a function and a namespace
  (`"pos"` next to `"pos.receive"`).
- `contractFunctions(contract, { settings? })` gives the `functions` to pass to `writ.connect()`,
  each with its package and function attached, and with your suggested
  [settings](#settings-values-each-user-gives-once) when you pass them. The banner does this for
  you.
- A function's `settings` (`{ key, label, kind }[]`) lists its package's settings, so your own
  form knows what to ask. `validateContract` checks that the package declares each one, with the
  same `kind`. They are never call inputs: the typed client refuses them.

## Drop-in banner

```ts
import { mountWritBanner } from "@usewrit/web";

const banner = mountWritBanner({
  app: "Arrivos",
  contract,                 // or: functions: [{ key, description, package, function? }]
  onReady(session) { enableReceiving(session); },
  position: "top",          // or "bottom"; ignored with `container`
  locale: "fr",             // "en" | "fr" | "es"; default: the browser's language, else English
});
// banner.session: Promise<WritSession>; banner.destroy() removes it.
```

Before it shows anything, the banner quietly asks the extension whether this visitor is
already connected. If they are, and every package is at the version you ship, it never renders
and calls `onReady` at once. Otherwise it walks the visitor through what is missing, one step at
a time:

1. **No extension.** A "Writ for Chrome" or "Writ for Edge" button opens the right store, next
   to "I installed it". If a re-check still finds nothing, the banner says to reload the page and
   the button becomes "Reload page". Firefox, Safari and phones see a short note that Writ needs
   Chrome or Edge on a computer, with nothing to click but close.
2. **No Writ desktop, or an old one.** "Get Writ desktop" (or "Update Writ desktop") links to
   https://usewrit.app/desktop, next to "I installed it".
3. **Writ is not running.** "Open Writ on this computer, then retry", with a Retry button. A
   locked Writ reads "Unlock Writ, then retry".
4. **Not connected yet.** The main button reads "Install Arrivos POS (one click)", using your
   first package's name. It reads "Update ... (one click)" when the visitor has an older
   version, and "Connect" when you ship no package. It opens the extension's consent window.
   If the visitor declines, a quiet "Not now" state offers "Try again".
5. **Connected.** The banner hides and calls `onReady(session)`.

Behavior:

- **Dismissible.** The close button hides the banner for the rest of the page session
  (`sessionStorage`). `banner.session` then rejects with `CONSENT_DENIED`; it rejects with
  `CANCELLED` after `destroy()`. A visitor who is already connected still gets `onReady`.
- **No background polling.** It re-checks only when the visitor clicks one of its buttons, and
  when the window gets focus back, for example after installing Writ in another tab. A re-check
  on focus never opens the consent window.
- **Isolated.** It renders in a closed shadow root, so no CSS leaks in either direction. It is
  fixed to the top or bottom of the viewport, or inside `container` when you pass one.
- **Accessible.** It is a labelled `region` with real buttons and links. Its status line is a
  polite live region, and keyboard focus stays in the banner as it changes.
- **Quiet by default.** It follows `prefers-color-scheme` and `prefers-reduced-motion`, draws
  inline SVG icons, and loads no fonts, images or scripts.
- **Validated early.** Invalid options throw `BAD_REQUEST`, and an invalid package or contract
  throws `INPUT_INVALID`, before anything renders. A linked workflow in `token` mode without
  `getRunToken` is a `BAD_REQUEST`.
- **Linked workflows.** After `onReady`, it comes back only for them: **Update** when a call finds
  the published workflow changed, **Unavailable** when it was withdrawn or cannot be fetched (see
  [Linked workflows](#linked-workflows)).

## Install your workflow on the visitor's computer

Without a contract file, you can describe a workflow package in code. With `connect()`, the
visitor installs it and allows it in the same click:

```ts
import { connectWrit, definePackage } from "@usewrit/web";

const posReceive = definePackage({
  format: "writ.workflow/v1",
  id: "arrivos.pos-receive",
  version: "1.2.0",
  name: "Arrivos POS receive",
  description: "Marks a supplier invoice as received in the POS on your store network.",
  inputs: { invoice_no: { description: "Supplier invoice number", required: true } },
  credentials: [{ key: "pos_password", label: "POS password", secret: true }],
  local_network: { hosts: ["192.168.1.20:8080"], reason: "Your POS server on the store network" },
  steps: [
    {
      type: "api_call",
      config: {
        method: "POST",
        url: "http://192.168.1.20:8080/api/receivings",
        headers: { "X-Pos-Password": "{{secret:pos_password}}" },
        body_json: { invoice: "{{invoice_no}}" },
        side_effect: "write",
      },
    },
  ],
});

const writ = await connectWrit();
if (!writ.available) return showInstallWrit(writ.installUrl);
const session = await writ.connect({
  app: "Arrivos",
  functions: [{ key: "pos.receive", description: "Receive an invoice in your POS", writes: true, package: posReceive }],
});
await session.call("pos.receive", { invoice_no: "F-1029" }).result;
```

**One click.** The consent window's button reads "Install and allow". Above it, the user sees:

- the package's name, version and description;
- each function, with its inputs, outputs, and whether it changes data;
- every host it calls;
- the local-network hosts it asks for, with your reason;
- one field per declared credential.

A new `version` reopens the same window as "Update", again one click.

**Your site never sees credentials.** The user types the POS password in the extension's own
window. It goes to Writ on their computer and is sealed on the installed workflow. Your page
can neither read nor script that window, and `{{secret:pos_password}}` is resolved only on the
user's machine.

**Isolation.** An installed site workflow, whoever runs it (your site, the owner, a schedule):

- never reads the owner's vault, personas or local files;
- sees only its own declared inputs and the credentials typed for it at install time;
- reaches local-network hosts only when the package declares them and the user confirms them
  in the same click (at most 8 single hosts: no ranges, never the computer itself);
- cannot carry AI steps (they would spend the owner's AI key), file steps, generated code or
  payment fields.

`definePackage()` returns a deep-frozen copy. It throws `INPUT_INVALID` with the exact field at
fault, and `connect()` runs the same checks on every `package` it gets, before anything is sent.
The checks cover:

- `format`, the id (`[a-z0-9][a-z0-9._-]{0,63}`), the name (1 to 120 characters), the version
  (at most 32) and the description (at most 1 000);
- 1 to 500 steps, and at most 512 KB of JSON;
- credential keys (`[A-Za-z0-9_]{1,64}`, at most 10), and every `{{secret:K}}` declared;
- settings (below): at most 8, keys `[A-Za-z0-9_]{1,64}` that are not also inputs or credentials,
  and no URL that takes its scheme or host from a function input;
- local-network hosts;
- the refused step types and placeholders above.

The Writ engine checks everything again at install.

A package with several functions needs `function` on each key that uses it:

```ts
functions: [
  { key: "pos.receive", description: "Receive an invoice", package: pos, function: "receive" },
  { key: "pos.lookup", description: "Look up a product", package: pos, function: "lookup" },
]
```

## Settings (values each user gives once)

Some values differ from one user to the next but never from one call to the next: the address of
their POS on the store network, their store number. Declare them as `settings`. Each user gives
them once, in Writ's own consent window, and every run reuses them as `{{key}}`:

```ts
const posReceive = definePackage({
  format: "writ.workflow/v1",
  id: "arrivos.pos-receive",
  name: "Arrivos POS receive",
  inputs: { invoice_no: { description: "Supplier invoice number" } },
  settings: [
    {
      key: "pos_host",
      label: "Your POS address",
      description: "On the POS: Settings, then Network",
      kind: "lan_host",              // one address on the user's network; default "text"
      example: "192.168.1.20:8080",  // the field's placeholder
    },
  ],
  steps: [
    {
      type: "api_call",
      config: { method: "POST", url: "http://{{pos_host}}/api/receivings", body_json: { invoice: "{{invoice_no}}" } },
    },
  ],
});
```

A setting has a `key` (`[A-Za-z0-9_]{1,64}`, never also an input or a credential), a `label` (1 to
80 characters), and optionally a `description` (at most 200), a `kind` (`"text"` or `"lan_host"`),
an `example` (at most 120) and `required` (default `true`). A package declares at most 8.

- **Who gives it.** The user, in Writ's consent window, when they install or update. Nothing is
  stored before they click "Install and allow". The value is stored on their installed workflow,
  and every run resolves `{{pos_host}}` with it, whoever starts the run: your site, the user, a
  schedule.
- **`lan_host`.** One address on the user's local network, `host` or `host:port`. The confirmed
  address becomes one of the workflow's approved local-network hosts. When the user changes it,
  the new address replaces the old one.
- **Not a call input.** Your site cannot pass a setting with a call: `pos_host` in `inputs` is
  `INPUT_INVALID`, and the typed client refuses it.
- **Not a secret.** Use a credential for passwords and keys.
- **Where a request may go.** A URL whose scheme or host comes from a placeholder must take it
  from a setting. `http://{{invoice_no}}/...` is refused by `definePackage()` and by Writ itself,
  because your site could aim the user's Writ anywhere, call by call. A value read from a response
  (`{{extracted:next_url}}`) and a declared credential are not inputs, so they may still name the
  host.

**Suggesting a value.** Your own form may already ask "What is your POS address?". Pass the
answer on, and Writ's consent window shows it pre-filled. The user still confirms or corrects it:

```ts
// Your form asked, then:
await bridge.suggestSettings({ "pos.receive": { pos_host } });
```

- **The visitor is connected.** `suggestSettings` re-runs the connect for those keys, which opens
  Writ's consent window as an update. It resolves once the user confirmed, at once when the value
  is already the stored one, and rejects with `CONSENT_DENIED` when they decline.
- **The visitor is not connected yet.** The banner's "Install" window shows the value pre-filled,
  and `suggestSettings` resolves once they are connected.
- **Known before the bridge starts.** Pass `settings` to `createWritBridge` instead. It is merged
  into the connect request of each key:

  ```ts
  createWritBridge({ contract, app: "Arrivos", settings: { "pos.receive": { pos_host } } });
  ```

- **Lower level.** `FunctionRequest.settings` carries the same suggestions to `writ.connect()`, and
  `contractFunctions(contract, { settings })` attaches them for you.

A suggestion is at most 8 values per key, each 1 to 200 characters without control characters,
for settings the key's package declares (`INPUT_INVALID` otherwise). Settings belong to the
package, so a value suggested for `pos.receive` holds for `pos.lookup` too when both keys
install the same package. A suggestion that differs from the stored value reopens consent as an
update. The user can also change the value later in Writ desktop (Websites, then your site).

## Linked workflows

A bundled contract ships the whole recipe with your site. A **linked** contract ships only what
the workflow does (its manifest) and a link: the recipe stays in your Writ Cloud, and the
visitor's Writ fetches it, signed, each time it runs one of its functions. It keeps it in memory
only. You publish a fix once and every visitor runs it on their next call. The visitor approved
the manifest, and Writ checks every recipe against it.

**The same code; the contract decides.** In Writ Cloud, on a workflow, choose "Use on a website",
publish, and download the **linked contract**. Load it exactly as you load a bundled one:

```ts
import contract from "./writ-contract.json"; // a linked contract from Writ Cloud
import type { WritFunctions } from "./writ-functions";

mountWritBanner({
  app: "Arrivos",
  contract,
  getRunToken: () => fetch("/api/writ-token").then((r) => r.text()), // token mode only
  onReady(session) {
    const pos = createWritClient<WritFunctions>(session, contract);
    pos.orders.list().result.then(({ data }) => showOrders(data.orders));
  },
});
```

`createWritBridge({ contract, app, mode, getRunToken })` works the same way. A linked contract
from a Writ Cloud workflow carries each function's `cloud` mapping, so `recommended` and `cloud`
work as they do for a bundled one.

**Access.** Each publication is `public` (any page on its allowed origins may run it) or `token`.

- **`token`:** every call needs a run token your backend mints with the publication's secret key
  (`mintRunToken` in `@usewrit/server`, `mint_run_token` in `usewrit`). Pass `getRunToken` to
  `mountWritBanner`, `createWritBridge`, `writ.connect()` / `writ.resume()`, or
  `createWritClient(session, contract, { getRunToken })`. Without it, these throw `BAD_REQUEST`
  as soon as the contract has a token-mode workflow.
- **The token stays in memory.** The library asks `getRunToken` before a call that needs a token,
  and reuses the answer until 60 seconds before its `exp`. It reads `exp` from the JWT without
  verifying it (the page cannot), never writes the token to storage, and shares one token between
  calls made at once. A failure is never cached, and a token Writ Cloud refused (`NOT_GRANTED`) is
  never reused. `getRunToken` rejecting fails the call with `NOT_GRANTED` (or the code of the
  `WritError` it rejected with).
- **Per call.** `call(key, inputs, { token })` sends a token you already have.

**How long the recipe stays: `recipeCache`.** Pass it where you pass `getRunToken`, or per call.

- `"session"` (the default): the visitor's Writ fetches the recipe at this page's first call, then
  reuses it until the page goes away.
- `"call"`: it fetches the recipe for every call.
- `refreshRecipes()` forces a fetch on the next call (`writ_refresh_recipes`). It exists on the
  session, on the client from `connectWrit()`, and on the bridge.

**What the visitor sees.** The banner installs a linked workflow like a bundled one, after
Writ fetched its manifest, and names it by the manifest's `name`, which Writ Cloud vouches for
(the entry's own `name` and `publisher` are only what your file says). Then it watches the
session it handed over:

- a call that finds the published workflow changed beyond what the visitor approved fails with
  `GRANT_STALE`, and the banner comes back with **Update**, which reopens consent;
- a workflow you withdrew (`PUBLICATION_REVOKED`) shows **Unavailable**;
- a recipe Writ cannot fetch (`RECIPE_UNAVAILABLE`, offline, say) shows **Unavailable** with
  Retry, which refreshes the recipes and hides the notice so the visitor can try again.

The call still rejects with its error, for your code to handle.

## Lower level: `connect()` and `call()`

Without a package, you ask for keys and the user binds each one to **one of their own Writ
functions** in the consent window. You never see their workflows. Those functions can sign in
with the user's own Writ personas.

```ts
import { connectWrit, isWritError } from "@usewrit/web";

const writ = await connectWrit();                 // waits up to 1.5 s for the extension
if (!writ.available) {
  showInstallWrit(writ.installUrl);               // Chrome Web Store or Edge Add-ons
  return;
}

const session = await writ.connect({
  app: "Arrivos",
  functions: [
    {
      key: "pos.receive",
      description: "Receive a supplier invoice in your POS",
      writes: true,
      match: { host: "192.168.1.20" },            // pre-selects the user's matching function
    },
  ],
});

const call = session.call<{ received: boolean; lines: number }>("pos.receive", {
  invoice_no: "F-1029",
});
call.on("progress", ({ index, total }) => setProgress(index / total));
call.on("needsUser", ({ reason }) => showHint(reason)); // "confirm" | "twofa" | "captcha" | "vault_locked"

try {
  const { data, runId, durationMs, engine } = await call.result;
  showReceived(data.lines);
} catch (error) {
  if (isWritError(error, "CONSENT_DENIED")) showNotice("Receiving was not confirmed.");
  else if (isWritError(error, ["NOT_GRANTED", "GRANT_STALE"])) await reconnect();
  else throw error;
}
```

`writ.connect()` opens the extension's consent window the first time. Keys that are already
bound answer at once, without a window.

On page load, to show "connected" without opening anything, use `resume()`:

```ts
const session = await writ.resume();              // null until the user connects this site
```

## When Writ is not available

`connectWrit()` never throws for a missing extension. It answers:

```ts
{ available: false, reason: "NOT_INSTALLED" | "DESKTOP_OUTDATED", installUrl, browser, error }
```

Fallback UI that works:

- `browser` is `"chrome"`, `"edge"` or `"chromium"` (Brave, Opera, Vivaldi): show an
  **Install Writ** button linking to `installUrl`, and tell the user to reload the page after.
- `browser` is `"other"` (Firefox, Safari, any phone): the extension does not exist there. Say
  "This feature needs Writ in Chrome or Edge on a computer", and keep your normal flow working.
- `reason` is `"DESKTOP_OUTDATED"`: the extension speaks another protocol. Link to `installUrl`
  so the user can update it.
- Writ installed but not ready? `await writ.status()` reads `host` (`"missing"` or
  `"outdated"` means install or update Writ desktop) and `daemon` (`"unavailable"` means Writ
  could not start) without prompting anyone.

The store links are exported as `CHROME_WEB_STORE_URL` and `EDGE_ADDONS_URL`.

## Calls

`session.call(key, inputs?, options?)` returns a handle at once:

| Member | |
|---|---|
| `call.result` | `Promise<{ data, runId, durationMs, engine, callId, receipt? }>`; rejects with a `WritError` |
| `call.callId` | `Promise<string>`, the extension's id for the call |
| `call.on(event, cb)` / `call.off(event, cb)` | `started` `{ runId }`, `progress` `{ index, total }`, `needsUser` `{ reason }`, `finished` (the result), `error` (the `WritError`) |
| `call.cancel()` | rejects `result` with `CANCELLED` and stops the run |
| `call.status`, `call.runId` | `pending`, `running`, `finished`, `failed` or `cancelled`; the run id once started |

`started`, `finished` and `error` are replayed to a listener attached late. `progress` and
`needsUser` events that arrive before any listener of their kind are queued for the first one.

Options:

- `signal`: an `AbortSignal`. Aborting cancels the run and rejects with `CANCELLED`.
- `timeoutMs`: the run's budget, clamped to 1 s .. 15 min (default 2 min). The extension enforces
  it; the library also gives up 5 s after it, in case the extension stops answering.
- `dryRun`: ask the function to run without changing anything, where it supports that.
- `challenge`: a value your server minted (at most 2 048 characters), sent as is. Writ signs it
  into the run's receipt, so your server can verify that this run answered it.
- `token`: a run token for a [linked workflow](#linked-workflows) in `token` mode, or a function
  that resolves with one. The session's `getRunToken` answers when you leave it out.
- `recipeCache`: `"session"` or `"call"`, for a linked workflow. Default: the session's.

`result.receipt` is the run's signed receipt ([contract](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md) §12.1) when the extension passes
receipts on: null when Writ signed none, absent with an older extension. A failed run's receipt
is in `error.details.receipt`. The page never verifies a receipt: send it to your server, which
does (`bridge.verify(receipt, ...)`).

`inputs` must be a plain JSON object of the function's declared inputs (see
`session.function(key)?.inputs`). The library refuses, before sending anything: non-JSON values
(functions, `Date`, `Map`, class instances, `NaN`, cycles), names starting with `secret:` or
`file:`, `persona_id` / `function_name` / `auth_policy`, and more than 1 MB of JSON.

Other session members: `session.origin`, `session.functions` (the granted functions, with their
inputs, outputs, `writes` and `local_network`), `session.function(key)`, `session.refresh()`
(re-read the grant), `session.refreshRecipes()` (fetch linked recipes again on the next call),
`session.disconnect()` (cancel running calls and revoke this site's grant).

Field names follow the wire: values the extension sends (`writ.status()`, `session.functions`)
keep its snake_case (`local_network`, `desktop_version`); values this library builds (results,
events, options) are camelCase.

## Errors

Every failure is a `WritError` with a stable `code`. Branch with `isWritError(error, code)`.

| code | when | what your page should do |
|---|---|---|
| `NOT_INSTALLED` | no extension (only in `connectWrit()`'s answer) | show the install link |
| `DESKTOP_MISSING` | Writ desktop is not installed, or too old | ask the user to install Writ desktop |
| `DESKTOP_OUTDATED` | extension, desktop or this library speak different protocols | ask the user to update Writ |
| `DAEMON_UNAVAILABLE` | Writ could not start its engine | ask the user to open Writ, then retry |
| `VAULT_LOCKED` | the user's Writ vault is locked | ask the user to unlock Writ, then retry |
| `CONSENT_DENIED` | the user declined the connection or a change | respect it; offer to try again |
| `NOT_GRANTED` | no grant for this site, or no binding for that key | call `writ.connect()` |
| `GRANT_STALE` | the user's function changed since they approved it | call `writ.connect()` again |
| `WRITE_NEEDS_CONFIRM` | a change was not confirmed | retry; the user is asked to confirm |
| `INPUT_INVALID` | inputs refused (undeclared, missing, secret/file, too large, a URL host chosen by input), or a package or contract the engine would refuse | fix the inputs, the package or the contract |
| `RATE_LIMITED` | per-site limits (2 running, 30 a minute, 500 a day; 4 in flight per tab) | wait and retry |
| `LAN_NOT_ALLOWED` | the run needed a local-network address the owner has not approved | ask the owner to approve it in Writ |
| `RUN_FAILED` | the run failed (the message carries no selectors, URLs or stack) | show the message; let the user retry |
| `CANCELLED` | cancelled by your page, the tab closing, or the user | nothing |
| `TIMEOUT` | the call exceeded its timeout | retry, maybe with a larger `timeoutMs` |
| `RESULT_TOO_LARGE` | the result exceeded the cap (25 MB) | return less data from the function |
| `BAD_REQUEST` | malformed request (bad key, description, option, banner option) | fix the code |
| `ORIGIN_NOT_ALLOWED` | not `https`, or not the top frame | serve over https, call from the top frame |
| `INTERNAL` | anything else; an unknown code is kept in `details.providerCode` | report it |
| `RECIPE_UNAVAILABLE` | a linked workflow: Writ could not fetch its recipe (offline, or a Writ Cloud it may not use) | let the visitor retry; the banner offers Retry |
| `PUBLICATION_REVOKED` | a linked workflow you withdrew | publish it again, or stop offering it |
| `QUOTA_EXCEEDED` | a linked workflow: your Writ plan is out of deliveries this month | raise your plan |
| `WRIT_REQUIRED` | Writ Bridge: your server refused to run a `required` function on Writ Cloud | run it through the bridge in the page |
| `USER_OFFLINE` | Writ Bridge (server side): none of the user's pages has Writ ready | ask the user to open your site |
| `RESULT_UNVERIFIED` | Writ Bridge (server side): a result's receipt did not verify | treat the result as forged |
| `CLOUD_NOT_CONFIGURED` | Writ Bridge: your server has no `WRIT_API_KEY`, or the function has no Writ Cloud mapping | configure the server bridge |

## Security

- **Your site never sees secrets.** Passwords, sessions and personas stay in the user's Writ
  vault on their PC; credentials for an installed package are typed in the extension's own
  window and sealed on that workflow. Your page receives only the function's declared outputs.
  Errors are sanitized and progress carries no step labels and no URLs.
- **The user decides.** You ask for keys and describe them. The user binds each key to one of
  their own functions, or installs the package you ship, in a consent window owned by the
  extension that your page can neither script nor frame. You never learn workflow ids.
- **Installed packages are walled off.** A site's workflow never reads the owner's vault,
  personas or files, never runs AI steps, and reaches only the local-network hosts the user
  confirmed for it.
- **Changes are confirmed.** Functions that change data are flagged in consent, and by default
  the user confirms each change before it runs (`CONSENT_DENIED` when they decline). `dryRun` is
  available where the function supports it.
- **Inputs cannot choose a local-network address.** A run may only reach the hosts recorded when
  the user approved the grant, and local-network hosts must be approved by the owner on their
  own computer. An input that would become a URL host is refused with `INPUT_INVALID`, so your
  page cannot turn the user's PC into a proxy.
- **The browser decides who you are.** Grants are keyed by the origin the browser reports, top
  frame only, `https` only. The user can revoke your site at any time from the extension or Writ
  desktop; `session.disconnect()` revokes it from your side.
- **Treat `data` like user input.** The user chose which function answers, so validate results
  the way you validate a form.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build        # tsc (ESM + .d.ts) and esbuild (dist/writ-web.iife.js)
```

The wire contract is [docs/contract.md in usewrit/writ-for-websites](https://github.com/usewrit/writ-for-websites/blob/main/docs/contract.md): §1 (page and
provider), §8 (installable workflows), §9 (the banner), §10 (the contract file and the typed
client), §11 (linked workflows: run tokens, the recipe cache) and §12 (the Writ Bridge: receipts
and the page channel).

## License

MIT, see [`LICENSE`](./LICENSE).
