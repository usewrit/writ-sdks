/**
 * Writ Cloud runs with the developer's API key, through the existing run API:
 *
 * - `POST {base}/api/automation/workflows/{workflow_id}/run` with
 *   `{ function_name?, form_data, mutation_mode? }` answers `{ task_id, status }`;
 * - `GET {base}/api/automation/tasks/{task_id}/results` answers
 *   `{ status, success, result_data, extracted_data, error }`, polled with a backoff
 *   (1 s, growing by 1.5 up to 5 s, jittered) until the task is terminal or the deadline passes.
 *
 * The data is the run's `extracted_data`, else its `result_data`.
 */

import { performance } from "node:perf_hooks";

import {
  CLOUD_POLL_GROWTH,
  CLOUD_POLL_INITIAL_MS,
  CLOUD_POLL_JITTER,
  CLOUD_POLL_MAX_MS,
  CLOUD_REQUEST_TIMEOUT_MS,
  CLOUD_UNRECOGNISED_READS,
} from "./constants.js";
import type { WritCloudMapping } from "./contract.js";
import { WritBridgeError } from "./errors.js";
import { isPlainObject, type JsonObject } from "./json.js";

/** Every spelling of a task status Writ has used (the Arrivos driver's sets). */
const SUCCESS = new Set(["success", "succeeded", "completed", "complete", "done", "finished"]);
const TIMED_OUT = new Set(["timeout", "timed_out"]);
const CANCELLED = new Set(["cancelled", "canceled", "aborted", "stopped", "killed"]);
const FAILED = new Set(["failed", "failure", "error", "errored", "rejected"]);
const PENDING = new Set([
  "",
  "pending",
  "queued",
  "running",
  "started",
  "in_progress",
  "processing",
  "scheduled",
  "waiting",
  "created",
  "dispatched",
  "retrying",
  "accepted",
]);

/** How the result polling backs off. */
export interface CloudPollTiming {
  /** First wait between reads, in ms. Default 1000. */
  initialMs?: number;
  /** Longest wait between reads, in ms. Default 5000. */
  maxMs?: number;
}

/** One Writ Cloud run. */
export interface CloudRunRequest {
  base: string;
  apiKey: string;
  fetch: typeof fetch;
  mapping: WritCloudMapping;
  /** The contract key, for messages. */
  key: string;
  inputs: JsonObject;
  timeoutMs: number;
  dryRun?: boolean;
  /** Stops waiting (the run itself continues on Writ Cloud). */
  signal?: AbortSignal;
  timing?: CloudPollTiming;
}

/** Run a mapped workflow on Writ Cloud and wait for its data. */
export async function runOnCloud(request: CloudRunRequest): Promise<unknown> {
  const started = performance.now();
  const deadline = started + request.timeoutMs;
  const headers = {
    authorization: `Bearer ${request.apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };

  const body: Record<string, unknown> = { form_data: request.inputs };
  if (request.mapping.function !== null) body.function_name = request.mapping.function;
  if (request.dryRun === true) body.mutation_mode = "dry_run";

  const runUrl = `${request.base}/api/automation/workflows/${request.mapping.workflow_id}/run`;
  let dispatch: Response;
  try {
    const budget = Math.min(CLOUD_REQUEST_TIMEOUT_MS, Math.max(1, deadline - performance.now()));
    dispatch = await timedFetch(request.fetch, runUrl, { method: "POST", headers, body: JSON.stringify(body) }, budget, request.signal);
  } catch (error) {
    if (request.signal?.aborted === true) {
      throw new WritBridgeError("CANCELLED", `${request.key}: the Writ Cloud run was abandoned before Writ Cloud answered.`, { cause: error });
    }
    throw unreachable(request.key, "the run was not sent, or its answer was lost", error);
  }
  if (!dispatch.ok) throw await dispatchRefused(request.key, dispatch);
  const dispatched = await readJson(dispatch);
  const taskId = isPlainObject(dispatched) ? dispatched.task_id : undefined;
  if (typeof taskId !== "number" && typeof taskId !== "string") {
    throw new WritBridgeError("CLOUD_UNAVAILABLE", `${request.key}: Writ Cloud accepted the run but answered no task id.`);
  }

  const resultsUrl = `${request.base}/api/automation/tasks/${encodeURIComponent(String(taskId))}/results`;
  const details = { task_id: taskId, workflow_id: request.mapping.workflow_id };
  let interval = Math.max(1, request.timing?.initialMs ?? CLOUD_POLL_INITIAL_MS);
  const maxInterval = Math.max(interval, request.timing?.maxMs ?? CLOUD_POLL_MAX_MS);
  let unrecognised = 0;
  let lastStatus = "pending";

  for (;;) {
    if (request.signal?.aborted === true) {
      throw new WritBridgeError("CANCELLED", `${request.key}: stopped waiting for the Writ Cloud run.`, { details });
    }
    const readBudget = Math.min(CLOUD_REQUEST_TIMEOUT_MS, Math.max(1_000, deadline - performance.now()));
    let reply: Response | null = null;
    try {
      const readHeaders = { authorization: headers.authorization, accept: "application/json" };
      reply = await timedFetch(request.fetch, resultsUrl, { method: "GET", headers: readHeaders }, readBudget, request.signal);
    } catch {
      // A slow read, a dropped connection, a Writ Cloud deploy: not an answer either way.
      reply = null;
    }
    let pause: number | null = null;
    if (reply !== null) {
      if (reply.status === 401 || reply.status === 403) {
        throw new WritBridgeError("NOT_GRANTED", `${request.key}: Writ Cloud refused WRIT_API_KEY while reading the result.`, {
          details: { ...details, status: reply.status },
        });
      }
      if (reply.status === 429) {
        pause = retryAfterMs(reply) ?? interval;
      } else if (reply.status >= 500 || reply.status === 404) {
        // A gateway answering for a restarting Writ Cloud, or a task a moment too new.
      } else if (reply.status >= 400) {
        throw new WritBridgeError("CLOUD_UNAVAILABLE", `${request.key}: Writ Cloud answered HTTP ${reply.status} to the result read.`, {
          details: { ...details, status: reply.status },
        });
      } else {
        const result = await readJson(reply);
        if (isPlainObject(result)) {
          const status = String(result.status ?? "").trim().toLowerCase();
          lastStatus = status || lastStatus;
          const failed = FAILED.has(status) || TIMED_OUT.has(status) || CANCELLED.has(status);
          // Terminal: a known end status, or `success: true` whatever the status says.
          if (failed || SUCCESS.has(status) || result.success === true) {
            if (failed || result.success === false) throw runFailure(request.key, status, result, details);
            return dataOf(request.key, result, details);
          }
          if (PENDING.has(status)) {
            unrecognised = 0;
          } else {
            unrecognised += 1;
            if (unrecognised >= CLOUD_UNRECOGNISED_READS) {
              throw new WritBridgeError("RUN_FAILED", `${request.key}: the Writ Cloud run ended with a status this SDK does not know (${status.slice(0, 40)}).`, { details });
            }
          }
        }
      }
    }
    const left = deadline - performance.now();
    if (left <= 0) {
      throw new WritBridgeError("TIMEOUT", `${request.key}: the Writ Cloud run did not finish within ${Math.round(request.timeoutMs / 1000)} s (last status: ${lastStatus || "pending"}).`, { details });
    }
    const jittered = pause ?? interval * (1 - CLOUD_POLL_JITTER + Math.random() * 2 * CLOUD_POLL_JITTER);
    await sleep(Math.max(0, Math.min(jittered, left)), request.signal);
    interval = Math.min(maxInterval, interval * CLOUD_POLL_GROWTH);
  }
}

function dataOf(key: string, result: Record<string, unknown>, details: Record<string, unknown>): unknown {
  const error = result.error;
  if (typeof error === "string" && error.trim() !== "" && result.success !== true) {
    throw new WritBridgeError("RUN_FAILED", `${key}: ${error}`, { details });
  }
  if (result.extracted_data !== undefined && result.extracted_data !== null) return result.extracted_data;
  if (result.result_data !== undefined) return result.result_data;
  return null;
}

function runFailure(key: string, status: string, result: Record<string, unknown>, details: Record<string, unknown>): WritBridgeError {
  const reason = typeof result.error === "string" && result.error.trim() !== "" ? result.error.trim() : status || "no reason given";
  if (TIMED_OUT.has(status)) return new WritBridgeError("TIMEOUT", `${key}: the Writ Cloud run timed out (${reason}).`, { details });
  if (CANCELLED.has(status)) return new WritBridgeError("CANCELLED", `${key}: the Writ Cloud run was cancelled (${reason}).`, { details });
  return new WritBridgeError("RUN_FAILED", `${key}: the Writ Cloud run failed: ${reason}`, { details });
}

async function dispatchRefused(key: string, response: Response): Promise<WritBridgeError> {
  const status = response.status;
  const body = await readJson(response);
  const detail = isPlainObject(body) ? body.detail : undefined;
  const detailCode = isPlainObject(detail) && typeof detail.code === "string" ? detail.code : undefined;
  const detailMessage = isPlainObject(detail) && typeof detail.message === "string"
    ? detail.message
    : typeof detail === "string"
      ? detail
      : undefined;
  const details: Record<string, unknown> = { status };
  if (detailCode !== undefined) details.cloudCode = detailCode;
  const suffix = detailMessage !== undefined ? `: ${detailMessage.slice(0, 300)}` : "";

  if (status === 401 || status === 403) {
    return new WritBridgeError("NOT_GRANTED", `${key}: Writ Cloud refused WRIT_API_KEY for this workflow (HTTP ${status})${suffix}.`, { details });
  }
  if (status === 402) {
    return new WritBridgeError("QUOTA_EXCEEDED", `${key}: the Writ Cloud plan behind WRIT_API_KEY is out of runs${suffix}.`, { details });
  }
  if (status === 404) {
    return new WritBridgeError("CLOUD_NOT_CONFIGURED", `${key}: the mapped Writ Cloud workflow does not exist in the WRIT_API_KEY account.`, { details });
  }
  if (status === 422 && detailCode === "unknown_function") {
    return new WritBridgeError("CLOUD_NOT_CONFIGURED", `${key}: the mapped Writ Cloud workflow has no such function${suffix}.`, { details });
  }
  if (status === 422 || status === 400) {
    return new WritBridgeError("INPUT_INVALID", `${key}: Writ Cloud refused the run${suffix}.`, { details });
  }
  if (status === 429) {
    const retry = retryAfterMs(response);
    if (retry !== null) details.retryAfterMs = retry;
    return new WritBridgeError("RATE_LIMITED", `${key}: Writ Cloud is limiting runs; try again later${suffix}.`, { details });
  }
  if (status >= 500) {
    return new WritBridgeError("CLOUD_UNAVAILABLE", `${key}: Writ Cloud answered HTTP ${status} to the run; whether it started is unknown.`, { details });
  }
  return new WritBridgeError("RUN_FAILED", `${key}: Writ Cloud refused the run (HTTP ${status})${suffix}.`, { details });
}

function unreachable(key: string, what: string, cause: unknown): WritBridgeError {
  if (cause instanceof WritBridgeError) return cause;
  return new WritBridgeError("CLOUD_UNAVAILABLE", `${key}: Writ Cloud could not be reached; ${what}.`, { cause });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.min(Math.max(0, date - Date.now()), 60_000);
}

/** `fetch` with its own timeout, also stopped by `signal`. */
async function timedFetch(
  fetcher: typeof fetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timed out")), Math.max(1, timeoutMs));
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    if (signal?.aborted === true) {
      resolvePromise();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolvePromise();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
