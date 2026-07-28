//! [`CloudClient`] — the tiered **Writ Cloud** surface: `scrape`, `map`, and
//! whole-site `crawl`.
//!
//! Unlike the rest of this SDK (which talks to the LOCAL daemon), these verbs run
//! on Writ Cloud — never on the calling machine — with a Firecrawl-style tier
//! model resolved from your credential:
//!
//! - **Metered** — an API key (builder `api_key` → `WRIT_API_KEY` env) → the
//!   authed `/api/crawl/*` surface, billed per page. `scrape`, `map`, AND `crawl`
//!   all work.
//! - **Keyless** — no key → the free `/v1/keyless/*` tier, daily-capped per
//!   install (a stable client-id header) AND per IP. `scrape` + `map` only;
//!   `crawl` returns [`WritError::ApiKeyRequired`] before any network call.
//!
//! The credential fallback chain (`api_key` arg → `WRIT_API_KEY` → keyless)
//! mirrors Firecrawl's, so the same code scales from an anonymous test to a
//! metered production key with no branching at the call site.
//!
//! ```no_run
//! # async fn demo() -> Result<(), writ_client::WritError> {
//! use writ_client::CloudClient;
//!
//! let cloud = CloudClient::from_env()?;      // metered if WRIT_API_KEY is set, else keyless
//! let page = cloud.scrape("https://example.com").await?;
//! println!("[{}] {}", cloud.tier(), page.markdown);
//! # Ok(())
//! # }
//! ```

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::Method;
use serde_json::{Map, Value};

use crate::client::USER_AGENT;
use crate::discovery::env_var;
use crate::error::{code_for_status, Result, WritError};
use crate::models::{CrawlJob, CrawlStartParams};

/// Default Writ Cloud base URL.
const DEFAULT_CLOUD_URL: &str = "https://api.usewrit.app";

/// Keyless device-identity header.
const CLIENT_ID_HEADER: &str = "X-Writ-Client-Id";

/// Default per-request timeout (mirrors the daemon client).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Which access tier a [`CloudClient`] resolved to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudTier {
    /// No API key — the free, daily-capped `/v1/keyless/*` surface.
    Keyless,
    /// An API key is present — the authed, per-page-billed `/api/crawl/*` surface.
    Metered,
}

impl CloudTier {
    /// The wire string for this tier: `"keyless"` or `"metered"` (identical
    /// across every Writ SDK).
    pub fn as_str(&self) -> &'static str {
        match self {
            CloudTier::Keyless => "keyless",
            CloudTier::Metered => "metered",
        }
    }
}

impl std::fmt::Display for CloudTier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Remaining keyless allowance echoed back on keyless calls.
#[derive(Debug, Clone)]
pub struct KeylessQuota {
    /// Always [`CloudTier::Keyless`].
    pub tier: CloudTier,
    /// Keyless requests left in the current window.
    pub requests_remaining: i64,
    /// Keyless pages left in the current window.
    pub pages_remaining: i64,
    /// Daily request allowance.
    pub requests_per_day: i64,
    /// Daily page allowance.
    pub pages_per_day: i64,
    /// ISO timestamp when the allowance refills.
    pub reset_at: String,
    /// Where to upgrade for a metered quota, if the server reported it.
    pub upgrade_url: Option<String>,
}

/// One clean-markdown page ([`CloudClient::scrape`]).
#[derive(Debug, Clone)]
pub struct ScrapeResult {
    /// The scraped URL.
    pub url: String,
    /// Page title, if any.
    pub title: Option<String>,
    /// Output format (usually `"markdown"`).
    pub format: String,
    /// The extracted markdown.
    pub markdown: String,
    /// Per-block element counts the server reported.
    pub counts: Map<String, Value>,
    /// The tier this call resolved to.
    pub tier: CloudTier,
    /// Present on the keyless tier only — remaining daily allowance.
    pub quota: Option<KeylessQuota>,
}

/// One ranked URL in a [`MapResult`].
#[derive(Debug, Clone)]
pub struct MapEntry {
    /// The discovered URL.
    pub url: String,
    /// Relevance score for the optional `search` (0 when none).
    pub score: f64,
    /// Link/anchor title, if any.
    pub title: Option<String>,
}

/// `returned` / `total` counts on a [`MapResult`].
#[derive(Debug, Clone, Default)]
pub struct MapCounts {
    /// URLs returned in this response.
    pub returned: i64,
    /// Total URLs discovered.
    pub total: i64,
}

/// A site's URLs, ranked by an optional `search` ([`CloudClient::map`]).
#[derive(Debug, Clone)]
pub struct MapResult {
    /// The mapped seed URL.
    pub url: String,
    /// The resolved host, if the server reported it.
    pub host: Option<String>,
    /// Ranked URLs.
    pub urls: Vec<MapEntry>,
    /// Returned / total counts.
    pub counts: MapCounts,
    /// The tier this call resolved to.
    pub tier: CloudTier,
    /// Present on the keyless tier only — remaining daily allowance.
    pub quota: Option<KeylessQuota>,
}

/// Options for [`CloudClient::map`].
#[derive(Debug, Clone, Default)]
pub struct MapOptions {
    /// Rank the discovered URLs by relevance to this query (empty = no ranking).
    pub search: Option<String>,
    /// Cap the number of URLs returned.
    pub limit: Option<i64>,
}

/// Configuration for [`CloudClient`]. `build()` performs **no network I/O**; the
/// only side effect is reading/minting `~/.writ/client_id` on the first keyless
/// call (lazily), never at construction.
#[derive(Debug, Default, Clone)]
pub struct CloudClientBuilder {
    api_key: Option<String>,
    cloud_url: Option<String>,
    client_id: Option<String>,
    timeout: Option<Duration>,
}

impl CloudClientBuilder {
    /// Metered API key (`wt_`/`wlk_`). Falls back to `WRIT_API_KEY`; absent ⇒
    /// keyless.
    pub fn api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = Some(api_key.into());
        self
    }

    /// Cloud base URL. Falls back to `WRIT_CLOUD_URL`, then
    /// `https://api.usewrit.app`. A trailing `/` is stripped.
    pub fn cloud_url(mut self, cloud_url: impl Into<String>) -> Self {
        self.cloud_url = Some(cloud_url.into());
        self
    }

    /// Override the keyless device/client id (else read/mint `~/.writ/client_id`).
    pub fn client_id(mut self, client_id: impl Into<String>) -> Self {
        self.client_id = Some(client_id.into());
        self
    }

    /// Per-request timeout (default 30 s).
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Build the client, resolving each field from its explicit value, then the
    /// matching env var, then the documented default. No network I/O.
    pub fn build(self) -> Result<CloudClient> {
        let api_key = self.api_key.or_else(|| env_var("WRIT_API_KEY"));
        let base = self
            .cloud_url
            .or_else(|| env_var("WRIT_CLOUD_URL"))
            .unwrap_or_else(|| DEFAULT_CLOUD_URL.to_string())
            .trim_end_matches('/')
            .to_string();
        let client_id_override = self.client_id.or_else(|| env_var("WRIT_CLIENT_ID"));

        let http = reqwest::Client::builder()
            .timeout(self.timeout.unwrap_or(DEFAULT_TIMEOUT))
            .user_agent(USER_AGENT)
            .build()
            .map_err(|e| WritError::Connection(format!("building cloud http client: {e}")))?;

        Ok(CloudClient {
            inner: Arc::new(CloudInner {
                api_key,
                base,
                client_id_override,
                client_id_cache: OnceLock::new(),
                http,
            }),
        })
    }
}

/// The async client for the tiered **Writ Cloud** surface (see the module docs).
///
/// Construct with [`CloudClient::builder`] (explicit config) or
/// [`CloudClient::from_env`] (pure env resolution). The credential decides the
/// tier: an API key ⇒ metered, none ⇒ keyless.
#[derive(Debug, Clone)]
pub struct CloudClient {
    inner: Arc<CloudInner>,
}

#[derive(Debug)]
struct CloudInner {
    api_key: Option<String>,
    base: String,
    client_id_override: Option<String>,
    client_id_cache: OnceLock<String>,
    http: reqwest::Client,
}

impl CloudClient {
    /// Start explicit configuration.
    pub fn builder() -> CloudClientBuilder {
        CloudClientBuilder::default()
    }

    /// Build a client purely from the environment (`WRIT_API_KEY`,
    /// `WRIT_CLOUD_URL`, `WRIT_CLIENT_ID`) and the defaults.
    pub fn from_env() -> Result<CloudClient> {
        CloudClientBuilder::default().build()
    }

    /// The resolved cloud base URL (no trailing slash).
    pub fn base_url(&self) -> &str {
        &self.inner.base
    }

    /// The tier this client will use: [`CloudTier::Metered`] when an API key is
    /// present, else [`CloudTier::Keyless`].
    pub fn tier(&self) -> CloudTier {
        if self.inner.api_key.is_some() {
            CloudTier::Metered
        } else {
            CloudTier::Keyless
        }
    }

    /// Scrape ONE page to clean markdown. Works on both tiers.
    ///
    /// `POST /api/crawl/scrape` (metered) or `/v1/keyless/scrape` (keyless), body
    /// `{"url": url}`.
    pub async fn scrape(&self, url: &str) -> Result<ScrapeResult> {
        let path = if self.inner.api_key.is_some() {
            "/api/crawl/scrape"
        } else {
            "/v1/keyless/scrape"
        };
        let raw = self
            .send(Method::POST, path, Some(&serde_json::json!({ "url": url })))
            .await?;
        Ok(normalize_scrape(&raw, self.tier()))
    }

    /// Map a site's URLs, ranked by an optional `search`. Works on both tiers.
    ///
    /// `POST /api/crawl/map` (metered) or `/v1/keyless/map` (keyless), body
    /// `{"url": url, "search": search, "limit"?: limit}`.
    pub async fn map(&self, url: &str, opts: &MapOptions) -> Result<MapResult> {
        let path = if self.inner.api_key.is_some() {
            "/api/crawl/map"
        } else {
            "/v1/keyless/map"
        };
        let mut body = Map::new();
        body.insert("url".into(), Value::String(url.to_string()));
        body.insert(
            "search".into(),
            Value::String(opts.search.clone().unwrap_or_default()),
        );
        if let Some(limit) = opts.limit {
            body.insert("limit".into(), Value::from(limit));
        }
        let raw = self
            .send(Method::POST, path, Some(&Value::Object(body)))
            .await?;
        Ok(normalize_map(&raw, self.tier()))
    }

    /// Start a whole-site crawl. **METERED ONLY** — requires an API key; on the
    /// keyless tier this returns [`WritError::ApiKeyRequired`] before any network
    /// call (use [`CloudClient::scrape`]/[`CloudClient::map`] instead).
    ///
    /// `POST /api/crawl` with the [`CrawlStartParams`] body.
    pub async fn crawl(&self, params: &CrawlStartParams) -> Result<CrawlJob> {
        if self.inner.api_key.is_none() {
            return Err(api_key_required(
                "Whole-site crawl needs an API key — set api_key or WRIT_API_KEY. \
                 Keyless access covers scrape and map only.",
            ));
        }
        let body = serde_json::to_value(params)
            .map_err(|e| WritError::Connection(format!("serializing crawl params: {e}")))?;
        let raw = self.send(Method::POST, "/api/crawl", Some(&body)).await?;
        decode_crawl_job(raw)
    }

    /// Poll a metered crawl's status (requires an API key).
    ///
    /// `GET /api/crawl/{id}`.
    pub async fn crawl_status(&self, id: i64) -> Result<CrawlJob> {
        if self.inner.api_key.is_none() {
            return Err(api_key_required(
                "Crawl status needs an API key — set api_key or WRIT_API_KEY.",
            ));
        }
        let raw = self
            .send(Method::GET, &format!("/api/crawl/{id}"), None)
            .await?;
        decode_crawl_job(raw)
    }

    /// Remaining keyless allowance for this install (keyless tier only; `None`
    /// when metered).
    ///
    /// `GET /v1/keyless/quota`.
    pub async fn quota(&self) -> Result<Option<KeylessQuota>> {
        if self.inner.api_key.is_some() {
            return Ok(None);
        }
        let raw = self.send(Method::GET, "/v1/keyless/quota", None).await?;
        Ok(Some(normalize_quota(&raw)))
    }

    // --- transport ----------------------------------------------------------

    async fn send(&self, method: Method, path: &str, json: Option<&Value>) -> Result<Value> {
        let mut req = self
            .inner
            .http
            .request(method, format!("{}{}", self.inner.base, path));
        if let Some(key) = &self.inner.api_key {
            req = req.header(AUTHORIZATION, format!("Bearer {key}"));
        } else {
            req = req.header(CLIENT_ID_HEADER, self.client_id());
        }
        if let Some(body) = json {
            req = req.header(CONTENT_TYPE, "application/json").json(body);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| WritError::Connection(format!("cloud request to {path} failed: {e}")))?;
        let status = resp.status().as_u16();
        let text = resp
            .text()
            .await
            .map_err(|e| WritError::Connection(format!("reading cloud response body: {e}")))?;

        if !(200..300).contains(&status) {
            return Err(cloud_error_from(status, &text));
        }
        if text.trim().is_empty() {
            return Ok(Value::Object(Map::new()));
        }
        serde_json::from_str(&text)
            .map_err(|e| WritError::Connection(format!("decoding cloud response body: {e}")))
    }

    /// The keyless client id: the explicit override, else the lazily
    /// loaded/minted `~/.writ/client_id`.
    fn client_id(&self) -> String {
        if let Some(id) = &self.inner.client_id_override {
            return id.clone();
        }
        self.inner
            .client_id_cache
            .get_or_init(load_or_mint_client_id)
            .clone()
    }
}

// --- error mapping ----------------------------------------------------------

/// Build the client-side [`WritError::ApiKeyRequired`] (no network call).
fn api_key_required(message: &str) -> WritError {
    WritError::ApiKeyRequired {
        status: 402,
        code: "api_key_required".to_string(),
        message: message.to_string(),
        body: Value::Null,
    }
}

/// Map a non-2xx Writ Cloud response body — `{"detail": {message, code,
/// reset_at, requests_remaining, pages_remaining}}` (some errors are flat
/// `{"code", "message"}`) — to a typed [`WritError`].
fn cloud_error_from(status: u16, raw: &str) -> WritError {
    let body: Value =
        serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()));
    // `detail` may be a nested object, a bare string, or absent (flat body).
    let detail = body.get("detail").cloned().unwrap_or_else(|| body.clone());
    let d = detail.as_object();

    let field_str = |key: &str| d.and_then(|m| m.get(key)).and_then(Value::as_str);
    let field_i64 = |key: &str| d.and_then(|m| m.get(key)).and_then(Value::as_i64);

    let code = field_str("code")
        .map(str::to_string)
        .unwrap_or_else(|| code_for_status(status));
    let message = field_str("message")
        .map(str::to_string)
        .or_else(|| detail.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("HTTP {status}"));

    match (status, code.as_str()) {
        (429, _) => WritError::RateLimited {
            status,
            code,
            message,
            reset_at: field_str("reset_at").map(str::to_string),
            requests_remaining: field_i64("requests_remaining"),
            pages_remaining: field_i64("pages_remaining"),
            body,
        },
        (402, "api_key_required") => WritError::ApiKeyRequired {
            status,
            code,
            message,
            body,
        },
        (402, _) => WritError::InsufficientCredits {
            status,
            code,
            message,
            body,
        },
        _ => WritError::Api {
            status,
            code,
            message,
            body,
        },
    }
}

// --- normalization ----------------------------------------------------------

fn decode_crawl_job(raw: Value) -> Result<CrawlJob> {
    serde_json::from_value(raw)
        .map_err(|e| WritError::Connection(format!("decoding cloud crawl job: {e}")))
}

fn str_field(raw: &Value, key: &str) -> String {
    raw.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn opt_str_field(raw: &Value, key: &str) -> Option<String> {
    raw.get(key).and_then(Value::as_str).map(str::to_string)
}

fn i64_field(raw: &Value, key: &str) -> i64 {
    raw.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn normalize_quota(raw: &Value) -> KeylessQuota {
    // The quota may sit under a `quota` envelope or be the object itself.
    let q = raw.get("quota").unwrap_or(raw);
    KeylessQuota {
        tier: CloudTier::Keyless,
        requests_remaining: i64_field(q, "requests_remaining"),
        pages_remaining: i64_field(q, "pages_remaining"),
        requests_per_day: i64_field(q, "requests_per_day"),
        pages_per_day: i64_field(q, "pages_per_day"),
        reset_at: str_field(q, "reset_at"),
        upgrade_url: opt_str_field(q, "upgrade_url"),
    }
}

fn normalize_scrape(raw: &Value, tier: CloudTier) -> ScrapeResult {
    let format = {
        let f = str_field(raw, "format");
        if f.is_empty() {
            "markdown".to_string()
        } else {
            f
        }
    };
    ScrapeResult {
        url: str_field(raw, "url"),
        title: opt_str_field(raw, "title"),
        format,
        markdown: str_field(raw, "markdown"),
        counts: raw
            .get("counts")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        tier,
        quota: raw.get("quota").map(|_| normalize_quota(raw)),
    }
}

fn normalize_map(raw: &Value, tier: CloudTier) -> MapResult {
    let urls = raw
        .get("urls")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|entry| MapEntry {
                    url: str_field(entry, "url"),
                    score: entry.get("score").and_then(Value::as_f64).unwrap_or(0.0),
                    title: opt_str_field(entry, "title"),
                })
                .collect()
        })
        .unwrap_or_default();
    let counts = raw
        .get("counts")
        .map(|c| MapCounts {
            returned: i64_field(c, "returned"),
            total: i64_field(c, "total"),
        })
        .unwrap_or_default();
    MapResult {
        url: str_field(raw, "url"),
        host: opt_str_field(raw, "host"),
        urls,
        counts,
        tier,
        quota: raw.get("quota").map(|_| normalize_quota(raw)),
    }
}

// --- client id --------------------------------------------------------------

/// `~/.writ` (via `$HOME` / `%USERPROFILE%`), the keyless client-id home.
fn writ_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".writ"))
}

/// Read (or mint + best-effort persist) the stable keyless device id at
/// `~/.writ/client_id`. Any filesystem error falls back to an ephemeral id.
fn load_or_mint_client_id() -> String {
    let id = base64_url_nopad(&random_bytes_16());
    let Some(dir) = writ_home_dir() else {
        return id;
    };
    let file = dir.join("client_id");
    if let Ok(existing) = std::fs::read_to_string(&file) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    // Best-effort persist; a read-only fs just keeps the ephemeral id.
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&file, &id);
    id
}

/// 16 bytes (128 bits) of entropy without pulling in a `rand`/`getrandom`
/// dependency: two independently OS-seeded `RandomState` hashers, mixed with the
/// pid / nanos / a process-global counter.
fn random_bytes_16() -> [u8; 16] {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hash, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seed = (
        std::process::id() as u64,
        nanos,
        COUNTER.fetch_add(1, Ordering::Relaxed),
    );

    let mut out = [0u8; 16];
    for (i, half) in out.chunks_mut(8).enumerate() {
        // A fresh RandomState is seeded from OS randomness, so each finish()
        // carries ~64 bits of entropy from the hasher keys alone.
        let mut hasher = RandomState::new().build_hasher();
        seed.hash(&mut hasher);
        (i as u64).hash(&mut hasher);
        half.copy_from_slice(&hasher.finish().to_le_bytes());
    }
    out
}

/// URL-safe base64, no padding (matches every other Writ SDK's client id).
fn base64_url_nopad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 63) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_from_credential() {
        let metered = CloudClient::builder().api_key("wt_x").build().unwrap();
        assert_eq!(metered.tier(), CloudTier::Metered);
        assert_eq!(metered.tier().as_str(), "metered");

        let keyless = CloudClient::builder().build().unwrap();
        // `build()` still consults WRIT_API_KEY; assert only when it is unset so
        // this stays deterministic in CI where the env is clean.
        if std::env::var_os("WRIT_API_KEY").is_none() {
            assert_eq!(keyless.tier(), CloudTier::Keyless);
            assert_eq!(keyless.tier().as_str(), "keyless");
        }
    }

    #[test]
    fn cloud_url_default_and_trim() {
        if std::env::var_os("WRIT_CLOUD_URL").is_none() {
            let c = CloudClient::builder().build().unwrap();
            assert_eq!(c.base_url(), "https://api.usewrit.app");
        }
        let c = CloudClient::builder()
            .cloud_url("https://example.test/")
            .build()
            .unwrap();
        assert_eq!(c.base_url(), "https://example.test");
    }

    #[test]
    fn base64_url_nopad_matches_reference() {
        // Classic RFC 4648 URL-safe, no-pad vectors.
        assert_eq!(base64_url_nopad(b""), "");
        assert_eq!(base64_url_nopad(b"f"), "Zg");
        assert_eq!(base64_url_nopad(b"fo"), "Zm8");
        assert_eq!(base64_url_nopad(b"foo"), "Zm9v");
        assert_eq!(base64_url_nopad(b"foob"), "Zm9vYg");
        // 16 bytes → 22 chars, no padding.
        assert_eq!(base64_url_nopad(&[0u8; 16]).len(), 22);
    }

    #[test]
    fn random_ids_are_distinct_and_url_safe() {
        let a = base64_url_nopad(&random_bytes_16());
        let b = base64_url_nopad(&random_bytes_16());
        assert_ne!(a, b, "two mints must differ");
        assert_eq!(a.len(), 22);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn error_mapping_covers_each_tier_shape() {
        // 429 → RateLimited with detail fields.
        let err = cloud_error_from(
            429,
            r#"{"detail":{"code":"rate_limited","message":"slow down","reset_at":"2026-07-16T00:00:00Z","requests_remaining":0,"pages_remaining":3}}"#,
        );
        match err {
            WritError::RateLimited {
                reset_at,
                requests_remaining,
                pages_remaining,
                message,
                ..
            } => {
                assert_eq!(reset_at.as_deref(), Some("2026-07-16T00:00:00Z"));
                assert_eq!(requests_remaining, Some(0));
                assert_eq!(pages_remaining, Some(3));
                assert_eq!(message, "slow down");
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }

        // 402 api_key_required → ApiKeyRequired.
        let err = cloud_error_from(402, r#"{"detail":{"code":"api_key_required","message":"key please"}}"#);
        assert!(matches!(err, WritError::ApiKeyRequired { .. }), "got {err:?}");

        // 402 otherwise → InsufficientCredits.
        let err = cloud_error_from(402, r#"{"detail":{"code":"insufficient_credits","message":"broke"}}"#);
        assert!(matches!(err, WritError::InsufficientCredits { .. }), "got {err:?}");

        // Flat body + non-tier status → generic Api.
        let err = cloud_error_from(400, r#"{"code":"bad_request","message":"nope"}"#);
        match err {
            WritError::Api { code, message, .. } => {
                assert_eq!(code, "bad_request");
                assert_eq!(message, "nope");
            }
            other => panic!("expected Api, got {other:?}"),
        }
    }
}
