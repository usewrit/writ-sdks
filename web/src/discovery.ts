/**
 * Finding the provider (CONTRACT.md §1, EIP-6963 style) and picking the store for this browser.
 *
 * Race-free in both orders:
 * - the provider injected first: `window.writ` is already there, or it re-announces when the
 *   library dispatches `writ:requestProvider`;
 * - the library loaded first: the provider's own `writ:announceProvider` at injection is heard.
 *
 * Nothing here touches `window` at import time, so the module is safe to import during SSR.
 */

import {
  ANNOUNCE_PROVIDER_EVENT,
  CHROME_WEB_STORE_URL,
  EDGE_ADDONS_URL,
  REQUEST_PROVIDER_EVENT,
  WRIT_PROTOCOL,
} from "./constants.js";
import type {
  BrowserKind,
  WritNavigator,
  WritProvider,
  WritProviderInfo,
  WritWindow,
} from "./types.js";

/** A `window.writ`-shaped object whose protocol is not checked yet. */
interface ProviderCandidate {
  readonly isWrit: true;
  readonly version?: unknown;
  readonly protocol?: unknown;
  request: WritProvider["request"];
  on: WritProvider["on"];
  off: WritProvider["off"];
}

/** What discovery found. */
export type DiscoveryOutcome =
  | { readonly kind: "found"; readonly provider: WritProvider; readonly info: WritProviderInfo }
  | { readonly kind: "outdated"; readonly version: string | null; readonly protocol: unknown }
  | { readonly kind: "missing" };

/**
 * Look for the Writ provider in `win`, waiting at most `timeoutMs` for an announcement.
 * Never rejects.
 */
export function findProvider(win: WritWindow, timeoutMs: number): Promise<DiscoveryOutcome> {
  const direct = readWindowProvider(win);
  if (direct !== null) return Promise.resolve(classify(direct, undefined));

  return new Promise<DiscoveryOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: DiscoveryOutcome): void => {
      if (settled) return;
      settled = true;
      win.removeEventListener(ANNOUNCE_PROVIDER_EVENT, onAnnounce);
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };

    function onAnnounce(event: Event): void {
      const detail = (event as Event & { detail?: unknown }).detail;
      if (typeof detail !== "object" || detail === null) return;
      const { provider, info } = detail as { provider?: unknown; info?: unknown };
      if (!isProviderCandidate(provider)) return;
      // `window.writ` is defined non-configurable by the extension at document_start. When it
      // exists, it wins over any announced object.
      const pinned = readWindowProvider(win);
      finish(classify(pinned ?? provider, pinned === null ? info : undefined));
    }

    win.addEventListener(ANNOUNCE_PROVIDER_EVENT, onAnnounce);
    timer = setTimeout(() => {
      const late = readWindowProvider(win);
      finish(late === null ? { kind: "missing" } : classify(late, undefined));
    }, timeoutMs);

    // A provider that is already injected answers synchronously inside dispatchEvent.
    try {
      const EventCtor = win.Event ?? globalThis.Event;
      win.dispatchEvent(new EventCtor(REQUEST_PROVIDER_EVENT));
    } catch {
      // A window without a working Event constructor: the timeout still answers.
    }
  });
}

/** `window.writ` when it is a Writ provider, else null (an unrelated global named `writ`). */
function readWindowProvider(win: WritWindow): ProviderCandidate | null {
  let value: unknown;
  try {
    value = win.writ;
  } catch {
    return null;
  }
  return isProviderCandidate(value) ? value : null;
}

function isProviderCandidate(value: unknown): value is ProviderCandidate {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.isWrit === true &&
    typeof record.request === "function" &&
    typeof record.on === "function" &&
    typeof record.off === "function"
  );
}

function classify(candidate: ProviderCandidate, announcedInfo: unknown): DiscoveryOutcome {
  const version = typeof candidate.version === "string" ? candidate.version : null;
  if (candidate.protocol !== WRIT_PROTOCOL) {
    return { kind: "outdated", version, protocol: candidate.protocol };
  }
  const announcedName =
    typeof announcedInfo === "object" &&
    announcedInfo !== null &&
    typeof (announcedInfo as { name?: unknown }).name === "string"
      ? (announcedInfo as { name: string }).name
      : "Writ";
  const info: WritProviderInfo = Object.freeze({
    name: announcedName,
    version: version ?? "unknown",
    protocol: WRIT_PROTOCOL,
  });
  return { kind: "found", provider: candidate as WritProvider, info };
}

// ---------------------------------------------------------------------------------------------
// Browser and store
// ---------------------------------------------------------------------------------------------

/**
 * Which store this browser installs extensions from.
 *
 * `edge` installs from `EDGE_ADDONS_URL` (the Chrome Web Store listing until the Edge Add-ons one
 * exists), `chrome` and `chromium` (Brave, Opera, Vivaldi, ...) from the Chrome Web Store. `other` is a browser the Writ extension does not support: Firefox,
 * Safari, and every mobile browser.
 */
export function detectBrowser(nav?: WritNavigator | null): BrowserKind {
  if (nav === undefined || nav === null) return "other";

  const data = nav.userAgentData;
  if (data !== undefined && data !== null && Array.isArray(data.brands) && data.brands.length > 0) {
    if (data.mobile === true) return "other";
    const brands = data.brands.map((entry) => {
      const brand: unknown = entry?.brand;
      return typeof brand === "string" ? brand.toLowerCase() : "";
    });
    if (brands.includes("microsoft edge")) return "edge";
    if (brands.includes("google chrome")) return "chrome";
    if (brands.includes("chromium")) return "chromium";
  }

  const ua = typeof nav.userAgent === "string" ? nav.userAgent : "";
  if (ua === "") return "other";
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return "other";
  if (/\bEdg\//.test(ua)) return "edge";
  if (/\b(OPR|Vivaldi|YaBrowser|SamsungBrowser|Brave)\//.test(ua)) return "chromium";
  if (/\bChrome\//.test(ua)) return "chrome";
  return "other";
}

/** The store page that installs the Writ extension in this kind of browser. */
export function installUrlFor(browser: BrowserKind): string {
  return browser === "edge" ? EDGE_ADDONS_URL : CHROME_WEB_STORE_URL;
}
