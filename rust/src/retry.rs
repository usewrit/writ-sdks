//! Transient-failure retry shared by the local and cloud transports.
//!
//! A production caller cannot treat one 503 or one dropped socket as fatal — but
//! it also must not blindly repeat a request that may already have executed. The
//! split below is the whole safety story:
//!
//! * `GET` / `HEAD` / `OPTIONS` are idempotent by definition and always eligible.
//! * `POST` / `PUT` / `PATCH` / `DELETE` are eligible ONLY when
//!   [`RetryPolicy::retry_unsafe_methods`] is set, which the SDK enables solely on
//!   the cloud surface, where every unsafe request carries an `Idempotency-Key`
//!   the server replays instead of re-executing. Against the local daemon (no such
//!   lane) unsafe methods are never retried, because a second POST there is a
//!   second monitor.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::{Method, Response, StatusCode};

/// Statuses worth trying again. 408/425 are the server asking for exactly that;
/// 429 is a rate limit that WILL clear; the 5xx here are the transient members of
/// the family. 501/505 and the 4xx client errors are deliberately absent —
/// repeating them just burns quota.
const RETRYABLE: &[u16] = &[408, 425, 429, 500, 502, 503, 504];

/// Tuning for transient-failure retries. [`RetryPolicy::default`] is what both
/// transports use unless overridden.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RetryPolicy {
    /// TOTAL attempts including the first. 0 or 1 disables retrying.
    pub max_attempts: u32,
    /// First backoff step; each further attempt doubles it.
    pub base_delay: Duration,
    /// Cap on a single backoff wait (before jitter).
    pub max_delay: Duration,
    /// Longest server-requested wait worth honouring. When `Retry-After` asks for
    /// longer the response is returned immediately instead — this is what keeps a
    /// genuinely exhausted quota ("retry in 9 hours", which a keyless daily
    /// allowance really does say) from being slept on and retried for nothing.
    pub max_retry_after: Duration,
    /// Allow unsafe methods to be retried. Only safe when the target honours
    /// `Idempotency-Key`.
    pub retry_unsafe_methods: bool,
}

impl Default for RetryPolicy {
    /// Four attempts over roughly 0.25s + 0.5s + 1s of backoff — enough to ride
    /// out a rolling deploy without turning a hung dependency into a
    /// minutes-long hang.
    fn default() -> Self {
        Self {
            max_attempts: 4,
            base_delay: Duration::from_millis(250),
            max_delay: Duration::from_secs(8),
            max_retry_after: Duration::from_secs(30),
            retry_unsafe_methods: false,
        }
    }
}

impl RetryPolicy {
    /// Disable retrying entirely.
    pub fn off() -> Self {
        Self {
            max_attempts: 1,
            ..Self::default()
        }
    }

    pub(crate) fn with_unsafe(mut self, allowed: bool) -> Self {
        self.retry_unsafe_methods = allowed;
        self
    }

    pub(crate) fn attempts_for(&self, method: &Method) -> u32 {
        if is_safe_method(method) || self.retry_unsafe_methods {
            self.max_attempts.max(1)
        } else {
            1
        }
    }

    /// Exponential backoff with FULL jitter.
    ///
    /// The randomisation is not a nicety: it is what stops a fleet of clients
    /// that all saw the same 503 from re-converging into a synchronised
    /// thundering herd on every retry.
    pub(crate) fn backoff(&self, attempt: u32) -> Duration {
        let base = if self.base_delay.is_zero() {
            Duration::from_millis(250)
        } else {
            self.base_delay
        };
        let cap = if self.max_delay.is_zero() {
            Duration::from_secs(8)
        } else {
            self.max_delay
        };
        let scaled = base.saturating_mul(1u32 << attempt.saturating_sub(1).min(20));
        let raw = scaled.min(cap);
        let nanos = raw.as_nanos() as u64;
        // Jitter source: the low bits of the wall clock. Retry spacing needs to be
        // unpredictable relative to OTHER clients, not cryptographically random,
        // so this avoids pulling in an RNG dependency for it.
        let jitter = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64)
            .unwrap_or(0);
        let half = nanos / 2;
        Duration::from_nanos(half + if half == 0 { 0 } else { jitter % half })
    }
}

pub(crate) fn is_safe_method(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

pub(crate) fn should_retry_status(status: StatusCode) -> bool {
    RETRYABLE.contains(&status.as_u16())
}

/// Parse `Retry-After` (delta-seconds only; an HTTP-date is treated as absent
/// rather than mis-parsed). The server's own number always beats our computed
/// backoff — it knows when the limit resets and we are guessing.
pub(crate) fn retry_after(resp: &Response) -> Option<Duration> {
    let raw = resp.headers().get(reqwest::header::RETRY_AFTER)?;
    let text = raw.to_str().ok()?.trim();
    let secs: f64 = text.parse().ok()?;
    if secs < 0.0 {
        return None;
    }
    Some(Duration::from_secs_f64(secs))
}

/// Mint an opaque key for ONE logical unsafe request.
///
/// Generated once per call and reused across that call's retries — that is the
/// entire point: the server recognises the repeat and replays its first answer
/// instead of executing twice. The server scopes keys by credential, so
/// uniqueness within one caller is what this must guarantee, and a monotonic
/// counter combined with the wall clock does exactly that.
pub(crate) fn new_idempotency_key() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("writ-{nanos:x}-{n:x}-{:x}", std::process::id())
}
