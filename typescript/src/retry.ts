/**
 * Transient-failure retry shared by the local and cloud transports.
 *
 * A production caller cannot treat one 503 or one dropped socket as fatal — but
 * it also must not blindly repeat a request that may already have executed. The
 * split below is the whole safety story:
 *
 *   • GET / HEAD / OPTIONS are idempotent by definition and always eligible.
 *   • POST / PUT / PATCH are eligible ONLY when `retryUnsafeMethods` is set,
 *     which the SDK enables solely on the cloud surface, where every unsafe
 *     request carries an `Idempotency-Key` the server replays instead of
 *     re-executing. Against the local daemon (no such lane) unsafe methods are
 *     never retried, because a second POST there is a second monitor.
 */

/** Tuning for {@link withRetry}. */
export interface RetryPolicy {
  /** TOTAL attempts including the first. 0 or 1 disables retrying. */
  maxAttempts: number;
  /** First backoff step in ms; each further attempt doubles it. */
  baseDelayMs: number;
  /** Cap on a single backoff wait (before jitter), in ms. */
  maxDelayMs: number;
  /**
   * Longest server-requested wait worth honouring, in ms. When `Retry-After`
   * asks for longer the response is returned immediately instead — this is what
   * keeps a genuinely exhausted quota ("retry in 9 hours", which a keyless daily
   * allowance really does say) from being slept on and retried for nothing.
   */
  maxRetryAfterMs: number;
  /** Allow POST/PUT/PATCH to be retried. Only safe when the target honours `Idempotency-Key`. */
  retryUnsafeMethods?: boolean;
}

/**
 * Four attempts over roughly 0.25s + 0.5s + 1s of backoff — enough to ride out a
 * rolling deploy without turning a hung dependency into a minutes-long hang.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 30_000,
};

/**
 * Statuses worth trying again. 408/425 are the server asking for exactly that;
 * 429 is a rate limit that WILL clear; the 5xx here are the transient members of
 * the family. 501/505 and the 4xx client errors are deliberately absent —
 * repeating them just burns quota.
 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

function canRetryMethod(policy: RetryPolicy, method: string): boolean {
  return isSafeMethod(method) || policy.retryUnsafeMethods === true;
}

/**
 * Exponential backoff with FULL jitter. The randomisation is not a nicety: it is
 * what stops a fleet of clients that all saw the same 503 from re-converging
 * into a synchronised thundering herd on every retry.
 */
export function backoffMs(policy: RetryPolicy, attempt: number): number {
  const base = policy.baseDelayMs > 0 ? policy.baseDelayMs : DEFAULT_RETRY_POLICY.baseDelayMs;
  const cap = policy.maxDelayMs > 0 ? policy.maxDelayMs : DEFAULT_RETRY_POLICY.maxDelayMs;
  const raw = Math.min(base * 2 ** Math.min(attempt - 1, 20), cap);
  return raw / 2 + Math.random() * (raw / 2);
}

/** Parse `Retry-After` (delta-seconds or HTTP-date) into ms. */
export function retryAfterMs(response: Response | null): number | null {
  const raw = response?.headers?.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds < 0 ? null : seconds * 1000;
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

/** Sleep that rejects as soon as `signal` aborts, so a retry wait stays cancellable. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `attempt` under the policy, retrying transient failures.
 *
 * `attempt` is invoked once per try so each retry gets a fresh request. A
 * retried response body is discarded before the next attempt: leaving it
 * un-consumed keeps the connection out of the pool, which turns a brief 503
 * burst into permanent connection churn.
 */
export async function withRetry(
  policy: RetryPolicy,
  method: string,
  attempt: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> {
  const total = canRetryMethod(policy, method) ? Math.max(1, policy.maxAttempts) : 1;

  let lastError: unknown;
  for (let n = 1; ; n++) {
    let response: Response | null = null;
    try {
      response = await attempt();
      if (!RETRYABLE_STATUSES.has(response.status)) return response;
    } catch (err) {
      // An abort is the caller's decision, not a transient fault.
      if (signal?.aborted) throw err;
      lastError = err;
    }

    if (n >= total) {
      if (response) return response;
      throw lastError;
    }

    let wait = backoffMs(policy, n);
    const requested = retryAfterMs(response);
    if (requested !== null) {
      const cap = policy.maxRetryAfterMs > 0 ? policy.maxRetryAfterMs : DEFAULT_RETRY_POLICY.maxRetryAfterMs;
      // The server is telling us this will not clear any time soon. Hand the
      // caller the real answer now — it carries the reset time.
      if (requested > cap && response) return response;
      wait = requested;
    }

    if (response) {
      // Drain so the socket returns to the pool.
      try {
        await response.arrayBuffer();
      } catch {
        /* already consumed or errored */
      }
    }
    await sleep(wait, signal);
  }
}

/**
 * Mint an opaque key for ONE logical unsafe request. It is generated once per
 * call and reused across that call's retries — that is the entire point: the
 * server recognises the repeat and replays its first answer instead of
 * executing twice.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return `writ-${c.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `writ-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
