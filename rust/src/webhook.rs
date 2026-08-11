//! Verify (and sign) Writ webhook deliveries.
//!
//! Writ signs every outbound delivery twice:
//!
//! ```text
//! X-Writ-Signature-V1  HMAC-SHA256 over "{timestamp}." + raw body  <- verify this
//! X-Writ-Signature     HMAC-SHA256 over the raw body alone         <- legacy
//! ```
//!
//! V1 binds the timestamp into the MAC, so a captured delivery stops being
//! replayable the moment its timestamp goes stale. The body-only signature is
//! still sent for handlers written before V1 and is accepted here as an opt-in
//! fallback, but it CANNOT support a freshness check — nothing ties it to a point
//! in time.
//!
//! ```
//! use writ_client::webhook::{verify_webhook, VerifyOptions, WebhookError};
//!
//! // `headers` is whatever your framework gives you; the closure just looks a
//! // name up, case-insensitively as far as that map does.
//! fn handle(headers: &[(String, String)], body: &[u8], secret: &str)
//!     -> Result<(), WebhookError>
//! {
//!     verify_webhook(
//!         |name| {
//!             headers
//!                 .iter()
//!                 .find(|(k, _)| k.eq_ignore_ascii_case(name))
//!                 .map(|(_, v)| v.as_str())
//!         },
//!         body,        // RAW bytes — re-serializing first breaks the MAC
//!         secret,
//!         &VerifyOptions::default(),
//!     )
//! }
//!
//! // An unsigned request is refused, which is the point.
//! assert!(handle(&[], b"{}", "whsec_x").is_err());
//! ```

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use sha2::Sha256;

pub const SIGNATURE_V1_HEADER: &str = "X-Writ-Signature-V1";
pub const SIGNATURE_HEADER: &str = "X-Writ-Signature";
pub const TIMESTAMP_HEADER: &str = "X-Writ-Timestamp";

/// Freshness window for a V1 signature, matching the server's own ±5 minutes.
pub const DEFAULT_TOLERANCE: Duration = Duration::from_secs(300);

/// Why a delivery was rejected.
///
/// Treat EVERY variant as "do not act on this payload" — the distinction is for
/// logging and metrics, not for deciding to proceed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WebhookError {
    #[error("writ: webhook secret is empty")]
    NoSecret,
    #[error("writ: {0}")]
    NoSignature(String),
    #[error("writ: {0} is missing or malformed")]
    BadTimestamp(String),
    #[error("writ: webhook timestamp is {drift_secs}s away from now (tolerance {tolerance_secs}s) — treat it as a replay")]
    Stale {
        drift_secs: u64,
        tolerance_secs: u64,
    },
    #[error("writ: webhook signature does not match — treat this request as hostile")]
    SignatureMismatch,
}

/// Tuning for [`verify_webhook`]. The default is the recommended posture: V1
/// required, ±5 minutes, legacy body-only signatures refused.
#[derive(Debug, Clone)]
pub struct VerifyOptions {
    /// Freshness window. `None` disables the check — only sensible when
    /// something upstream already enforces replay protection.
    pub tolerance: Option<Duration>,
    /// Accept a delivery carrying ONLY the body-only `X-Writ-Signature`. Off by
    /// default: that signature cannot be checked for freshness, so accepting it
    /// silently reintroduces unlimited replay. Turn it on only while migrating a
    /// handler that predates V1.
    pub allow_legacy_body_only: bool,
    /// Override the clock (unix seconds) in tests.
    pub now: Option<u64>,
}

impl Default for VerifyOptions {
    fn default() -> Self {
        Self {
            tolerance: Some(DEFAULT_TOLERANCE),
            allow_legacy_body_only: false,
            now: None,
        }
    }
}

fn mac_hex(secret: &str, signed: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256>>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts a key of any length");
    mac.update(signed);
    mac.finalize().into_bytes().to_vec()
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let s = s.strip_prefix("sha256=").unwrap_or(s);
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Constant-time compare of a `sha256=<hex>` (or bare hex) header against the MAC
/// of `signed`.
///
/// A plain `==` on a hex digest leaks how many leading bytes matched, which is
/// enough to recover the expected MAC one byte at a time over many attempts;
/// `hmac`'s `verify_slice` does the comparison in constant time.
fn mac_matches(header: &str, secret: &str, signed: &[u8]) -> bool {
    let Some(given) = decode_hex(header.trim()) else {
        return false;
    };
    let mut mac = <Hmac<Sha256>>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts a key of any length");
    mac.update(signed);
    mac.verify_slice(&given).is_ok()
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Authenticate an outbound Writ delivery.
///
/// `header` looks a header up by name, case-insensitively as far as the caller's
/// header map does. `body` MUST be the exact bytes received: deserializing and
/// re-serializing first changes them (key order, spacing, number formatting) and
/// the MAC will not match — the single most common cause of a "wrong secret"
/// report.
pub fn verify_webhook<'a, F>(
    header: F,
    body: &[u8],
    secret: &str,
    opts: &VerifyOptions,
) -> std::result::Result<(), WebhookError>
where
    F: Fn(&str) -> Option<&'a str>,
{
    if secret.is_empty() {
        return Err(WebhookError::NoSecret);
    }

    if let Some(v1) = header(SIGNATURE_V1_HEADER)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let ts = header(TIMESTAMP_HEADER)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| WebhookError::BadTimestamp(TIMESTAMP_HEADER.to_string()))?;

        if let Some(tolerance) = opts.tolerance {
            let stamped: u64 = ts
                .parse()
                .map_err(|_| WebhookError::BadTimestamp(TIMESTAMP_HEADER.to_string()))?;
            let now = opts.now.unwrap_or_else(unix_now);
            // Absolute skew: a delivery timestamped in the FUTURE is as suspect
            // as a stale one — it means forged headers or a badly wrong clock.
            let drift = now.abs_diff(stamped);
            if drift > tolerance.as_secs() {
                return Err(WebhookError::Stale {
                    drift_secs: drift,
                    tolerance_secs: tolerance.as_secs(),
                });
            }
        }

        let mut signed = Vec::with_capacity(ts.len() + 1 + body.len());
        signed.extend_from_slice(ts.as_bytes());
        signed.push(b'.');
        signed.extend_from_slice(body);
        return if mac_matches(v1, secret, &signed) {
            Ok(())
        } else {
            Err(WebhookError::SignatureMismatch)
        };
    }

    let legacy = header(SIGNATURE_HEADER)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            WebhookError::NoSignature("request carries no Writ webhook signature".into())
        })?;

    if !opts.allow_legacy_body_only {
        return Err(WebhookError::NoSignature(format!(
            "only the body-only {SIGNATURE_HEADER} was present. It cannot be checked for \
             freshness, so it is refused by default — set allow_legacy_body_only while migrating"
        )));
    }
    if mac_matches(legacy, secret, body) {
        Ok(())
    } else {
        Err(WebhookError::SignatureMismatch)
    }
}

/// Headers for an INBOUND call to a Writ hook (`POST /api/webhooks/hook/{token}`).
///
/// That route requires a fresh signed timestamp: the MAC covers
/// `"{timestamp}." + body`, and an unsigned or stale call is rejected 401.
pub fn sign_webhook_request(body: &[u8], secret: &str) -> Vec<(&'static str, String)> {
    let ts = unix_now().to_string();
    let mut signed = Vec::with_capacity(ts.len() + 1 + body.len());
    signed.extend_from_slice(ts.as_bytes());
    signed.push(b'.');
    signed.extend_from_slice(body);
    let hex: String = mac_hex(secret, &signed)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    vec![
        (TIMESTAMP_HEADER, ts),
        (SIGNATURE_HEADER, format!("sha256={hex}")),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "whsec_test";
    const BODY: &[u8] = br#"{"event":"change_detected","target":{"id":42}}"#;

    fn v1(ts: &str) -> String {
        let mut signed = ts.as_bytes().to_vec();
        signed.push(b'.');
        signed.extend_from_slice(BODY);
        let hex: String = mac_hex(SECRET, &signed)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        format!("sha256={hex}")
    }

    fn lookup<'a>(pairs: &'a [(&'a str, String)]) -> impl Fn(&str) -> Option<&'a str> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
    }

    #[test]
    fn accepts_a_valid_v1_delivery() {
        let ts = unix_now().to_string();
        let pairs = vec![
            (TIMESTAMP_HEADER, ts.clone()),
            (SIGNATURE_V1_HEADER, v1(&ts)),
        ];
        verify_webhook(lookup(&pairs), BODY, SECRET, &VerifyOptions::default()).unwrap();
    }

    #[test]
    fn rejects_a_tampered_body_and_a_wrong_secret() {
        let ts = unix_now().to_string();
        let pairs = vec![
            (TIMESTAMP_HEADER, ts.clone()),
            (SIGNATURE_V1_HEADER, v1(&ts)),
        ];
        let mut tampered = BODY.to_vec();
        tampered.push(b' ');
        assert_eq!(
            verify_webhook(lookup(&pairs), &tampered, SECRET, &VerifyOptions::default()),
            Err(WebhookError::SignatureMismatch)
        );
        assert_eq!(
            verify_webhook(lookup(&pairs), BODY, "nope", &VerifyOptions::default()),
            Err(WebhookError::SignatureMismatch)
        );
    }

    #[test]
    fn rejects_a_correctly_signed_but_stale_delivery() {
        // Signed correctly, but an hour old: that is a replay.
        let old = (unix_now() - 3600).to_string();
        let pairs = vec![
            (TIMESTAMP_HEADER, old.clone()),
            (SIGNATURE_V1_HEADER, v1(&old)),
        ];
        assert!(matches!(
            verify_webhook(lookup(&pairs), BODY, SECRET, &VerifyOptions::default()),
            Err(WebhookError::Stale { .. })
        ));
    }

    #[test]
    fn refuses_body_only_unless_opted_in() {
        let hex: String = mac_hex(SECRET, BODY)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let pairs = vec![(SIGNATURE_HEADER, format!("sha256={hex}"))];
        assert!(matches!(
            verify_webhook(lookup(&pairs), BODY, SECRET, &VerifyOptions::default()),
            Err(WebhookError::NoSignature(_))
        ));
        verify_webhook(
            lookup(&pairs),
            BODY,
            SECRET,
            &VerifyOptions {
                allow_legacy_body_only: true,
                ..VerifyOptions::default()
            },
        )
        .unwrap();
    }

    #[test]
    fn signed_inbound_request_round_trips_through_the_verifier() {
        let headers = sign_webhook_request(BODY, SECRET);
        let ts = headers[0].1.clone();
        let sig = headers[1].1.clone();
        // The inbound scheme IS V1's scheme — one recipe for both directions.
        let pairs = vec![(TIMESTAMP_HEADER, ts), (SIGNATURE_V1_HEADER, sig)];
        verify_webhook(lookup(&pairs), BODY, SECRET, &VerifyOptions::default()).unwrap();
    }
}
