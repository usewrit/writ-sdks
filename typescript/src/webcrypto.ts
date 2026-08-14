/**
 * The single seam through which this package reaches Web Crypto.
 *
 * `globalThis.crypto` is a global in browsers, Deno, workers and **Node 19+** —
 * but NOT on Node 18, which this package's `engines` still supports. There it
 * exists only as `node:crypto`'s `webcrypto`. Every caller goes through here so
 * that difference is handled once; two copies of this ladder would drift.
 *
 * The `node:crypto` import is dynamic and guarded. `src/` has no other runtime
 * Node import, and that is deliberate — this package runs in browsers and
 * workers, where a static `node:` import fails to resolve at bundle time.
 * Guarded and dynamic, a bundle that cannot resolve it simply falls through.
 */

// Type-only: this tsconfig is `lib: ES2022` with no DOM, so the DOM `Crypto` and
// `SubtleCrypto` names do not exist here. Erased at build; costs a bundle nothing.
import type { webcrypto } from "node:crypto";

export type Subtle = webcrypto.SubtleCrypto;

/** The slice of Web Crypto this package uses. */
export interface WebCryptoLike {
  readonly subtle: Subtle;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  randomUUID?(): string;
}

let resolved: WebCryptoLike | undefined;
let inflight: Promise<WebCryptoLike | undefined> | undefined;

/**
 * Web Crypto if it can be had **without awaiting** — the global, or a
 * `node:crypto` instance a previous [`warmWebCrypto`] already cached.
 *
 * Returns `undefined` on Node 18 before anything has warmed it. Callers that
 * can await should prefer [`warmWebCrypto`]; this exists for synchronous APIs
 * that cannot change shape without a breaking release.
 */
export function webCryptoSync(): WebCryptoLike | undefined {
  const fromGlobal = globalThis.crypto as WebCryptoLike | undefined;
  if (fromGlobal?.getRandomValues) return fromGlobal;
  return resolved;
}

/**
 * Web Crypto, resolving `node:crypto` once if the global is absent. Cached, so
 * the dynamic import happens at most once per process.
 */
export function warmWebCrypto(): Promise<WebCryptoLike | undefined> {
  const sync = webCryptoSync();
  if (sync) return Promise.resolve(sync);
  inflight ??= (async () => {
    try {
      const mod = await import("node:crypto");
      const wc = mod.webcrypto as unknown as WebCryptoLike | undefined;
      if (wc?.getRandomValues) resolved = wc;
    } catch {
      // Not Node — a browser without Web Crypto (an insecure context), or a
      // bundle that stripped the import. Leave `resolved` unset.
    }
    return resolved;
  })();
  return inflight;
}
