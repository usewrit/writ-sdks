/** Writ Cloud runs: dispatch, result polling, failure mapping. */

import { describe, expect, it } from "vitest";

import { isWritBridgeError, type WritBridgeErrorCode } from "../src/index.js";
import { jsonResponse, mockFetch, rejectionOf, testBridge } from "./fixtures.js";

describe("run and poll", () => {
  it("dispatches with the API key, polls until the task finishes, answers extracted_data", async () => {
    let reads = 0;
    const double = mockFetch((url) => {
      if (url.endsWith("/run")) return jsonResponse(200, { task_id: 77, status: "queued" });
      reads += 1;
      if (reads === 1) return jsonResponse(404, { detail: "Task not found" });
      if (reads === 2) return jsonResponse(200, { status: "running", success: null });
      if (reads === 3) return jsonResponse(503, { detail: "restarting" });
      return jsonResponse(200, { status: "completed", success: true, extracted_data: { orders: 12 }, result_data: { steps_completed: 3 } });
    });
    const bridge = testBridge({ fetch: double.fetch });
    await expect(bridge.orders.list({ status: "open" })).resolves.toEqual({ data: { orders: 12 }, venue: "cloud" });

    const [dispatch, ...polls] = double.calls;
    expect(dispatch).toMatchObject({
      url: "https://cloud.test/api/automation/workflows/12/run",
      method: "POST",
      headers: { authorization: "Bearer wrk_test_key", "content-type": "application/json" },
      body: { function_name: "list_orders", form_data: { status: "open" } },
    });
    expect(polls).toHaveLength(4);
    for (const poll of polls) {
      expect(poll).toMatchObject({ url: "https://cloud.test/api/automation/tasks/77/results", method: "GET", headers: { authorization: "Bearer wrk_test_key" } });
    }
  });

  it("answers result_data when the run extracted nothing", async () => {
    const double = mockFetch((url) =>
      url.endsWith("/run")
        ? jsonResponse(200, { task_id: 1 })
        : jsonResponse(200, { status: "success", success: true, extracted_data: null, result_data: { rows: [1, 2] } }),
    );
    await expect(testBridge({ fetch: double.fetch }).orders.list()).resolves.toEqual({ data: { rows: [1, 2] }, venue: "cloud" });
  });

  it("times out with TIMEOUT and the task id", async () => {
    const double = mockFetch((url) => (url.endsWith("/run") ? jsonResponse(200, { task_id: 5 }) : jsonResponse(200, { status: "running" })));
    const error = await rejectionOf(testBridge({ fetch: double.fetch }).orders.list({}, { timeoutMs: 1_000 }));
    expect(isWritBridgeError(error, "TIMEOUT")).toBe(true);
    expect((error as { details?: { task_id?: unknown } }).details?.task_id).toBe(5);
  });

  it.each<[string, unknown, WritBridgeErrorCode]>([
    ["failed", { status: "failed", success: false, error: "Element not found" }, "RUN_FAILED"],
    ["success false", { status: "completed", success: false, error: "Login refused" }, "RUN_FAILED"],
    ["timed out", { status: "timeout", success: false }, "TIMEOUT"],
    ["cancelled", { status: "cancelled", success: false }, "CANCELLED"],
    ["an unknown status, three times", { status: "teleported" }, "RUN_FAILED"],
  ])("maps a %s run", async (_name, result, code) => {
    const double = mockFetch((url) => (url.endsWith("/run") ? jsonResponse(200, { task_id: 2 }) : jsonResponse(200, result)));
    expect(isWritBridgeError(await rejectionOf(testBridge({ fetch: double.fetch }).orders.list()), code)).toBe(true);
  });

  it("keeps Writ Cloud's failure reason in the message", async () => {
    const double = mockFetch((url) =>
      url.endsWith("/run") ? jsonResponse(200, { task_id: 2 }) : jsonResponse(200, { status: "failed", error: "Element not found" }),
    );
    const error = await rejectionOf(testBridge({ fetch: double.fetch }).orders.list());
    expect((error as Error).message).toContain("Element not found");
  });
});

describe("dispatch refusals", () => {
  it.each<[number, unknown, WritBridgeErrorCode]>([
    [401, { detail: "Invalid API key" }, "NOT_GRANTED"],
    [403, { detail: "API key cannot run this workflow" }, "NOT_GRANTED"],
    [402, { detail: { code: "plan_limit", message: "Out of runs" } }, "QUOTA_EXCEEDED"],
    [404, { detail: "Workflow not found" }, "CLOUD_NOT_CONFIGURED"],
    [422, { detail: { code: "unknown_function", message: "list_orders is not a function of this workflow." } }, "CLOUD_NOT_CONFIGURED"],
    [422, { detail: { code: "invalid_mutation_mode", message: "bad" } }, "INPUT_INVALID"],
    [429, { detail: "Slow down" }, "RATE_LIMITED"],
    [409, { detail: "conflict" }, "RUN_FAILED"],
    [500, { detail: "boom" }, "CLOUD_UNAVAILABLE"],
    [502, "bad gateway", "CLOUD_UNAVAILABLE"],
  ])("HTTP %i maps to its code", async (status, body, code) => {
    const double = mockFetch(() => jsonResponse(status, body));
    const error = await rejectionOf(testBridge({ fetch: double.fetch }).orders.list());
    expect(isWritBridgeError(error, code)).toBe(true);
    expect(double.calls).toHaveLength(1);
  });

  it("maps a network failure to CLOUD_UNAVAILABLE", async () => {
    const bridge = testBridge({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(isWritBridgeError(await rejectionOf(bridge.orders.list()), "CLOUD_UNAVAILABLE")).toBe(true);
  });

  it("maps a refused API key while polling to NOT_GRANTED", async () => {
    const double = mockFetch((url) => (url.endsWith("/run") ? jsonResponse(200, { task_id: 3 }) : jsonResponse(401, { detail: "expired" })));
    expect(isWritBridgeError(await rejectionOf(testBridge({ fetch: double.fetch }).orders.list()), "NOT_GRANTED")).toBe(true);
  });

  it("refuses a dispatch answer without a task id", async () => {
    const double = mockFetch(() => jsonResponse(200, { status: "queued" }));
    expect(isWritBridgeError(await rejectionOf(testBridge({ fetch: double.fetch }).orders.list()), "CLOUD_UNAVAILABLE")).toBe(true);
  });
});
