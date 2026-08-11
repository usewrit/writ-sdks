//! Env-gated LIVE test: drives `CloudClient::monitors` and `CloudClient::crawl`
//! against a REAL running coordinator. No stub server — this is the test that
//! catches a wrong path, a wrong JSON casing, or a scope the route map never
//! mapped. (It is how the `brand` shape bug and the 402 misclassification were
//! found: both decoded fine against a hand-written stub body.)
//!
//! ```sh
//! WRIT_E2E=1 WRIT_CLOUD_URL=http://localhost:8000 WRIT_API_KEY=wt_… \
//!   cargo test --test cloud_live -- --nocapture
//! ```
//!
//! The key needs monitors:read/write/execute/delete and crawl:read/execute.
//! Skipped (not failed) when `WRIT_E2E` is unset, so `cargo test` stays hermetic.

use std::time::Duration;

use serde_json::json;
use writ_client::{
    ChangeListOptions, CloudClient, CloudMonitorListOptions, CloudTier, CrawlStartParams, WritError,
};

/// example.com is the one seed guaranteed to answer 200 — the API fetches the
/// page to establish a baseline, so a 404 seed is rejected outright.
const SEED: &str = "https://example.com";

fn live_client() -> Option<CloudClient> {
    if std::env::var("WRIT_E2E").ok().as_deref() != Some("1") {
        eprintln!("cloud_live: skipped (set WRIT_E2E=1 to run against a live coordinator)");
        return None;
    }
    let url = std::env::var("WRIT_CLOUD_URL").unwrap_or_else(|_| "http://localhost:8000".into());
    let key = std::env::var("WRIT_API_KEY").expect("WRIT_E2E=1 requires WRIT_API_KEY");
    Some(
        CloudClient::builder()
            .cloud_url(url)
            .api_key(key)
            .timeout(Duration::from_secs(30))
            .build()
            .expect("build metered cloud client"),
    )
}

#[tokio::test]
async fn cloud_monitor_lifecycle_against_live_coordinator() {
    let Some(cloud) = live_client() else { return };
    assert_eq!(cloud.tier(), CloudTier::Metered);
    let monitors = cloud.monitors();

    let mon = monitors
        .create(json!({
            "url": SEED,
            "check_type": "content",
            "selector": "h1",
            "check_period_ms": 300_000
        }))
        .await
        .expect("create a cloud monitor");

    // The serde tags in cloud.rs claim camelCase — assert the server agrees.
    assert_eq!(mon.check_period_ms, Some(300_000));
    assert_eq!(mon.selector.as_deref(), Some("h1"));
    assert!(mon.enabled);

    let listed = monitors
        .list(&CloudMonitorListOptions {
            limit: Some(100),
            ..Default::default()
        })
        .await
        .expect("list cloud monitors");
    assert!(listed.iter().any(|m| m.id == mon.id));

    let got = monitors.get(mon.id).await.expect("get");
    assert_eq!(got.url, SEED);

    let updated = monitors
        .update(mon.id, json!({"check_period_ms": 600_000}))
        .await
        .expect("update");
    assert_eq!(updated.check_period_ms, Some(600_000));

    assert!(!monitors.toggle(mon.id, false).await.expect("pause").enabled);
    assert!(monitors.toggle(mon.id, true).await.expect("resume").enabled);

    monitors.run(mon.id).await.expect("check now");
    monitors
        .changes(mon.id, &ChangeListOptions::limit(5))
        .await
        .expect("changes");
    monitors
        .recent_changes(&ChangeListOptions::limit(5))
        .await
        .expect("recent changes");

    monitors.delete(mon.id).await.expect("delete");
    let after = monitors
        .list(&CloudMonitorListOptions {
            limit: Some(100),
            ..Default::default()
        })
        .await
        .expect("list after delete");
    assert!(!after.iter().any(|m| m.id == mon.id));
}

#[tokio::test]
async fn plan_interval_floor_surfaces_as_plan_limit_not_credits() {
    let Some(cloud) = live_client() else { return };

    // plan_enforcer REJECTS a sub-floor interval rather than clamping it, and it
    // is a PLAN ceiling — calling it "insufficient credits" would send the caller
    // to top up a wallet that was never the problem.
    let err = cloud
        .monitors()
        .create(json!({"url": SEED, "check_period_ms": 1000}))
        .await
        .expect_err("a sub-floor interval must be rejected");
    match err {
        WritError::PlanLimit { code, limit, .. } => {
            assert_eq!(code, "interval_too_short");
            assert!(limit > 0, "the ceiling should be reported, got {limit}");
        }
        other => panic!("expected PlanLimit, got {other:?}"),
    }
}

#[tokio::test]
async fn crawl_decodes_the_cloud_brand_object() {
    let Some(cloud) = live_client() else { return };

    // The cloud sends brand as {"crawl","agent"} while the daemon sends a bare
    // string. Typing it as String made this call fail outright.
    let job = cloud
        .crawl(&CrawlStartParams {
            url: SEED.into(),
            max_depth: Some(0),
            page_budget: Some(1),
            ..Default::default()
        })
        .await
        .expect("start a crawl");
    assert!(
        !job.brand.crawl().is_empty(),
        "cloud brand carries a crawl name"
    );

    let status = cloud.crawl_status(job.id).await.expect("poll crawl status");
    assert!(status.seed_url.contains("example.com"));
}
