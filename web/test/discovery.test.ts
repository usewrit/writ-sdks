/** Discovery (CONTRACT.md §1): window.writ, announce/request events, timeouts, store links. */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHROME_WEB_STORE_URL,
  EDGE_ADDONS_URL,
  REQUEST_PROVIDER_EVENT,
  connectWrit,
  detectBrowser,
  installUrlFor,
  isWritError,
} from "../src/index.js";
import {
  CHROME_UA,
  EDGE_UA,
  FIREFOX_UA,
  FakeProvider,
  FakeWindow,
  announce,
  announceOnRequest,
  installDirect,
} from "./fake-provider.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("connectWrit discovery", () => {
  it("uses window.writ when the provider was injected first", async () => {
    const win = new FakeWindow();
    const provider = new FakeProvider();
    installDirect(win, provider);
    let requested = 0;
    win.addEventListener(REQUEST_PROVIDER_EVENT, () => {
      requested += 1;
    });

    const writ = await connectWrit({ window: win });

    expect(writ.available).toBe(true);
    if (!writ.available) return;
    expect(writ.provider).toBe(provider);
    expect(writ.providerInfo).toEqual({ name: "Writ", version: "1.0.0", protocol: 1 });
    expect(writ.installUrl).toBe(CHROME_WEB_STORE_URL);
    expect(writ.browser).toBe("chrome");
    // Found directly: no request event, no waiting.
    expect(requested).toBe(0);
  });

  it("asks an injected provider to announce itself when window.writ is not readable", async () => {
    const win = new FakeWindow();
    const provider = new FakeProvider();
    const requestCount = announceOnRequest(win, provider);

    const writ = await connectWrit({ window: win, timeoutMs: 1_000 });

    expect(requestCount()).toBe(1);
    expect(writ.available).toBe(true);
    if (writ.available) expect(writ.provider).toBe(provider);
  });

  it("hears a provider that is injected after the library loaded", async () => {
    const win = new FakeWindow();
    const provider = new FakeProvider();

    const pending = connectWrit({ window: win, timeoutMs: 1_000 });
    setTimeout(() => {
      installDirect(win, provider);
      announce(win, provider);
    }, 10);
    const writ = await pending;

    expect(writ.available).toBe(true);
    if (writ.available) expect(writ.provider).toBe(provider);
  });

  it("prefers the non-configurable window.writ over an announced object", async () => {
    const win = new FakeWindow();
    const real = new FakeProvider();
    const impostor = new FakeProvider();

    const pending = connectWrit({ window: win, timeoutMs: 1_000 });
    installDirect(win, real);
    announce(win, impostor);
    const writ = await pending;

    expect(writ.available).toBe(true);
    if (writ.available) expect(writ.provider).toBe(real);
  });

  it("answers NOT_INSTALLED with the store link after the timeout", async () => {
    vi.useFakeTimers();
    const win = new FakeWindow({ userAgent: EDGE_UA });

    let settled = false;
    const pending = connectWrit({ window: win }).then((answer) => {
      settled = true;
      return answer;
    });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const writ = await pending;

    expect(settled).toBe(true);
    expect(writ.available).toBe(false);
    if (writ.available) return;
    expect(writ.reason).toBe("NOT_INSTALLED");
    expect(writ.browser).toBe("edge");
    expect(writ.installUrl).toBe(EDGE_ADDONS_URL);
    expect(isWritError(writ.error, "NOT_INSTALLED")).toBe(true);
  });

  it("ignores an unrelated window.writ and invalid announcements", async () => {
    const win = new FakeWindow();
    installDirect(win, { name: "some other writ" });

    const pending = connectWrit({ window: win, timeoutMs: 30 });
    announce(win, { isWrit: false, protocol: 1 } as never);
    win.dispatchEvent(new Event("writ:announceProvider"));
    const writ = await pending;

    expect(writ.available).toBe(false);
    if (!writ.available) expect(writ.reason).toBe("NOT_INSTALLED");
  });

  it("answers DESKTOP_OUTDATED for a provider with another protocol", async () => {
    const win = new FakeWindow();
    const base = new FakeProvider();
    const future = {
      isWrit: true,
      version: "2.0.0",
      protocol: 2,
      request: base.request.bind(base),
      on: base.on.bind(base),
      off: base.off.bind(base),
    };
    installDirect(win, future);

    const writ = await connectWrit({ window: win });

    expect(writ.available).toBe(false);
    if (writ.available) return;
    expect(writ.reason).toBe("DESKTOP_OUTDATED");
    expect(writ.error.code).toBe("DESKTOP_OUTDATED");
    expect(writ.error.details).toMatchObject({ extensionVersion: "2.0.0", extensionProtocol: 2 });
    expect(writ.installUrl).toBe(CHROME_WEB_STORE_URL);
  });

  it("is safe without a window (server rendering)", async () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
    const writ = await connectWrit({ timeoutMs: 0 });
    expect(writ.available).toBe(false);
    if (!writ.available) {
      expect(writ.reason).toBe("NOT_INSTALLED");
      expect(writ.installUrl).toBe(CHROME_WEB_STORE_URL);
    }
  });

  it("never defines or replaces window.writ", async () => {
    const win = new FakeWindow();
    await connectWrit({ window: win, timeoutMs: 0 });
    expect(Object.prototype.hasOwnProperty.call(win, "writ")).toBe(false);
  });

  it("rejects an invalid timeout with BAD_REQUEST", async () => {
    const win = new FakeWindow();
    await expect(connectWrit({ window: win, timeoutMs: -1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(connectWrit({ window: win, timeoutMs: Number.NaN })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("detectBrowser / installUrlFor", () => {
  it("reads userAgentData brands first", () => {
    const brands = (names: string[]) => names.map((brand) => ({ brand, version: "141" }));
    expect(detectBrowser({ userAgentData: { brands: brands(["Not=A?Brand", "Microsoft Edge", "Chromium"]), mobile: false } })).toBe("edge");
    expect(detectBrowser({ userAgentData: { brands: brands(["Google Chrome", "Chromium"]), mobile: false } })).toBe("chrome");
    expect(detectBrowser({ userAgentData: { brands: brands(["Brave", "Chromium"]), mobile: false } })).toBe("chromium");
    expect(detectBrowser({ userAgentData: { brands: brands(["Google Chrome"]), mobile: true } })).toBe("other");
  });

  it("falls back to the user agent string", () => {
    expect(detectBrowser({ userAgent: CHROME_UA })).toBe("chrome");
    expect(detectBrowser({ userAgent: EDGE_UA })).toBe("edge");
    expect(detectBrowser({ userAgent: `${CHROME_UA} OPR/120.0.0.0` })).toBe("chromium");
    expect(detectBrowser({ userAgent: FIREFOX_UA })).toBe("other");
    expect(
      detectBrowser({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      }),
    ).toBe("other");
    expect(
      detectBrowser({
        userAgent:
          "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
      }),
    ).toBe("other");
    expect(detectBrowser(undefined)).toBe("other");
  });

  it("links Edge to Edge Add-ons and everything else to the Chrome Web Store", () => {
    expect(installUrlFor("edge")).toBe(EDGE_ADDONS_URL);
    expect(installUrlFor("chrome")).toBe(CHROME_WEB_STORE_URL);
    expect(installUrlFor("chromium")).toBe(CHROME_WEB_STORE_URL);
    expect(installUrlFor("other")).toBe(CHROME_WEB_STORE_URL);
  });
});
