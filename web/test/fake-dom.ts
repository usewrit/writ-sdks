/**
 * A minimal DOM for the banner tests: elements, text, closed shadow roots, focus, attributes,
 * inline styles and click events. Just enough of the real API for the banner; no jsdom.
 *
 * Unlike a real closed shadow root, the fake keeps a test-only reference (`shadowForTest`), so
 * tests can look inside the banner.
 */

import type { WritNavigator } from "../src/index.js";
import { CHROME_UA, FakeWindow } from "./fake-provider.js";

const HTML_NS = "http://www.w3.org/1999/xhtml";

type FakeChild = FakeElement | FakeText;

export class FakeText {
  parent: FakeContainer | null = null;
  data: string;

  constructor(data: string) {
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }

  set textContent(value: string) {
    this.data = value;
  }

  remove(): void {
    this.parent?.removeChild(this);
  }
}

abstract class FakeContainer extends EventTarget {
  readonly childNodes: FakeChild[] = [];
  parent: FakeContainer | null = null;
  readonly ownerDocument: FakeDocument;

  constructor(ownerDocument: FakeDocument | null) {
    super();
    this.ownerDocument = ownerDocument ?? (this as unknown as FakeDocument);
  }

  /** Element children only. */
  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement);
  }

  append(...nodes: (FakeChild | string)[]): void {
    for (const node of nodes) this.#insert(node, this.childNodes.length);
  }

  prepend(...nodes: (FakeChild | string)[]): void {
    nodes.forEach((node, offset) => this.#insert(node, offset));
  }

  appendChild<T extends FakeChild>(node: T): T {
    this.#insert(node, this.childNodes.length);
    return node;
  }

  replaceChildren(...nodes: (FakeChild | string)[]): void {
    for (const node of [...this.childNodes]) this.removeChild(node);
    this.append(...nodes);
  }

  removeChild(node: FakeChild): void {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error("not a child");
    this.childNodes.splice(index, 1);
    node.parent = null;
  }

  remove(): void {
    this.parent?.removeChild(this as unknown as FakeChild);
  }

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join("");
  }

  set textContent(value: string) {
    this.replaceChildren(...(value === "" ? [] : [new FakeText(value)]));
  }

  /** Every element below this node, depth first. */
  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) {
      out.push(child);
      out.push(...child.descendants());
      if (child.shadowForTest !== null) out.push(...child.shadowForTest.descendants());
    }
    return out;
  }

  #insert(node: FakeChild | string, index: number): void {
    const child = typeof node === "string" ? new FakeText(node) : node;
    child.parent?.removeChild(child);
    this.childNodes.splice(index, 0, child);
    child.parent = this;
  }
}

class FakeStyle {
  readonly #values = new Map<string, { value: string; priority: string }>();

  setProperty(name: string, value: string, priority = ""): void {
    this.#values.set(name, { value, priority });
  }

  getPropertyValue(name: string): string {
    return this.#values.get(name)?.value ?? "";
  }

  getPropertyPriority(name: string): string {
    return this.#values.get(name)?.priority ?? "";
  }
}

export class FakeElement extends FakeContainer {
  readonly localName: string;
  readonly namespaceURI: string;
  readonly style = new FakeStyle();
  readonly #attributes = new Map<string, string>();
  shadowForTest: FakeShadowRoot | null = null;

  constructor(ownerDocument: FakeDocument, localName: string, namespaceURI: string) {
    super(ownerDocument);
    this.localName = localName;
    this.namespaceURI = namespaceURI;
  }

  get tagName(): string {
    return this.namespaceURI === HTML_NS ? this.localName.toUpperCase() : this.localName;
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.#attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name);
  }

  attachShadow(init: { mode: "open" | "closed" }): FakeShadowRoot {
    if (this.shadowForTest !== null) throw new Error("a shadow root is already attached");
    this.shadowForTest = new FakeShadowRoot(this.ownerDocument, this, init.mode);
    return this.shadowForTest;
  }

  /** The shadow root or document this element lives in, or null when detached. */
  root(): FakeShadowRoot | FakeDocument | null {
    let node: FakeContainer | null = this.parent;
    while (node !== null) {
      if (node instanceof FakeShadowRoot || node instanceof FakeDocument) return node;
      node = node.parent;
    }
    return null;
  }

  get isConnected(): boolean {
    let root = this.root();
    while (root instanceof FakeShadowRoot) root = root.host.root();
    return root instanceof FakeDocument;
  }

  focus(): void {
    const root = this.root();
    if (root instanceof FakeShadowRoot) {
      root.focused = this;
      this.ownerDocument.focused = root.host;
    } else if (root instanceof FakeDocument) {
      root.focused = this;
    }
  }

  /** A user click: nothing happens on a disabled control, as in a browser. */
  click(): void {
    if (this.hasAttribute("disabled")) return;
    this.dispatchEvent(new Event("click"));
  }
}

export class FakeShadowRoot extends FakeContainer {
  readonly host: FakeElement;
  readonly mode: "open" | "closed";
  focused: FakeElement | null = null;

  constructor(ownerDocument: FakeDocument, host: FakeElement, mode: "open" | "closed") {
    super(ownerDocument);
    this.host = host;
    this.mode = mode;
  }

  get activeElement(): FakeElement | null {
    const element = this.focused;
    return element !== null && element.root() === this ? element : null;
  }
}

export class FakeDocument extends FakeContainer {
  readonly body: FakeElement;
  focused: FakeElement | null = null;
  /** How many elements were created: zero means the banner never rendered. */
  created = 0;

  constructor() {
    super(null);
    this.body = new FakeElement(this, "body", HTML_NS);
    this.append(this.body);
  }

  get activeElement(): FakeElement | null {
    return this.focused;
  }

  createElement(tag: string): FakeElement {
    this.created += 1;
    return new FakeElement(this, tag.toLowerCase(), HTML_NS);
  }

  createElementNS(namespaceURI: string, tag: string): FakeElement {
    this.created += 1;
    return new FakeElement(this, tag, namespaceURI);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }
}

/** `sessionStorage`, optionally throwing like a browser with storage blocked. */
export class FakeStorage {
  readonly values = new Map<string, string>();
  blocked = false;

  getItem(key: string): string | null {
    if (this.blocked) throw new Error("SecurityError: storage is blocked");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.blocked) throw new Error("SecurityError: storage is blocked");
    this.values.set(key, String(value));
  }
}

/** A window with a document, session storage and `location.reload()`. */
export class BannerWindow extends FakeWindow {
  readonly document = new FakeDocument();
  readonly sessionStorage = new FakeStorage();
  reloads = 0;
  readonly location = {
    reload: (): void => {
      this.reloads += 1;
    },
  };

  constructor(navigator: WritNavigator = { userAgent: CHROME_UA, language: "en-US" }) {
    super(navigator);
  }

  /** The banner's host element, wherever it was mounted, or null. */
  host(): FakeElement | null {
    return this.document.descendants().find((element) => element.localName === "writ-banner") ?? null;
  }

  /** The banner's region (inside the closed shadow root), or null when nothing is shown. */
  bar(): FakeElement | null {
    const shadow = this.host()?.shadowForTest ?? null;
    return shadow?.children.find((element) => element.localName === "section") ?? null;
  }

  /** The banner's `data-state`, or null when nothing is shown. */
  state(): string | null {
    return this.bar()?.getAttribute("data-state") ?? null;
  }

  /** A control by `data-action` ("primary", "secondary", "dismiss"). */
  control(action: string): FakeElement | null {
    return this.bar()?.descendants().find((element) => element.getAttribute("data-action") === action) ?? null;
  }

  /** The element with this class inside the banner. */
  part(className: string): FakeElement | null {
    return (
      this.bar()
        ?.descendants()
        .find((element) => (element.getAttribute("class") ?? "").split(" ").includes(className)) ?? null
    );
  }

  /** Simulate the visitor coming back to the tab. */
  focusWindow(): void {
    this.dispatchEvent(new Event("focus"));
  }
}
