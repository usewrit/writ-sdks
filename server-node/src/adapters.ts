/**
 * Mount the fetch-API handler on Node frameworks: Express (or any `(req, res, next)` stack, such
 * as Connect, or a bare `node:http` server) and Next.js App Router route handlers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** The fetch-API handler the bridge serves. */
export type FetchHandler = (request: Request) => Promise<Response>;

/** An Express-style middleware. */
export type WritExpressMiddleware = (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void) => Promise<void>;

/** Next.js App Router route handlers: `export const { GET, POST } = bridge.next()`. */
export interface WritNextHandlers {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
}

/**
 * `bridge.handler`: a fetch-API handler, which also works directly as Express middleware
 * (`app.all("/writ-bridge", bridge.handler)`).
 */
export interface WritBridgeHandler {
  (request: Request): Promise<Response>;
  (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void): Promise<void>;
}

/** An Express request may carry what a body parser already read. */
type NodeRequest = IncomingMessage & { body?: unknown; originalUrl?: string };

/** True when called as `(req, res, next)` rather than `(request)`. */
export function isNodeCall(first: unknown, second: unknown): boolean {
  return (
    typeof second === "object" &&
    second !== null &&
    typeof (second as { setHeader?: unknown }).setHeader === "function" &&
    typeof first === "object" &&
    first !== null &&
    typeof (first as { headers?: unknown }).headers === "object"
  );
}

/** Express middleware serving `handler`. */
export function expressAdapter(handler: FetchHandler, maxBodyBytes: number): WritExpressMiddleware {
  return async (req, res, next) => {
    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);
    try {
      const request = await toFetchRequest(req as NodeRequest, controller.signal, maxBodyBytes);
      const response = request === null ? tooLarge(maxBodyBytes) : await handler(request);
      await sendFetchResponse(res, response);
    } catch (error) {
      if (next !== undefined) next(error);
      else if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: { code: "INTERNAL", message: "Writ failed unexpectedly." } }));
      } else res.end();
    } finally {
      res.off("close", onClose);
    }
  };
}

/** Next.js App Router handlers serving `handler`. */
export function nextAdapter(handler: FetchHandler): WritNextHandlers {
  return Object.freeze({ GET: (request: Request) => handler(request), POST: (request: Request) => handler(request) });
}

function tooLarge(limit: number): Response {
  return new Response(JSON.stringify({ error: { code: "BAD_REQUEST", message: `The request body is larger than ${limit} bytes.` } }), {
    status: 413,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** A fetch `Request` for a Node request, or `null` when its body is over `limit`. */
async function toFetchRequest(req: NodeRequest, signal: AbortSignal, limit: number): Promise<Request | null> {
  const method = (req.method ?? "GET").toUpperCase();
  const path = req.originalUrl ?? req.url ?? "/";
  let url: string;
  try {
    url = new URL(path, `http://${headerValue(req.headers.host) ?? "localhost"}`).toString();
  } catch {
    url = new URL(path.startsWith("/") ? path : "/", "http://localhost").toString();
  }

  const headers = new Headers();
  for (const name of ["authorization", "content-type", "accept"]) {
    const value = headerValue(req.headers[name]);
    if (value !== undefined) headers.set(name, value);
  }

  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const read = await nodeBody(req, limit);
    if (read === null) return null;
    body = read;
  }
  return new Request(url, { method, headers, body, signal });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

/** The request body: what a body parser kept, else the stream read up to `limit`. */
async function nodeBody(req: NodeRequest, limit: number): Promise<Buffer | null> {
  const parsed = req.body;
  if (Buffer.isBuffer(parsed)) return parsed.length > limit ? null : parsed;
  if (typeof parsed === "string") {
    const bytes = Buffer.from(parsed, "utf8");
    return bytes.length > limit ? null : bytes;
  }
  if (req.readableEnded) {
    // A JSON body parser consumed the stream: re-serialize what it parsed.
    if (parsed === undefined || parsed === null) return Buffer.alloc(0);
    const bytes = Buffer.from(JSON.stringify(parsed), "utf8");
    return bytes.length > limit ? null : bytes;
  }
  const declared = Number(headerValue(req.headers["content-length"]) ?? "0");
  if (declared > limit) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += bytes.length;
    if (size > limit) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** Write a fetch `Response` to a Node response. */
async function sendFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  if (response.body === null) {
    res.end();
    return;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  res.setHeader("content-length", String(bytes.length));
  res.end(bytes);
}
