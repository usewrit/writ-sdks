//! The three-kind error model shared by every Writ agent SDK (DESIGN.md §5).

use serde_json::Value;

/// Convenience alias used across the crate.
pub type Result<T> = std::result::Result<T, WritError>;

/// Maximum length of a plain-text error body promoted into `message`.
const MESSAGE_CAP: usize = 500;

/// Every failure surfaced by this SDK.
///
/// - [`WritError::Api`] — the daemon answered with a non-2xx HTTP status.
/// - [`WritError::Connection`] — the daemon could not be reached / the request
///   or stream timed out / the response body could not be decoded.
/// - [`WritError::Discovery`] — no live daemon could be found at construction.
///
/// The tiered Writ Cloud surface ([`crate::CloudClient`]) adds three more
/// non-2xx shapes on top of `Api`: [`WritError::RateLimited`] (429),
/// [`WritError::ApiKeyRequired`] (402 `api_key_required`, or a keyless
/// whole-site crawl refused before any network call), and
/// [`WritError::InsufficientCredits`] (any other 402).
#[derive(Debug, thiserror::Error)]
pub enum WritError {
    /// Non-2xx HTTP response from the daemon.
    #[error("writ api error {status} [{code}]: {message}")]
    Api {
        /// HTTP status code.
        status: u16,
        /// Stable machine code: the daemon's JSON `code` field when present,
        /// otherwise derived from the status
        /// (`400→bad_request, 401→unauthorized, 403→forbidden, 404→not_found,
        /// 409→conflict, 422→unprocessable, 429→rate_limited, 5xx→internal`).
        code: String,
        /// Human message: JSON `error` → `detail` → `message` → raw text
        /// (truncated to ~500 chars) → HTTP status text.
        message: String,
        /// The parsed JSON body, or the raw text as a JSON string.
        body: Value,
    },
    /// The keyless daily allowance (requests/day or pages/day, per device or IP)
    /// is exhausted — Writ Cloud answered `429`. `reset_at` is when the allowance
    /// refills; add an API key for a full metered quota.
    #[error("writ rate limited [{code}]: {message}")]
    RateLimited {
        /// HTTP status (always 429).
        status: u16,
        /// Stable machine code (body `detail.code`, else `rate_limited`).
        code: String,
        /// Human message (body `detail.message`).
        message: String,
        /// The parsed JSON body, or the raw text as a JSON string.
        body: Value,
        /// ISO timestamp when the keyless daily allowance resets, if reported.
        reset_at: Option<String>,
        /// Keyless requests left today, if reported.
        requests_remaining: Option<i64>,
        /// Keyless pages left today, if reported.
        pages_remaining: Option<i64>,
    },
    /// A whole-site crawl was requested on the keyless cloud tier (no API key).
    /// Crawl is metered and always needs a credential — set an API key (builder
    /// `api_key` or `WRIT_API_KEY`). Keyless access covers `scrape` + `map`.
    /// Raised by [`crate::CloudClient::crawl`]/[`crate::CloudClient::crawl_status`]
    /// **before any network call**, or from a `402 api_key_required` response.
    #[error("writ api key required [{code}]: {message}")]
    ApiKeyRequired {
        /// HTTP status (402).
        status: u16,
        /// Stable machine code (`api_key_required`).
        code: String,
        /// Human message.
        message: String,
        /// The parsed JSON body, or `null` when refused client-side.
        body: Value,
    },
    /// The tenant's crawl-page allotment is spent and the wallet can't cover the
    /// call — Writ Cloud answered `402` (any code other than `api_key_required`).
    #[error("writ insufficient credits [{code}]: {message}")]
    InsufficientCredits {
        /// HTTP status (402).
        status: u16,
        /// Stable machine code.
        code: String,
        /// Human message.
        message: String,
        /// The parsed JSON body, or the raw text as a JSON string.
        body: Value,
    },
    /// A `run(..., wait)` call whose SERVER-side budget expired (HTTP 504).
    ///
    /// NOT a failure of the run: it is still executing and `run_id` still addresses it —
    /// poll `runs().get(run_id)`, stream `runs().events(run_id)`, or `runs().cancel(run_id)`.
    /// Retrying the call would start a SECOND run, which is exactly what carrying the id
    /// here is meant to prevent.
    #[error(
        "writ: run {run_id} did not finish within the requested budget and is STILL RUNNING — \
         observe it with runs().events({run_id}) or runs().get({run_id}); \
         do not retry, that would start a second run"
    )]
    RunTimeout {
        /// The still-running run.
        run_id: i64,
        /// Where to read the outcome once terminal, as reported by the daemon.
        status_url: Option<String>,
        /// Live SSE stream for this run.
        events_url: Option<String>,
    },
    /// Network failure / timeout / undecodable response (daemon down mid-session).
    #[error("writ connection error: {0}")]
    Connection(String),
    /// No live daemon found at construction time (see DESIGN.md §4).
    #[error("writ discovery error: {0}")]
    Discovery(String),
}

impl From<reqwest::Error> for WritError {
    fn from(err: reqwest::Error) -> Self {
        WritError::Connection(err.to_string())
    }
}

/// Derive the stable machine code from an HTTP status (plain-text / code-less bodies).
pub(crate) fn code_for_status(status: u16) -> String {
    match status {
        400 => "bad_request".to_string(),
        401 => "unauthorized".to_string(),
        403 => "forbidden".to_string(),
        404 => "not_found".to_string(),
        409 => "conflict".to_string(),
        422 => "unprocessable".to_string(),
        429 => "rate_limited".to_string(),
        s if s >= 500 => "internal".to_string(),
        s => format!("http_{s}"),
    }
}

/// Truncate a plain-text body for the `message` field (~500 chars, char-safe).
fn truncate_message(text: &str) -> String {
    if text.chars().count() <= MESSAGE_CAP {
        return text.to_string();
    }
    let cut: String = text.chars().take(MESSAGE_CAP).collect();
    format!("{cut}…")
}

/// Build a [`WritError::Api`] from a non-2xx response body per DESIGN.md §5:
/// parse JSON if possible (`code` from the body, `message` from
/// `error` → `detail` → `message`); otherwise treat the body as plain text.
pub(crate) fn api_error(status: u16, status_text: &str, text: &str) -> WritError {
    let derived = code_for_status(status);
    match serde_json::from_str::<Value>(text) {
        Ok(body) if body.is_object() => {
            let code = body
                .get("code")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or(derived);
            let message = ["error", "detail", "message"]
                .iter()
                .find_map(|k| body.get(*k).and_then(Value::as_str))
                .map(str::to_string)
                .unwrap_or_else(|| status_text.to_string());
            WritError::Api {
                status,
                code,
                message,
                body,
            }
        }
        Ok(body) => {
            // Valid JSON but not an object (bare string/number/array).
            let message = if text.trim().is_empty() {
                status_text.to_string()
            } else {
                truncate_message(text)
            };
            WritError::Api {
                status,
                code: derived,
                message,
                body,
            }
        }
        Err(_) => {
            let message = if text.trim().is_empty() {
                status_text.to_string()
            } else {
                truncate_message(text)
            };
            WritError::Api {
                status,
                code: derived,
                message,
                body: Value::String(text.to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_domain_error_maps_code_and_message() {
        let err = api_error(
            404,
            "Not Found",
            r#"{"error":"not found: workflow 999999","code":"not_found"}"#,
        );
        match err {
            WritError::Api {
                status,
                code,
                message,
                body,
            } => {
                assert_eq!(status, 404);
                assert_eq!(code, "not_found");
                assert_eq!(message, "not found: workflow 999999");
                assert_eq!(body["code"], "not_found");
            }
            other => panic!("expected Api, got {other:?}"),
        }
    }

    #[test]
    fn plain_text_body_derives_code_from_status() {
        let text = "Failed to deserialize the JSON body into the target type: missing field `url`";
        let err = api_error(422, "Unprocessable Entity", text);
        match err {
            WritError::Api {
                status,
                code,
                message,
                body,
            } => {
                assert_eq!(status, 422);
                assert_eq!(code, "unprocessable");
                assert_eq!(message, text);
                assert_eq!(body, Value::String(text.to_string()));
            }
            other => panic!("expected Api, got {other:?}"),
        }
    }

    #[test]
    fn message_resolution_falls_through_error_detail_message() {
        let err = api_error(400, "Bad Request", r#"{"detail":"nope"}"#);
        match err {
            WritError::Api { message, code, .. } => {
                assert_eq!(message, "nope");
                assert_eq!(code, "bad_request");
            }
            other => panic!("expected Api, got {other:?}"),
        }
        let err = api_error(500, "Internal Server Error", r#"{"message":"boom"}"#);
        match err {
            WritError::Api { message, code, .. } => {
                assert_eq!(message, "boom");
                assert_eq!(code, "internal");
            }
            other => panic!("expected Api, got {other:?}"),
        }
        // Empty body → status text.
        let err = api_error(429, "Too Many Requests", "");
        match err {
            WritError::Api { message, code, .. } => {
                assert_eq!(message, "Too Many Requests");
                assert_eq!(code, "rate_limited");
            }
            other => panic!("expected Api, got {other:?}"),
        }
    }

    #[test]
    fn long_plain_text_is_truncated_to_about_500_chars() {
        let text = "x".repeat(2000);
        let err = api_error(500, "Internal Server Error", &text);
        match err {
            WritError::Api { message, body, .. } => {
                assert!(message.chars().count() <= MESSAGE_CAP + 1);
                // The full raw text is preserved in `body`.
                assert_eq!(body, Value::String(text));
            }
            other => panic!("expected Api, got {other:?}"),
        }
    }
}
