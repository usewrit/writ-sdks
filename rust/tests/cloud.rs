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
use writ_client::{
    ChangeListOptions, CloudClient, CloudMonitorListOptions, CloudTier, CrawlStartParams,
    MapOptions, WritError,
};

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
    assert_eq!(
        req.header("x-writ-client-id").as_deref(),
        Some("cid_test_123")
    );
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
            status, code, body, ..
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
    assert_eq!(job.brand.crawl(), "Dragnet");
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
    assert_eq!(
        quota.upgrade_url.as_deref(),
        Some("https://usewrit.app/pricing")
    );
    assert_eq!(quota.tier, CloudTier::Keyless);

    // Metered never hits the network for quota.
    let server2 = StubServer::start().await;
    let metered = metered_for(&server2, "wt_secret");
    assert!(metered.quota().await.unwrap().is_none());
    assert!(server2.requests().is_empty());
}

// --- cloud monitors ---------------------------------------------------------

/// A minimal camelCase monitor body, as `/api/targets` actually serialises one.
fn monitor_json() -> Value {
    json!({
        "id": 412,
        "url": "https://example.com/pricing",
        "checkType": "content",
        "selector": ".price",
        "checkPeriodMs": 300000,
        "enabled": true,
        "requiresPlaywright": false,
        "changesCount": 0,
        "createdAt": "2026-08-05T00:00:00Z",
        "state": "ok"
    })
}

// (g) create posts snake_case to /api/targets and decodes the camelCase answer.
#[tokio::test]
async fn cloud_monitor_create_posts_snake_case_and_decodes_camel_case() {
    let server = StubServer::start().await;
    server.route("POST", "/api/targets", json_reply(201, monitor_json()));
    let cloud = metered_for(&server, "wt_secret");

    let mon = cloud
        .monitors()
        .create(json!({
            "url": "https://example.com/pricing",
            "check_type": "content",
            "selector": ".price",
            "check_period_ms": 300000
        }))
        .await
        .unwrap();

    assert_eq!(mon.id, 412);
    assert_eq!(mon.check_type, "content");
    assert_eq!(mon.check_period_ms, Some(300000));
    assert_eq!(mon.selector.as_deref(), Some(".price"));
    assert!(mon.enabled);

    let req = &server.requests()[0];
    assert_eq!(req.path, "/api/targets");
    assert_eq!(
        req.header("authorization").as_deref(),
        Some("Bearer wt_secret")
    );
    // The cloud ACCEPTS snake_case even though it ANSWERS camelCase.
    let body: Value = serde_json::from_slice(&req.body).unwrap();
    assert_eq!(body["check_period_ms"], 300000);
    assert_eq!(body["check_type"], "content");
}

// (h) every verb reaches its real path/method, and an unset option appends NO
// query at all — "?limit=" would 422 against a typed int.
#[tokio::test]
async fn cloud_monitor_verbs_route_to_real_paths() {
    let server = StubServer::start().await;
    server.route(
        "GET",
        "/api/targets",
        json_reply(200, json!([monitor_json()])),
    );
    server.route("GET", "/api/targets/412", json_reply(200, monitor_json()));
    server.route("PATCH", "/api/targets/412", json_reply(200, monitor_json()));
    server.route(
        "PATCH",
        "/api/targets/412/toggle",
        json_reply(200, monitor_json()),
    );
    server.route(
        "POST",
        "/api/targets/412/run",
        json_reply(200, json!({"ok": true, "dispatched": 2})),
    );
    server.route(
        "DELETE",
        "/api/targets/412",
        Reply::full(204, "application/json", Vec::new()),
    );
    // The two change routes answer DIFFERENT shapes and must be stubbed
    // separately. Serving one camelCase body for both is what hid a shipped bug:
    // the global feed's numeric `id` cannot deserialize into a String, so
    // `recent_changes` failed against every real response while this test passed.
    let changes = json!([{
        "id": "9", "targetId": "412", "timestamp": "2026-08-05T00:00:00Z",
        "firstDetectedAt": "2026-08-05T00:00:00Z", "lastDetectedAt": "2026-08-05T00:01:00Z",
        "oldContent": "$1,199", "newContent": "$1,099",
        "diff": "-$1,199\n+$1,099", "detectedBy": "1 agent"
    }]);
    // Verbatim RecentChangeInfo (backend/routers/targets.py).
    let recent = json!([{
        "id": 9, "target_id": 412, "target_url": "https://example.com/pricing",
        "target_selector_id": null, "selector_name": null,
        "diff_snippet": "-$1,199 +$1,099",
        "first_detected_at": "2026-08-05T00:00:00+00:00",
        "last_detected_at": "2026-08-05T00:01:00+00:00"
    }]);
    server.route("GET", "/api/targets/412/changes", json_reply(200, changes));
    server.route(
        "GET",
        "/api/targets/changes/recent",
        json_reply(200, recent),
    );

    let cloud = metered_for(&server, "wt_secret");
    let m = cloud.monitors();

    assert_eq!(
        m.list(&CloudMonitorListOptions::default())
            .await
            .unwrap()
            .len(),
        1
    );
    m.list(&CloudMonitorListOptions {
        enabled_only: true,
        limit: Some(50),
        ..Default::default()
    })
    .await
    .unwrap();
    m.get(412).await.unwrap();
    m.update(412, json!({"check_period_ms": 600000}))
        .await
        .unwrap();
    m.toggle(412, false).await.unwrap();

    let run = m.run(412).await.unwrap();
    assert!(run.ok);
    assert_eq!(run.dispatched, 2);

    let hist = m.changes(412, &ChangeListOptions::limit(25)).await.unwrap();
    assert_eq!(hist.len(), 1);
    assert_eq!(hist[0].new_content, "$1,099");
    assert_eq!(hist[0].target_id, "412");
    assert_eq!(
        hist[0].last_detected_at, "2026-08-05T00:01:00Z",
        "per-monitor change must expose the field the feed is ORDERED by"
    );

    // The regression this guards: every field below deserialized as a zero value
    // (or the whole call failed) while the global feed shared the per-monitor type.
    let recent = m
        .recent_changes(&ChangeListOptions::default())
        .await
        .unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].id, 9, "recent ids must decode as integers");
    assert_eq!(recent[0].target_id, 412);
    assert_eq!(recent[0].target_url, "https://example.com/pricing");
    assert_eq!(recent[0].diff_snippet.as_deref(), Some("-$1,199 +$1,099"));
    assert_eq!(
        recent[0].last_detected_at, "2026-08-05T00:01:00+00:00",
        "the cursor field must decode"
    );

    m.delete(412).await.unwrap();

    let seen: Vec<(String, String, Option<String>)> = server
        .requests()
        .iter()
        .map(|r| (r.method.clone(), r.path.clone(), r.query.clone()))
        .collect();
    let expected = vec![
        ("GET", "/api/targets", None),
        ("GET", "/api/targets", Some("enabled_only=true&limit=50")),
        ("GET", "/api/targets/412", None),
        ("PATCH", "/api/targets/412", None),
        ("PATCH", "/api/targets/412/toggle", Some("enabled=false")),
        ("POST", "/api/targets/412/run", None),
        ("GET", "/api/targets/412/changes", Some("limit=25")),
        ("GET", "/api/targets/changes/recent", None),
        ("DELETE", "/api/targets/412", None),
    ];
    assert_eq!(seen.len(), expected.len(), "calls: {seen:?}");
    for (i, (method, path, query)) in expected.into_iter().enumerate() {
        assert_eq!(seen[i].0, method, "call {i} method");
        assert_eq!(seen[i].1, path, "call {i} path");
        assert_eq!(seen[i].2.as_deref(), query, "call {i} query");
    }
}

// (i) the keyless tier has no account to own a monitor: every verb fails BEFORE
// the network call, so the stub records nothing.
#[tokio::test]
async fn cloud_monitors_keyless_refuses_without_any_request() {
    let server = StubServer::start().await;
    let cloud = keyless_for(&server);
    let m = cloud.monitors();

    let errs: Vec<WritError> = vec![
        m.list(&CloudMonitorListOptions::default())
            .await
            .unwrap_err(),
        m.create(json!({"url": "https://x.test"}))
            .await
            .unwrap_err(),
        m.get(1).await.unwrap_err(),
        m.update(1, json!({})).await.unwrap_err(),
        m.delete(1).await.unwrap_err(),
        m.toggle(1, true).await.unwrap_err(),
        m.run(1).await.unwrap_err(),
        m.changes(1, &ChangeListOptions::default())
            .await
            .unwrap_err(),
        m.recent_changes(&ChangeListOptions::default())
            .await
            .unwrap_err(),
    ];
    for err in &errs {
        assert!(
            matches!(err, WritError::ApiKeyRequired { .. }),
            "expected ApiKeyRequired, got {err:?}"
        );
    }
    assert!(
        server.requests().is_empty(),
        "keyless must not hit the network"
    );
}

// (j) `brand` arrives in TWO shapes — the LOCAL daemon sends a bare string, the
// CLOUD sends {"crawl","agent"}. Typing it as a plain String made crawl() fail
// to decode against the real coordinator, so lock both shapes.
#[tokio::test]
async fn crawl_job_brand_accepts_string_and_object() {
    let server = StubServer::start().await;
    server.route_seq(
        "POST",
        "/api/crawl",
        vec![
            json_reply(
                200,
                json!({"id": 1, "seed_url": "https://a.test", "brand": "Dragnet"}),
            ),
            json_reply(
                200,
                json!({"id": 2, "seed_url": "https://b.test",
                       "brand": {"crawl": "Dragnet", "agent": "Scribe"}}),
            ),
            json_reply(
                200,
                json!({"id": 3, "seed_url": "https://c.test", "brand": null}),
            ),
        ],
    );
    let cloud = metered_for(&server, "wt_secret");
    let params = CrawlStartParams {
        url: "https://a.test".into(),
        ..Default::default()
    };

    let daemon_shape = cloud.crawl(&params).await.unwrap();
    assert_eq!(daemon_shape.brand.crawl(), "Dragnet");
    assert_eq!(daemon_shape.brand.agent(), None);

    let cloud_shape = cloud.crawl(&params).await.unwrap();
    assert_eq!(cloud_shape.brand.crawl(), "Dragnet");
    assert_eq!(cloud_shape.brand.agent(), Some("Scribe"));

    // A missing label must never fail a whole crawl view.
    let absent = cloud.crawl(&params).await.unwrap();
    assert_eq!(absent.brand.crawl(), "");
}

// (k) A 402 is either a wallet problem or a PLAN CEILING, and they need
// different fixes. The plan denial is the one that reports a numeric `limit`.
#[tokio::test]
async fn payment_required_splits_plan_limit_from_credits() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/api/targets",
        json_reply(
            402,
            json!({"detail": "Check interval too short. Minimum for your plan: 10s.",
                   "code": "interval_too_short", "current": 1000, "limit": 10000,
                   "upgrade_hint": "growth"}),
        ),
    );
    let cloud = metered_for(&server, "wt_secret");
    let err = cloud
        .monitors()
        .create(json!({"url": "https://x.test", "check_period_ms": 1000}))
        .await
        .unwrap_err();
    match err {
        WritError::PlanLimit {
            code,
            limit,
            current,
            upgrade_hint,
            ..
        } => {
            assert_eq!(code, "interval_too_short");
            assert_eq!(limit, 10_000);
            assert_eq!(current, 1_000);
            assert_eq!(upgrade_hint.as_deref(), Some("growth"));
        }
        other => panic!("expected PlanLimit, got {other:?}"),
    }

    let server2 = StubServer::start().await;
    server2.route(
        "POST",
        "/api/crawl/scrape",
        json_reply(
            402,
            json!({"detail": {"message": "allotment spent", "code": "insufficient_credits"}}),
        ),
    );
    let cloud2 = metered_for(&server2, "wt_secret");
    let err2 = cloud2.scrape("https://x.test").await.unwrap_err();
    assert!(
        matches!(err2, WritError::InsufficientCredits { .. }),
        "a wallet 402 must stay InsufficientCredits, got {err2:?}"
    );
}
