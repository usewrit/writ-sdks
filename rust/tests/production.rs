//! Production-readiness behaviour: retry, idempotency, cursor watching.
//!
//! Webhook verification is covered by unit tests in `src/webhook.rs`, where it
//! needs no server.

#[allow(dead_code)]
mod stub;

use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use writ_client::{ChangeListOptions, CloudClient, RetryPolicy, WatchOptions};

use stub::{Reply, StubServer};

fn json_reply(status: u16, body: Value) -> Reply {
    Reply::full(status, "application/json", body.to_string().into_bytes())
}

fn fast_retry() -> RetryPolicy {
    RetryPolicy {
        max_attempts: 4,
        base_delay: Duration::from_millis(1),
        max_delay: Duration::from_millis(5),
        ..RetryPolicy::default()
    }
}

fn metered(server: &StubServer, retry: RetryPolicy) -> CloudClient {
    CloudClient::builder()
        .cloud_url(server.base_url())
        .api_key("wt_test")
        .timeout(Duration::from_secs(5))
        .retry(retry)
        .build()
        .expect("build metered client")
}

/// A transient 503 must not surface when a retry would clear it.
#[tokio::test]
async fn transient_server_error_is_retried() {
    let server = StubServer::start().await;
    server.route_seq(
        "GET",
        "/api/targets",
        vec![
            Reply::full(503, "application/json", b"{}".to_vec()),
            Reply::full(503, "application/json", b"{}".to_vec()),
            json_reply(200, json!([])),
        ],
    );

    let cloud = metered(&server, fast_retry());
    cloud
        .monitors()
        .list(&Default::default())
        .await
        .expect("the third attempt should succeed");
    assert_eq!(server.requests().len(), 3, "expected two retries");
}

/// Every attempt of one logical unsafe call must carry the SAME
/// `Idempotency-Key`. If the key changed, the server would execute twice — which
/// is precisely what retrying a POST must never cause.
#[tokio::test]
async fn unsafe_cloud_call_retries_under_one_stable_idempotency_key() {
    let server = StubServer::start().await;
    server.route_seq(
        "POST",
        "/api/targets",
        vec![
            Reply::full(502, "application/json", b"{}".to_vec()),
            json_reply(200, json!({"id": 7, "url": "https://example.com"})),
        ],
    );

    let cloud = metered(&server, fast_retry());
    let created = cloud
        .monitors()
        .create(json!({"url": "https://example.com"}))
        .await
        .expect("retry should succeed");
    assert_eq!(created.id, 7);

    let seen = server.requests();
    assert_eq!(seen.len(), 2, "expected exactly one retry");
    let first = seen[0].header("idempotency-key");
    let second = seen[1].header("idempotency-key");
    assert!(
        first.is_some(),
        "an unsafe cloud request must carry an Idempotency-Key"
    );
    assert_eq!(first, second, "the retry changed the Idempotency-Key");
}

/// A `Retry-After` far in the future means the condition will not clear.
/// Sleeping on it is worse than handing back the response, which carries the
/// reset time.
#[tokio::test]
async fn long_retry_after_is_not_slept_on() {
    let server = StubServer::start().await;
    server.route(
        "GET",
        "/api/targets",
        Reply::Full {
            status: 429,
            content_type: "application/json",
            body: json!({"detail": {"code": "rate_limited", "message": "daily allowance spent"}})
                .to_string()
                .into_bytes(),
        },
    );

    // The stub cannot set arbitrary headers, so this asserts the shape that does
    // NOT depend on Retry-After: a 429 is retried a bounded number of times and
    // still surfaces as an error rather than hanging.
    let started = Instant::now();
    let cloud = metered(&server, fast_retry());
    let err = cloud
        .monitors()
        .list(&Default::default())
        .await
        .unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(2), "retry hung");
    assert!(format!("{err}").contains("rate"), "unexpected error: {err}");
}

/// Rows for a keyset feed stub: `no cursor` = newest-first browsing view,
/// `since` = oldest-first keyset walk. Mirrors the server exactly.
fn feed_rows(n: i64) -> Vec<Value> {
    (1..=n)
        .map(|i| {
            json!({
                "id": i,
                "target_id": 1,
                "target_url": "https://a",
                "target_selector_id": null,
                "selector_name": null,
                "diff_snippet": null,
                "first_detected_at": format!("2026-08-05T00:00:0{i}Z"),
                "last_detected_at": format!("2026-08-05T00:00:0{i}Z"),
            })
        })
        .collect()
}

/// `watch` must walk the cursor forward: no gaps when a page fills, no repeats,
/// and the cursor advancing on `(last_detected_at, id)`.
#[tokio::test]
async fn watch_walks_the_cursor_without_gaps_or_repeats() {
    let server = StubServer::start().await;
    let rows = feed_rows(5);

    // page_size 2 forces three pages — the exact case a naive newest-first
    // poller drops rows on. The stub replays a fixed sequence, which is enough
    // to prove the cursor advances and nothing is delivered twice.
    server.route_seq(
        "GET",
        "/api/targets/changes/recent",
        vec![
            json_reply(200, json!([rows[0], rows[1]])),
            json_reply(200, json!([rows[2], rows[3]])),
            json_reply(200, json!([rows[4]])),
            json_reply(200, json!([])),
        ],
    );

    let cloud = metered(&server, RetryPolicy::off());
    let monitors = cloud.monitors();
    let feed = monitors.watch(WatchOptions {
        page_size: 2,
        interval: Duration::from_millis(5),
        replay_history: true,
        ..WatchOptions::default()
    });
    futures_util::pin_mut!(feed);

    let mut seen = Vec::new();
    while let Some(change) = feed.next().await {
        seen.push(change.expect("watch item").id);
        if seen.len() == 5 {
            break;
        }
    }
    assert_eq!(seen, vec![1, 2, 3, 4, 5]);

    // Replaying history must start from the cursor FLOOR, not from "no cursor" —
    // the no-cursor view is newest-first and would walk backwards.
    let first = &server.requests()[0];
    let query = first.query.clone().unwrap_or_default();
    assert!(
        query.contains("since="),
        "replay must send a floor cursor, got query {query:?}"
    );
}

/// A fresh watcher opens on the head of the feed, not on the whole archive.
#[tokio::test]
async fn watch_starts_at_the_head_by_default() {
    let server = StubServer::start().await;
    let rows = feed_rows(3);
    server.route_seq(
        "GET",
        "/api/targets/changes/recent",
        vec![
            // Bootstrap read: the newest row (no cursor → newest-first).
            json_reply(200, json!([rows[2]])),
            // Then nothing new.
            json_reply(200, json!([])),
        ],
    );

    let cloud = metered(&server, RetryPolicy::off());
    let monitors = cloud.monitors();
    let feed = monitors.watch(WatchOptions {
        interval: Duration::from_millis(5),
        ..WatchOptions::default()
    });
    futures_util::pin_mut!(feed);

    // Give the watcher time to bootstrap and poll once; it must deliver nothing.
    let delivered = tokio::time::timeout(Duration::from_millis(200), feed.next()).await;
    assert!(
        delivered.is_err(),
        "a head-started watcher must not deliver pre-existing history"
    );

    let seen = server.requests();
    assert!(seen.len() >= 2, "watcher did not bootstrap then poll");
    let bootstrap = seen[0].query.clone().unwrap_or_default();
    assert!(
        bootstrap.contains("limit=1") && !bootstrap.contains("since="),
        "bootstrap must read the feed head with no cursor, got {bootstrap:?}"
    );
    let follow_up = seen[1].query.clone().unwrap_or_default();
    assert!(
        follow_up.contains("since=") && follow_up.contains("since_id=3"),
        "watcher must resume from the head row, got {follow_up:?}"
    );
}

/// `ChangeListOptions` must actually reach the wire — a cursor the SDK drops
/// silently turns an incremental poll into a full re-read.
#[tokio::test]
async fn change_cursor_reaches_the_wire() {
    let server = StubServer::start().await;
    server.route(
        "GET",
        "/api/targets/changes/recent",
        json_reply(200, json!([])),
    );

    let cloud = metered(&server, RetryPolicy::off());
    cloud
        .monitors()
        .recent_changes(&ChangeListOptions {
            limit: Some(10),
            since: Some("2026-08-05T00:00:00Z".into()),
            since_id: Some(4),
        })
        .await
        .expect("recent_changes");

    let query = server.requests()[0].query.clone().unwrap_or_default();
    assert!(query.contains("limit=10"), "{query}");
    assert!(query.contains("since_id=4"), "{query}");
    assert!(query.contains("since="), "{query}");
}
