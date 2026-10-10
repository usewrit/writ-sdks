/**
 * Test doubles for the Writ Bridge: a page window with a location and `fetch`, and a scriptable
 * developer server behind `/writ-bridge` (CONTRACT.md §12.3). No network: `fetch` is answered
 * here, long polls stay pending until a test answers them, and every request is recorded.
 */

import type { WritNavigator } from "../src/index.js";
import { BannerWindow } from "./fake-dom.js";
import { CHROME_UA } from "./fake-provider.js";

export const PAGE_ORIGIN = "https://arrivos.example";
export const ENDPOINT_URL = `${PAGE_ORIGIN}/writ-bridge`;

/** The parts of a fetch Response the bridge reads. */
export interface FakeAnswer {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** A response with `status` and, when given, a JSON body. */
export function reply(status: number, body?: unknown): FakeAnswer {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (text === undefined) throw new SyntaxError("Unexpected end of JSON input");
      return JSON.parse(text) as unknown;
    },
  };
}

export interface SentRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown> | undefined;
  readonly keepalive: boolean;
  /** `Date.now()` when it was sent (fake timers make it exact). */
  readonly at: number;
}

interface PendingPoll {
  readonly url: string;
  resolve(answer: FakeAnswer): void;
  reject(error: unknown): void;
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** The developer's server bridge route, scripted per test. */
export class FakeServer {
  readonly requests: SentRequest[] = [];
  readonly #polls: PendingPoll[] = [];
  /** While true, every long poll fails at once with a network error. */
  pollsFail = false;
  /** When set, every long poll answers this status at once. */
  pollStatus: number | null = null;
  /** A long poll nobody answers gets `{ commands: [] }` after this long, as a real server does (`wait=25`). */
  holdMs = 25_000;
  helloStatus = 204;
  resultStatus = 204;
  /** How `POST { run }` answers. */
  onRun: (run: Record<string, unknown>) => FakeAnswer | Promise<FakeAnswer> = () =>
    reply(200, { data: null, venue: "cloud" });

  readonly fetch = (url: string, init: RequestInit = {}): Promise<FakeAnswer> => {
    const method = init.method ?? "GET";
    const headers = { ...((init.headers ?? {}) as Record<string, string>) };
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    this.requests.push({ method, url, headers, body, keepalive: init.keepalive === true, at: Date.now() });
    const signal = init.signal ?? undefined;
    if (signal?.aborted === true) return Promise.reject(abortError());

    if (method === "GET") {
      if (this.pollsFail) return Promise.reject(new TypeError("Failed to fetch"));
      if (this.pollStatus !== null) return Promise.resolve(reply(this.pollStatus));
      return new Promise<FakeAnswer>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = this.#polls.indexOf(poll);
          if (index < 0) return;
          this.#polls.splice(index, 1);
          resolve(reply(200, { commands: [] }));
        }, this.holdMs);
        const poll: PendingPoll = {
          url,
          resolve: (answer) => {
            clearTimeout(timer);
            resolve(answer);
          },
          reject,
        };
        this.#polls.push(poll);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const index = this.#polls.indexOf(poll);
            if (index >= 0) this.#polls.splice(index, 1);
            reject(abortError());
          },
          { once: true },
        );
      });
    }

    if (body !== undefined && "run" in body) {
      return Promise.resolve(this.onRun(body.run as Record<string, unknown>));
    }
    if (body !== undefined && "hello" in body) return Promise.resolve(reply(this.helloStatus));
    if (body !== undefined && "result" in body) return Promise.resolve(reply(this.resultStatus));
    return Promise.resolve(reply(400, { error: { code: "BAD_REQUEST", message: "unknown body" } }));
  };

  /** Long polls still waiting for an answer. */
  get pendingPolls(): number {
    return this.#polls.length;
  }

  /** Answer the oldest pending long poll with `{ commands }`. */
  sendCommands(commands: unknown[]): void {
    const poll = this.#polls.shift();
    if (poll === undefined) throw new Error("no long poll is waiting");
    poll.resolve(reply(200, { commands }));
  }

  /** Every GET (long poll) sent. */
  get gets(): SentRequest[] {
    return this.requests.filter((request) => request.method === "GET");
  }

  /** Every `hello` posted, in order. */
  get hellos(): Record<string, unknown>[] {
    return this.#posted("hello");
  }

  /** Every `result` posted, in order. */
  get results(): Record<string, unknown>[] {
    return this.#posted("result");
  }

  /** Every `run` posted, in order. */
  get runs(): Record<string, unknown>[] {
    return this.#posted("run");
  }

  #posted(field: string): Record<string, unknown>[] {
    return this.requests
      .filter((request) => request.method === "POST" && request.body !== undefined && field in request.body)
      .map((request) => (request.body as Record<string, Record<string, unknown>>)[field] as Record<string, unknown>);
  }
}

/** A page on {@link PAGE_ORIGIN}, with a document, session storage and the fake server's `fetch`. */
export class BridgeWindow extends BannerWindow {
  override readonly location = {
    href: `${PAGE_ORIGIN}/orders?tab=open`,
    origin: PAGE_ORIGIN,
    reload: (): void => {
      this.reloads += 1;
    },
  };
  readonly server = new FakeServer();

  constructor(navigator: WritNavigator = { userAgent: CHROME_UA, language: "en-US" }) {
    super(navigator);
  }

  fetch(input: string, init?: RequestInit): Promise<Response> {
    return this.server.fetch(input, init) as unknown as Promise<Response>;
  }

  /** Hide or show the page, as switching tabs does. */
  setHidden(hidden: boolean): void {
    Object.defineProperty(this.document, "hidden", { value: hidden, configurable: true, writable: true });
    this.document.dispatchEvent(new Event("visibilitychange"));
  }
}
