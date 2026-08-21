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
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use futures_core::Stream;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::Method;
use serde_json::{Map, Value};

use crate::client::USER_AGENT;
use crate::discovery::env_var;
use crate::error::{code_for_status, Result, WritError};
use crate::models::{CrawlFilesResult, CrawlJob, CrawlStartParams, SavedCrawlFilesResult};
use crate::retry::{
    is_safe_method, new_idempotency_key, retry_after, should_retry_status, RetryPolicy,
};
use crate::watch::{watch_changes, WatchOptions};

/// Default Writ Cloud base URL.
const DEFAULT_CLOUD_URL: &str = "https://api.usewrit.app";

/// Keyless device-identity header.
const CLIENT_ID_HEADER: &str = "X-Writ-Client-Id";

/// Server-minted, HMAC-signed keyless subject. The server issues one on any
/// keyless response where we did not present a valid token; persisting it and
/// sending it back is what earns this install its OWN daily bucket. Without it a
/// caller is metered on its IP prefix, shared with every install behind the same
/// NAT. The client cannot forge or edit this value — it is signed server-side
/// (`backend/services/keyless_identity.py`).
const DEVICE_TOKEN_HEADER: &str = "X-Writ-Device-Token";

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

/// Options for [`CloudApi::scrape_with`].
#[derive(Debug, Clone, Default)]
pub struct ScrapeOptions {
    /// Scrape a page behind a login (metered tier only; forces the identity's own
    /// residential exit).
    pub persona_id: Option<i64>,
    /// Fetch through the platform residential network for a page that blocks
    /// datacenter IPs. Money-safe: degrades to direct when unfunded.
    pub use_residential: bool,
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
    retry: Option<RetryPolicy>,
    http_client: Option<reqwest::Client>,
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

    /// Override the transient-failure retry policy. [`RetryPolicy::off`]
    /// disables retrying entirely.
    ///
    /// Unsafe methods ARE retried on this surface (unlike the daemon client):
    /// every POST/PATCH/DELETE carries an `Idempotency-Key`, and the cloud
    /// replays its recorded response rather than executing a second time.
    pub fn retry(mut self, policy: RetryPolicy) -> Self {
        self.retry = Some(policy);
        self
    }

    /// Supply your own [`reqwest::Client`] — the extension point for a proxy, a
    /// pool limit, custom TLS, tracing middleware, or a mock transport in tests.
    /// When set, `timeout` is the supplied client's business.
    pub fn http_client(mut self, client: reqwest::Client) -> Self {
        self.http_client = Some(client);
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

        let http = match self.http_client {
            Some(client) => client,
            None => reqwest::Client::builder()
                .timeout(self.timeout.unwrap_or(DEFAULT_TIMEOUT))
                .user_agent(USER_AGENT)
                .build()
                .map_err(|e| WritError::Connection(format!("building cloud http client: {e}")))?,
        };

        Ok(CloudClient {
            inner: Arc::new(CloudInner {
                api_key,
                base,
                client_id_override,
                client_id_cache: OnceLock::new(),
                device_token: RwLock::new(None),
                device_token_loaded: OnceLock::new(),
                http,
                // Unsafe methods are retried here — see the builder's `retry` docs.
                retry: self.retry.unwrap_or_default().with_unsafe(true),
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
    /// Current server-minted subject. Interior mutability because the server can
    /// hand us a new one on ANY response, long after the client was built.
    device_token: RwLock<Option<String>>,
    /// Guards the one-shot lazy read of `~/.writ/device_token`, so a metered
    /// client never touches the filesystem (same posture as `client_id_cache`).
    device_token_loaded: OnceLock<()>,
    http: reqwest::Client,
    /// Transient-failure policy. Unsafe methods ARE eligible: every one of them
    /// carries an `Idempotency-Key` the cloud replays instead of re-executing.
    retry: RetryPolicy,
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
    /// `{"url": url}`. Use [`CloudApi::scrape_with`] to scrape behind a login or
    /// through the residential network.
    pub async fn scrape(&self, url: &str) -> Result<ScrapeResult> {
        self.scrape_with(url, &ScrapeOptions::default()).await
    }

    /// Scrape ONE page with options. `persona_id` scrapes a page behind a login
    /// (metered tier only; forces the identity's own residential exit).
    /// `use_residential` fetches through the platform residential network for a page
    /// that blocks datacenter IPs — money-safe (degrades to direct when unfunded).
    /// Both are ignored on the keyless tier, which is always direct.
    pub async fn scrape_with(&self, url: &str, opts: &ScrapeOptions) -> Result<ScrapeResult> {
        let path = if self.inner.api_key.is_some() {
            "/api/crawl/scrape"
        } else {
            "/v1/keyless/scrape"
        };
        let mut body = serde_json::Map::new();
        body.insert("url".into(), Value::from(url));
        if let Some(pid) = opts.persona_id {
            body.insert("persona_id".into(), Value::from(pid));
        }
        if opts.use_residential {
            body.insert("use_residential".into(), Value::from(true));
        }
        let raw = self
            .send(Method::POST, path, Some(&Value::Object(body)))
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
                 Without one, scrape, map and the bounded crawl_keyless() still work.",
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

    /// The ORIGINAL documents a crawl captured as stored files — PDFs, office
    /// documents, images, CSVs the crawler reached (requires an API key).
    ///
    /// The crawl's dataset holds the extracted text; each entry here carries the
    /// file metadata plus a short-TTL `download_url` fetchable with no further
    /// auth. `limit` left as `None` lets the server apply its own cap.
    ///
    /// `GET /api/crawl/{id}/files`.
    pub async fn crawl_files(&self, id: i64, limit: Option<i64>) -> Result<CrawlFilesResult> {
        if self.inner.api_key.is_none() {
            return Err(api_key_required(
                "Crawl files needs an API key — set api_key or WRIT_API_KEY.",
            ));
        }
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(limit) = limit {
            query.push(("limit", limit.to_string()));
        }
        let raw = self
            .send_query(Method::GET, &format!("/api/crawl/{id}/files"), None, &query)
            .await?;
        serde_json::from_value(raw)
            .map_err(|e| WritError::Connection(format!("decoding crawl files: {e}")))
    }

    /// Documents captured by a SAVED crawl's recent completed run(s), addressed
    /// by id or slug (requires an API key).
    ///
    /// By default that is the latest run — the current version of every
    /// document; raise `runs` to also reach older versions from earlier runs.
    ///
    /// `GET /api/crawl/definitions/{reference}/files`.
    pub async fn saved_crawl_files(
        &self,
        reference: &str,
        limit: Option<i64>,
        runs: Option<i64>,
    ) -> Result<SavedCrawlFilesResult> {
        if self.inner.api_key.is_none() {
            return Err(api_key_required(
                "Crawl files needs an API key — set api_key or WRIT_API_KEY.",
            ));
        }
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(limit) = limit {
            query.push(("limit", limit.to_string()));
        }
        if let Some(runs) = runs {
            query.push(("runs", runs.to_string()));
        }
        let path = format!(
            "/api/crawl/definitions/{}/files",
            encode_path_segment(reference)
        );
        let raw = self.send_query(Method::GET, &path, None, &query).await?;
        serde_json::from_value(raw)
            .map_err(|e| WritError::Connection(format!("decoding saved crawl files: {e}")))
    }

    /// Cloud monitors — the same verbs as [`WritAgent::monitors`] on the local
    /// daemon, against `/api/targets/*` on Writ Cloud.
    ///
    /// [`WritAgent::monitors`]: crate::WritAgent::monitors
    pub fn monitors(&self) -> CloudMonitors<'_> {
        CloudMonitors { c: self }
    }

    /// Cloud automations — the same verbs as [`WritAgent::automations`] on the
    /// local daemon, against `/api/triggers/*` on Writ Cloud.
    ///
    /// [`WritAgent::automations`]: crate::WritAgent::automations
    pub fn automations(&self) -> CloudAutomations<'_> {
        CloudAutomations { c: self }
    }

    /// Cloud personas — the same verbs as [`WritAgent::personas`] on the local
    /// daemon, against `/api/personas/*` on Writ Cloud.
    ///
    /// [`WritAgent::personas`]: crate::WritAgent::personas
    pub fn personas(&self) -> CloudPersonas<'_> {
        CloudPersonas { c: self }
    }

    /// Website → API builds — the REST twin of the MCP tool `writ_website_to_api`.
    pub fn builds(&self) -> CloudBuilds<'_> {
        CloudBuilds { c: self }
    }

    /// A bounded crawl with NO account — the free tier's version.
    ///
    /// Separate from [`CloudClient::crawl`] because the two return genuinely
    /// different things: `crawl` queues a fleet job you poll, this fetches a few
    /// same-domain pages in process and returns their markdown inline. Capped per
    /// request (see [`KeylessCrawlLimits::page_cap`]), one level deep, and every
    /// page spends the same daily allowance as [`CloudClient::scrape`] — so the
    /// daily cap, not the per-request cap, is the real ceiling.
    ///
    /// `POST /v1/keyless/crawl`.
    pub async fn crawl_keyless(
        &self,
        url: &str,
        opts: &KeylessCrawlOptions,
    ) -> Result<KeylessCrawlResult> {
        let mut body = Map::new();
        body.insert("url".into(), Value::String(url.to_string()));
        if let Some(search) = &opts.search {
            body.insert("search".into(), Value::String(search.clone()));
        }
        if let Some(limit) = opts.limit {
            body.insert("limit".into(), Value::from(limit));
        }
        let raw = self
            .send(
                Method::POST,
                "/v1/keyless/crawl",
                Some(&Value::Object(body)),
            )
            .await?;
        decode(raw, "keyless crawl")
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
        self.send_query(method, path, json, &[]).await
    }

    /// [`CloudClient::send`] with a query string. An empty slice appends nothing:
    /// `?limit=` is not the same as omitting `limit`, and the API rejects the
    /// empty string for a typed int.
    async fn send_query(
        &self,
        method: Method,
        path: &str,
        json: Option<&Value>,
        query: &[(&str, String)],
    ) -> Result<Value> {
        let mut req = self
            .inner
            .http
            .request(method.clone(), format!("{}{}", self.inner.base, path));
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(key) = &self.inner.api_key {
            req = req.header(AUTHORIZATION, format!("Bearer {key}"));
        } else {
            req = req.header(CLIENT_ID_HEADER, self.client_id());
            if let Some(token) = self.device_token() {
                req = req.header(DEVICE_TOKEN_HEADER, token);
            }
        }
        if let Some(body) = json {
            req = req.header(CONTENT_TYPE, "application/json").json(body);
        }

        // One key per logical call, reused by every retry of it — that is what
        // makes repeating an unsafe method safe rather than duplicative. Unsafe
        // retries are enabled on this surface ONLY because of it.
        let mut policy = self.inner.retry;
        if !is_safe_method(&method) {
            req = req.header("Idempotency-Key", new_idempotency_key());
        }
        if req.try_clone().is_none() {
            // An unclonable (streaming) body cannot be replayed; attempting it
            // twice would send a truncated request rather than a repeat.
            policy.max_attempts = 1;
        }

        let resp = self.send_retrying(req, policy, &method, path).await?;
        let status = resp.status().as_u16();
        // Absorb BEFORE the status check (and before `text()` consumes `resp`):
        // a 429 carries a minted token too, and dropping it would leave a
        // rate-limited caller anonymous forever.
        self.absorb_device_token(resp.headers());
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

    /// Send under the retry policy, re-issuing the request on a transient
    /// failure. Each attempt gets a fresh clone so the body is replayed intact.
    async fn send_retrying(
        &self,
        req: reqwest::RequestBuilder,
        policy: RetryPolicy,
        method: &Method,
        path: &str,
    ) -> Result<reqwest::Response> {
        let attempts = policy.attempts_for(method);
        let mut pending = Some(req);
        let mut attempt = 1u32;

        loop {
            let current = pending.take().ok_or_else(|| {
                WritError::Connection(format!("retry lost the cloud request to {path}"))
            })?;
            let next = if attempt < attempts {
                current.try_clone()
            } else {
                None
            };

            match current.send().await {
                Ok(resp) => {
                    if !should_retry_status(resp.status()) {
                        return Ok(resp);
                    }
                    let Some(next_req) = next else {
                        return Ok(resp);
                    };
                    let mut wait = policy.backoff(attempt);
                    if let Some(requested) = retry_after(&resp) {
                        if requested > policy.max_retry_after {
                            // The server says this will not clear any time soon.
                            // Hand back the real answer, which carries the reset.
                            return Ok(resp);
                        }
                        wait = requested;
                    }
                    tokio::time::sleep(wait).await;
                    pending = Some(next_req);
                }
                Err(e) => {
                    let Some(next_req) = next else {
                        return Err(WritError::Connection(format!(
                            "cloud request to {path} failed: {e}"
                        )));
                    };
                    tokio::time::sleep(policy.backoff(attempt)).await;
                    pending = Some(next_req);
                }
            }
            attempt += 1;
        }
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

    /// The server-minted keyless subject, if one has been issued to us. Lazily
    /// reads `~/.writ/device_token` exactly once.
    fn device_token(&self) -> Option<String> {
        self.inner.device_token_loaded.get_or_init(|| {
            if let Some(token) = load_device_token() {
                if let Ok(mut guard) = self.inner.device_token.write() {
                    *guard = Some(token);
                }
            }
        });
        self.inner.device_token.read().ok()?.clone()
    }

    /// Pick up a token the server minted for us and persist it. The server only
    /// issues one when we did not present a valid token, so this is a no-op on
    /// the steady-state path.
    fn absorb_device_token(&self, headers: &reqwest::header::HeaderMap) {
        if self.inner.api_key.is_some() {
            return;
        }
        let Some(issued) = headers
            .get(DEVICE_TOKEN_HEADER)
            .and_then(|v| v.to_str().ok())
        else {
            return;
        };
        if issued.is_empty() {
            return;
        }
        // Mark the lazy load done: the issued token supersedes anything on disk.
        let _ = self.inner.device_token_loaded.set(());
        if let Ok(mut guard) = self.inner.device_token.write() {
            if guard.as_deref() != Some(issued) {
                *guard = Some(issued.to_string());
                store_device_token(issued);
            }
        }
    }
}

// --- cloud monitors ---------------------------------------------------------

/// Path prefix for cloud monitors. On the wire the cloud calls this resource
/// `targets`; the product, the daemon and every SDK call it a MONITOR. The
/// rename happens here, once.
const MONITORS_PATH: &str = "/api/targets";

/// A monitor as the **cloud** serialises it — camelCase, because `/api/targets`
/// answers with its own aliases. The daemon's [`Monitor`] is the same concept in
/// snake_case; they are deliberately separate types so neither service's wire
/// format is silently claimed for the other.
///
/// [`Monitor`]: crate::Monitor
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudMonitor {
    pub id: i64,
    pub url: String,
    /// `content` | `uptime`.
    pub check_type: String,
    pub selector: Option<String>,
    pub ignore_regex: Option<String>,
    pub check_period_ms: Option<i64>,
    pub schedule_kind: Option<String>,
    pub schedule_time: Option<String>,
    pub schedule_days: Option<Vec<i64>>,
    pub schedule_tz: Option<String>,
    pub enabled: bool,
    pub expected_status_code: Option<i64>,
    pub timeout_ms: Option<i64>,
    pub max_response_time_ms: Option<i64>,
    pub check_ssl: Option<bool>,
    pub requires_playwright: bool,
    pub preferred_region: Option<String>,
    pub use_residential: Option<bool>,
    pub residential_country: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub changes_count: i64,
    /// Live health from the monitoring state: `up`/`down`/`ok`/`stale`/`never`.
    pub state: Option<String>,
    pub status_code: Option<i64>,
    pub last_change_at: Option<String>,
}

/// One detected change in ONE monitor's history, as `GET /api/targets/{id}/changes`
/// serialises it: camelCase, with STRING ids.
///
/// Deliberately NOT the type the GLOBAL feed returns — see [`RecentChange`]. The
/// two routes answer genuinely different shapes (different casing, different id
/// types, different fields), and this SDK used to model both with this one
/// struct: the global feed's numeric `id` cannot deserialize into a `String` at
/// all, so `recent_changes` failed against every real response.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudMonitorChange {
    pub id: String,
    pub target_id: String,
    /// When this change was FIRST seen — the same value as `first_detected_at`.
    pub timestamp: String,
    /// The two real timestamps behind `timestamp`. The feed is ORDERED by
    /// `last_detected_at`, so that — not `timestamp` — is what a client sorts or
    /// advances a cursor on. Sorting on `timestamp` silently disagrees with the
    /// server's own order.
    pub first_detected_at: String,
    pub last_detected_at: String,
    pub old_content: String,
    pub new_content: String,
    pub diff: String,
    pub detected_by: String,
    pub selector_id: Option<i64>,
    pub selector_name: Option<String>,
    /// Same-origin proxy path, present only when that snapshot has stored bytes.
    pub screenshot_before: Option<String>,
    pub screenshot_after: Option<String>,
    pub screenshot_diff: Option<String>,
}

/// One row of the GLOBAL recent-changes feed — the cloud's
/// `GET /api/targets/changes/recent` and the daemon's `GET /v1/changes/recent`,
/// which serialise the identical shape. snake_case with INTEGER ids.
///
/// Carries a feed row's worth of data: the monitor URL, which selector fired, a
/// server-truncated diff snippet, and the two timestamps. Full before/after
/// content lives on the per-monitor route ([`CloudMonitorChange`]).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct RecentChange {
    pub id: i64,
    pub target_id: i64,
    pub target_url: String,
    /// Which selector fired — `None` for a whole-page monitor.
    pub target_selector_id: Option<i64>,
    pub selector_name: Option<String>,
    /// Truncated server-side to a feed-friendly length.
    pub diff_snippet: Option<String>,
    /// `first_detected_at` is when this content first differed.
    /// `last_detected_at` moves forward every time the SAME difference is seen
    /// again, which is why it — not `first_detected_at` — is the feed's sort key
    /// and the value a cursor advances to. A row already processed legitimately
    /// reappears with a later `last_detected_at`: a fresh detection, not a
    /// duplicate.
    pub first_detected_at: String,
    pub last_detected_at: String,
}

/// Filters for either change feed.
///
/// Leaving `since` unset gives the newest-first browsing view. Setting it
/// switches the server to an oldest-first keyset walk returning only what was
/// detected AFTER that point — which is what a poller wants: newest-first plus a
/// limit silently drops changes whenever more than `limit` of them land between
/// two polls.
#[derive(Debug, Clone, Default)]
pub struct ChangeListOptions {
    /// Page size. `None` uses the API default.
    pub limit: Option<i64>,
    /// ISO-8601 cursor — the `last_detected_at` of the last row processed.
    pub since: Option<String>,
    /// That row's id, breaking ties between changes sharing one timestamp.
    /// Without it two rows in the same millisecond can straddle the page
    /// boundary and the trailing one is never returned again.
    pub since_id: Option<i64>,
}

impl ChangeListOptions {
    /// Just a page size — the common case.
    pub fn limit(n: i64) -> Self {
        Self {
            limit: Some(n),
            ..Self::default()
        }
    }

    pub(crate) fn query(&self) -> Vec<(&'static str, String)> {
        let mut q = Vec::new();
        if let Some(n) = self.limit {
            q.push(("limit", n.to_string()));
        }
        if let Some(since) = &self.since {
            q.push(("since", since.clone()));
        }
        if let Some(id) = self.since_id {
            q.push(("since_id", id.to_string()));
        }
        q
    }
}

/// Outcome of an out-of-schedule check. `ok` is false with a `detail` when no
/// recorder is assigned to the monitor yet — the check still happens on its next
/// scheduled cycle.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct CloudMonitorRun {
    pub ok: bool,
    pub dispatched: i64,
    pub detail: Option<String>,
}

/// Filters for [`CloudMonitors::list`]. `limit` unset returns every monitor.
#[derive(Debug, Clone, Default)]
pub struct CloudMonitorListOptions {
    pub enabled_only: bool,
    /// `content` or `uptime`; `None` means both.
    pub check_type: Option<String>,
    /// 1-1000, newest first.
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// The cloud monitors surface, reached through [`CloudClient::monitors`].
///
/// Mirrors the local daemon's [`Monitors`] resource verb for verb, so the same
/// program runs against either venue by changing which object it talks to.
///
/// Every verb is metered-only: the keyless tier has no account to own a monitor,
/// so these return [`WritError::ApiKeyRequired`] **before any network call**
/// rather than sending a request that could only come back 401.
///
/// [`Monitors`]: crate::Monitors
pub struct CloudMonitors<'a> {
    c: &'a CloudClient,
}

impl CloudMonitors<'_> {
    /// `GET /api/targets` — every monitor on the account, newest first.
    pub async fn list(&self, opts: &CloudMonitorListOptions) -> Result<Vec<CloudMonitor>> {
        self.guard("Listing cloud monitors")?;
        let mut query: Vec<(&str, String)> = Vec::new();
        if opts.enabled_only {
            query.push(("enabled_only", "true".to_string()));
        }
        if let Some(kind) = &opts.check_type {
            query.push(("check_type", kind.clone()));
        }
        if let Some(limit) = opts.limit {
            query.push(("limit", limit.to_string()));
        }
        if let Some(offset) = opts.offset {
            query.push(("offset", offset.to_string()));
        }
        let raw = self
            .c
            .send_query(Method::GET, MONITORS_PATH, None, &query)
            .await?;
        decode(raw, "monitor list")
    }

    /// `POST /api/targets` — requires a non-empty `url`.
    ///
    /// A `check_period_ms` below the plan's minimum check interval is REJECTED
    /// with a 402 `interval_too_short` naming the floor — it is never silently
    /// clamped, so a monitor never runs slower than you asked without saying so.
    pub async fn create(&self, body: Value) -> Result<CloudMonitor> {
        self.guard("Creating a cloud monitor")?;
        let raw = self
            .c
            .send(Method::POST, MONITORS_PATH, Some(&body))
            .await?;
        decode(raw, "monitor")
    }

    /// `GET /api/targets/{id}` — one monitor, enriched with live check state.
    pub async fn get(&self, id: i64) -> Result<CloudMonitor> {
        self.guard("Reading a cloud monitor")?;
        let raw = self
            .c
            .send(Method::GET, &format!("{MONITORS_PATH}/{id}"), None)
            .await?;
        decode(raw, "monitor")
    }

    /// `PATCH /api/targets/{id}` — partial update; send only what changes.
    pub async fn update(&self, id: i64, patch: Value) -> Result<CloudMonitor> {
        self.guard("Updating a cloud monitor")?;
        let raw = self
            .c
            .send(
                Method::PATCH,
                &format!("{MONITORS_PATH}/{id}"),
                Some(&patch),
            )
            .await?;
        decode(raw, "monitor")
    }

    /// `DELETE /api/targets/{id}` — removes the monitor with its selectors,
    /// triggers and notification history. Answers 204, so there is no body.
    pub async fn delete(&self, id: i64) -> Result<()> {
        self.guard("Deleting a cloud monitor")?;
        self.c
            .send(Method::DELETE, &format!("{MONITORS_PATH}/{id}"), None)
            .await?;
        Ok(())
    }

    /// `PATCH /api/targets/{id}/toggle?enabled=` — pause or resume without deleting.
    pub async fn toggle(&self, id: i64, enabled: bool) -> Result<CloudMonitor> {
        self.guard("Toggling a cloud monitor")?;
        let raw = self
            .c
            .send_query(
                Method::PATCH,
                &format!("{MONITORS_PATH}/{id}/toggle"),
                None,
                &[("enabled", enabled.to_string())],
            )
            .await?;
        decode(raw, "monitor")
    }

    /// `POST /api/targets/{id}/run` — check this monitor NOW, out of schedule.
    pub async fn run(&self, id: i64) -> Result<CloudMonitorRun> {
        self.guard("Running a cloud monitor")?;
        let raw = self
            .c
            .send(Method::POST, &format!("{MONITORS_PATH}/{id}/run"), None)
            .await?;
        decode(raw, "monitor run")
    }

    /// `GET /api/targets/{id}/changes` — this monitor's change history, newest
    /// first, or an oldest-first keyset walk when `opts.since` is set.
    pub async fn changes(
        &self,
        id: i64,
        opts: &ChangeListOptions,
    ) -> Result<Vec<CloudMonitorChange>> {
        self.guard("Reading cloud monitor changes")?;
        let path = format!("{MONITORS_PATH}/{id}/changes");
        let query = opts.query();
        let raw = self.c.send_query(Method::GET, &path, None, &query).await?;
        decode(raw, "monitor changes")
    }

    /// `GET /api/targets/changes/recent` — changes across ALL monitors on the
    /// account (`limit` 1-200), newest first, or an oldest-first keyset walk when
    /// `opts.since` is set.
    ///
    /// For a continuous feed prefer [`CloudMonitors::watch`], which drives this
    /// call with a correctly advanced cursor.
    pub async fn recent_changes(&self, opts: &ChangeListOptions) -> Result<Vec<RecentChange>> {
        self.guard("Reading recent cloud changes")?;
        let path = format!("{MONITORS_PATH}/changes/recent");
        let query = opts.query();
        let raw = self.c.send_query(Method::GET, &path, None, &query).await?;
        decode(raw, "recent changes")
    }

    /// Stream detected changes across ALL monitors, in detection order, without
    /// gaps or repeats.
    ///
    /// ```no_run
    /// # use futures_util::StreamExt;
    /// # async fn demo(cloud: writ_client::CloudClient) -> writ_client::Result<()> {
    /// let monitors = cloud.monitors();
    /// let feed = monitors.watch(Default::default());
    /// futures_util::pin_mut!(feed);
    /// while let Some(change) = feed.next().await {
    ///     let change = change?;
    ///     println!("{} {:?}", change.target_url, change.diff_snippet);
    /// }
    /// # Ok(()) }
    /// ```
    ///
    /// This exists because polling the feed correctly by hand is harder than it
    /// looks: the newest-first view drops changes when more than a page of them
    /// lands between polls, and a change row is UPDATED (not re-inserted) when
    /// the same difference recurs, so an id already processed can resurface.
    /// `watch` drives the server's keyset cursor instead, which makes
    /// "everything after this point" exact — and a resurfaced id arrives as what
    /// it actually is, a fresh detection.
    ///
    /// To resume across restarts, persist the last delivered change's
    /// `last_detected_at` + `id` and pass them as [`WatchOptions::since`] /
    /// [`WatchOptions::since_id`].
    pub fn watch(&self, opts: WatchOptions) -> impl Stream<Item = Result<RecentChange>> + '_ {
        watch_changes(opts, move |o| {
            let opts = o;
            async move { self.recent_changes(&opts).await }
        })
    }

    fn guard(&self, what: &str) -> Result<()> {
        if self.c.tier() == CloudTier::Metered {
            return Ok(());
        }
        Err(api_key_required(&format!(
            "{what} needs an API key — set api_key or WRIT_API_KEY. \
             Keyless access covers scrape and map only."
        )))
    }
}

/// Decode a cloud body into `T`, naming what failed rather than surfacing a bare
/// serde message with no context.
fn decode<T: serde::de::DeserializeOwned>(raw: Value, what: &str) -> Result<T> {
    serde_json::from_value(raw)
        .map_err(|e| WritError::Connection(format!("decoding cloud {what}: {e}")))
}

/// One page from a bounded keyless crawl.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct KeylessCrawlPage {
    pub url: String,
    pub title: Option<String>,
    pub markdown: String,
}

/// The ceilings that applied to a keyless crawl, stated so a caller need not
/// discover them by hitting them.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct KeylessCrawlLimits {
    pub page_cap: i64,
    pub max_depth: i64,
    pub same_domain: bool,
    pub note: String,
}

/// A bounded, no-account crawl: a few same-domain pages fetched in process and
/// returned inline.
///
/// Deliberately NOT a [`CrawlJob`] — that one is a fleet job you poll, and one
/// type must never pretend to be both shapes.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct KeylessCrawlResult {
    pub verb: String,
    pub url: String,
    pub pages: Vec<KeylessCrawlPage>,
    pub tier: String,
    pub limits: KeylessCrawlLimits,
    pub upgrade_url: Option<String>,
}

/// Options for [`CloudClient::crawl_keyless`].
#[derive(Debug, Clone, Default)]
pub struct KeylessCrawlOptions {
    /// Rank discovered URLs by relevance to this.
    pub search: Option<String>,
    /// Pages to fetch; the server caps it regardless.
    pub limit: Option<i64>,
}

// --- cloud automations + personas -------------------------------------------

/// Path prefix for cloud automations. On the wire the cloud calls this resource
/// `triggers`; the product, the daemon and every SDK call it an AUTOMATION.
const AUTOMATIONS_PATH: &str = "/api/triggers";

/// Path prefix for cloud personas.
const PERSONAS_PATH: &str = "/api/personas";

/// One thing an automation does when it fires.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct CloudAutomationAction {
    /// `notification` | `workflow` | `ai_session`.
    pub r#type: String,
    pub config: Value,
}

/// An event → conditions → actions rule, as Writ Cloud returns it.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct CloudAutomation {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    /// `change_detected` | `webhook_received` | `workflow_completed` | …
    pub event_type: String,
    pub enabled: bool,
    pub priority: i64,
    pub target_id: Option<i64>,
    pub target_selector_id: Option<i64>,
    pub workflow_id: Option<i64>,
    pub webhook_trigger_id: Option<i64>,
    pub webhook_trigger_token: Option<String>,
    pub custom_path: Option<String>,
    pub conditions: Option<Value>,
    pub actions: Vec<CloudAutomationAction>,
    pub blocks: Option<Vec<Value>>,
    pub last_triggered_at: Option<String>,
    pub next_scheduled_at: Option<String>,
    pub trigger_count: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Filters for [`CloudAutomations::list`].
#[derive(Debug, Clone, Default)]
pub struct CloudAutomationListOptions {
    pub enabled_only: bool,
    pub event_type: Option<String>,
    pub workflow_id: Option<i64>,
}

/// A login identity, as Writ Cloud returns it.
///
/// SECRET MATERIAL IS WRITE-ONLY: a password, TOTP seed and proxy credentials go
/// in on create/update and are stored encrypted; they never come back. What
/// reads back are the `has_*` booleans.
///
/// ⚠️ `relay_token` IS returned, because the owner needs it to point OTP
/// forwarding at the right address. It is a DEPOSIT-only credential (it can add
/// messages to this persona's relay mailbox, never read them) — treat it as a
/// secret in logs and screenshots even though it cannot read anything.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct CloudPersona {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub target_domain: Option<String>,
    pub login_username: Option<String>,
    pub has_password: bool,
    pub twofa_method: String,
    pub has_totp_seed: bool,
    pub email_otp_mode: Option<String>,
    pub mail_connection_id: Option<i64>,
    pub connected_mailbox: Option<String>,
    pub relay_address: Option<String>,
    pub relay_token: Option<String>,
    pub relay_inbound_address: Option<String>,
    pub relay_inbound_url: Option<String>,
    pub has_fingerprint: bool,
    pub preferred_agent_id: Option<String>,
    pub has_proxy: bool,
    pub proxy_provider: Option<String>,
    pub proxy_lawful_use_ack_at: Option<String>,
    pub is_active: bool,
    pub validation_status: String,
    pub has_warm_session: bool,
    pub session_expires_at: Option<String>,
    pub last_login_at: Option<String>,
    pub last_used_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub linked_workflows: Vec<Value>,
    pub linked_secrets: Value,
}

/// Answer from [`CloudPersonas::validate_totp`].
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct TotpValidation {
    pub valid_base32: bool,
    pub matches_code: Option<bool>,
}

/// The cloud automations surface, reached through [`CloudClient::automations`].
///
/// Mirrors the daemon's `Automations` resource verb for verb. Two shape
/// differences, both the server's: the list route is `/all`, and
/// [`CloudAutomations::toggle`] FLIPS the enabled flag rather than setting it.
///
/// Scopes: `triggers:*`. An action of type `workflow` additionally needs
/// `workflows:execute`, because it arranges a workflow run.
pub struct CloudAutomations<'a> {
    c: &'a CloudClient,
}

impl CloudAutomations<'_> {
    /// `GET /api/triggers/all` — every automation on the account.
    pub async fn list(&self, opts: &CloudAutomationListOptions) -> Result<Vec<CloudAutomation>> {
        self.guard("Listing cloud automations")?;
        let mut query: Vec<(&str, String)> = Vec::new();
        if opts.enabled_only {
            query.push(("enabled_only", "true".to_string()));
        }
        if let Some(kind) = &opts.event_type {
            query.push(("event_type", kind.clone()));
        }
        if let Some(id) = opts.workflow_id {
            query.push(("workflow_id", id.to_string()));
        }
        let raw = self
            .c
            .send_query(
                Method::GET,
                &format!("{AUTOMATIONS_PATH}/all"),
                None,
                &query,
            )
            .await?;
        decode(raw, "automation list")
    }

    /// `POST /api/triggers` — requires a non-empty `name`.
    pub async fn create(&self, body: Value) -> Result<CloudAutomation> {
        self.guard("Creating a cloud automation")?;
        let raw = self
            .c
            .send(Method::POST, AUTOMATIONS_PATH, Some(&body))
            .await?;
        decode(raw, "automation")
    }

    /// `GET /api/triggers/{id}`.
    pub async fn get(&self, id: i64) -> Result<CloudAutomation> {
        self.guard("Reading a cloud automation")?;
        let raw = self
            .c
            .send(Method::GET, &format!("{AUTOMATIONS_PATH}/{id}"), None)
            .await?;
        decode(raw, "automation")
    }

    /// `PATCH /api/triggers/{id}` — partial update.
    pub async fn update(&self, id: i64, patch: Value) -> Result<CloudAutomation> {
        self.guard("Updating a cloud automation")?;
        let raw = self
            .c
            .send(
                Method::PATCH,
                &format!("{AUTOMATIONS_PATH}/{id}"),
                Some(&patch),
            )
            .await?;
        decode(raw, "automation")
    }

    /// `DELETE /api/triggers/{id}`.
    pub async fn delete(&self, id: i64) -> Result<()> {
        self.guard("Deleting a cloud automation")?;
        self.c
            .send(Method::DELETE, &format!("{AUTOMATIONS_PATH}/{id}"), None)
            .await?;
        Ok(())
    }

    /// `PATCH /api/triggers/{id}/toggle` — FLIPS the enabled flag and returns
    /// the refreshed row. Read `enabled` off it rather than assuming.
    pub async fn toggle(&self, id: i64) -> Result<CloudAutomation> {
        self.guard("Toggling a cloud automation")?;
        let raw = self
            .c
            .send(
                Method::PATCH,
                &format!("{AUTOMATIONS_PATH}/{id}/toggle"),
                None,
            )
            .await?;
        decode(raw, "automation")
    }

    /// `POST /api/triggers/{id}/run` — fire it NOW, skipping its event.
    pub async fn run(&self, id: i64, inputs: Option<&Value>) -> Result<Value> {
        self.guard("Running a cloud automation")?;
        self.c
            .send(
                Method::POST,
                &format!("{AUTOMATIONS_PATH}/{id}/run"),
                inputs,
            )
            .await
    }

    /// `POST /api/triggers/{id}/test` — evaluate against a sample event WITHOUT
    /// running its actions.
    pub async fn test(&self, id: i64, body: &Value) -> Result<Value> {
        self.guard("Testing a cloud automation")?;
        self.c
            .send(
                Method::POST,
                &format!("{AUTOMATIONS_PATH}/{id}/test"),
                Some(body),
            )
            .await
    }

    /// `GET /api/triggers/{id}/executions` — this automation's history.
    pub async fn executions(&self, id: i64, limit: Option<i64>) -> Result<Vec<Value>> {
        self.guard("Reading cloud automation executions")?;
        let query: Vec<(&str, String)> = match limit {
            Some(n) => vec![("limit", n.to_string())],
            None => Vec::new(),
        };
        let raw = self
            .c
            .send_query(
                Method::GET,
                &format!("{AUTOMATIONS_PATH}/{id}/executions"),
                None,
                &query,
            )
            .await?;
        decode(raw, "automation executions")
    }

    /// `GET /api/triggers/target/{id}` — the automations wired to one monitor,
    /// the other half of [`CloudClient::monitors`].
    pub async fn for_monitor(
        &self,
        monitor_id: i64,
        enabled_only: bool,
    ) -> Result<Vec<CloudAutomation>> {
        self.guard("Reading a monitor's cloud automations")?;
        let query: Vec<(&str, String)> = if enabled_only {
            vec![("enabled_only", "true".to_string())]
        } else {
            Vec::new()
        };
        let raw = self
            .c
            .send_query(
                Method::GET,
                &format!("{AUTOMATIONS_PATH}/target/{monitor_id}"),
                None,
                &query,
            )
            .await?;
        decode(raw, "automation list")
    }

    fn guard(&self, what: &str) -> Result<()> {
        if self.c.tier() == CloudTier::Metered {
            return Ok(());
        }
        Err(api_key_required(&format!(
            "{what} needs an API key — set api_key or WRIT_API_KEY. \
             Keyless access covers scrape and map only."
        )))
    }
}

/// The cloud personas surface, reached through [`CloudClient::personas`].
///
/// Mirrors the daemon's `Personas` resource verb for verb. Scopes: `personas:*`.
/// Use personas only with sites and accounts you are authorized to access.
pub struct CloudPersonas<'a> {
    c: &'a CloudClient,
}

impl CloudPersonas<'_> {
    /// `GET /api/personas` — every persona on the account. `domain` suggests by site.
    pub async fn list(&self, domain: Option<&str>) -> Result<Vec<CloudPersona>> {
        self.guard("Listing cloud personas")?;
        let query: Vec<(&str, String)> = match domain {
            Some(d) => vec![("domain", d.to_string())],
            None => Vec::new(),
        };
        let raw = self
            .c
            .send_query(Method::GET, PERSONAS_PATH, None, &query)
            .await?;
        decode(raw, "persona list")
    }

    /// `POST /api/personas` — `name` is required. `password`, `totp_seed` and
    /// `proxy_password` are WRITE-ONLY: stored encrypted, never returned.
    pub async fn create(&self, body: Value) -> Result<CloudPersona> {
        self.guard("Creating a cloud persona")?;
        let raw = self
            .c
            .send(Method::POST, PERSONAS_PATH, Some(&body))
            .await?;
        decode(raw, "persona")
    }

    /// `GET /api/personas/{id}`.
    pub async fn get(&self, id: i64) -> Result<CloudPersona> {
        self.guard("Reading a cloud persona")?;
        let raw = self
            .c
            .send(Method::GET, &format!("{PERSONAS_PATH}/{id}"), None)
            .await?;
        decode(raw, "persona")
    }

    /// `PATCH /api/personas/{id}` — a secret is replaced only when sent.
    pub async fn update(&self, id: i64, patch: Value) -> Result<CloudPersona> {
        self.guard("Updating a cloud persona")?;
        let raw = self
            .c
            .send(
                Method::PATCH,
                &format!("{PERSONAS_PATH}/{id}"),
                Some(&patch),
            )
            .await?;
        decode(raw, "persona")
    }

    /// `DELETE /api/personas/{id}` — removes the persona and its credentials.
    pub async fn delete(&self, id: i64) -> Result<()> {
        self.guard("Deleting a cloud persona")?;
        self.c
            .send(Method::DELETE, &format!("{PERSONAS_PATH}/{id}"), None)
            .await?;
        Ok(())
    }

    /// `GET /api/personas/{id}/runs` — recent runs that acted as this persona.
    pub async fn runs(&self, id: i64, limit: Option<i64>) -> Result<Value> {
        self.guard("Reading cloud persona runs")?;
        let query: Vec<(&str, String)> = match limit {
            Some(n) => vec![("limit", n.to_string())],
            None => Vec::new(),
        };
        self.c
            .send_query(
                Method::GET,
                &format!("{PERSONAS_PATH}/{id}/runs"),
                None,
                &query,
            )
            .await
    }

    /// `POST /api/personas/{id}/test-2fa` — exercise the configured 2FA path and
    /// report whether it produced a code, without running a login.
    pub async fn test_2fa(&self, id: i64) -> Result<Value> {
        self.guard("Testing a cloud persona's 2FA")?;
        self.c
            .send(
                Method::POST,
                &format!("{PERSONAS_PATH}/{id}/test-2fa"),
                None,
            )
            .await
    }

    /// `POST /api/personas/validate-totp` — check a pasted seed is well-formed
    /// base32 and, with a code, that it reproduces that code.
    ///
    /// The seed is NEVER stored or logged by this call, so it is the safe way to
    /// check one BEFORE committing it to a persona.
    pub async fn validate_totp(
        &self,
        totp_seed: &str,
        code: Option<&str>,
    ) -> Result<TotpValidation> {
        self.guard("Validating a TOTP seed")?;
        let mut body = Map::new();
        body.insert("totp_seed".into(), Value::String(totp_seed.to_string()));
        if let Some(code) = code {
            body.insert("code".into(), Value::String(code.to_string()));
        }
        let raw = self
            .c
            .send(
                Method::POST,
                &format!("{PERSONAS_PATH}/validate-totp"),
                Some(&Value::Object(body)),
            )
            .await?;
        decode(raw, "totp validation")
    }

    fn guard(&self, what: &str) -> Result<()> {
        if self.c.tier() == CloudTier::Metered {
            return Ok(());
        }
        Err(api_key_required(&format!(
            "{what} needs an API key — set api_key or WRIT_API_KEY. \
             Keyless access covers scrape and map only."
        )))
    }
}

/// Path prefix for website → API builds.
const BUILDS_PATH: &str = "/api/v1/website-to-api";

/// Build states that will never change again.
pub const TERMINAL_BUILD_STATUSES: [&str; 3] = ["succeeded", "failed", "cancelled"];

/// A website → API build, or the ladder answer that made one unnecessary.
///
/// `build_id` is `None` on a ladder answer — check [`CloudBuild::status`] first.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct CloudBuild {
    pub build_id: Option<i64>,
    /// `queued` | `building` | `succeeded` | `failed` | `cancelled`, or a ladder
    /// answer: `existing_workflows` | `marketplace_candidates`.
    pub status: String,
    pub url: Option<String>,
    pub goal: Option<String>,
    /// Set once the agent saves — this is what the build was for.
    pub workflow_id: Option<i64>,
    pub error: Option<String>,
    pub next: Option<String>,
    pub message: Option<String>,
    pub created_at: Option<String>,
    pub completed_at: Option<String>,
    /// Ladder answers carry these instead of a build.
    pub workflows: Vec<Value>,
    pub candidates: Vec<Value>,
}

impl CloudBuild {
    /// Whether this build will never change again.
    pub fn is_terminal(&self) -> bool {
        TERMINAL_BUILD_STATUSES.contains(&self.status.as_str())
    }
}

/// Options for [`CloudBuilds::start`]. Only `url` and `goal` are required.
#[derive(Debug, Clone, Default)]
pub struct CloudBuildParams {
    pub url: String,
    pub goal: String,
    /// Saved identity to sign in with, for sites behind a login.
    pub persona_id: Option<i64>,
    /// Upper bound on the agent loop.
    pub max_steps: Option<i64>,
    pub save_as: Option<String>,
    /// Skip proposing your own matching workflows (replaying one is free).
    pub skip_existing: bool,
    /// Skip proposing ready-made marketplace listings.
    pub skip_marketplace: bool,
}

impl CloudBuildParams {
    fn to_body(&self) -> Value {
        let mut body = Map::new();
        body.insert("url".into(), Value::String(self.url.clone()));
        body.insert("goal".into(), Value::String(self.goal.clone()));
        if let Some(v) = self.persona_id {
            body.insert("persona_id".into(), Value::from(v));
        }
        if let Some(v) = self.max_steps {
            body.insert("max_steps".into(), Value::from(v));
        }
        if let Some(v) = &self.save_as {
            body.insert("save_as".into(), Value::String(v.clone()));
        }
        if self.skip_existing {
            body.insert("skip_existing".into(), Value::Bool(true));
        }
        if self.skip_marketplace {
            body.insert("skip_marketplace".into(), Value::Bool(true));
        }
        Value::Object(body)
    }
}

/// Website → API builds, reached through [`CloudClient::builds`].
///
/// The REST twin of the MCP tool `writ_website_to_api`, and ASYNCHRONOUS for a
/// reason: the tool works because the caller is a MODEL that drives the browser
/// turn by turn. A program cannot, so Writ's own agent loop drives and this
/// surface hands back a build id to poll.
///
/// The server checks two cheap rungs before spending any AI — your own matching
/// workflows, then ready-made marketplace listings — so `status` may come back
/// as `existing_workflows` or `marketplace_candidates` with no build at all.
///
/// Scopes: `workflows:write` to start, `workflows:read` to poll.
pub struct CloudBuilds<'a> {
    c: &'a CloudClient,
}

impl CloudBuilds<'_> {
    /// `POST /api/v1/website-to-api` — turn a website into a callable API.
    pub async fn start(&self, params: &CloudBuildParams) -> Result<CloudBuild> {
        self.guard("Building an API from a website")?;
        let raw = self
            .c
            .send(Method::POST, BUILDS_PATH, Some(&params.to_body()))
            .await?;
        decode(raw, "build")
    }

    /// `GET /api/v1/website-to-api/{id}` — poll a build.
    pub async fn get(&self, build_id: i64) -> Result<CloudBuild> {
        self.guard("Reading a website-to-API build")?;
        let raw = self
            .c
            .send(Method::GET, &format!("{BUILDS_PATH}/{build_id}"), None)
            .await?;
        decode(raw, "build")
    }

    /// [`start`](CloudBuilds::start), then poll until the build is terminal.
    ///
    /// Returns the ladder answer unchanged when the server resolved it without
    /// building — there is nothing to wait for. On timeout returns
    /// [`WritError::Timeout`]; the build keeps going and `build_id` still
    /// addresses it.
    pub async fn start_and_wait(
        &self,
        params: &CloudBuildParams,
        timeout: std::time::Duration,
        poll: std::time::Duration,
    ) -> Result<CloudBuild> {
        let started = self.start(params).await?;
        let Some(build_id) = started.build_id else {
            return Ok(started);
        };
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let current = self.get(build_id).await?;
            if current.is_terminal() {
                return Ok(current);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(WritError::BuildTimeout { build_id });
            }
            tokio::time::sleep(poll).await;
        }
    }

    fn guard(&self, what: &str) -> Result<()> {
        if self.c.tier() == CloudTier::Metered {
            return Ok(());
        }
        Err(api_key_required(&format!(
            "{what} needs an API key — set api_key or WRIT_API_KEY. \
             Keyless access covers scrape and map only."
        )))
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
    let body: Value = serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()));
    // `detail` may be a nested object, a bare STRING, or absent (flat body).
    let detail = body.get("detail").cloned().unwrap_or_else(|| body.clone());
    // Prefer the nested detail object, but fall back to the TOP level when
    // `detail` is a string. A plan denial sends the flat shape
    // {"detail": "<reason>", "code": …, "current": …, "limit": …}, and reading
    // only the (string) detail black-holed every machine-readable field — the
    // code degraded to "http_402" and the ceiling was lost entirely.
    let d = detail
        .as_object()
        .cloned()
        .or_else(|| body.as_object().cloned());

    let field_str = |key: &str| {
        d.as_ref()
            .and_then(|m| m.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let field_i64 = |key: &str| d.as_ref().and_then(|m| m.get(key)).and_then(Value::as_i64);

    let code = field_str("code").unwrap_or_else(|| code_for_status(status));
    let message = field_str("message")
        .or_else(|| detail.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("HTTP {status}"));

    match (status, code.as_str()) {
        (429, _) => WritError::RateLimited {
            status,
            code,
            message,
            reset_at: field_str("reset_at"),
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
        // Two different 402s share this status. Tell them apart STRUCTURALLY
        // rather than by a code allowlist that would drift as the backend adds
        // limits: a plan denial always reports the ceiling it hit as a numeric
        // `limit`, a credits/wallet 402 never does.
        (402, _) if field_i64("limit").is_some() => WritError::PlanLimit {
            status,
            code,
            message,
            current: field_i64("current").unwrap_or(0),
            limit: field_i64("limit").unwrap_or(0),
            upgrade_hint: field_str("upgrade_hint"),
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

/// Percent-encode one path segment.
///
/// A saved crawl is addressable by SLUG as well as by id, and a slug is
/// interpolated straight into the request path. Without this, a `?` or `#` in a
/// slug would be read as the start of the query or fragment and silently
/// address a different resource, and a space would produce an invalid URL.
/// Unreserved characters (RFC 3986 §2.3) pass through untouched, so an ordinary
/// slug is unchanged.
fn encode_path_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

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

/// Read the server-minted keyless subject from `~/.writ/device_token`, if issued.
fn load_device_token() -> Option<String> {
    if let Some(token) = env_var("WRIT_DEVICE_TOKEN") {
        return Some(token);
    }
    let file = writ_home_dir()?.join("device_token");
    let contents = std::fs::read_to_string(file).ok()?;
    let trimmed = contents.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Persist a freshly-issued token. Best-effort: a read-only home just means the
/// next process starts over as an anonymous caller, which still works.
fn store_device_token(token: &str) {
    let Some(dir) = writ_home_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("device_token"), token);
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
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
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
        let err = cloud_error_from(
            402,
            r#"{"detail":{"code":"api_key_required","message":"key please"}}"#,
        );
        assert!(
            matches!(err, WritError::ApiKeyRequired { .. }),
            "got {err:?}"
        );

        // 402 otherwise → InsufficientCredits.
        let err = cloud_error_from(
            402,
            r#"{"detail":{"code":"insufficient_credits","message":"broke"}}"#,
        );
        assert!(
            matches!(err, WritError::InsufficientCredits { .. }),
            "got {err:?}"
        );

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
