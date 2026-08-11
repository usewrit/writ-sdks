//! Client construction, configuration (DESIGN.md §3) and discovery (§4), plus the
//! shared HTTP plumbing every resource handle rides on.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use reqwest::{Method, Response};
use serde::de::DeserializeOwned;
use serde_json::Value;

use tokio::time::sleep;

use crate::discovery::{env_var, runtime_candidates};
use crate::error::{api_error, Result, WritError};
use crate::models::WsTicket;
use crate::resources::{
    Agent, Automations, Crawl, Data, Datasets, Extractors, Files, Keys, Monitors, Personas, Runs,
    Secrets, Selectors, Vault, Workflows,
};
use crate::retry::{retry_after, should_retry_status, RetryPolicy};

/// `User-Agent` sent on every request: `writ-sdk-rust/<version>`.
pub(crate) const USER_AGENT: &str = concat!("writ-sdk-rust/", env!("CARGO_PKG_VERSION"));

/// Default per-request timeout (DESIGN.md §3).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Liveness-probe budget during discovery (DESIGN.md §4).
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Per-request timeout override for plain `runs().events()` streams — an SSE stream
/// must outlive the client's default 30 s request timeout.
pub(crate) const SSE_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

/// The async client for a local Writ agent (`writ-agentd`).
///
/// Construct with [`WritAgent::builder`] (explicit config, no network I/O) or
/// [`WritAgent::discover`] (env + `runtime.json` walk with a liveness probe).
/// Resource groups hang off accessor methods: [`WritAgent::workflows`],
/// [`WritAgent::runs`], [`WritAgent::monitors`], …
#[derive(Debug, Clone)]
pub struct WritAgent {
    inner: Arc<Inner>,
}

/// Shared HTTP state (one reqwest client, resolved base URL + bearer).
#[derive(Debug)]
pub(crate) struct Inner {
    pub(crate) http: reqwest::Client,
    pub(crate) base_url: String,
    /// Transient-failure policy. Unsafe methods are never retried here: the local
    /// daemon has no `Idempotency-Key` lane, so a repeated POST is a second
    /// resource, not a replayed answer.
    pub(crate) retry: RetryPolicy,
    /// Applied per request rather than only as a client default header, so a
    /// caller-supplied [`reqwest::Client`] is authenticated too. Without this a
    /// custom client would send every request unauthenticated and 401.
    pub(crate) auth: Option<HeaderValue>,
}

/// Configuration builder. `build()` performs **no network I/O** (and no filesystem
/// discovery); the only I/O it can do is reading the CA file passed to
/// [`WritAgentBuilder::ca_pem_file`]. `discover()` runs the full DESIGN.md §4
/// algorithm for whichever of base URL / token was not provided.
#[derive(Debug, Default, Clone)]
pub struct WritAgentBuilder {
    base_url: Option<String>,
    token: Option<String>,
    timeout: Option<Duration>,
    ca_pem_file: Option<PathBuf>,
    retry: Option<RetryPolicy>,
    http_client: Option<reqwest::Client>,
}

impl WritAgentBuilder {
    /// Base URL of the daemon, e.g. `http://127.0.0.1:8131`. No trailing `/v1` —
    /// the SDK appends path prefixes itself. A trailing `/` is stripped.
    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = Some(url.into());
        self
    }

    /// Bearer token (`wlt_` runtime token, `wlk_` scoped key, or `wlo_` OAuth
    /// token) — treated as an opaque string.
    pub fn token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    /// Per-request timeout (default 30 s). `run_and_wait` and `events()` manage
    /// their own deadlines.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// PEM file of the daemon's local CA (`~/.writ/tls/ca.pem`) for the HTTPS twin
    /// port. Read (filesystem only) at `build()`/`discover()` time.
    pub fn ca_pem_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.ca_pem_file = Some(path.into());
        self
    }

    /// Override the transient-failure retry policy. [`RetryPolicy::off`] disables
    /// retrying entirely.
    ///
    /// Unsafe methods are never retried against the local daemon regardless of
    /// this setting — it has no `Idempotency-Key` lane, so a repeated POST is a
    /// second resource.
    pub fn retry(mut self, policy: RetryPolicy) -> Self {
        self.retry = Some(policy);
        self
    }

    /// Supply your own [`reqwest::Client`].
    ///
    /// This is the extension point for anything the builder does not model
    /// directly: a proxy, a connection-pool limit, custom TLS, a tracing
    /// middleware layer, or a mock transport in tests. When set, `timeout` and
    /// `ca_pem_file` are the supplied client's business — the SDK only adds the
    /// per-request `Authorization` header it always adds.
    pub fn http_client(mut self, client: reqwest::Client) -> Self {
        self.http_client = Some(client);
        self
    }

    /// The reqwest client for `timeout`, honoring the optional CA file — or the
    /// caller's own client, when one was supplied via
    /// [`WritAgentBuilder::http_client`].
    fn build_http(&self, timeout: Duration, token: Option<&str>) -> Result<reqwest::Client> {
        if let Some(client) = &self.http_client {
            return Ok(client.clone());
        }
        let mut builder = reqwest::Client::builder()
            .timeout(timeout)
            .user_agent(USER_AGENT);
        if let Some(token) = token {
            let mut headers = HeaderMap::new();
            let mut auth = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| {
                WritError::Discovery("token contains characters invalid in an HTTP header".into())
            })?;
            auth.set_sensitive(true);
            headers.insert(AUTHORIZATION, auth);
            builder = builder.default_headers(headers);
        }
        if let Some(path) = &self.ca_pem_file {
            let pem = std::fs::read(path).map_err(|e| {
                WritError::Discovery(format!("cannot read ca_pem_file {}: {e}", path.display()))
            })?;
            let cert = reqwest::Certificate::from_pem(&pem).map_err(|e| {
                WritError::Discovery(format!("invalid CA pem {}: {e}", path.display()))
            })?;
            builder = builder.add_root_certificate(cert);
        }
        builder
            .build()
            .map_err(|e| WritError::Discovery(format!("building http client: {e}")))
    }

    /// Resolve `(base_url, token)` from explicit options, falling back to the
    /// `WRIT_API_URL` / `WRIT_TOKEN` env overrides (§4 step 1).
    fn resolved(&self) -> (Option<String>, Option<String>) {
        let url = self.base_url.clone().or_else(|| env_var("WRIT_API_URL"));
        let token = self.token.clone().or_else(|| env_var("WRIT_TOKEN"));
        (url, token)
    }

    fn assemble(&self, base_url: &str, token: &str) -> Result<WritAgent> {
        let http = self.build_http(self.timeout.unwrap_or(DEFAULT_TIMEOUT), Some(token))?;
        let mut auth = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| {
            WritError::Discovery("token contains characters invalid in an HTTP header".into())
        })?;
        auth.set_sensitive(true);
        Ok(WritAgent {
            inner: Arc::new(Inner {
                http,
                base_url: base_url.trim_end_matches('/').to_string(),
                // Unsafe methods forced off — see the field docs.
                retry: self.retry.unwrap_or_default().with_unsafe(false),
                auth: Some(auth),
            }),
        })
    }

    /// Build the client from explicit options (env `WRIT_API_URL`/`WRIT_TOKEN`
    /// fill gaps; base URL defaults to `http://127.0.0.1:8131`). **No network or
    /// filesystem discovery, no liveness probe.** Fails with a discovery error
    /// when no token can be resolved.
    pub fn build(self) -> Result<WritAgent> {
        let (url, token) = self.resolved();
        let token = token.ok_or_else(|| {
            WritError::Discovery(
                "no token configured — is the Writ agent running? pass .token(...) or set WRIT_TOKEN"
                    .into(),
            )
        })?;
        let url = url.unwrap_or_else(|| "http://127.0.0.1:8131".to_string());
        self.assemble(&url, &token)
    }

    /// Full discovery (DESIGN.md §4) for whichever of base URL / token this
    /// builder does not already have: env overrides, then the `runtime.json`
    /// candidate walk with a 2 s `GET /v1/agent` liveness probe per candidate
    /// (stale descriptors fall through to the next candidate).
    pub async fn discover(self) -> Result<WritAgent> {
        let (url_override, token_override) = self.resolved();

        // §4 step 1: with both fields pinned (explicitly or via env), discovery is done.
        if let (Some(url), Some(token)) = (&url_override, &token_override) {
            return self.assemble(url, token);
        }

        let candidates = runtime_candidates();
        if candidates.is_empty() {
            return Err(WritError::Discovery(
                "no runtime.json found under $WRIT_HOME or ~/.writ — is the Writ agent running? \
                 pass base_url/token explicitly or set WRIT_API_URL/WRIT_TOKEN"
                    .into(),
            ));
        }

        let probe = self.build_http(PROBE_TIMEOUT, None)?;
        let mut tried: Vec<String> = Vec::new();
        for candidate in candidates {
            let url = url_override
                .clone()
                .unwrap_or_else(|| candidate.base_url.clone());
            let url = url.trim_end_matches('/').to_string();
            let token = token_override
                .clone()
                .unwrap_or_else(|| candidate.token.clone());
            let live = probe
                .get(format!("{url}/v1/agent"))
                .bearer_auth(&token)
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            if live {
                return self.assemble(&url, &token);
            }
            tried.push(candidate.source.display().to_string());
        }
        Err(WritError::Discovery(format!(
            "no live Writ agent answered the probe (stale runtime.json candidates: {}) — \
             is the Writ agent running? pass token=... or set WRIT_TOKEN",
            tried.join(", ")
        )))
    }
}

impl WritAgent {
    /// Start explicit configuration. `build()` performs no I/O.
    pub fn builder() -> WritAgentBuilder {
        WritAgentBuilder::default()
    }

    /// Discover a live local daemon (env → `runtime.json` walk → liveness probe)
    /// and return a ready client. See DESIGN.md §4 / [`WritAgentBuilder::discover`].
    pub async fn discover() -> Result<WritAgent> {
        WritAgentBuilder::default().discover().await
    }

    /// The resolved base URL (no trailing slash).
    pub fn base_url(&self) -> &str {
        &self.inner.base_url
    }

    /// Agent status/health (`/v1/agent`, `/v1/health`).
    pub fn agent(&self) -> Agent<'_> {
        Agent { c: &self.inner }
    }

    /// Workflows (`/v1/workflows`).
    pub fn workflows(&self) -> Workflows<'_> {
        Workflows { c: &self.inner }
    }

    /// Runs — read + control (`/v1/runs`).
    pub fn runs(&self) -> Runs<'_> {
        Runs { c: &self.inner }
    }

    /// Monitors (`/v1/monitors`, `/v1/changes/recent`).
    pub fn monitors(&self) -> Monitors<'_> {
        Monitors { c: &self.inner }
    }

    /// Content selectors nested under monitors (`/v1/monitors/:id/selectors`).
    pub fn selectors(&self) -> Selectors<'_> {
        Selectors { c: &self.inner }
    }

    /// Field extractors (`/v1/extractors`, `/v1/selectors/:sid/extractors`).
    pub fn extractors(&self) -> Extractors<'_> {
        Extractors { c: &self.inner }
    }

    /// Automations (`/v1/automations`).
    pub fn automations(&self) -> Automations<'_> {
        Automations { c: &self.inner }
    }

    /// Personas (`/v1/personas`).
    pub fn personas(&self) -> Personas<'_> {
        Personas { c: &self.inner }
    }

    /// Vault secrets — metadata only, values never come back (`/v1/secrets`).
    pub fn secrets(&self) -> Secrets<'_> {
        Secrets { c: &self.inner }
    }

    /// Vault app-lock (`/v1/vault/*`).
    pub fn vault(&self) -> Vault<'_> {
        Vault { c: &self.inner }
    }

    /// Stored files (`/v1/files`).
    pub fn files(&self) -> Files<'_> {
        Files { c: &self.inner }
    }

    /// Extracted-data queries and exports (`/v1/data`, `/v1/workflows/:id/data*`).
    pub fn data(&self) -> Data<'_> {
        Data { c: &self.inner }
    }

    /// Scoped API keys (`/v1/keys`; requires the `manage`-capable `wlt_` token).
    pub fn keys(&self) -> Keys<'_> {
        Keys { c: &self.inner }
    }

    /// Dragnet whole-site crawls (`/v1/crawl`).
    pub fn crawl(&self) -> Crawl<'_> {
        Crawl { c: &self.inner }
    }

    /// Datasets — the unified crawl + workflow extracted-data index (`/v1/datasets`).
    pub fn datasets(&self) -> Datasets<'_> {
        Datasets { c: &self.inner }
    }

    /// Mint a single-use WebSocket connect ticket (`POST /v1/ws-ticket`).
    /// `route` ∈ `"record" | "ai-preview"`; `ai-preview` requires a `channel`.
    /// Opening the WebSocket itself is out of scope for v1.
    pub async fn ws_ticket(&self, route: &str, channel: Option<&str>) -> Result<WsTicket> {
        let mut body = serde_json::json!({ "route": route });
        if let Some(channel) = channel {
            body["channel"] = Value::String(channel.to_string());
        }
        self.inner
            .send_json(Method::POST, "/v1/ws-ticket", &[], Some(&body))
            .await
    }
}

impl Inner {
    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// Send (retrying transient failures) and surface non-2xx outside `extra_ok`
    /// as [`WritError::Api`].
    ///
    /// Retrying needs a fresh request per attempt, which `try_clone` provides for
    /// every body this SDK sends. A streaming body cannot be cloned; that request
    /// is simply attempted once rather than silently sending a truncated retry.
    async fn execute(&self, rb: reqwest::RequestBuilder, extra_ok: &[u16]) -> Result<Response> {
        // Applied here, at the single choke point, so a caller-supplied client
        // (which carries none of the SDK's default headers) is still
        // authenticated and still identifies itself.
        let rb = match &self.auth {
            Some(auth) => rb
                .header(AUTHORIZATION, auth.clone())
                .header(reqwest::header::USER_AGENT, USER_AGENT),
            None => rb,
        };
        let policy = self.retry;
        let method = rb
            .try_clone()
            .and_then(|c| c.build().ok())
            .map(|r| r.method().clone())
            .unwrap_or(Method::GET);
        let attempts = policy.attempts_for(&method);

        let mut pending = Some(rb);
        let mut attempt = 1u32;
        let resp = loop {
            let current = pending
                .take()
                .ok_or_else(|| WritError::Connection("retry lost the request".into()))?;
            // Keep a clone for the next attempt only while one is still allowed.
            let next = if attempt < attempts {
                current.try_clone()
            } else {
                None
            };

            match current.send().await {
                Ok(resp) => {
                    if !should_retry_status(resp.status()) {
                        break resp;
                    }
                    let Some(next_rb) = next else { break resp };
                    let mut wait = policy.backoff(attempt);
                    if let Some(requested) = retry_after(&resp) {
                        if requested > policy.max_retry_after {
                            // The server says this will not clear any time soon.
                            // Hand back the real answer, which carries the reset.
                            break resp;
                        }
                        wait = requested;
                    }
                    sleep(wait).await;
                    pending = Some(next_rb);
                }
                Err(err) => {
                    let Some(next_rb) = next else {
                        return Err(WritError::from(err));
                    };
                    sleep(policy.backoff(attempt)).await;
                    pending = Some(next_rb);
                }
            }
            attempt += 1;
        };

        let status = resp.status();
        if status.is_success() || extra_ok.contains(&status.as_u16()) {
            return Ok(resp);
        }
        let reason = status.canonical_reason().unwrap_or("error").to_string();
        let text = resp.text().await.unwrap_or_default();
        Err(api_error(status.as_u16(), &reason, &text))
    }

    async fn decode<T: DeserializeOwned>(resp: Response) -> Result<T> {
        resp.json::<T>()
            .await
            .map_err(|e| WritError::Connection(format!("decoding response body: {e}")))
    }

    /// `GET path?query` → JSON.
    pub(crate) async fn get_json<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T> {
        let rb = self.http.get(self.url(path)).query(query);
        Self::decode(self.execute(rb, &[]).await?).await
    }

    /// `method path?query` with an optional JSON body → JSON.
    pub(crate) async fn send_json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<T> {
        self.send_json_allowing(method, path, query, body, &[])
            .await
    }

    /// Like [`Inner::send_json`], but the listed non-2xx statuses are decoded as a
    /// success body instead of an error (cancel's `409 not_running`).
    pub(crate) async fn send_json_allowing<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
        extra_ok: &[u16],
    ) -> Result<T> {
        let mut rb = self.http.request(method, self.url(path)).query(query);
        if let Some(body) = body {
            rb = rb.json(body);
        }
        Self::decode(self.execute(rb, extra_ok).await?).await
    }

    /// `method path?query` where the daemon answers `204 No Content`.
    ///
    /// Separate from [`Inner::send_json`] because that decodes the body with
    /// `resp.json()`, which FAILS on an empty one — a 204 would surface as a bogus
    /// "decoding response body" error even though the call succeeded.
    pub(crate) async fn send_no_content(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<()> {
        let mut rb = self.http.request(method, self.url(path)).query(query);
        if let Some(body) = body {
            rb = rb.json(body);
        }
        self.execute(rb, &[]).await?;
        Ok(())
    }

    /// `GET path?query` → raw text (CSV lane).
    pub(crate) async fn get_text(&self, path: &str, query: &[(&str, &str)]) -> Result<String> {
        let rb = self.http.get(self.url(path)).query(query);
        self.execute(rb, &[])
            .await?
            .text()
            .await
            .map_err(|e| WritError::Connection(format!("reading response body: {e}")))
    }

    /// `GET path?query` → raw bytes (file content / exports).
    pub(crate) async fn get_bytes(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<bytes::Bytes> {
        let rb = self.http.get(self.url(path)).query(query);
        self.execute(rb, &[])
            .await?
            .bytes()
            .await
            .map_err(|e| WritError::Connection(format!("reading response body: {e}")))
    }

    /// An OWNED handle that can re-open one streaming endpoint.
    ///
    /// A `'static` SSE stream cannot borrow `Inner`, so reconnecting after a
    /// mid-stream drop needs its own copy of what it takes to issue the request.
    /// `reqwest::Client` is an `Arc` internally, so this clone is cheap.
    pub(crate) fn stream_opener(&self, path: &str, timeout: Duration) -> StreamOpener {
        StreamOpener {
            http: self.http.clone(),
            url: self.url(path),
            auth: self.auth.clone(),
            timeout,
        }
    }

    /// `GET path` as a streaming response (SSE) with a per-request timeout
    /// override — the client-wide 30 s default would sever a long stream.
    pub(crate) async fn get_stream(&self, path: &str, timeout: Duration) -> Result<Response> {
        let rb = self
            .http
            .get(self.url(path))
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .timeout(timeout);
        self.execute(rb, &[]).await
    }

    /// `POST path` with a multipart form → JSON.
    pub(crate) async fn post_multipart<T: DeserializeOwned>(
        &self,
        path: &str,
        form: reqwest::multipart::Form,
    ) -> Result<T> {
        let rb = self.http.post(self.url(path)).multipart(form);
        Self::decode(self.execute(rb, &[]).await?).await
    }
}

/// Re-opens one streaming endpoint. See [`Inner::stream_opener`].
#[derive(Debug, Clone)]
pub(crate) struct StreamOpener {
    http: reqwest::Client,
    url: String,
    auth: Option<HeaderValue>,
    timeout: Duration,
}

impl StreamOpener {
    pub(crate) async fn open(&self) -> Result<Response> {
        let mut rb = self
            .http
            .get(&self.url)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .timeout(self.timeout);
        if let Some(auth) = &self.auth {
            rb = rb
                .header(AUTHORIZATION, auth.clone())
                .header(reqwest::header::USER_AGENT, USER_AGENT);
        }
        let resp = rb.send().await.map_err(WritError::from)?;
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let reason = status.canonical_reason().unwrap_or("error").to_string();
        let text = resp.text().await.unwrap_or_default();
        Err(api_error(status.as_u16(), &reason, &text))
    }
}
