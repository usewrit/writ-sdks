/** The drop-in banner (CONTRACT.md §9): each state, each transition, and what never renders. */

import { describe, expect, it } from "vitest";
import {
  CHROME_WEB_STORE_URL,
  EDGE_ADDONS_URL,
  WRIT_DESKTOP_URL,
  isWritError,
  mountWritBanner,
  type FunctionRequest,
  type WritBanner,
  type WritBannerOptions,
  type WritSession,
} from "../src/index.js";
import { BannerWindow } from "./fake-dom.js";
import { CHROME_UA, EDGE_UA, FIREFOX_UA, FakeProvider, deferred, flush, grantFor, installDirect } from "./fake-provider.js";
import { posContract, posReceivePackage, posSettingsPackage } from "./fixtures.js";

const RECEIVE: FunctionRequest = {
  key: "pos.receive",
  description: "Receive an invoice in your POS",
  writes: true,
  package: posReceivePackage(),
};

interface Mounted {
  banner: WritBanner;
  ready: WritSession[];
}

function mount(win: BannerWindow, overrides: Partial<WritBannerOptions> = {}): Mounted {
  const ready: WritSession[] = [];
  const banner = mountWritBanner({
    app: "Arrivos",
    functions: [RECEIVE],
    onReady: (session) => ready.push(session),
    timeoutMs: 0,
    window: win as never,
    ...overrides,
  });
  return { banner, ready };
}

/** Let discovery timers and provider promises run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await flush();
}

/** A window with the extension and a provider whose Writ is installed and running. */
function withExtension(navigator = { userAgent: CHROME_UA, language: "en-US" }): { win: BannerWindow; provider: FakeProvider } {
  const win = new BannerWindow(navigator);
  const provider = new FakeProvider();
  installDirect(win, provider);
  return { win, provider };
}

function text(win: BannerWindow, className: string): string {
  return win.part(className)?.textContent ?? "";
}

function label(win: BannerWindow, action: string): string | null {
  return win.control(action)?.textContent ?? null;
}

describe("mountWritBanner(): already connected", () => {
  it("never renders, and calls onReady with the existing session", async () => {
    const { win, provider } = withExtension();
    provider.handlers.set("writ_functions", () => ({ origin: "https://arrivos.example", functions: [grantFor(RECEIVE)] }));
    const { banner, ready } = mount(win);
    await settle();

    expect(ready).toHaveLength(1);
    expect(ready[0]?.function("pos.receive")).toBeDefined();
    await expect(banner.session).resolves.toBe(ready[0]);
    expect(win.document.created).toBe(0);
    expect(win.document.body.children).toEqual([]);
    expect(provider.requests.map((r) => r.method)).toEqual(["writ_functions"]);
  });

  it("never renders when the installed package is the requested version", async () => {
    const { win, provider } = withExtension();
    provider.handlers.set("writ_functions", () => ({
      origin: "https://arrivos.example",
      functions: [{ ...grantFor(RECEIVE), package: { id: "arrivos.pos-receive", version: "1.2.0" } }],
    }));
    const { ready } = mount(win);
    await settle();
    expect(ready).toHaveLength(1);
    expect(win.document.created).toBe(0);
  });

  it("offers an update when the installed package is an older version", async () => {
    const { win, provider } = withExtension();
    provider.handlers.set("writ_functions", () => ({
      origin: "https://arrivos.example",
      functions: [{ ...grantFor(RECEIVE), package: { id: "arrivos.pos-receive", version: "1.1.0" } }],
    }));
    const { ready } = mount(win);
    await settle();
    expect(ready).toEqual([]);
    expect(win.state()).toBe("connect");
    expect(label(win, "primary")).toBe("Update Arrivos POS receive (one click)");
  });

  it("asks again when a requested key is not granted", async () => {
    const { win, provider } = withExtension();
    provider.handlers.set("writ_functions", () => ({
      origin: "https://arrivos.example",
      functions: [grantFor({ key: "pos.lookup", description: "Look up" })],
    }));
    mount(win);
    await settle();
    expect(win.state()).toBe("connect");
    expect(label(win, "primary")).toBe("Install Arrivos POS receive (one click)");
  });
});

describe("mountWritBanner(): 1. the extension", () => {
  it("shows the store button for this browser and re-checks on 'I installed it'", async () => {
    const win = new BannerWindow();
    const { ready } = mount(win);
    await settle();

    expect(win.state()).toBe("extension");
    const store = win.control("primary");
    expect(store?.localName).toBe("a");
    expect(store?.getAttribute("href")).toBe(CHROME_WEB_STORE_URL);
    expect(store?.getAttribute("target")).toBe("_blank");
    expect(store?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(store?.textContent).toBe("Writ for Chrome");
    expect(label(win, "secondary")).toBe("I installed it");

    const provider = new FakeProvider();
    installDirect(win, provider);
    win.control("secondary")?.click();
    await settle();
    expect(win.state()).toBe("connect");
    expect(ready).toEqual([]);
  });

  it("says to reload when the extension is still missing, then reloads", async () => {
    const win = new BannerWindow();
    mount(win);
    await settle();
    win.control("secondary")?.click();
    await settle();

    expect(win.state()).toBe("extension");
    expect(text(win, "status")).toBe("Writ for Chrome was not found yet. If you just added it, reload this page.");
    expect(label(win, "secondary")).toBe("Reload page");
    win.control("secondary")?.click();
    expect(win.reloads).toBe(1);
  });

  it("links Edge visitors to Edge Add-ons", async () => {
    const win = new BannerWindow({ userAgent: EDGE_UA, language: "en-US" });
    mount(win);
    await settle();
    expect(win.control("primary")?.getAttribute("href")).toBe(EDGE_ADDONS_URL);
    expect(label(win, "primary")).toBe("Writ for Edge");
  });

  it("explains that Writ needs Chrome or Edge, with nothing to click but dismiss", async () => {
    const win = new BannerWindow({ userAgent: FIREFOX_UA, language: "en-US" });
    mount(win);
    await settle();
    expect(win.state()).toBe("unsupported");
    expect(text(win, "title")).toBe("Writ needs Chrome or Edge on a computer");
    expect(win.control("primary")).toBeNull();
    expect(win.control("secondary")).toBeNull();
    expect(win.control("dismiss")).not.toBeNull();
  });

  it("asks to update an extension that speaks another protocol", async () => {
    const win = new BannerWindow();
    const provider = new FakeProvider();
    Object.defineProperty(provider, "protocol", { value: 2 });
    installDirect(win, provider);
    mount(win);
    await settle();
    expect(win.state()).toBe("extension");
    expect(label(win, "primary")).toBe("Update Writ for Chrome");
    expect(label(win, "secondary")).toBe("I updated it");
  });
});

describe("mountWritBanner(): 2. Writ desktop", () => {
  it("links to Writ desktop when the host is missing and re-checks on 'I installed it'", async () => {
    const { win, provider } = withExtension();
    let host = "missing";
    provider.handlers.set("writ_status", () => ({
      extension_version: "1.0.0",
      protocol: 1,
      host,
      daemon: "running",
      desktop_version: null,
      lan_capable: false,
    }));
    mount(win);
    await settle();

    expect(win.state()).toBe("desktop");
    expect(win.control("primary")?.getAttribute("href")).toBe(WRIT_DESKTOP_URL);
    expect(label(win, "primary")).toBe("Get Writ desktop");

    win.control("secondary")?.click();
    await settle();
    expect(win.state()).toBe("desktop");
    expect(text(win, "status")).toContain("Writ desktop was not found yet");

    host = "ok";
    win.control("secondary")?.click();
    await settle();
    expect(win.state()).toBe("connect");
    expect(text(win, "status")).toBe("");
  });

  it("asks for an update on DESKTOP_OUTDATED", async () => {
    const { win, provider } = withExtension();
    provider.handlers.set("writ_status", () => {
      throw { code: "PROTOCOL_MISMATCH", message: "Update Writ." };
    });
    mount(win);
    await settle();
    expect(win.state()).toBe("desktop");
    expect(text(win, "title")).toBe("Update Writ desktop");
    expect(label(win, "secondary")).toBe("I updated it");
  });

  it("treats a DESKTOP_MISSING rejection like a missing host", async () => {
    const { win, provider } = withExtension();
    provider.handlers.set("writ_status", () => {
      throw { code: "DESKTOP_MISSING", message: "Install Writ desktop." };
    });
    mount(win);
    await settle();
    expect(win.state()).toBe("desktop");
    expect(text(win, "title")).toBe("Get Writ desktop");
  });
});

describe("mountWritBanner(): 3. the engine", () => {
  it("asks to open Writ and retries", async () => {
    const { win, provider } = withExtension();
    let daemon = "unavailable";
    provider.handlers.set("writ_status", () => ({
      extension_version: "1.0.0",
      protocol: 1,
      host: "ok",
      daemon,
      desktop_version: "1.0.7",
      lan_capable: true,
    }));
    mount(win);
    await settle();

    expect(win.state()).toBe("engine");
    expect(text(win, "title")).toBe("Open Writ on this computer, then retry");
    expect(label(win, "primary")).toBe("Retry");

    win.control("primary")?.click();
    await settle();
    expect(text(win, "status")).toBe("Writ is still not running.");

    daemon = "started";
    win.control("primary")?.click();
    await settle();
    expect(win.state()).toBe("connect");
  });
});

describe("mountWritBanner(): 4. install / connect", () => {
  it("installs with one click, hides, and calls onReady", async () => {
    const { win, provider } = withExtension();
    const { banner, ready } = mount(win);
    await settle();

    expect(win.state()).toBe("connect");
    expect(text(win, "title")).toBe("Install Arrivos POS receive on this computer");
    expect(label(win, "primary")).toBe("Install Arrivos POS receive (one click)");

    win.control("primary")?.click();
    await settle();

    expect(provider.sent("writ_connect")).toEqual([
      {
        app: "Arrivos",
        functions: [
          {
            key: "pos.receive",
            description: "Receive an invoice in your POS",
            writes: true,
            package: posReceivePackage(),
          },
        ],
      },
    ]);
    expect(ready).toHaveLength(1);
    await expect(banner.session).resolves.toBe(ready[0]);
    expect(win.host()).toBeNull();
  });

  it("disables its buttons and says so while the consent window is open", async () => {
    const { win, provider } = withExtension();
    const consent = deferred<unknown>();
    provider.handlers.set("writ_connect", () => consent.promise);
    mount(win);
    await settle();

    win.control("primary")?.click();
    await settle();
    expect(win.control("primary")?.hasAttribute("disabled")).toBe(true);
    expect(win.bar()?.getAttribute("aria-busy")).toBe("true");
    expect(text(win, "status")).toBe("Answer in the Writ window…");

    // A second click while waiting sends nothing.
    win.control("primary")?.click();
    consent.resolve({ origin: "https://arrivos.example", functions: [grantFor(RECEIVE)] });
    await settle();
    expect(provider.sent("writ_connect")).toHaveLength(1);
    expect(win.host()).toBeNull();
  });

  it("says Connect when nothing is installed", async () => {
    const { win } = withExtension();
    mount(win, { functions: [{ key: "pos.receive", description: "Receive an invoice in your POS" }] });
    await settle();
    expect(text(win, "title")).toBe("Connect Arrivos to Writ");
    expect(label(win, "primary")).toBe("Connect");
  });

  it("shows a quiet 'Not now' on CONSENT_DENIED, and retries", async () => {
    const { win, provider } = withExtension();
    provider.handlers.set("writ_connect", () => {
      throw { code: "CONSENT_DENIED", message: "The user declined." };
    });
    const { ready } = mount(win);
    await settle();
    win.control("primary")?.click();
    await settle();

    expect(win.state()).toBe("declined");
    expect(win.bar()?.hasAttribute("data-quiet")).toBe(true);
    expect(text(win, "title")).toBe("Not now");
    expect(win.control("primary")).toBeNull();
    expect(label(win, "secondary")).toBe("Try again");

    provider.handlers.set("writ_connect", (params) => ({
      origin: "https://arrivos.example",
      functions: (params as { functions: FunctionRequest[] }).functions.map((fn) => grantFor(fn)),
    }));
    win.control("secondary")?.click();
    await settle();
    expect(provider.sent("writ_connect")).toHaveLength(2);
    expect(ready).toHaveLength(1);
    expect(win.host()).toBeNull();
  });

  it("goes back to the engine step when connect() finds Writ stopped", async () => {
    const { win, provider } = withExtension();
    provider.handlers.set("writ_connect", () => {
      throw { code: "DAEMON_UNAVAILABLE", message: "Writ is not running." };
    });
    mount(win);
    await settle();
    win.control("primary")?.click();
    await settle();
    expect(win.state()).toBe("engine");
  });

  it("asks to unlock Writ on VAULT_LOCKED", async () => {
    const { win, provider } = withExtension();
    provider.handlers.set("writ_connect", () => {
      throw { code: "VAULT_LOCKED", message: "Unlock Writ." };
    });
    mount(win);
    await settle();
    win.control("primary")?.click();
    await settle();
    expect(win.state()).toBe("vault");
    expect(text(win, "title")).toBe("Unlock Writ, then retry");
  });

  it("shows a retryable error for anything else", async () => {
    const { win, provider } = withExtension();
    provider.handlers.set("writ_connect", () => {
      throw { code: "RATE_LIMITED", message: "Slow down." };
    });
    mount(win);
    await settle();
    win.control("primary")?.click();
    await settle();
    expect(win.state()).toBe("error");
    expect(text(win, "body")).toBe("Too many attempts. Wait a moment, then try again.");
    expect(label(win, "primary")).toBe("Retry");
  });

  it("installs the packages of a contract", async () => {
    const { win, provider } = withExtension();
    const { ready } = mount(win, { functions: undefined, contract: posContract() });
    await settle();
    expect(label(win, "primary")).toBe("Install Arrivos POS (one click)");

    win.control("primary")?.click();
    await settle();
    const [sent] = provider.sent("writ_connect") as { functions: FunctionRequest[] }[];
    expect(sent?.functions.map((fn) => [fn.key, fn.package?.id, fn.function])).toEqual([
      ["pos.receive", "arrivos.pos", "receive"],
      ["pos.lookup", "arrivos.pos", "lookup"],
      ["health", "arrivos.health", undefined],
    ]);
    expect(ready).toHaveLength(1);
  });

  it("passes suggested settings through to writ_connect", async () => {
    const { win, provider } = withExtension();
    const functions: FunctionRequest[] = [
      {
        key: "pos.receive",
        description: "Receive an invoice in your POS",
        package: posSettingsPackage(),
        function: "receive",
        settings: { pos_host: "192.168.1.20:8080" },
      },
    ];
    mount(win, { functions });
    await settle();

    win.control("primary")?.click();
    await settle();
    const [sent] = provider.sent("writ_connect") as { functions: FunctionRequest[] }[];
    expect(sent?.functions[0]?.settings).toEqual({ pos_host: "192.168.1.20:8080" });
  });

  it("refuses invalid suggestions with INPUT_INVALID before rendering", () => {
    const { win } = withExtension();
    const functions: FunctionRequest[] = [
      { key: "pos.receive", description: "Receive", package: posSettingsPackage(), function: "receive", settings: { pos_ip: "x" } },
    ];
    let error: unknown;
    try {
      mount(win, { functions });
    } catch (caught) {
      error = caught;
    }
    expect(isWritError(error, "INPUT_INVALID")).toBe(true);
    expect(win.document.created).toBe(0);
  });
});

describe("mountWritBanner(): dismiss, focus, destroy", () => {
  it("dismisses for the page session and rejects the session with CONSENT_DENIED", async () => {
    const { win, provider } = withExtension();
    const { banner, ready } = mount(win);
    await settle();
    win.control("dismiss")?.click();

    expect(win.host()).toBeNull();
    expect(win.sessionStorage.values.get("writ:banner:dismissed:Arrivos")).toBe("1");
    const error: unknown = await banner.session.catch((e: unknown) => e);
    expect(isWritError(error, "CONSENT_DENIED")).toBe(true);

    // Mounted again in the same page session: stays hidden, asks nothing.
    const created = win.document.created;
    const before = provider.requests.length;
    const again = mount(win);
    await settle();
    expect(win.document.created).toBe(created);
    expect(provider.requests.slice(before).map((r) => r.method)).toEqual(["writ_functions"]);
    await expect(again.banner.session).rejects.toMatchObject({ code: "CONSENT_DENIED" });
    expect(ready).toEqual([]);
  });

  it("still hands over an existing session after a dismissal", async () => {
    const { win, provider } = withExtension();
    win.sessionStorage.values.set("writ:banner:dismissed:Arrivos", "1");
    provider.handlers.set("writ_functions", () => ({ origin: "https://arrivos.example", functions: [grantFor(RECEIVE)] }));
    const { ready } = mount(win);
    await settle();
    expect(ready).toHaveLength(1);
    expect(win.document.created).toBe(0);
  });

  it("dismisses even when storage is blocked", async () => {
    const { win } = withExtension();
    win.sessionStorage.blocked = true;
    const { banner } = mount(win);
    await settle();
    expect(win.state()).toBe("connect");
    win.control("dismiss")?.click();
    expect(win.host()).toBeNull();
    await expect(banner.session).rejects.toMatchObject({ code: "CONSENT_DENIED" });
  });

  it("re-checks when the window gets focus back, without opening consent", async () => {
    const { win, provider } = withExtension();
    let host = "missing";
    provider.handlers.set("writ_status", () => ({
      extension_version: "1.0.0",
      protocol: 1,
      host,
      daemon: "running",
      desktop_version: "1.0.7",
      lan_capable: true,
    }));
    mount(win);
    await settle();
    expect(win.state()).toBe("desktop");

    host = "ok";
    win.focusWindow();
    await settle();
    expect(win.state()).toBe("connect");

    win.focusWindow();
    await settle();
    expect(provider.sent("writ_connect")).toEqual([]);
  });

  it("hands over the session when the visitor connected in another tab", async () => {
    const { win, provider } = withExtension();
    const { ready } = mount(win);
    await settle();
    expect(win.state()).toBe("connect");

    provider.handlers.set("writ_functions", () => ({ origin: "https://arrivos.example", functions: [grantFor(RECEIVE)] }));
    win.focusWindow();
    await settle();
    expect(ready).toHaveLength(1);
    expect(win.host()).toBeNull();
  });

  it("polls nothing in the background", async () => {
    const { win, provider } = withExtension();
    mount(win);
    await settle();
    const count = provider.requests.length;
    for (let i = 0; i < 5; i += 1) await settle();
    expect(provider.requests.length).toBe(count);
  });

  it("destroy() removes the banner, rejects with CANCELLED and stops listening", async () => {
    const { win, provider } = withExtension();
    const { banner } = mount(win);
    await settle();
    banner.destroy();
    expect(win.host()).toBeNull();
    await expect(banner.session).rejects.toMatchObject({ code: "CANCELLED" });

    const count = provider.requests.length;
    win.focusWindow();
    await settle();
    expect(provider.requests.length).toBe(count);
  });
});

describe("mountWritBanner(): rendering", () => {
  it("is an accessible region in a closed shadow root, fixed at the top", async () => {
    const { win } = withExtension();
    mount(win);
    await settle();

    const host = win.host();
    expect(host?.shadowForTest?.mode).toBe("closed");
    expect(win.document.body.children[0]).toBe(host);
    expect(host?.style.getPropertyValue("position")).toBe("fixed");
    expect(host?.style.getPropertyValue("top")).toBe("0");
    expect(host?.style.getPropertyPriority("position")).toBe("important");

    const bar = win.bar();
    expect(bar?.getAttribute("role")).toBe("region");
    expect(bar?.getAttribute("aria-label")).toBe("Set up Writ for Arrivos");
    const status = win.part("status");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(win.control("dismiss")?.getAttribute("aria-label")).toBe("Dismiss");
    expect(win.control("primary")?.getAttribute("type")).toBe("button");
    const icons = bar?.descendants().filter((element) => element.localName === "svg") ?? [];
    expect(icons.length).toBeGreaterThan(0);
    expect(icons.every((svg) => svg.getAttribute("aria-hidden") === "true")).toBe(true);
    const style = host?.shadowForTest?.children.find((element) => element.localName === "style");
    expect(style?.textContent).toContain("prefers-color-scheme: dark");
    expect(style?.textContent).toContain("prefers-reduced-motion");
  });

  it("keeps keyboard focus inside the banner across a state change", async () => {
    const { win, provider } = withExtension();
    provider.handlers.set("writ_connect", () => {
      throw { code: "CONSENT_DENIED", message: "No." };
    });
    mount(win);
    await settle();
    win.control("primary")?.focus();
    win.control("primary")?.click();
    await settle();
    expect(win.state()).toBe("declined");
    expect(win.host()?.shadowForTest?.activeElement).toBe(win.control("secondary"));
  });

  it("sits at the bottom when asked", async () => {
    const { win } = withExtension();
    mount(win, { position: "bottom" });
    await settle();
    expect(win.host()?.style.getPropertyValue("bottom")).toBe("0");
    expect(win.bar()?.getAttribute("data-position")).toBe("bottom");
  });

  it("renders inside a container instead of fixed", async () => {
    const { win } = withExtension();
    const container = win.document.createElement("div");
    win.document.body.append(container);
    mount(win, { container: container as never });
    await settle();
    expect(container.children[0]?.localName).toBe("writ-banner");
    expect(win.host()?.style.getPropertyValue("position")).toBe("relative");
  });

  it("speaks the visitor's language", async () => {
    const { win } = withExtension({ userAgent: CHROME_UA, language: "fr-CA" });
    mount(win);
    await settle();
    expect(label(win, "primary")).toBe("Installer Arrivos POS receive (en un clic)");
    expect(win.control("dismiss")?.getAttribute("aria-label")).toBe("Fermer");
  });

  it("uses the first supported preferred language", async () => {
    const { win } = withExtension({ userAgent: CHROME_UA, language: "de-DE", languages: ["de-DE", "es-MX", "fr"] } as never);
    mount(win);
    await settle();
    expect(label(win, "primary")).toBe("Instalar Arrivos POS receive (un clic)");
  });

  it("uses `locale` over the browser language", async () => {
    const { win } = withExtension({ userAgent: CHROME_UA, language: "fr-FR" });
    mount(win, { locale: "es" });
    await settle();
    expect(text(win, "title")).toBe("Instala Arrivos POS receive en este equipo");
  });
});

describe("mountWritBanner(): options", () => {
  const cases: [string, Partial<WritBannerOptions> & Record<string, unknown>, string][] = [
    ["both functions and contract", { contract: posContract() }, "BAD_REQUEST"],
    ["neither functions nor contract", { functions: undefined }, "BAD_REQUEST"],
    ["no onReady", { onReady: undefined as never }, "BAD_REQUEST"],
    ["a bad position", { position: "left" as never }, "BAD_REQUEST"],
    ["a bad locale", { locale: "de" as never }, "BAD_REQUEST"],
    ["a container that is not an element", { container: {} as never }, "BAD_REQUEST"],
    ["a negative timeout", { timeoutMs: -1 }, "BAD_REQUEST"],
    ["no app", { app: "" }, "BAD_REQUEST"],
    ["an invalid package", { functions: [{ ...RECEIVE, package: { ...posReceivePackage(), id: "Bad Id" } }] }, "INPUT_INVALID"],
    ["an invalid contract", { functions: undefined, contract: { ...posContract(), format: "nope" } as never }, "INPUT_INVALID"],
  ];

  it.each(cases)("throws for %s, before rendering", (_label, overrides, code) => {
    const win = new BannerWindow();
    let thrown: unknown;
    try {
      mount(win, overrides);
    } catch (error) {
      thrown = error;
    }
    expect(isWritError(thrown, code as never)).toBe(true);
    expect(win.document.created).toBe(0);
  });

  it("rejects with NOT_INSTALLED where there is no window (server rendering)", async () => {
    const banner = mountWritBanner({ app: "Arrivos", functions: [RECEIVE], onReady: () => undefined });
    await expect(banner.session).rejects.toMatchObject({ code: "NOT_INSTALLED" });
    expect(() => banner.destroy()).not.toThrow();
  });
});
