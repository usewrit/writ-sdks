//! Env-gated live smoke test (DESIGN.md §9): discovers the real local daemon and
//! makes three read-only calls. Skipped unless `WRIT_SMOKE=1`.
//!
//! ```sh
//! WRIT_SMOKE=1 cargo test --test live_smoke -- --nocapture
//! ```

use writ_client::WritAgent;

#[tokio::test]
async fn live_smoke() {
    if std::env::var("WRIT_SMOKE").ok().as_deref() != Some("1") {
        eprintln!("live_smoke: skipped (set WRIT_SMOKE=1 to run against a live daemon)");
        return;
    }

    let agent = WritAgent::discover().await.expect("discover a live daemon");
    eprintln!("live_smoke: discovered daemon at {}", agent.base_url());

    let status = agent.agent().status().await.expect("agent.status()");
    assert_eq!(status.status, "ok");
    eprintln!(
        "live_smoke: agent ok — version {:?}, active_runs {:?}",
        status.version, status.active_runs
    );

    let workflows = agent.workflows().list().await.expect("workflows.list()");
    eprintln!("live_smoke: {} workflow(s)", workflows.count);

    let runs = agent
        .runs()
        .list_with(&[("limit", "1")])
        .await
        .expect("runs.list(limit=1)");
    eprintln!(
        "live_smoke: runs page count={} total={:?}",
        runs.count, runs.total
    );
    if let Some(run) = runs.data.first() {
        assert!(
            run.row_id().is_some(),
            "composite run id parses: {}",
            run.id
        );
    }
}
