//! Integration tests against a minimal in-crate HTTP/1.1 stub server (no wiremock),
//! covering DESIGN.md §9: discovery, headers, envelope normalization, error
//! mapping, run/run_and_wait over SSE and polling, CSV/bytes lanes, multipart.
//!
//! Env-var-touching discovery tests are process-global, so they all serialize on
//! [`stub::env_lock`].

// Justified: the discovery tests deliberately hold the process-global env lock
// across `WritAgent::discover().await` — env vars ARE process-global state, so the
// mutation and the discovery call must sit under the same critical section. Each
// `#[tokio::test]` runs on its own OS thread with its own single-threaded runtime,
// so a std `MutexGuard` held across an await cannot deadlock the executor here.
#![allow(clippy::await_holding_lock)]

mod stub;

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};
use writ_client::{
    CrawlStartParams, Page, RunEvent, RunFeedItem, RunOptions, WritAgent, WritError,
};

use stub::{Reply, StubServer};

const TOKEN: &str = "wlt_test_token";

/// A client wired to the stub with the standard test token.
fn client_for(server: &StubServer) -> WritAgent {
    WritAgent::builder()
        .base_url(server.base_url())
        .token(TOKEN)
        .timeout(Duration::from_secs(5))
        .build()
        .expect("build client")
}

fn json_reply(status: u16, body: Value) -> Reply {
    Reply::full(status, "application/json", body.to_string().into_bytes())
}

// ---------------------------------------------------------------------------
// §9.2 — auth header + User-Agent on the wire.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sends_bearer_and_user_agent_headers() {
    let server = StubServer::start().await;
    server.route(
        "GET",
        "/v1/agent",
        json_reply(
            200,
            json!({"status": "ok", "version": "1.2.3", "active_runs": 0}),
        ),
    );
    let agent = client_for(&server);

    let status = agent.agent().status().await.unwrap();
    assert_eq!(status.status, "ok");
    assert_eq!(status.version.as_deref(), Some("1.2.3"));

    let reqs = server.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(
        reqs[0].header("authorization").as_deref(),
        Some(&*format!("Bearer {TOKEN}"))
    );
    assert_eq!(
        reqs[0].header("user-agent").as_deref(),
        Some(concat!("writ-sdk-rust/", env!("CARGO_PKG_VERSION")))
    );
}

// ---------------------------------------------------------------------------
// §9.3 — envelope normalization: three wire shapes → one Page.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn page_from_data_count_envelope() {
    let server = StubServer::start().await;
    server.route(
        "GET",
        "/v1/workflows",
        json_reply(
            200,
            json!({"data": [
                {"id": 1, "name": "a", "steps": []},
                {"id": 2, "name": "b", "steps": []}
            ], "count": 2}),
        ),
    );
    let agent = client_for(&server);
    let page = agent.workflows().list().await.unwrap();
    assert_eq!(page.count, 2);
    assert_eq!(page.total, None);
    assert_eq!(page.data[1].name, "b");
}

#[tokio::test]
async fn page_from_data_count_total_envelope() {
    let server = StubServer::start().await;
    server.route(
        "GET",
        "/v1/runs",
        json_reply(
            200,
            json!({"data": [
                {"id": "workflow-3", "run_type": "workflow", "status": "success"}
            ], "count": 1, "total": 40}),
        ),
    );
    let agent = client_for(&server);
    let page = agent.runs().list_with(&[("limit", "1")]).await.unwrap();
    assert_eq!(page.count, 1);
    assert_eq!(page.total, Some(40));
    assert_eq!(page.data[0].row_id(), Some(3));
    // Query params pass through as given.
    let req = &server.requests()[0];
    assert_eq!(req.query.as_deref(), Some("limit=1"));
}

#[tokio::test]
async fn page_from_bare_array() {
    let server = StubServer::start().await;
    server.route(
        "GET",
        "/v1/monitors",
        json_reply(
            200,
            json!([
                {"id": 10, "url": "https://a.test", "enabled": 1},
                {"id": 11, "url": "https://b.test", "enabled": 0},
                {"id": 12, "url": "https://c.test"}
            ]),
        ),
    );
    let agent = client_for(&server);
    let page = agent.monitors().list().await.unwrap();
    assert_eq!(page.count, 3, "bare array synthesizes count");
    assert_eq!(page.total, None);
    assert_eq!(page.data[0].url.as_deref(), Some("https://a.test"));
}

// ---------------------------------------------------------------------------
// §9.4 — error mapping.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn json_domain_error_maps_to_api_error() {
    let server = StubServer::start().await;
    server.route(
        "GET",
        "/v1/workflows/999999",
        json_reply(
            404,
            json!({"error": "not found: workflow 999999", "code": "not_found"}),
        ),
    );
    let agent = client_for(&server);
    let err = agent.workflows().get(999_999).await.unwrap_err();
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
        other => panic!("expected Api error, got {other:?}"),
    }
}

#[tokio::test]
async fn plain_text_axum_rejection_maps_with_status_derived_code() {
    let server = StubServer::start().await;
    let text = "Failed to deserialize the JSON body into the target type: missing field `url`";
    server.route(
        "POST",
        "/v1/monitors",
        Reply::full(422, "text/plain; charset=utf-8", text.as_bytes().to_vec()),
    );
    let agent = client_for(&server);
    let err = agent.monitors().create(json!({})).await.unwrap_err();
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
        other => panic!("expected Api error, got {other:?}"),
    }
}

#[tokio::test]
async fn connection_refused_maps_to_connection_error() {
    // Bind + drop a listener so the port is (almost certainly) closed.
    let closed = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap()
    };
    let agent = WritAgent::builder()
        .base_url(format!("http://{closed}"))
        .token(TOKEN)
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let err = agent.agent().status().await.unwrap_err();
    assert!(matches!(err, WritError::Connection(_)), "got {err:?}");
}

// ---------------------------------------------------------------------------
// §9.5 — run 202, run_and_wait over SSE and via the polling fallback.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn run_returns_202_shape() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/workflows/7/run",
        json_reply(202, json!({"run_id": 31, "status": "running"})),
    );
    let agent = client_for(&server);
    let started = agent
        .workflows()
        .run(
            7,
            &RunOptions {
                inputs: Some(json!({"city": "Paris"})),
                persona_id: Some(2),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(started.run_id, 31);
    assert_eq!(started.status, "running");
    // Wire body: inputs + persona_id, no dry_run key.
    let req = &server.requests()[0];
    let body: Value = serde_json::from_slice(&req.body).unwrap();
    assert_eq!(body["inputs"]["city"], "Paris");
    assert_eq!(body["persona_id"], 2);
    assert!(body.get("dry_run").is_none());
}

/// Happy path: 202 → SSE started/step/finished (with keep-alive comments and a
/// multi-`data:` frame) → one final `runs.get`. No polling.
#[tokio::test]
async fn run_and_wait_over_sse() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/workflows/7/run",
        json_reply(202, json!({"run_id": 9, "status": "running"})),
    );
    let sse_body = concat!(
        ": keep-alive\n",
        "event: started\ndata: {\"event\":\"started\",\"run_id\":9,\"total_steps\":2}\n\n",
        "id: 1\nretry: 3000\n",
        "event: step\ndata: {\"event\":\"step\",\"run_id\":9,\"index\":0,\"step_type\":\"navigate\",\"status\":\"succeeded\"}\n\n",
        ": keep-alive\n",
        // Multi-data frame — the two lines join with \n into one JSON payload.
        "event: progress\ndata: {\"event\":\"progress\",\ndata: \"run_id\":9,\"completed\":1,\"total\":2}\n\n",
        "event: finished\ndata: {\"event\":\"finished\",\"run_id\":9,\"status\":\"success\"}\n\n",
    );
    server.route(
        "GET",
        "/v1/runs/9/events",
        Reply::sse(vec![(sse_body.as_bytes().to_vec(), 0)]),
    );
    server.route(
        "GET",
        "/v1/runs/9",
        json_reply(
            200,
            json!({"id": "workflow-9", "status": "success", "run_type": "workflow"}),
        ),
    );
    server.route(
        "GET",
        "/v1/runs/9/results",
        json_reply(
            200,
            json!({"run_id": 9, "status": "success", "result": {"extracted_data": {"k": "v"}}}),
        ),
    );

    let agent = client_for(&server);
    let outcome = agent
        .workflows()
        .run_and_wait(
            7,
            &RunOptions {
                include_results: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(outcome.run.status, "success");
    assert_eq!(outcome.run.row_id(), Some(9));
    let results = outcome.results.expect("include_results fetches results");
    assert_eq!(results.result["extracted_data"]["k"], "v");

    // SSE delivered the terminal — exactly one poll-style GET (the final fetch).
    let gets = server
        .requests()
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/v1/runs/9")
        .count();
    assert_eq!(gets, 1, "no polling on the SSE happy path");
}

/// SSE drops pre-terminal → the helper falls back to 1 s polling until the run
/// leaves `running`.
#[tokio::test]
async fn run_and_wait_polling_fallback_when_sse_drops() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/workflows/7/run",
        json_reply(202, json!({"run_id": 12, "status": "running"})),
    );
    // Stream sends `started` then closes WITHOUT a terminal frame.
    let dropped =
        "event: started\ndata: {\"event\":\"started\",\"run_id\":12,\"total_steps\":3}\n\n";
    server.route(
        "GET",
        "/v1/runs/12/events",
        Reply::sse(vec![(dropped.as_bytes().to_vec(), 0)]),
    );
    // Poll sequence: running → running → success (then the final fetch re-reads success).
    server.route_seq(
        "GET",
        "/v1/runs/12",
        vec![
            json_reply(200, json!({"id": "workflow-12", "status": "running"})),
            json_reply(200, json!({"id": "workflow-12", "status": "running"})),
            json_reply(
                200,
                json!({"id": "workflow-12", "status": "success", "duration_ms": 2100}),
            ),
        ],
    );

    let agent = client_for(&server);
    let outcome = agent
        .workflows()
        .run_and_wait(7, &RunOptions::default())
        .await
        .unwrap();
    assert_eq!(outcome.run.status, "success");
    assert!(outcome.results.is_none());

    let gets = server
        .requests()
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/v1/runs/12")
        .count();
    assert!(gets >= 3, "expected polling + final fetch, saw {gets} GETs");
}

/// The overall deadline times out without cancelling the run.
#[tokio::test]
async fn run_and_wait_times_out_and_does_not_cancel() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/workflows/7/run",
        json_reply(202, json!({"run_id": 13, "status": "running"})),
    );
    server.route(
        "GET",
        "/v1/runs/13/events",
        Reply::sse(vec![(b": keep-alive\n".to_vec(), 0)]),
    ); // closes, no terminal
    server.route(
        "GET",
        "/v1/runs/13",
        json_reply(200, json!({"id": "workflow-13", "status": "running"})),
    );

    let agent = client_for(&server);
    let err = agent
        .workflows()
        .run_and_wait(
            7,
            &RunOptions {
                wait_timeout: Some(Duration::from_millis(1500)),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, WritError::Connection(ref m) if m.contains("NOT cancelled")),
        "got {err:?}"
    );
    // No cancel call was ever issued.
    assert!(
        !server.requests().iter().any(|r| r.path.contains("cancel")),
        "run_and_wait must never auto-cancel"
    );
}

/// A run that is already finished yields exactly one terminal frame, then the
/// stream ends.
#[tokio::test]
async fn events_stream_ends_after_terminal_frame() {
    let server = StubServer::start().await;
    let body =
        "event: finished\ndata: {\"event\":\"finished\",\"run_id\":5,\"status\":\"success\"}\n\n";
    server.route(
        "GET",
        "/v1/runs/5/events",
        Reply::sse(vec![(body.as_bytes().to_vec(), 0)]),
    );
    let agent = client_for(&server);

    let mut stream = agent.runs().events(5).await.unwrap();
    let first = stream.next().await.expect("one frame").unwrap();
    assert_eq!(
        first,
        RunEvent::Finished {
            run_id: 5,
            status: "success".into()
        }
    );
    assert!(
        stream.next().await.is_none(),
        "stream must end after the terminal frame"
    );
}

// ---------------------------------------------------------------------------
// Cancel: 409 not_running is a result, not an error.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cancel_409_not_running_is_ok() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/runs/3/cancel",
        json_reply(
            409,
            json!({"run_id": 3, "status": "not_running", "run_status": "success"}),
        ),
    );
    server.route(
        "POST",
        "/v1/runs/4/cancel",
        json_reply(202, json!({"run_id": 4, "status": "cancel_requested"})),
    );
    let agent = client_for(&server);

    let done = agent.runs().cancel(3).await.unwrap();
    assert_eq!(done.status, "not_running");
    assert_eq!(done.run_status.as_deref(), Some("success"));
    assert!(!done.cancel_requested());

    let live = agent.runs().cancel(4).await.unwrap();
    assert!(live.cancel_requested());
    assert_eq!(live.run_id, Some(4));
}

// ---------------------------------------------------------------------------
// §9.6 — CSV lane returns raw text; file content returns bytes.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn runs_data_csv_returns_raw_text() {
    let server = StubServer::start().await;
    let csv = "run_id,title,price\n3,A,10\n3,B,20\n";
    server.route(
        "GET",
        "/v1/runs/3/data",
        Reply::full(200, "text/csv; charset=utf-8", csv.as_bytes().to_vec()),
    );
    let agent = client_for(&server);
    let out = agent.runs().data_csv(3).await.unwrap();
    assert_eq!(out, csv);
    assert_eq!(server.requests()[0].query.as_deref(), Some("format=csv"));
}

#[tokio::test]
async fn files_content_returns_bytes_intact() {
    let server = StubServer::start().await;
    let blob: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
    server.route(
        "GET",
        "/v1/files/file_abc/content",
        Reply::full(200, "application/octet-stream", blob.clone()),
    );
    let agent = client_for(&server);
    let bytes = agent.files().content("file_abc").await.unwrap();
    assert_eq!(
        bytes.as_ref(),
        blob.as_slice(),
        "binary payload must round-trip untouched"
    );
}

// ---------------------------------------------------------------------------
// §9.7 — multipart upload sends a well-formed body.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn multipart_upload_wire_format() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/files",
        json_reply(
            200,
            json!({"id": "file_1", "object": "file", "filename": "report.csv", "bytes": 12}),
        ),
    );
    let agent = client_for(&server);
    let content = b"a,b\n1,2\n3,4\n".to_vec();
    let stored = agent
        .files()
        .upload("report.csv", content.clone(), Some("text/csv"), Some("api"))
        .await
        .unwrap();
    assert_eq!(stored.id, "file_1");

    let req = &server.requests()[0];
    let ct = req.header("content-type").expect("content-type header");
    assert!(ct.starts_with("multipart/form-data; boundary="), "got {ct}");
    let boundary = ct.split("boundary=").nth(1).unwrap().to_string();
    let body = String::from_utf8_lossy(&req.body);
    assert!(
        body.contains(&format!("--{boundary}")),
        "body uses the declared boundary"
    );
    assert!(body.contains("name=\"file\""), "file part present");
    assert!(
        body.contains("filename=\"report.csv\""),
        "filename preserved"
    );
    assert!(
        body.contains("Content-Type: text/csv"),
        "part content type set"
    );
    assert!(body.contains("a,b\n1,2\n3,4\n"), "file bytes intact");
    assert!(
        body.contains("name=\"source\"") && body.contains("api"),
        "source text part present"
    );
    assert!(
        body.ends_with(&format!("--{boundary}--\r\n")),
        "closing boundary present"
    );
}

// ---------------------------------------------------------------------------
// ws-ticket + misc surface smoke against the stub.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ws_ticket_mints() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/ws-ticket",
        json_reply(200, json!({"ticket": "wtk_x", "expires_in_secs": 30})),
    );
    let agent = client_for(&server);
    let ticket = agent.ws_ticket("ai-preview", Some("ai-7")).await.unwrap();
    assert_eq!(ticket.ticket, "wtk_x");
    assert_eq!(ticket.expires_in_secs, 30);
    let body: Value = serde_json::from_slice(&server.requests()[0].body).unwrap();
    assert_eq!(body["route"], "ai-preview");
    assert_eq!(body["channel"], "ai-7");
}

#[tokio::test]
async fn trailing_slash_on_base_url_is_stripped() {
    let server = StubServer::start().await;
    server.route("GET", "/v1/agent", json_reply(200, json!({"status": "ok"})));
    let agent = WritAgent::builder()
        .base_url(format!("{}/", server.base_url()))
        .token(TOKEN)
        .build()
        .unwrap();
    agent.agent().status().await.unwrap();
    assert_eq!(server.requests()[0].path, "/v1/agent");
}

// ---------------------------------------------------------------------------
// crawl (Dragnet) resource — non-Page list, start body, get, cancel, 404.
// ---------------------------------------------------------------------------

/// A crawl status view as the daemon's `to_view` emits it.
fn crawl_view(id: i64, status: &str) -> Value {
    json!({
        "id": id,
        "name": "Dragnet: example.com",
        "seed_url": "https://example.com",
        "include_paths": ["^/docs"],
        "exclude_paths": [],
        "max_depth": 3,
        "same_domain": 1,
        "allow_subdomains": 1,
        "extract_mode": "markdown",
        "extract_schema": null,
        "persona_id": null,
        "respect_robots": 1,
        "delay_ms": 250,
        "max_concurrent": 4,
        "page_budget": 500,
        "workflow_id": 77,
        "data_workflow_id": 77,
        "concierge_session_id": null,
        "status": status,
        "pages_discovered": 0,
        "pages_done": 0,
        "pages_failed": 0,
        "pages_skipped": 0,
        "workers_active": 0,
        "current_depth": 0,
        "error": null,
        "cancel_requested": 0,
        "brand": "Dragnet",
        "is_terminal": false,
        "created_at": "2026-07-13T00:00:00Z",
        "updated_at": null,
        "started_at": null,
        "completed_at": null
    })
}

#[tokio::test]
async fn crawl_list_unwraps_crawls_envelope() {
    let server = StubServer::start().await;
    server.route(
        "GET",
        "/v1/crawl",
        json_reply(
            200,
            json!({"crawls": [crawl_view(1, "queued"), crawl_view(2, "crawling")]}),
        ),
    );
    let agent = client_for(&server);
    let list = agent.crawl().list(Some(50)).await.unwrap();
    assert_eq!(list.crawls.len(), 2);
    assert_eq!(list.crawls[0].brand, "Dragnet");
    assert_eq!(list.crawls[1].status, "crawling");
    // `limit` passes through; boolean columns stay typed as 0/1 ints.
    assert_eq!(server.requests()[0].query.as_deref(), Some("limit=50"));
    assert_eq!(list.crawls[0].same_domain, 1);
}

#[tokio::test]
async fn crawl_start_sends_body_and_parses_view() {
    let server = StubServer::start().await;
    server.route("POST", "/v1/crawl", json_reply(200, crawl_view(5, "queued")));
    let agent = client_for(&server);
    let job = agent
        .crawl()
        .start(CrawlStartParams {
            url: "https://example.com".into(),
            extract_mode: Some("markdown".into()),
            include_paths: Some(vec!["^/docs".into()]),
            max_depth: Some(2),
            respect_robots: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(job.id, 5);
    assert_eq!(job.brand, "Dragnet");
    assert_eq!(job.data_workflow_id, Some(77));
    assert_eq!(job.include_paths, vec!["^/docs".to_string()]);

    // Wire body: set fields present, unset optionals omitted (skip_serializing_if).
    let body: Value = serde_json::from_slice(&server.requests()[0].body).unwrap();
    assert_eq!(body["url"], "https://example.com");
    assert_eq!(body["extract_mode"], "markdown");
    assert_eq!(body["include_paths"][0], "^/docs");
    assert_eq!(body["max_depth"], 2);
    assert_eq!(body["respect_robots"], true);
    assert!(body.get("persona_id").is_none());
    assert!(body.get("page_budget").is_none());
    assert!(body.get("name").is_none());
}

#[tokio::test]
async fn crawl_get_fetches_one() {
    let server = StubServer::start().await;
    server.route(
        "GET",
        "/v1/crawl/5",
        json_reply(200, crawl_view(5, "crawling")),
    );
    let agent = client_for(&server);
    let job = agent.crawl().get(5).await.unwrap();
    assert_eq!(job.id, 5);
    assert_eq!(job.status, "crawling");
    assert_eq!(job.max_concurrent, 4);
}

#[tokio::test]
async fn crawl_cancel_parses_cancel_requested_now() {
    let server = StubServer::start().await;
    let mut view = crawl_view(5, "stopping");
    view["cancel_requested_now"] = json!(true);
    server.route("POST", "/v1/crawl/5/cancel", json_reply(200, view));
    let agent = client_for(&server);
    let out = agent.crawl().cancel(5).await.unwrap();
    assert!(out.cancel_requested_now);
    assert_eq!(out.job.id, 5);
    assert_eq!(out.job.status, "stopping");
    assert_eq!(out.job.brand, "Dragnet");
}

#[tokio::test]
async fn crawl_get_missing_maps_to_api_error() {
    let server = StubServer::start().await;
    server.route(
        "GET",
        "/v1/crawl/999999",
        json_reply(
            404,
            json!({"error": "not found: crawl 999999", "code": "not_found"}),
        ),
    );
    let agent = client_for(&server);
    let err = agent.crawl().get(999_999).await.unwrap_err();
    match err {
        WritError::Api {
            status,
            code,
            message,
            ..
        } => {
            assert_eq!(status, 404);
            assert_eq!(code, "not_found");
            assert_eq!(message, "not found: crawl 999999");
        }
        other => panic!("expected Api error, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// §9.1 — discovery against a temp home. Env vars are process-global: every test
// below serializes on the same lock and restores the environment when done.
// ---------------------------------------------------------------------------

/// Write a runtime.json descriptor under `home`.
fn write_runtime(dir: &std::path::Path, port: u16, token: &str) {
    std::fs::create_dir_all(dir).unwrap();
    let desc = json!({
        "pid": 4242, "port": port, "token": token,
        "version": "0.0.0-test", "started_at": "2026-07-13T00:00:00Z"
    });
    std::fs::write(dir.join("runtime.json"), desc.to_string()).unwrap();
}

/// Scoped env override that restores prior values on drop.
struct EnvGuard {
    saved: Vec<(&'static str, Option<String>)>,
}

impl EnvGuard {
    fn set(pairs: &[(&'static str, Option<&str>)]) -> Self {
        let saved = pairs
            .iter()
            .map(|(k, _)| (*k, std::env::var(*k).ok()))
            .collect();
        for (k, v) in pairs {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
        EnvGuard { saved }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (k, v) in &self.saved {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
    }
}

#[tokio::test]
async fn discovery_resolves_active_profile_runtime_json() {
    let _lock = stub::env_lock();
    let server = StubServer::start().await;
    server.route("GET", "/v1/agent", json_reply(200, json!({"status": "ok"})));

    let home = stub::temp_dir("discover-profile");
    let base = home.join(".writ");
    std::fs::create_dir_all(&base).unwrap();
    std::fs::write(base.join("active_profile"), "acct_1\n").unwrap();
    write_runtime(&base.join("profiles").join("acct_1"), server.port(), TOKEN);

    let _env = EnvGuard::set(&[
        ("HOME", Some(home.to_str().unwrap())),
        ("USERPROFILE", None),
        ("WRIT_HOME", None),
        ("WRIT_API_URL", None),
        ("WRIT_TOKEN", None),
    ]);
    let agent = WritAgent::discover()
        .await
        .expect("discovery via active_profile");
    assert_eq!(agent.base_url(), server.base_url());

    // The probe hit /v1/agent with the runtime.json token.
    let reqs = server.requests();
    assert!(!reqs.is_empty());
    assert_eq!(
        reqs[0].header("authorization").as_deref(),
        Some(&*format!("Bearer {TOKEN}"))
    );

    // ... and the built client works.
    agent.agent().status().await.unwrap();
}

#[tokio::test]
async fn discovery_stale_candidate_falls_through_to_next() {
    let _lock = stub::env_lock();
    let server = StubServer::start().await;
    server.route("GET", "/v1/agent", json_reply(200, json!({"status": "ok"})));

    // A dead port for the stale profile candidate.
    let dead_port = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap().port()
    };

    let home = stub::temp_dir("discover-stale");
    let base = home.join(".writ");
    std::fs::create_dir_all(&base).unwrap();
    // active_profile points at a crashed daemon's descriptor...
    std::fs::write(base.join("active_profile"), "dead").unwrap();
    write_runtime(&base.join("profiles").join("dead"), dead_port, "wlt_stale");
    // ...while the plain home descriptor is live.
    write_runtime(&base, server.port(), TOKEN);

    let _env = EnvGuard::set(&[
        ("HOME", Some(home.to_str().unwrap())),
        ("USERPROFILE", None),
        ("WRIT_HOME", None),
        ("WRIT_API_URL", None),
        ("WRIT_TOKEN", None),
    ]);
    let agent = WritAgent::discover()
        .await
        .expect("stale candidate must fall through");
    assert_eq!(agent.base_url(), server.base_url());
}

#[tokio::test]
async fn discovery_env_override_wins_without_filesystem() {
    let _lock = stub::env_lock();
    let server = StubServer::start().await;
    server.route("GET", "/v1/agent", json_reply(200, json!({"status": "ok"})));

    // Empty home: nothing on disk — env alone must be enough.
    let home = stub::temp_dir("discover-env");
    let _env = EnvGuard::set(&[
        ("HOME", Some(home.to_str().unwrap())),
        ("USERPROFILE", None),
        ("WRIT_HOME", None),
        ("WRIT_API_URL", Some(&server.base_url())),
        ("WRIT_TOKEN", Some("wlt_from_env")),
    ]);
    let agent = WritAgent::discover().await.expect("env override discovery");
    agent.agent().status().await.unwrap();
    let reqs = server.requests();
    assert_eq!(
        reqs[0].header("authorization").as_deref(),
        Some("Bearer wlt_from_env")
    );
}

#[tokio::test]
async fn discovery_writ_home_candidate_is_first() {
    let _lock = stub::env_lock();
    let server = StubServer::start().await;
    server.route("GET", "/v1/agent", json_reply(200, json!({"status": "ok"})));

    let home = stub::temp_dir("discover-home-env");
    // ~/.writ has a descriptor pointing nowhere useful (dead port)...
    let dead_port = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap().port()
    };
    write_runtime(&home.join(".writ"), dead_port, "wlt_dead");
    // ...but WRIT_HOME names a directory with the live descriptor.
    let writ_home = stub::temp_dir("discover-writ-home");
    write_runtime(&writ_home, server.port(), TOKEN);

    let _env = EnvGuard::set(&[
        ("HOME", Some(home.to_str().unwrap())),
        ("USERPROFILE", None),
        ("WRIT_HOME", Some(writ_home.to_str().unwrap())),
        ("WRIT_API_URL", None),
        ("WRIT_TOKEN", None),
    ]);
    let agent = WritAgent::discover().await.expect("WRIT_HOME discovery");
    assert_eq!(agent.base_url(), server.base_url());
    // WRIT_HOME won without ever probing the dead home candidate first.
    assert_eq!(
        server.requests()[0].header("authorization").as_deref(),
        Some(&*format!("Bearer {TOKEN}"))
    );
}

#[tokio::test]
async fn discovery_with_nothing_found_is_a_discovery_error() {
    let _lock = stub::env_lock();
    let home = stub::temp_dir("discover-none");
    let _env = EnvGuard::set(&[
        ("HOME", Some(home.to_str().unwrap())),
        ("USERPROFILE", None),
        ("WRIT_HOME", None),
        ("WRIT_API_URL", None),
        ("WRIT_TOKEN", None),
    ]);
    let err = WritAgent::discover().await.unwrap_err();
    match err {
        WritError::Discovery(msg) => {
            assert!(
                msg.contains("WRIT_TOKEN"),
                "error must say how to fix it: {msg}"
            );
        }
        other => panic!("expected Discovery error, got {other:?}"),
    }

    // builder().build() with no token resolvable is a discovery error too.
    let err = WritAgent::builder()
        .base_url("http://127.0.0.1:8131")
        .build()
        .unwrap_err();
    assert!(matches!(err, WritError::Discovery(_)), "got {err:?}");
}

// ---------------------------------------------------------------------------
// Model-level regression: Page deserializes typed items with extras intact.
// ---------------------------------------------------------------------------

#[test]
fn page_of_run_feed_items_keeps_unknown_fields() {
    let page: Page<RunFeedItem> = serde_json::from_value(json!({
        "data": [{"id": "workflow-8", "status": "failed", "brand_new_field": true}],
        "count": 1, "total": 1
    }))
    .unwrap();
    assert_eq!(page.data[0].row_id(), Some(8));
    assert_eq!(page.data[0].extra["brand_new_field"], true);
}

// ---------------------------------------------------------------------------
// Server-side wait (`?wait=true`) — the local mirror of the cloud gateway's
// delivery contract. Distinct from `run_and_wait`, which waits CLIENT-side over
// SSE with its own deadline; `run_wait` is one request that the daemon holds.
// ---------------------------------------------------------------------------

/// REGRESSION GUARD: `run` must stay async and must not start sending `?wait=`,
/// or every existing caller silently changes behavior.
#[tokio::test]
async fn run_defaults_to_async_and_sends_no_wait_query() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/workflows/9/run",
        json_reply(202, json!({"run_id": 42, "status": "running"})),
    );
    let agent = client_for(&server);

    let started = agent
        .workflows()
        .run(9, &RunOptions::default())
        .await
        .expect("run");

    assert_eq!(started.run_id, 42);
    assert_eq!(started.status, "running");
    let req = server.requests().pop().expect("a request");
    assert!(
        req.query.as_deref().unwrap_or("").is_empty(),
        "default run sent a query: {:?}",
        req.query
    );
}

/// `run_wait` sends the delivery options as QUERY params (the body stays the run's
/// inputs) and returns the terminal document.
#[tokio::test]
async fn run_wait_sends_query_and_returns_terminal_document() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/workflows/9/run",
        json_reply(
            200,
            json!({
                "run_id": 42, "status": "success", "done": true,
                "data": {"price": "19.99"}, "duration_ms": 8123
            }),
        ),
    );
    let agent = client_for(&server);

    let done = agent
        .workflows()
        .run_wait(9, &RunOptions::default(), Some(Duration::from_secs(60)))
        .await
        .expect("run_wait");

    assert_eq!(done.status, "success");
    assert!(done.done);
    assert_eq!(done.data.unwrap()["price"], "19.99");
    assert_eq!(done.duration_ms, Some(8123));

    let req = server.requests().pop().expect("a request");
    let query = req.query.unwrap_or_default();
    assert!(query.contains("wait=true"), "query = {query}");
    assert!(query.contains("timeout=60"), "query = {query}");
    let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
    assert!(
        body.get("wait").is_none(),
        "wait leaked into the body; it belongs in the query: {body}"
    );
}

/// A FAILED run is an `Ok` value, not an `Err` — otherwise a caller cannot tell a
/// failed workflow from a rejected request.
#[tokio::test]
async fn run_wait_failed_run_is_ok_with_status_failed() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/workflows/9/run",
        json_reply(
            200,
            json!({
                "run_id": 43, "status": "failed", "done": true,
                "error": "login step timed out"
            }),
        ),
    );
    let agent = client_for(&server);

    let done = agent
        .workflows()
        .run_wait(9, &RunOptions::default(), None)
        .await
        .expect("a failed run must not be an Err");

    assert_eq!(done.status, "failed");
    assert_eq!(done.error.as_deref(), Some("login step timed out"));
}

/// An expired budget yields `WritError::RunTimeout` carrying the still-valid run id,
/// so the caller collects the run instead of retrying and starting a second one.
#[tokio::test]
async fn run_wait_timeout_carries_the_still_running_run_id() {
    let server = StubServer::start().await;
    server.route(
        "POST",
        "/v1/workflows/9/run",
        json_reply(
            504,
            json!({
                "run_id": 44, "status": "running", "done": false,
                "status_url": "/v1/runs/44", "events_url": "/v1/runs/44/events"
            }),
        ),
    );
    let agent = client_for(&server);

    let err = agent
        .workflows()
        .run_wait(9, &RunOptions::default(), Some(Duration::from_secs(5)))
        .await
        .expect_err("expected a timeout");

    match err {
        WritError::RunTimeout {
            run_id,
            status_url,
            events_url,
        } => {
            assert_eq!(run_id, 44);
            assert_eq!(status_url.as_deref(), Some("/v1/runs/44"));
            assert_eq!(events_url.as_deref(), Some("/v1/runs/44/events"));
        }
        other => panic!("wrong error variant: {other:?}"),
    }
}

/// The message must steer toward collecting, not retrying — a retry would start a
/// SECOND run of a workflow that is already executing.
#[tokio::test]
async fn run_timeout_message_says_do_not_retry() {
    let err = WritError::RunTimeout {
        run_id: 7,
        status_url: None,
        events_url: None,
    };
    let msg = err.to_string();
    assert!(msg.contains("STILL RUNNING"), "message = {msg}");
    assert!(msg.contains("do not retry"), "message = {msg}");
}
