/** Discovery tests (DESIGN.md §4, §9.1) against a temp fake home dir. */

import { afterEach, describe, expect, it } from "vitest";
import { discoverAgent, WritAgent, WritDiscoveryError } from "../src/index.js";
import {
  makeWritDir,
  MockAgentServer,
  refusedPort,
  rmDir,
  runtimeDescriptor,
  startMockAgent,
} from "./mock.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function track(server: MockAgentServer): MockAgentServer {
  cleanups.push(() => server.close());
  return server;
}

function trackDir(dir: string): string {
  cleanups.push(() => rmDir(dir));
  return dir;
}

describe("discovery", () => {
  it("resolves port+token from active_profile → profiles/<id>/runtime.json", async () => {
    const server = track(await startMockAgent()).withAgentStatus();
    const writDir = trackDir(
      makeWritDir({
        activeProfile: "acct_1",
        profiles: { acct_1: runtimeDescriptor(server.port, "wlt_profile_token") },
      }),
    );

    const conn = await discoverAgent({ env: {}, writDir });
    expect(conn.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
    expect(conn.token).toBe("wlt_profile_token");

    // The liveness probe actually hit /v1/agent with the candidate token.
    const probe = server.requests.find((r) => r.path === "/v1/agent");
    expect(probe).toBeDefined();
    expect(probe!.headers.authorization).toBe("Bearer wlt_profile_token");
  });

  it("falls through a stale candidate to the next live one", async () => {
    const server = track(await startMockAgent()).withAgentStatus();
    const deadPort = await refusedPort();
    // active_profile points at a DEAD daemon; the root runtime.json is live.
    const writDir = trackDir(
      makeWritDir({
        activeProfile: "stale_profile",
        profiles: { stale_profile: runtimeDescriptor(deadPort, "wlt_stale") },
        root: runtimeDescriptor(server.port, "wlt_live"),
      }),
    );

    const conn = await discoverAgent({ env: {}, writDir });
    expect(conn.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
    expect(conn.token).toBe("wlt_live");
  });

  it("scans profiles/* when neither active_profile nor root descriptor is live", async () => {
    const server = track(await startMockAgent()).withAgentStatus();
    const writDir = trackDir(
      makeWritDir({
        profiles: { other_profile: runtimeDescriptor(server.port, "wlt_scanned") },
      }),
    );

    const conn = await discoverAgent({ env: {}, writDir });
    expect(conn.token).toBe("wlt_scanned");
  });

  it("env override (WRIT_API_URL + WRIT_TOKEN) wins without touching the filesystem", async () => {
    const conn = await discoverAgent({
      env: { WRIT_API_URL: "http://127.0.0.1:59999/", WRIT_TOKEN: "wlt_env" },
      writDir: "/nonexistent-writ-dir",
    });
    // Trailing slash stripped; no probe, no fs.
    expect(conn.baseUrl).toBe("http://127.0.0.1:59999");
    expect(conn.token).toBe("wlt_env");
  });

  it("a lone WRIT_TOKEN fills the token; the port is still discovered", async () => {
    const server = track(await startMockAgent()).withAgentStatus();
    const writDir = trackDir(
      makeWritDir({ root: runtimeDescriptor(server.port, "wlt_from_file") }),
    );

    const conn = await discoverAgent({ env: { WRIT_TOKEN: "wlt_env_only" }, writDir });
    expect(conn.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
    expect(conn.token).toBe("wlt_env_only");
    const probe = server.requests.find((r) => r.path === "/v1/agent");
    expect(probe!.headers.authorization).toBe("Bearer wlt_env_only");
  });

  it("WRIT_HOME/runtime.json wins over the ~/.writ candidates", async () => {
    const homeServer = track(await startMockAgent()).withAgentStatus();
    const rootServer = track(await startMockAgent()).withAgentStatus();
    const writHome = trackDir(makeWritDir({ root: runtimeDescriptor(homeServer.port, "wlt_home") }));
    const writDir = trackDir(makeWritDir({ root: runtimeDescriptor(rootServer.port, "wlt_root") }));

    const conn = await discoverAgent({ env: { WRIT_HOME: writHome }, writDir });
    expect(conn.token).toBe("wlt_home");
    expect(conn.baseUrl).toBe(`http://127.0.0.1:${homeServer.port}`);
  });

  it("throws WritDiscoveryError with a fix-it message when nothing is found", async () => {
    const writDir = trackDir(makeWritDir({}));
    await expect(discoverAgent({ env: {}, writDir })).rejects.toBeInstanceOf(WritDiscoveryError);
    await expect(discoverAgent({ env: {}, writDir })).rejects.toThrow(/WRIT_TOKEN/);
  });

  it("discovery is lazy and single-flight through the client", async () => {
    const server = track(await startMockAgent()).withAgentStatus();
    server.json("GET", "/v1/workflows", { data: [], count: 0 });
    const writDir = trackDir(makeWritDir({ root: runtimeDescriptor(server.port, "wlt_lazy") }));

    const client = new WritAgent({ env: {}, writDir });
    // Two concurrent first calls → exactly ONE probe (single-flight discovery).
    await Promise.all([client.workflows.list(), client.workflows.list()]);
    const probes = server.requests.filter((r) => r.path === "/v1/agent");
    expect(probes).toHaveLength(1);
  });

  it("WritAgent.discover() probes eagerly and fails fast when the daemon is down", async () => {
    const writDir = trackDir(makeWritDir({}));
    await expect(WritAgent.discover({ env: {}, writDir })).rejects.toBeInstanceOf(
      WritDiscoveryError,
    );
  });
});
