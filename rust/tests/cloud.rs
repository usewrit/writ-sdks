//! Integration tests for the tiered Writ Cloud surface ([`CloudClient`]) against
//! the same in-crate HTTP/1.1 stub server the daemon tests use. Covers the
//! credential-driven tier split (keyless client-id header vs metered Bearer),
//! the client-side crawl refusal (zero requests), and 429 → RateLimited mapping.

// The stub server module is shared with `sdk.rs`; this binary exercises only a
// subset of its surface, so silence dead-code warnings for the unused helpers.
#[allow(dead_code)]
mod stub;

use std::time::Duration;

use serde_json::{json, Value};
use writ_client::{CloudClient, CloudTier, CrawlStartParams, MapOptions, WritError};

use stub::{Reply, StubServer};

fn json_reply(status: u16, body: Value) -> Reply {
    Reply::full(status, "application/json", body.to_string().into_bytes())
}

/// Keyless client (no api key) wired to the stub, with an explicit client id so
/// no filesystem `~/.writ/client_id` I/O happens during the test.
fn keyless_for(server: &StubServer) -> CloudClient {
    CloudClient::builder()
        .cloud_url(server.base_url())
        .client_id("cid_test_123")
        .timeout(Duration::from_secs(5))
        .build()
        .expect("build keyless client")
}

/// Metered client (api key present) wired to the stub.
fn metered_for(server: &StubServer, key: &str) -> CloudClient {
    CloudClient::builder()
        .cloud_url(server.base_url())
        .api_key(key)
        .timeout(Duration::from_secs(5))
        .build()
        .expect("build metered client")
}

// (a) keyless scrape → /v1/keyless/scrape with X-Writ-Client-Id and no bearer.
#[tokio::test]
async fn keyless_scrape_uses_keyless_path_and_client_id_header() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/keyless/scrape",
        json_reply(
            200,
            json!({
                "url": "https://example.com",
                "title": "Example",
                "format": "markdown",
                "markdown": "# Example",
                "counts": {"headings": 1},
                "quota": {
                    "requests_remaining": 9, "pages_remaining": 49,
                    "requests_per_day": 10, "pages_per_day": 50,
                    "reset_at": "2026-07-17T00:00:00Z"
                }
            }),
        ),
    );
    let cloud = keyless_for(&server);
    assert_eq!(cloud.tier(), CloudTier::Keyless);

    let res = cloud.scrape("https://example.com").await.unwrap();
    assert_eq!(res.url, "https://example.com");
    assert_eq!(res.title.as_deref(), Some("Example"));
    assert_eq!(res.markdown, "# Example");
    assert_eq!(res.tier, CloudTier::Keyless);
    let quota = res.quota.expect("keyless call echoes quota");
    assert_eq!(quota.requests_remaining, 9);
    assert_eq!(quota.pages_remaining, 49);

    let req = &server.requests()[0];
    assert_eq!(req.path, "/v1/keyless/scrape");
    assert_eq!(req.header("x-writ-client-id").as_deref(), Some("cid_test_123"));
    assert!(
        req.header("authorization").is_none(),
        "keyless must NOT send a bearer token"
    );
    let body: Value = serde_json::from_slice(&req.body).unwrap();
    assert_eq!(body["url"], "https://example.com");
}

// (b) metered scrape → /api/crawl/scrape with Bearer (and no client-id header).
#[tokio::test]
async fn metered_scrape_uses_authed_path_and_bearer() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/api/crawl/scrape",
        json_reply(
            200,
            json!({
                "url": "https://example.com",
                "title": null,
                "format": "markdown",
                "markdown": "hello",
                "counts": {}
            }),
        ),
    );
    let cloud = metered_for(&server, "wt_secret");
    assert_eq!(cloud.tier(), CloudTier::Metered);

    let res = cloud.scrape("https://example.com").await.unwrap();
    assert_eq!(res.tier, CloudTier::Metered);
    assert_eq!(res.markdown, "hello");
    assert!(res.title.is_none());
    assert!(res.quota.is_none(), "metered calls carry no keyless quota");

    let req = &server.requests()[0];
    assert_eq!(req.path, "/api/crawl/scrape");
    assert_eq!(
        req.header("authorization").as_deref(),
        Some("Bearer wt_secret")
    );
    assert!(
        req.header("x-writ-client-id").is_none(),
        "metered must NOT send the client-id header"
    );
}

// Map: keyless path + body carries url/search/limit.
#[tokio::test]
async fn keyless_map_sends_search_and_limit() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/keyless/map",
        json_reply(
            200,
            json!({
                "url": "https://example.com",
                "host": "example.com",
                "urls": [{"url": "https://example.com/a", "score": 0.9, "title": "A"}],
                "counts": {"returned": 1, "total": 1}
            }),
        ),
    );
    let cloud = keyless_for(&server);
    let res = cloud
        .map(
            "https://example.com",
            &MapOptions {
                search: Some("pricing".into()),
                limit: Some(5),
            },
        )
        .await
        .unwrap();
    assert_eq!(res.host.as_deref(), Some("example.com"));
    assert_eq!(res.urls.len(), 1);
    assert_eq!(res.urls[0].url, "https://example.com/a");
    assert_eq!(res.counts.total, 1);

    let body: Value = serde_json::from_slice(&server.requests()[0].body).unwrap();
    assert_eq!(body["url"], "https://example.com");
    assert_eq!(body["search"], "pricing");
    assert_eq!(body["limit"], 5);
}

// (c) crawl with no key → ApiKeyRequired error, zero requests issued.
#[tokio::test]
async fn keyless_crawl_refused_client_side_with_zero_requests() {
    let server = StubServer::start().await;
    let cloud = keyless_for(&server);

    let err = cloud
        .crawl(&CrawlStartParams {
            url: "https://example.com".into(),
            ..Default::default()
        })
        .await
        .unwrap_err();
    match err {
        WritError::ApiKeyRequired {
            status,
            code,
            body,
            ..
        } => {
            assert_eq!(status, 402);
            assert_eq!(code, "api_key_required");
            assert_eq!(body, Value::Null, "client-side refusal carries a null body");
        }
        other => panic!("expected ApiKeyRequired, got {other:?}"),
    }
    // crawl_status is likewise refused client-side.
    assert!(matches!(
        cloud.crawl_status(1).await.unwrap_err(),
        WritError::ApiKeyRequired { .. }
    ));

    assert!(
        server.requests().is_empty(),
        "no network call may be made when crawl is refused client-side"
    );
}

// Metered crawl reaches /api/crawl and parses the CrawlJob view.
#[tokio::test]
async fn metered_crawl_posts_and_parses_job() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/api/crawl",
        json_reply(
            200,
            json!({
                "id": 42, "name": "Dragnet: example.com", "seed_url": "https://example.com",
                "include_paths": [], "exclude_paths": [], "max_depth": 3,
                "same_domain": 1, "allow_subdomains": 1, "extract_mode": "markdown",
                "extract_schema": null, "persona_id": null, "respect_robots": 1,
                "delay_ms": 250, "max_concurrent": 4, "page_budget": 500,
                "workflow_id": 77, "data_workflow_id": 77, "concierge_session_id": null,
                "status": "queued", "pages_discovered": 0, "pages_done": 0,
                "pages_failed": 0, "pages_skipped": 0, "workers_active": 0,
                "current_depth": 0, "error": null, "cancel_requested": 0,
                "brand": "Dragnet", "is_terminal": false, "created_at": "2026-07-16T00:00:00Z"
            }),
        ),
    );
    let cloud = metered_for(&server, "wt_secret");
    let job = cloud
        .crawl(&CrawlStartParams {
            url: "https://example.com".into(),
            max_depth: Some(3),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(job.id, 42);
    assert_eq!(job.brand, "Dragnet");
    assert_eq!(job.data_workflow_id, Some(77));

    let req = &server.requests()[0];
    assert_eq!(req.path, "/api/crawl");
    assert_eq!(
        req.header("authorization").as_deref(),
        Some("Bearer wt_secret")
    );
    let body: Value = serde_json::from_slice(&req.body).unwrap();
    assert_eq!(body["url"], "https://example.com");
    assert_eq!(body["max_depth"], 3);
}

// (d) 429 → RateLimited carrying reset_at (and remaining allowances).
#[tokio::test]
async fn keyless_429_maps_to_rate_limited_with_reset_at() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/keyless/scrape",
        json_reply(
            429,
            json!({"detail": {
                "code": "rate_limited",
                "message": "daily keyless allowance exhausted",
                "reset_at": "2026-07-17T00:00:00Z",
                "requests_remaining": 0,
                "pages_remaining": 0
            }}),
        ),
    );
    let cloud = keyless_for(&server);
    let err = cloud.scrape("https://example.com").await.unwrap_err();
    match err {
        WritError::RateLimited {
            status,
            code,
            message,
            reset_at,
            requests_remaining,
            pages_remaining,
            ..
        } => {
            assert_eq!(status, 429);
            assert_eq!(code, "rate_limited");
            assert_eq!(message, "daily keyless allowance exhausted");
            assert_eq!(reset_at.as_deref(), Some("2026-07-17T00:00:00Z"));
            assert_eq!(requests_remaining, Some(0));
            assert_eq!(pages_remaining, Some(0));
        }
        other => panic!("expected RateLimited, got {other:?}"),
    }
}

// quota(): keyless GETs /v1/keyless/quota; metered short-circuits to None.
#[tokio::test]
async fn quota_keyless_fetches_metered_none() {
    let server = StubServer::start().await;
    server.route(
        "GET",
        "/v1/keyless/quota",
        json_reply(
            200,
            json!({"quota": {
                "requests_remaining": 7, "pages_remaining": 40,
                "requests_per_day": 10, "pages_per_day": 50,
                "reset_at": "2026-07-17T00:00:00Z", "upgrade_url": "https://usewrit.app/pricing"
            }}),
        ),
    );
    let keyless = keyless_for(&server);
    let quota = keyless.quota().await.unwrap().expect("keyless has a quota");
    assert_eq!(quota.requests_remaining, 7);
    assert_eq!(quota.upgrade_url.as_deref(), Some("https://usewrit.app/pricing"));
    assert_eq!(quota.tier, CloudTier::Keyless);

    // Metered never hits the network for quota.
    let server2 = StubServer::start().await;
    let metered = metered_for(&server2, "wt_secret");
    assert!(metered.quota().await.unwrap().is_none());
    assert!(server2.requests().is_empty());
}
