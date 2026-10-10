/**
 * The banner's DOM: one host element with a CLOSED shadow root, so the page's CSS cannot reach
 * the banner and the banner's CSS cannot reach the page. Framework-free; only standard DOM APIs.
 *
 * The view knows nothing about Writ. It renders a {@link BannerModel} and reports clicks as
 * {@link BannerAction}s.
 */

/** What a click on the banner asks for. */
export type BannerAction = "primary" | "secondary" | "dismiss";

/** The banner's icons, drawn inline (no image requests, no icon font). */
export type BannerIcon = "extension" | "desktop" | "power" | "lock" | "install" | "connect" | "pause" | "alert" | "info";

/** One action button. With `href`, it is a link opening in a new tab. */
export interface BannerButton {
  readonly label: string;
  readonly href?: string;
}

/** Everything the banner shows at one moment. */
export interface BannerModel {
  /** Written to `data-state`, for styling and tests. */
  readonly state: string;
  readonly icon: BannerIcon;
  readonly title: string;
  readonly body: string;
  /** A quieter line under the body (why the banner is there); empty hides it. */
  readonly note?: string;
  readonly primary?: BannerButton;
  readonly secondary?: BannerButton;
  /** The live status line (announced by screen readers); empty hides it. */
  readonly status: string;
  /** A check or consent is in flight: buttons are disabled. */
  readonly busy: boolean;
  /** A quieter look (the visitor said "not now"). */
  readonly quiet: boolean;
}

/** How the view is mounted. */
export interface BannerViewOptions {
  /** Render inside this element instead of fixed to the viewport. */
  readonly container: HTMLElement | null;
  readonly position: "top" | "bottom";
  /** The region's accessible name. */
  readonly label: string;
  readonly dismissLabel: string;
  /** False: no dismiss control (the site requires Writ, CONTRACT.md §12). */
  readonly dismissible: boolean;
  /** `CSSStyleSheet` of the page's window, for adopted styles (CSP-friendly). */
  readonly styleSheetConstructor: unknown;
  readonly onAction: (action: BannerAction) => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** 24x24 stroke paths. */
const ICON_PATHS: Readonly<Record<BannerIcon | "close", readonly string[]>> = Object.freeze({
  extension: ["M4 8h4V6.5a2 2 0 1 1 4 0V8h4v4h1.5a2 2 0 1 1 0 4H16v4H4z"],
  desktop: ["M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M9 20h6", "M12 16v4"],
  power: ["M12 3v8", "M7.05 6.05a7 7 0 1 0 9.9 0"],
  lock: ["M8 11V8a4 4 0 0 1 8 0v3", "M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"],
  install: ["M12 4v11", "M7.5 10.5 12 15l4.5-4.5", "M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"],
  connect: ["M9 3v5", "M15 3v5", "M7 8h10v3a5 5 0 0 1-10 0z", "M12 16v5"],
  pause: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M10 9v6", "M14 9v6"],
  alert: ["M12 4 2.8 19.5a.8.8 0 0 0 .7 1.2h17a.8.8 0 0 0 .7-1.2z", "M12 10v4", "M12 17h.01"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v5", "M12 8h.01"],
  close: ["M6 6l12 12", "M18 6 6 18"],
});

const CSS = `
:host { all: initial; }
.bar {
  --writ-bg: #ffffff;
  --writ-fg: #15171a;
  --writ-muted: #5a6170;
  --writ-border: #e2e4e9;
  --writ-border-strong: #c9cdd5;
  --writ-quiet: #f3f4f6;
  --writ-accent: #2557d6;
  --writ-accent-hover: #1d48b5;
  --writ-accent-fg: #ffffff;
  --writ-focus: #2557d6;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 12px 10px 16px;
  background: var(--writ-bg);
  color: var(--writ-fg);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  text-align: start;
  border-bottom: 1px solid var(--writ-border);
  box-shadow: 0 1px 2px rgba(15, 17, 20, 0.04), 0 4px 12px rgba(15, 17, 20, 0.06);
  -webkit-font-smoothing: antialiased;
}
.bar[data-position="bottom"] {
  border-bottom: 0;
  border-top: 1px solid var(--writ-border);
  box-shadow: 0 -1px 2px rgba(15, 17, 20, 0.04), 0 -4px 12px rgba(15, 17, 20, 0.06);
}
.bar[data-inline] { border: 1px solid var(--writ-border); border-radius: 8px; box-shadow: none; }
.bar:focus { outline: none; }
.bar:focus-visible { outline: 2px solid var(--writ-focus); outline-offset: -2px; }
.icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--writ-quiet);
  color: var(--writ-accent);
}
.bar[data-quiet] .icon { color: var(--writ-muted); }
svg { display: block; width: 18px; height: 18px; }
.text { flex: 1 1 0; min-width: 0; }
.title { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.body { margin: 2px 0 0; color: var(--writ-muted); overflow-wrap: anywhere; }
.note { margin: 4px 0 0; font-size: 13px; color: var(--writ-muted); overflow-wrap: anywhere; }
.note:empty { display: none; }
.status { margin: 4px 0 0; font-size: 13px; color: var(--writ-fg); }
.status:empty { display: none; }
.actions { flex: none; display: flex; flex-wrap: wrap; gap: 8px; }
.actions:empty { display: none; }
.btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 6px 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  font: inherit;
  font-weight: 600;
  line-height: 1.2;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
.btn-primary { background: var(--writ-accent); color: var(--writ-accent-fg); }
.btn-primary:hover { background: var(--writ-accent-hover); }
.btn-secondary { background: transparent; color: var(--writ-fg); border-color: var(--writ-border-strong); }
.btn-secondary:hover { background: var(--writ-quiet); }
.btn[disabled], .btn[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.dismiss {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--writ-muted);
  cursor: pointer;
}
.dismiss:hover { background: var(--writ-quiet); color: var(--writ-fg); }
.btn:focus-visible, .dismiss:focus-visible { outline: 2px solid var(--writ-focus); outline-offset: 2px; }
@media (max-width: 640px) {
  .bar { flex-wrap: wrap; align-items: flex-start; padding: 12px 8px 12px 16px; }
  .dismiss { order: 2; }
  .actions { order: 3; width: 100%; padding-left: 44px; }
}
@media (prefers-color-scheme: dark) {
  .bar {
    --writ-bg: #16181c;
    --writ-fg: #eceef2;
    --writ-muted: #a3a9b6;
    --writ-border: #2b2f36;
    --writ-border-strong: #3d424b;
    --writ-quiet: #1f2228;
    --writ-accent: #6d93ff;
    --writ-accent-hover: #8aa8ff;
    --writ-accent-fg: #0b0d10;
    --writ-focus: #8aa8ff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 12px rgba(0, 0, 0, 0.35);
  }
}
@media (prefers-reduced-motion: no-preference) {
  .bar { animation: writ-enter 200ms cubic-bezier(0.2, 0.8, 0.2, 1); }
  .bar[data-position="bottom"] { animation-name: writ-enter-up; }
}
@media (prefers-reduced-motion: reduce) {
  .btn { transition: none; }
}
@media (forced-colors: active) {
  .btn, .dismiss { border: 1px solid ButtonText; }
}
@keyframes writ-enter { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
@keyframes writ-enter-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
`;

/** The rendered banner. Created on the first {@link render}; {@link destroy} removes it. */
export class BannerView {
  readonly #doc: Document;
  readonly #options: BannerViewOptions;
  #host: HTMLElement | null = null;
  #shadow: ShadowRoot | null = null;
  #bar: HTMLElement | null = null;
  #icon: HTMLElement | null = null;
  #title: HTMLElement | null = null;
  #body: HTMLElement | null = null;
  #note: HTMLElement | null = null;
  #status: HTMLElement | null = null;
  #actions: HTMLElement | null = null;
  #dismiss: HTMLElement | null = null;
  /** The action buttons of the current render, by `data-action`. */
  #controls = new Map<string, HTMLElement>();
  #destroyed = false;

  constructor(doc: Document, options: BannerViewOptions) {
    this.#doc = doc;
    this.#options = options;
  }

  /** Show `model`. The first call mounts the banner; later calls update it in place. */
  render(model: BannerModel): void {
    if (this.#destroyed) return;
    if (this.#bar === null && !this.#mount()) return;
    const bar = this.#bar as HTMLElement;
    const focused = this.#focusedAction();

    bar.setAttribute("data-state", model.state);
    if (model.busy) bar.setAttribute("aria-busy", "true");
    else bar.removeAttribute("aria-busy");
    if (model.quiet) bar.setAttribute("data-quiet", "");
    else bar.removeAttribute("data-quiet");

    (this.#icon as HTMLElement).replaceChildren(this.#svg(model.icon));
    (this.#title as HTMLElement).textContent = model.title;
    (this.#body as HTMLElement).textContent = model.body;
    (this.#note as HTMLElement).textContent = model.note ?? "";
    // The live region persists across renders, so a changed status is announced.
    const status = this.#status as HTMLElement;
    if (status.textContent !== model.status) status.textContent = model.status;

    this.#controls = new Map();
    if (model.primary !== undefined) this.#controls.set("primary", this.#button("primary", model.primary, model.busy));
    if (model.secondary !== undefined) {
      this.#controls.set("secondary", this.#button("secondary", model.secondary, model.busy));
    }
    (this.#actions as HTMLElement).replaceChildren(...this.#controls.values());
    if (this.#dismiss !== null) this.#controls.set("dismiss", this.#dismiss);

    if (focused !== null) this.#restoreFocus(focused, model.busy);
  }

  /** Remove the banner from the page. */
  destroy(): void {
    this.#destroyed = true;
    this.#host?.remove();
    this.#host = null;
    this.#shadow = null;
    this.#bar = null;
    this.#note = null;
    this.#dismiss = null;
    this.#controls = new Map();
  }

  #mount(): boolean {
    const doc = this.#doc;
    const host = doc.createElement("writ-banner");
    if (typeof host.attachShadow !== "function") return false;
    const shadow = host.attachShadow({ mode: "closed" });
    const fixed = this.#options.container === null;

    const important = (property: string, value: string): void => {
      host.style.setProperty(property, value, "important");
    };
    important("display", "block");
    important("margin", "0");
    important("padding", "0");
    important("border", "0");
    important("width", fixed ? "auto" : "100%");
    if (fixed) {
      important("position", "fixed");
      important("left", "0");
      important("right", "0");
      important(this.#options.position, "0");
      important("z-index", "2147483000");
    } else {
      important("position", "relative");
    }

    this.#adoptStyles(shadow);

    const bar = this.#element("section", {
      class: "bar",
      role: "region",
      "aria-label": this.#options.label,
      "data-position": this.#options.position,
      tabindex: "-1",
    });
    if (!fixed) bar.setAttribute("data-inline", "");
    if (!this.#options.dismissible) bar.setAttribute("data-required", "");
    const icon = this.#element("div", { class: "icon", "aria-hidden": "true" });
    const text = this.#element("div", { class: "text" });
    const title = this.#element("p", { class: "title" });
    const body = this.#element("p", { class: "body" });
    const note = this.#element("p", { class: "note" });
    const status = this.#element("p", { class: "status", role: "status", "aria-live": "polite" });
    text.append(title, body, note, status);
    const actions = this.#element("div", { class: "actions" });
    let dismiss: HTMLElement | null = null;
    if (this.#options.dismissible) {
      dismiss = this.#element("button", {
        class: "dismiss",
        type: "button",
        "aria-label": this.#options.dismissLabel,
        title: this.#options.dismissLabel,
        "data-action": "dismiss",
      });
      dismiss.append(this.#svg("close"));
      dismiss.addEventListener("click", () => this.#options.onAction("dismiss"));
      bar.append(icon, text, actions, dismiss);
    } else {
      bar.append(icon, text, actions);
    }
    shadow.append(bar);

    const parent = this.#options.container ?? doc.body;
    if (parent === null) return false;
    if (fixed && this.#options.position === "top") parent.prepend(host);
    else parent.append(host);

    this.#host = host;
    this.#shadow = shadow;
    this.#bar = bar;
    this.#icon = icon;
    this.#title = title;
    this.#body = body;
    this.#note = note;
    this.#status = status;
    this.#actions = actions;
    this.#dismiss = dismiss;
    return true;
  }

  /** Adopted stylesheets where supported (not blocked by a strict style-src CSP), else <style>. */
  #adoptStyles(shadow: ShadowRoot): void {
    const Sheet = this.#options.styleSheetConstructor as
      | (new () => { replaceSync(text: string): void })
      | undefined;
    if (typeof Sheet === "function" && "adoptedStyleSheets" in shadow) {
      try {
        const sheet = new Sheet();
        sheet.replaceSync(CSS);
        (shadow as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets = [sheet];
        return;
      } catch {
        // Fall back to a <style> element below.
      }
    }
    const style = this.#element("style", {});
    style.textContent = CSS;
    shadow.append(style);
  }

  #button(action: "primary" | "secondary", button: BannerButton, busy: boolean): HTMLElement {
    const className = `btn btn-${action}`;
    if (button.href !== undefined) {
      const link = this.#element("a", {
        class: className,
        href: button.href,
        target: "_blank",
        rel: "noopener noreferrer",
        "data-action": action,
      });
      if (busy) link.setAttribute("aria-disabled", "true");
      link.textContent = button.label;
      return link;
    }
    const element = this.#element("button", { class: className, type: "button", "data-action": action });
    if (busy) element.setAttribute("disabled", "");
    element.textContent = button.label;
    element.addEventListener("click", () => this.#options.onAction(action));
    return element;
  }

  #element(tag: string, attributes: Readonly<Record<string, string>>): HTMLElement {
    const element = this.#doc.createElement(tag);
    for (const name of Object.keys(attributes)) element.setAttribute(name, attributes[name] as string);
    return element;
  }

  #svg(name: BannerIcon | "close"): SVGElement {
    const svg = this.#doc.createElementNS(SVG_NS, "svg");
    const attributes: Record<string, string> = {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.75",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    };
    for (const attribute of Object.keys(attributes)) svg.setAttribute(attribute, attributes[attribute] as string);
    for (const d of ICON_PATHS[name]) {
      const path = this.#doc.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  /** The `data-action` of the focused control, "region" for the bar itself, or null. */
  #focusedAction(): string | null {
    const active = this.#shadow?.activeElement ?? null;
    if (active === null) return null;
    return active.getAttribute("data-action") ?? "region";
  }

  /** Keep keyboard focus inside the banner across a re-render. */
  #restoreFocus(previous: string, busy: boolean): void {
    const bar = this.#bar;
    if (bar === null) return;
    if (busy) {
      bar.focus();
      return;
    }
    const controls = this.#controls;
    const target =
      controls.get(previous) ?? controls.get("primary") ?? controls.get("secondary") ?? controls.get("dismiss");
    (target ?? bar).focus();
  }
}
