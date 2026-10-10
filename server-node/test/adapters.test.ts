/** bridge.express(), bridge.handler as middleware, and bridge.next(), on a real node:http server. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { makeReceipt, testBridge } from "./fixtures.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          // fetch keeps connections alive; close them so close() does not wait for their timeout.
          server.closeAllConnections();
        }),
    ),
  );
});

/** Serve `handle` on a random local port; answers its base URL. */
async function serve(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("bridge.express()", () => {
  it("serves hello, polls and results end to end", async () => {
    const bridge = testBridge();
    const middleware = bridge.express();
    const base = await serve((req, res) => {
      void middleware(req, res, (error) => {
        res.statusCode = 500;
        res.end(String(error));
      });
    });
    const auth = { authorization: `Writ ${bridge.userToken("u1")}` };

    const hello = await fetch(`${base}/writ-bridge`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ hello: { ready: true, granted: ["auth.verify_login"], writ_version: "1.0.7" } }),
    });
    expect(hello.status).toBe(204);

    const call = bridge.user("u1").auth.verify_login({ company: "acme", username: "zoe" });
    const poll = await fetch(`${base}/writ-bridge?wait=5`, { headers: auth });
    expect(poll.status).toBe(200);
    expect(poll.headers.get("content-type")).toContain("application/json");
    const { commands } = (await poll.json()) as { commands: { id: string; key: string; challenge: string; inputs: unknown }[] };
    const command = commands[0];
    expect(command?.key).toBe("auth.verify_login");

    const data = { ok: true, user: "zoe" };
    const result = await fetch(`${base}/writ-bridge`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ result: { id: command?.id, ok: true, data, receipt: makeReceipt({ key: "auth.verify_login", challenge: command?.challenge ?? null, inputs: command?.inputs, data }) } }),
    });
    expect(result.status).toBe(204);
    await expect(call).resolves.toMatchObject({ venue: "user", data });
  });

  it("answers 401 without a token", async () => {
    const middleware = testBridge().express();
    const base = await serve((req, res) => void middleware(req, res));
    const response = await fetch(`${base}/writ-bridge?wait=0`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_GRANTED" } });
  });

  it("reads a body an Express JSON parser already consumed", async () => {
    const bridge = testBridge();
    const middleware = bridge.express();
    const base = await serve((req, res) => {
      // What express.json() leaves behind: the stream read to its end, the parsed body on req.body.
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        (req as IncomingMessage & { body?: unknown }).body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        void middleware(req, res);
      });
    });
    const response = await fetch(`${base}/writ-bridge`, {
      method: "POST",
      headers: { authorization: `Writ ${bridge.userToken("u1")}`, "content-type": "application/json" },
      body: JSON.stringify({ hello: { ready: true, granted: [], writ_version: null } }),
    });
    expect(response.status).toBe(204);
  });

  it("answers 413 to a body over the limit", async () => {
    const bridge = testBridge({ maxBodyBytes: 1_024 });
    const middleware = bridge.express();
    const base = await serve((req, res) => void middleware(req, res));
    const response = await fetch(`${base}/writ-bridge`, {
      method: "POST",
      headers: { authorization: `Writ ${bridge.userToken("u1")}`, "content-type": "application/json" },
      body: JSON.stringify({ hello: { ready: true, granted: ["x".repeat(4_000)] } }),
    });
    expect(response.status).toBe(413);
  });
});

describe("bridge.handler as middleware", () => {
  it("is recognised when called as (req, res, next)", async () => {
    const bridge = testBridge();
    const base = await serve((req, res) => void bridge.handler(req, res));
    const response = await fetch(`${base}/writ-bridge?wait=0`, { headers: { authorization: `Writ ${bridge.userToken("u1")}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commands: [] });
  });
});

describe("bridge.next()", () => {
  it("answers GET and POST as App Router handlers", async () => {
    const bridge = testBridge();
    const { GET, POST } = bridge.next();
    const auth = { authorization: `Writ ${bridge.userToken("u1")}` };
    const hello = await POST(
      new Request("https://app.example.com/api/writ-bridge", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ hello: { ready: true, granted: ["auth.verify_login"] } }),
      }),
    );
    expect(hello.status).toBe(204);
    const poll = await GET(new Request("https://app.example.com/api/writ-bridge?wait=0", { headers: auth }));
    expect(poll.status).toBe(200);
    expect(await bridge.online("u1")).toBe(true);
  });
});
