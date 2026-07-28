//! Resource namespaces (DESIGN.md §7) — lightweight handles returned by the
//! accessor methods on [`crate::WritAgent`].
//!
//! Loosely-shaped request bodies (create/update payloads) are `serde_json::Value`
//! (build them with `serde_json::json!`); responses are typed models with an
//! `extra` catch-all. `*_with` variants pass arbitrary query params through as
//! given.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use reqwest::Method;
use serde_json::{json, Value};

use crate::client::{Inner, SSE_TIMEOUT};
use crate::error::{Result, WritError};
use crate::models::{
    AgentStatus, ApiKey, Automation, CancelOutcome, CrawlCancel, CrawlJob, CrawlList,
    CrawlStartParams, DatasetFormat, DatasetList, DatasetMeta, DatasetSearchResult, Extractor,
    Health, Monitor, MonitorHistory, Persona, RunCompleted, RunData, RunEvent, RunFeedItem,
    RunOutcome, RunResults, RunStarted, SecretMeta, Selector, StoredFile, VaultStatus, Workflow,
};
use crate::page::Page;
use crate::sse::SseParser;

/// Default overall deadline for [`Workflows::run_and_wait`] (DESIGN.md §8).
const DEFAULT_WAIT_TIMEOUT: Duration = Duration::from_secs(600);

/// Polling cadence when the SSE stream is unavailable (DESIGN.md §8).
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// A live stream of [`RunEvent`]s; ends after a terminal `finished`/`error` frame.
pub type RunEventStream = BoxStream<'static, Result<RunEvent>>;

/// Options for `POST /v1/workflows/:id/run` (and `run_and_wait`).
///
/// The wire body is `{ inputs?, persona_id?, files? }` — `form_data` is an accepted
/// daemon alias for `inputs`, but this SDK only exposes `inputs`.
#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    /// Free-form run inputs `{NAME: value}` resolved over `{{NAME}}`/`{{input.NAME}}`.
    pub inputs: Option<Value>,
    /// Persona override for this run (wins over the workflow's pinned default).
    pub persona_id: Option<i64>,
    /// `{slot: file_id}` bindings of vault files to declared upload slots.
    pub files: Option<Value>,
    /// `run_and_wait` only: overall deadline (default 600 s). The run itself is
    /// **never** cancelled on timeout.
    pub wait_timeout: Option<Duration>,
    /// `run_and_wait` only: also fetch `runs().results()` after the terminal event.
    pub include_results: bool,
}

impl RunOptions {
    fn body(&self, dry_run: bool) -> Value {
        let mut body = serde_json::Map::new();
        if let Some(inputs) = &self.inputs {
            body.insert("inputs".into(), inputs.clone());
        }
        if let Some(persona_id) = self.persona_id {
            body.insert("persona_id".into(), json!(persona_id));
        }
        if let Some(files) = &self.files {
            body.insert("files".into(), files.clone());
        }
        if dry_run {
            body.insert("dry_run".into(), json!(true));
        }
        Value::Object(body)
    }
}

/// `/v1/agent` + `/v1/health`.
#[derive(Debug, Clone, Copy)]
pub struct Agent<'a> {
    pub(crate) c: &'a Inner,
}

impl Agent<'_> {
    /// `GET /v1/agent` — lightweight status.
    pub async fn status(&self) -> Result<AgentStatus> {
        self.c.get_json("/v1/agent", &[]).await
    }

    /// `GET /v1/health` — deep health.
    pub async fn health(&self) -> Result<Health> {
        self.c.get_json("/v1/health", &[]).await
    }
}

/// `/v1/workflows`.
#[derive(Debug, Clone, Copy)]
pub struct Workflows<'a> {
    pub(crate) c: &'a Inner,
}

impl Workflows<'_> {
    /// `GET /v1/workflows`.
    pub async fn list(&self) -> Result<Page<Workflow>> {
        self.list_with(&[]).await
    }

    /// `GET /v1/workflows` with query params (`active_only`, `limit`).
    pub async fn list_with(&self, query: &[(&str, &str)]) -> Result<Page<Workflow>> {
        self.c.get_json("/v1/workflows", query).await
    }

    /// `POST /v1/workflows`.
    pub async fn create(&self, body: Value) -> Result<Workflow> {
        self.c
            .send_json(Method::POST, "/v1/workflows", &[], Some(&body))
            .await
    }

    /// `GET /v1/workflows/:id`.
    pub async fn get(&self, id: i64) -> Result<Workflow> {
        self.c.get_json(&format!("/v1/workflows/{id}"), &[]).await
    }

    /// `PATCH /v1/workflows/:id` — sparse update.
    pub async fn update(&self, id: i64, patch: Value) -> Result<Workflow> {
        self.c
            .send_json(
                Method::PATCH,
                &format!("/v1/workflows/{id}"),
                &[],
                Some(&patch),
            )
            .await
    }

    /// `DELETE /v1/workflows/:id` — hard delete.
    pub async fn delete(&self, id: i64) -> Result<Value> {
        self.c
            .send_json(Method::DELETE, &format!("/v1/workflows/{id}"), &[], None)
            .await
    }

    /// `POST /v1/workflows/:id/run` → `202 {run_id, status:"running"}`.
    ///
    /// Observe the run with [`RunsApi::events`] / [`RunsApi::get`], or use
    /// [`Self::run_wait`] to have the daemon block and hand back the result directly.
    pub async fn run(&self, id: i64, opts: &RunOptions) -> Result<RunStarted> {
        self.c
            .send_json(
                Method::POST,
                &format!("/v1/workflows/{id}/run"),
                &[],
                Some(&opts.body(false)),
            )
            .await
    }

    /// `POST /v1/workflows/:id/run?wait=true` — run the workflow and BLOCK on the daemon
    /// until it reaches a terminal state, returning the run's own result. One request: no
    /// SSE, no poll loop.
    ///
    /// `timeout` is how long the daemon may block (clamped server-side to `[1s, 3600s]`,
    /// default 120 s). A run that FAILS is returned as `Ok` with `status == "failed"` —
    /// check it. Only an expired budget is an `Err`, and it is
    /// [`WritError::RunTimeout`] carrying the still-valid `run_id`, so you can collect the
    /// run rather than start a second one.
    ///
    /// Prefer [`Self::run_and_wait`] when you want live events, the enriched run feed item,
    /// or a deadline longer than the daemon's own ceiling.
    pub async fn run_wait(
        &self,
        id: i64,
        opts: &RunOptions,
        timeout: Option<Duration>,
    ) -> Result<RunCompleted> {
        let secs = timeout.map(|d| d.as_secs().max(1).to_string());
        let mut query: Vec<(&str, &str)> = vec![("wait", "true")];
        if let Some(secs) = secs.as_deref() {
            query.push(("timeout", secs));
        }
        // 504 is a documented, RECOVERABLE outcome of waiting, so it is decoded as a body
        // rather than mapped to a generic API error — which would throw away the run id,
        // the only thing that makes it recoverable.
        let out: RunCompleted = self
            .c
            .send_json_allowing(
                Method::POST,
                &format!("/v1/workflows/{id}/run"),
                &query,
                Some(&opts.body(false)),
                &[504],
            )
            .await?;
        if !out.done {
            return Err(WritError::RunTimeout {
                run_id: out.run_id,
                status_url: out.status_url,
                events_url: out.events_url,
            });
        }
        Ok(out)
    }

    /// `POST /v1/workflows/:id/run` with `dry_run: true` → `200` validate-only
    /// step-plan report (nothing is executed).
    pub async fn dry_run(&self, id: i64, opts: &RunOptions) -> Result<Value> {
        self.c
            .send_json(
                Method::POST,
                &format!("/v1/workflows/{id}/run"),
                &[],
                Some(&opts.body(true)),
            )
            .await
    }

    /// `POST /v1/workflows/:id/cancel` — cancel the newest live run of this
    /// workflow. A `409 not_running` is a valid [`CancelOutcome`], not an error.
    pub async fn cancel(&self, id: i64) -> Result<CancelOutcome> {
        self.c
            .send_json_allowing(
                Method::POST,
                &format!("/v1/workflows/{id}/cancel"),
                &[],
                None,
                &[409],
            )
            .await
    }

    /// `GET /v1/workflows/:id/session` — browserless-HTTP-lane session status.
    pub async fn session(&self, id: i64) -> Result<Value> {
        self.c
            .get_json(&format!("/v1/workflows/{id}/session"), &[])
            .await
    }

    /// `DELETE /v1/workflows/:id/session` — drop the persisted session.
    pub async fn clear_session(&self, id: i64) -> Result<Value> {
        self.c
            .send_json(
                Method::DELETE,
                &format!("/v1/workflows/{id}/session"),
                &[],
                None,
            )
            .await
    }

    /// Run the workflow and wait for the terminal state (DESIGN.md §8):
    /// start the run, follow the SSE event stream, and on SSE failure fall back to
    /// polling `runs().get()` every second. Overall deadline
    /// [`RunOptions::wait_timeout`] (default **600 s**) — on timeout the run is
    /// **NOT cancelled**; it keeps executing on the daemon. Returns the final
    /// [`RunFeedItem`] (plus `runs().results()` when
    /// [`RunOptions::include_results`] is set).
    pub async fn run_and_wait(&self, id: i64, opts: &RunOptions) -> Result<RunOutcome> {
        let started = self.run(id, opts).await?;
        let run_id = started.run_id;
        let wait = opts.wait_timeout.unwrap_or(DEFAULT_WAIT_TIMEOUT);
        let deadline = Instant::now() + wait;
        let runs = Runs { c: self.c };

        let timeout_err = || {
            WritError::Connection(format!(
                "run_and_wait: run {run_id} not terminal after {}s — the run was NOT cancelled \
                 and continues on the daemon",
                wait.as_secs()
            ))
        };

        // Phase 1: SSE. The per-request timeout is capped at the remaining
        // deadline, so a silent stream cannot outlive the overall budget.
        let mut saw_terminal = false;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            if let Ok(mut stream) = runs.events_with_timeout(run_id, remaining).await {
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(ev) if ev.is_terminal() => {
                            saw_terminal = true;
                            break;
                        }
                        Ok(_) => {
                            if Instant::now() >= deadline {
                                return Err(timeout_err());
                            }
                        }
                        // Dropped pre-terminal → polling fallback.
                        Err(_) => break,
                    }
                }
            }
        }

        // Phase 2: polling fallback (stream failed, dropped, or closed without a
        // terminal frame).
        if !saw_terminal {
            loop {
                if Instant::now() >= deadline {
                    return Err(timeout_err());
                }
                let item = runs.get(run_id).await?;
                if !item.is_running() {
                    break;
                }
                let nap = POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now()));
                if nap.is_zero() {
                    return Err(timeout_err());
                }
                crate::util::sleep(nap).await;
            }
        }

        // Final snapshot (once, after the terminal event).
        let run = runs.get(run_id).await?;
        let results = if opts.include_results {
            Some(runs.results(run_id).await?)
        } else {
            None
        };
        Ok(RunOutcome { run, results })
    }
}

/// `/v1/runs` — read + control. Ids are the **numeric row id**
/// ([`RunFeedItem::row_id`] parses it out of the composite feed id).
#[derive(Debug, Clone, Copy)]
pub struct Runs<'a> {
    pub(crate) c: &'a Inner,
}

impl Runs<'_> {
    /// `GET /v1/runs`.
    pub async fn list(&self) -> Result<Page<RunFeedItem>> {
        self.list_with(&[]).await
    }

    /// `GET /v1/runs` with filters (`entity_id`, `workflow_id`, `run_type`,
    /// `status`, `limit`, `offset`).
    pub async fn list_with(&self, query: &[(&str, &str)]) -> Result<Page<RunFeedItem>> {
        self.c.get_json("/v1/runs", query).await
    }

    /// `GET /v1/runs/:id`.
    pub async fn get(&self, run_id: i64) -> Result<RunFeedItem> {
        self.c.get_json(&format!("/v1/runs/{run_id}"), &[]).await
    }

    /// `GET /v1/runs/:id/results` → `{run_id, status, result}`.
    pub async fn results(&self, run_id: i64) -> Result<RunResults> {
        self.c
            .get_json(&format!("/v1/runs/{run_id}/results"), &[])
            .await
    }

    /// `GET /v1/runs/:id/data` — the run's extracted rows (JSON lane).
    pub async fn data(&self, run_id: i64) -> Result<RunData> {
        self.c
            .get_json(&format!("/v1/runs/{run_id}/data"), &[])
            .await
    }

    /// `GET /v1/runs/:id/data?format=csv` — the extracted rows flattened to CSV.
    pub async fn data_csv(&self, run_id: i64) -> Result<String> {
        self.c
            .get_text(&format!("/v1/runs/{run_id}/data"), &[("format", "csv")])
            .await
    }

    /// `POST /v1/runs/:id/cancel`. Both `202 cancel_requested` and
    /// `409 not_running` are valid [`CancelOutcome`]s (the 409 is not an `Err`).
    pub async fn cancel(&self, run_id: i64) -> Result<CancelOutcome> {
        self.c
            .send_json_allowing(
                Method::POST,
                &format!("/v1/runs/{run_id}/cancel"),
                &[],
                None,
                &[409],
            )
            .await
    }

    /// `GET /v1/runs/:id/events` — live SSE stream of [`RunEvent`]s. The stream
    /// ends after the terminal `finished`/`error` frame (a run that is already
    /// finished yields exactly one terminal frame). Keep-alive comments are
    /// consumed by the parser. No reconnect logic in v1 — a dropped stream
    /// surfaces as an `Err` item.
    pub async fn events(&self, run_id: i64) -> Result<RunEventStream> {
        self.events_with_timeout(run_id, SSE_TIMEOUT).await
    }

    /// [`Runs::events`] with an explicit whole-stream timeout (used by
    /// `run_and_wait` to cap the stream at the remaining deadline).
    pub(crate) async fn events_with_timeout(
        &self,
        run_id: i64,
        timeout: Duration,
    ) -> Result<RunEventStream> {
        let resp = self
            .c
            .get_stream(&format!("/v1/runs/{run_id}/events"), timeout)
            .await?;

        struct SseState {
            body: BoxStream<'static, reqwest::Result<bytes::Bytes>>,
            parser: SseParser,
            pending: VecDeque<RunEvent>,
            done: bool,
        }

        let state = SseState {
            body: resp.bytes_stream().boxed(),
            parser: SseParser::new(),
            pending: VecDeque::new(),
            done: false,
        };

        let stream = futures_util::stream::unfold(state, |mut st| async move {
            loop {
                if let Some(ev) = st.pending.pop_front() {
                    if ev.is_terminal() {
                        // Terminal frame: deliver it, then end the stream.
                        st.done = true;
                        st.pending.clear();
                    }
                    return Some((Ok(ev), st));
                }
                if st.done {
                    return None;
                }
                match st.body.next().await {
                    Some(Ok(chunk)) => {
                        let mut payloads = Vec::new();
                        st.parser.feed(&chunk, &mut payloads);
                        for p in payloads {
                            st.pending.push_back(RunEvent::parse(&p));
                        }
                    }
                    Some(Err(e)) => {
                        st.done = true;
                        return Some((Err(WritError::from(e)), st));
                    }
                    None => return None,
                }
            }
        })
        .boxed();
        Ok(stream)
    }
}

/// `/v1/monitors` (+ `/v1/changes/recent`).
#[derive(Debug, Clone, Copy)]
pub struct Monitors<'a> {
    pub(crate) c: &'a Inner,
}

impl Monitors<'_> {
    /// `GET /v1/monitors` (bare-array endpoint, normalized to [`Page`]).
    pub async fn list(&self) -> Result<Page<Monitor>> {
        self.list_with(&[]).await
    }

    /// `GET /v1/monitors` with query params (`limit`, `check_type`).
    pub async fn list_with(&self, query: &[(&str, &str)]) -> Result<Page<Monitor>> {
        self.c.get_json("/v1/monitors", query).await
    }

    /// `POST /v1/monitors` — requires a non-empty `url`. A `409 device_capacity`
    /// surfaces as a normal [`WritError::Api`].
    pub async fn create(&self, body: Value) -> Result<Monitor> {
        self.c
            .send_json(Method::POST, "/v1/monitors", &[], Some(&body))
            .await
    }

    /// `GET /v1/monitors/:id`.
    pub async fn get(&self, id: i64) -> Result<Monitor> {
        self.c.get_json(&format!("/v1/monitors/{id}"), &[]).await
    }

    /// `PATCH /v1/monitors/:id`.
    pub async fn update(&self, id: i64, patch: Value) -> Result<Monitor> {
        self.c
            .send_json(
                Method::PATCH,
                &format!("/v1/monitors/{id}"),
                &[],
                Some(&patch),
            )
            .await
    }

    /// `DELETE /v1/monitors/:id`.
    pub async fn delete(&self, id: i64) -> Result<Value> {
        self.c
            .send_json(Method::DELETE, &format!("/v1/monitors/{id}"), &[], None)
            .await
    }

    /// `POST /v1/monitors/:id/run` — run the check now; returns the check outcome.
    pub async fn run(&self, id: i64) -> Result<Value> {
        self.c
            .send_json(Method::POST, &format!("/v1/monitors/{id}/run"), &[], None)
            .await
    }

    /// `GET /v1/monitors/:id/changes` — change + uptime history.
    pub async fn changes(&self, id: i64) -> Result<MonitorHistory> {
        self.changes_with(id, &[]).await
    }

    /// `GET /v1/monitors/:id/changes` with `limit`/`offset`.
    pub async fn changes_with(&self, id: i64, query: &[(&str, &str)]) -> Result<MonitorHistory> {
        self.c
            .get_json(&format!("/v1/monitors/{id}/changes"), query)
            .await
    }

    /// `GET /v1/monitors/capacity` — the device check-capacity meter.
    pub async fn capacity(&self) -> Result<Value> {
        self.c.get_json("/v1/monitors/capacity", &[]).await
    }

    /// `GET /v1/changes/recent` — cross-monitor recent content changes.
    pub async fn recent_changes(&self) -> Result<Page<Value>> {
        self.recent_changes_with(&[]).await
    }

    /// `GET /v1/changes/recent` with `limit`.
    pub async fn recent_changes_with(&self, query: &[(&str, &str)]) -> Result<Page<Value>> {
        self.c.get_json("/v1/changes/recent", query).await
    }
}

/// `/v1/monitors/:id/selectors` — selectors nested under a monitor.
#[derive(Debug, Clone, Copy)]
pub struct Selectors<'a> {
    pub(crate) c: &'a Inner,
}

impl Selectors<'_> {
    /// `GET /v1/monitors/:id/selectors` (bare array, normalized to [`Page`]).
    pub async fn list(&self, monitor_id: i64) -> Result<Page<Selector>> {
        self.c
            .get_json(&format!("/v1/monitors/{monitor_id}/selectors"), &[])
            .await
    }

    /// `POST /v1/monitors/:id/selectors` — requires a non-empty `selector`.
    pub async fn create(&self, monitor_id: i64, body: Value) -> Result<Selector> {
        self.c
            .send_json(
                Method::POST,
                &format!("/v1/monitors/{monitor_id}/selectors"),
                &[],
                Some(&body),
            )
            .await
    }

    /// `GET /v1/monitors/:id/selectors/:sid`.
    pub async fn get(&self, monitor_id: i64, selector_id: i64) -> Result<Selector> {
        self.c
            .get_json(
                &format!("/v1/monitors/{monitor_id}/selectors/{selector_id}"),
                &[],
            )
            .await
    }

    /// `PATCH /v1/monitors/:id/selectors/:sid`.
    pub async fn update(
        &self,
        monitor_id: i64,
        selector_id: i64,
        patch: Value,
    ) -> Result<Selector> {
        self.c
            .send_json(
                Method::PATCH,
                &format!("/v1/monitors/{monitor_id}/selectors/{selector_id}"),
                &[],
                Some(&patch),
            )
            .await
    }

    /// `DELETE /v1/monitors/:id/selectors/:sid`.
    pub async fn delete(&self, monitor_id: i64, selector_id: i64) -> Result<Value> {
        self.c
            .send_json(
                Method::DELETE,
                &format!("/v1/monitors/{monitor_id}/selectors/{selector_id}"),
                &[],
                None,
            )
            .await
    }

    /// `POST .../selectors/:sid/toggle` — flip `enabled`.
    pub async fn toggle(&self, monitor_id: i64, selector_id: i64) -> Result<Value> {
        self.c
            .send_json(
                Method::POST,
                &format!("/v1/monitors/{monitor_id}/selectors/{selector_id}/toggle"),
                &[],
                None,
            )
            .await
    }

    /// `POST .../selectors/:sid/test` — live one-off probe, nothing persisted.
    pub async fn test(&self, monitor_id: i64, selector_id: i64) -> Result<Value> {
        self.c
            .send_json(
                Method::POST,
                &format!("/v1/monitors/{monitor_id}/selectors/{selector_id}/test"),
                &[],
                None,
            )
            .await
    }

    /// `POST .../selectors/:sid/set-baseline` — capture a fresh baseline.
    pub async fn set_baseline(&self, monitor_id: i64, selector_id: i64) -> Result<Value> {
        self.c
            .send_json(
                Method::POST,
                &format!("/v1/monitors/{monitor_id}/selectors/{selector_id}/set-baseline"),
                &[],
                None,
            )
            .await
    }

    /// `POST .../selectors/:sid/clear-baseline` — drop the stored baseline.
    pub async fn clear_baseline(&self, monitor_id: i64, selector_id: i64) -> Result<Value> {
        self.c
            .send_json(
                Method::POST,
                &format!("/v1/monitors/{monitor_id}/selectors/{selector_id}/clear-baseline"),
                &[],
                None,
            )
            .await
    }
}

/// `/v1/extractors` (+ `/v1/selectors/:sid/extractors`).
#[derive(Debug, Clone, Copy)]
pub struct Extractors<'a> {
    pub(crate) c: &'a Inner,
}

impl Extractors<'_> {
    /// `GET /v1/selectors/:sid/extractors` (bare array, normalized to [`Page`]).
    pub async fn list(&self, selector_id: i64) -> Result<Page<Extractor>> {
        self.c
            .get_json(&format!("/v1/selectors/{selector_id}/extractors"), &[])
            .await
    }

    /// `POST /v1/extractors` — body carries `target_selector_id` + `output_name`.
    pub async fn create(&self, body: Value) -> Result<Extractor> {
        self.c
            .send_json(Method::POST, "/v1/extractors", &[], Some(&body))
            .await
    }

    /// `GET /v1/extractors/:id`.
    pub async fn get(&self, extractor_id: i64) -> Result<Extractor> {
        self.c
            .get_json(&format!("/v1/extractors/{extractor_id}"), &[])
            .await
    }

    /// `PATCH /v1/extractors/:id`.
    pub async fn update(&self, extractor_id: i64, patch: Value) -> Result<Extractor> {
        self.c
            .send_json(
                Method::PATCH,
                &format!("/v1/extractors/{extractor_id}"),
                &[],
                Some(&patch),
            )
            .await
    }

    /// `DELETE /v1/extractors/:id`.
    pub async fn delete(&self, extractor_id: i64) -> Result<Value> {
        self.c
            .send_json(
                Method::DELETE,
                &format!("/v1/extractors/{extractor_id}"),
                &[],
                None,
            )
            .await
    }

    /// `PATCH /v1/extractors/:id/toggle` — flip `enabled`.
    pub async fn toggle(&self, extractor_id: i64) -> Result<Value> {
        self.c
            .send_json(
                Method::PATCH,
                &format!("/v1/extractors/{extractor_id}/toggle"),
                &[],
                None,
            )
            .await
    }

    /// `POST /v1/extractors/:id/test` — run the saved extractor over
    /// caller-supplied content (`{content, content_type?}`), nothing persisted.
    pub async fn test(&self, extractor_id: i64, body: Value) -> Result<Value> {
        self.c
            .send_json(
                Method::POST,
                &format!("/v1/extractors/{extractor_id}/test"),
                &[],
                Some(&body),
            )
            .await
    }
}

/// `/v1/automations`.
#[derive(Debug, Clone, Copy)]
pub struct Automations<'a> {
    pub(crate) c: &'a Inner,
}

impl Automations<'_> {
    /// `GET /v1/automations` (bare array, normalized to [`Page`]).
    pub async fn list(&self) -> Result<Page<Automation>> {
        self.list_with(&[]).await
    }

    /// `GET /v1/automations` with query params (`limit`).
    pub async fn list_with(&self, query: &[(&str, &str)]) -> Result<Page<Automation>> {
        self.c.get_json("/v1/automations", query).await
    }

    /// `POST /v1/automations` — requires a non-empty `name`.
    pub async fn create(&self, body: Value) -> Result<Automation> {
        self.c
            .send_json(Method::POST, "/v1/automations", &[], Some(&body))
            .await
    }

    /// `GET /v1/automations/:id`.
    pub async fn get(&self, id: i64) -> Result<Automation> {
        self.c.get_json(&format!("/v1/automations/{id}"), &[]).await
    }

    /// `PATCH /v1/automations/:id`.
    pub async fn update(&self, id: i64, patch: Value) -> Result<Automation> {
        self.c
            .send_json(
                Method::PATCH,
                &format!("/v1/automations/{id}"),
                &[],
                Some(&patch),
            )
            .await
    }

    /// `DELETE /v1/automations/:id`.
    pub async fn delete(&self, id: i64) -> Result<Value> {
        self.c
            .send_json(Method::DELETE, &format!("/v1/automations/{id}"), &[], None)
            .await
    }

    /// `POST /v1/automations/:id/enable` — set the `enabled` flag; returns the
    /// refreshed row.
    pub async fn enable(&self, id: i64, enabled: bool) -> Result<Automation> {
        self.c
            .send_json(
                Method::POST,
                &format!("/v1/automations/{id}/enable"),
                &[],
                Some(&json!({ "enabled": enabled })),
            )
            .await
    }

    /// `POST /v1/automations/:id/run` — fire now (optional `inputs`); returns the
    /// execution outcome.
    pub async fn run(&self, id: i64, inputs: Option<Value>) -> Result<Value> {
        let body = json!({ "inputs": inputs });
        self.c
            .send_json(
                Method::POST,
                &format!("/v1/automations/{id}/run"),
                &[],
                Some(&body),
            )
            .await
    }
}

/// `/v1/personas`.
#[derive(Debug, Clone, Copy)]
pub struct Personas<'a> {
    pub(crate) c: &'a Inner,
}

impl Personas<'_> {
    /// `GET /v1/personas`.
    pub async fn list(&self) -> Result<Page<Persona>> {
        self.list_with(&[]).await
    }

    /// `GET /v1/personas` with query params (`limit`, `domain`).
    pub async fn list_with(&self, query: &[(&str, &str)]) -> Result<Page<Persona>> {
        self.c.get_json("/v1/personas", query).await
    }

    /// `POST /v1/personas`.
    pub async fn create(&self, body: Value) -> Result<Persona> {
        self.c
            .send_json(Method::POST, "/v1/personas", &[], Some(&body))
            .await
    }

    /// `GET /v1/personas/:id`.
    pub async fn get(&self, id: i64) -> Result<Persona> {
        self.c.get_json(&format!("/v1/personas/{id}"), &[]).await
    }

    /// `PATCH /v1/personas/:id`.
    pub async fn update(&self, id: i64, patch: Value) -> Result<Persona> {
        self.c
            .send_json(
                Method::PATCH,
                &format!("/v1/personas/{id}"),
                &[],
                Some(&patch),
            )
            .await
    }

    /// `DELETE /v1/personas/:id`.
    pub async fn delete(&self, id: i64) -> Result<Value> {
        self.c
            .send_json(Method::DELETE, &format!("/v1/personas/{id}"), &[], None)
            .await
    }

    /// `GET /v1/personas/:id/runs` — runs attributed to this persona.
    pub async fn runs(&self, id: i64) -> Result<Page<Value>> {
        self.c
            .get_json(&format!("/v1/personas/{id}/runs"), &[])
            .await
    }

    /// `POST /v1/personas/validate-totp` — check a base32 seed (and optionally a
    /// live code) without persisting anything. Body:
    /// `{totp_seed, code?, digits?, period?, algorithm?}`.
    pub async fn validate_totp(&self, body: Value) -> Result<Value> {
        self.c
            .send_json(Method::POST, "/v1/personas/validate-totp", &[], Some(&body))
            .await
    }

    /// `POST /v1/personas/:id/test-2fa` — exercise the persona's stored 2FA.
    pub async fn test_2fa(&self, id: i64) -> Result<Value> {
        self.c
            .send_json(
                Method::POST,
                &format!("/v1/personas/{id}/test-2fa"),
                &[],
                None,
            )
            .await
    }
}

/// `/v1/secrets` — metadata only; secret **values never come back** over this API.
#[derive(Debug, Clone, Copy)]
pub struct Secrets<'a> {
    pub(crate) c: &'a Inner,
}

impl Secrets<'_> {
    /// `GET /v1/secrets`.
    pub async fn list(&self) -> Result<Page<SecretMeta>> {
        self.list_with(&[]).await
    }

    /// `GET /v1/secrets` with query params (`limit`, `search`, `category`).
    pub async fn list_with(&self, query: &[(&str, &str)]) -> Result<Page<SecretMeta>> {
        self.c.get_json("/v1/secrets", query).await
    }

    /// `POST /v1/secrets` — create a single-value secret. The plaintext is sealed
    /// daemon-side; only metadata is returned.
    pub async fn set(&self, key: &str, value: &str) -> Result<SecretMeta> {
        self.create(json!({ "name": key, "value": value })).await
    }

    /// `POST /v1/secrets` with a full body — single-value `{name, value}`,
    /// credential `{name, username, password}`, or card `{name, card: {...}}`
    /// (plus optional `description`/`category`).
    pub async fn create(&self, body: Value) -> Result<SecretMeta> {
        self.c
            .send_json(Method::POST, "/v1/secrets", &[], Some(&body))
            .await
    }

    /// `GET /v1/secrets/:key` — **metadata** for one secret (never the value).
    pub async fn get(&self, key: &str) -> Result<SecretMeta> {
        self.c.get_json(&format!("/v1/secrets/{key}"), &[]).await
    }

    /// `DELETE /v1/secrets/:key`.
    pub async fn delete(&self, key: &str) -> Result<Value> {
        self.c
            .send_json(Method::DELETE, &format!("/v1/secrets/{key}"), &[], None)
            .await
    }
}

/// `/v1/vault/*` — the app-lock control surface.
#[derive(Debug, Clone, Copy)]
pub struct Vault<'a> {
    pub(crate) c: &'a Inner,
}

impl Vault<'_> {
    /// `GET /v1/vault/status` → `{enabled, locked, idle_timeout_secs}`.
    pub async fn status(&self) -> Result<VaultStatus> {
        self.c.get_json("/v1/vault/status", &[]).await
    }

    /// `POST /v1/vault/lock` — relock now. Idempotent.
    pub async fn lock(&self) -> Result<Value> {
        self.c
            .send_json(Method::POST, "/v1/vault/lock", &[], None)
            .await
    }

    /// `POST /v1/vault/unlock` — unlock with the passphrase (consumed
    /// daemon-side; never persisted). A wrong passphrase surfaces as a 401
    /// [`WritError::Api`].
    pub async fn unlock(&self, passphrase: &str) -> Result<Value> {
        self.c
            .send_json(
                Method::POST,
                "/v1/vault/unlock",
                &[],
                Some(&json!({ "passphrase": passphrase })),
            )
            .await
    }
}

/// `/v1/files` — metadata + byte I/O.
#[derive(Debug, Clone, Copy)]
pub struct Files<'a> {
    pub(crate) c: &'a Inner,
}

impl Files<'_> {
    /// `GET /v1/files`.
    pub async fn list(&self) -> Result<Page<StoredFile>> {
        self.list_with(&[]).await
    }

    /// `GET /v1/files` with query params (`limit`, `source`).
    pub async fn list_with(&self, query: &[(&str, &str)]) -> Result<Page<StoredFile>> {
        self.c.get_json("/v1/files", query).await
    }

    /// `POST /v1/files` — multipart upload of `bytes` as the `file` part
    /// (max 50 MiB daemon-side). `source` may be `upload` (default) | `api` |
    /// `workflow_output`.
    pub async fn upload(
        &self,
        filename: &str,
        bytes: impl Into<Vec<u8>>,
        content_type: Option<&str>,
        source: Option<&str>,
    ) -> Result<StoredFile> {
        let mut part =
            reqwest::multipart::Part::bytes(bytes.into()).file_name(filename.to_string());
        if let Some(ct) = content_type {
            part = part
                .mime_str(ct)
                .map_err(|e| WritError::Connection(format!("invalid content type {ct:?}: {e}")))?;
        }
        let mut form = reqwest::multipart::Form::new().part("file", part);
        if let Some(source) = source {
            form = form.text("source", source.to_string());
        }
        self.c.post_multipart("/v1/files", form).await
    }

    /// `POST /v1/files/from-data` — export a workflow's extracted data into a
    /// stored file. Body: `{workflow_id, format?, filters?}`.
    pub async fn from_data(&self, body: Value) -> Result<StoredFile> {
        self.c
            .send_json(Method::POST, "/v1/files/from-data", &[], Some(&body))
            .await
    }

    /// `GET /v1/files/:id` — one file's metadata.
    pub async fn get(&self, id: &str) -> Result<StoredFile> {
        self.c.get_json(&format!("/v1/files/{id}"), &[]).await
    }

    /// `DELETE /v1/files/:id` — soft-delete the handle.
    pub async fn delete(&self, id: &str) -> Result<Value> {
        self.c
            .send_json(Method::DELETE, &format!("/v1/files/{id}"), &[], None)
            .await
    }

    /// `GET /v1/files/:id/content` — the decrypted raw bytes.
    pub async fn content(&self, id: &str) -> Result<bytes::Bytes> {
        self.c
            .get_bytes(&format!("/v1/files/{id}/content"), &[])
            .await
    }
}

/// `/v1/data` + `/v1/workflows/:id/data*` — the extracted-data surface.
/// Shapes are query-engine-driven, so responses stay loosely typed.
#[derive(Debug, Clone, Copy)]
pub struct Data<'a> {
    pub(crate) c: &'a Inner,
}

impl Data<'_> {
    /// `GET /v1/data` — workflows that have extracted data.
    pub async fn query(&self, query: &[(&str, &str)]) -> Result<Value> {
        self.c.get_json("/v1/data", query).await
    }

    /// `GET /v1/workflows/:id/data` — the aggregated data table (filters,
    /// `limit`/`offset`, sort — pass query params through as given).
    pub async fn workflow_data(&self, workflow_id: i64, query: &[(&str, &str)]) -> Result<Value> {
        self.c
            .get_json(&format!("/v1/workflows/{workflow_id}/data"), query)
            .await
    }

    /// `DELETE /v1/workflows/:id/data` — drop the workflow's extracted data.
    pub async fn delete_workflow_data(&self, workflow_id: i64) -> Result<Value> {
        self.c
            .send_json(
                Method::DELETE,
                &format!("/v1/workflows/{workflow_id}/data"),
                &[],
                None,
            )
            .await
    }

    /// `GET /v1/workflows/:id/data/facets` — per-column facet values.
    pub async fn facets(&self, workflow_id: i64) -> Result<Value> {
        self.c
            .get_json(&format!("/v1/workflows/{workflow_id}/data/facets"), &[])
            .await
    }

    /// `GET /v1/workflows/:id/data/export` — raw export bytes (`format=csv|json`
    /// via query params).
    pub async fn export(&self, workflow_id: i64, query: &[(&str, &str)]) -> Result<bytes::Bytes> {
        self.c
            .get_bytes(&format!("/v1/workflows/{workflow_id}/data/export"), query)
            .await
    }

    /// `GET /v1/workflows/:id/data/runs` — the runs feeding the data table.
    pub async fn data_runs(&self, workflow_id: i64) -> Result<Value> {
        self.c
            .get_json(&format!("/v1/workflows/{workflow_id}/data/runs"), &[])
            .await
    }
}

/// `/v1/keys` — scoped `wlk_` API keys (requires the `manage`-capable `wlt_` token).
#[derive(Debug, Clone, Copy)]
pub struct Keys<'a> {
    pub(crate) c: &'a Inner,
}

impl Keys<'_> {
    /// `GET /v1/keys`.
    pub async fn list(&self) -> Result<Page<ApiKey>> {
        self.c.get_json("/v1/keys", &[]).await
    }

    /// `POST /v1/keys` — mint a scoped key. The plaintext `wlk_` key appears
    /// **only** in this response ([`ApiKey::key`]); capture it immediately.
    /// `scopes` is a CSV of `read|run|admin` (daemon default: `run`).
    pub async fn create(&self, name: &str, scopes: Option<&str>) -> Result<ApiKey> {
        let mut body = json!({ "name": name });
        if let Some(scopes) = scopes {
            body["scopes"] = Value::String(scopes.to_string());
        }
        self.c
            .send_json(Method::POST, "/v1/keys", &[], Some(&body))
            .await
    }

    /// `GET /v1/keys/:id`.
    pub async fn get(&self, id: i64) -> Result<ApiKey> {
        self.c.get_json(&format!("/v1/keys/{id}"), &[]).await
    }

    /// `DELETE /v1/keys/:id`.
    pub async fn delete(&self, id: i64) -> Result<Value> {
        self.c
            .send_json(Method::DELETE, &format!("/v1/keys/{id}"), &[], None)
            .await
    }
}

/// `/v1/crawl` — the **Dragnet** whole-site crawl. One crawl fans a seed URL across
/// a bounded in-process worker pool; extracted pages aggregate under a synthetic
/// per-crawl workflow ([`CrawlJob::data_workflow_id`]) read back through the Data API.
#[derive(Debug, Clone, Copy)]
pub struct Crawl<'a> {
    pub(crate) c: &'a Inner,
}

impl Crawl<'_> {
    /// `GET /v1/crawl` — newest-first crawls (`limit` default 50 daemon-side, max
    /// 500). **Not** a [`Page`]: the daemon answers `{crawls: [...]}`, so this
    /// returns a [`CrawlList`] (unwrap its `crawls` field).
    pub async fn list(&self, limit: Option<i64>) -> Result<CrawlList> {
        let limit_str = limit.map(|n| n.to_string());
        let mut query: Vec<(&str, &str)> = Vec::new();
        if let Some(limit) = &limit_str {
            query.push(("limit", limit.as_str()));
        }
        self.c.get_json("/v1/crawl", &query).await
    }

    /// `POST /v1/crawl` — validate the seed, mint the synthetic dataset workflow +
    /// the crawl row, and kick the crawl off. Returns the queued [`CrawlJob`] view
    /// (with `workflow_id`/`data_workflow_id` set). An empty `url` is a `400`
    /// [`WritError::Api`].
    pub async fn start(&self, params: CrawlStartParams) -> Result<CrawlJob> {
        let body = serde_json::to_value(&params)
            .map_err(|e| WritError::Connection(format!("serializing crawl params: {e}")))?;
        self.c
            .send_json(Method::POST, "/v1/crawl", &[], Some(&body))
            .await
    }

    /// `GET /v1/crawl/:id` — one crawl's live status view (`404` if missing).
    pub async fn get(&self, id: i64) -> Result<CrawlJob> {
        self.c.get_json(&format!("/v1/crawl/{id}"), &[]).await
    }

    /// `POST /v1/crawl/:id/cancel` — request cancellation. Returns the refreshed
    /// view plus [`CrawlCancel::cancel_requested_now`] (never a 409; `404` if
    /// missing).
    pub async fn cancel(&self, id: i64) -> Result<CrawlCancel> {
        self.c
            .send_json(Method::POST, &format!("/v1/crawl/{id}/cancel"), &[], None)
            .await
    }
}

/// `/v1/datasets` — the unified dataset index over crawl- and workflow-sourced
/// extracted data. Metadata is typed ([`DatasetList`]/[`DatasetMeta`]); the
/// records/export shapes are query-engine-driven, so those stay loosely typed
/// (as with the [`Data`] surface).
#[derive(Debug, Clone, Copy)]
pub struct Datasets<'a> {
    pub(crate) c: &'a Inner,
}

impl Datasets<'_> {
    /// `GET /v1/datasets` — datasets that have accumulated extracted data. **Not**
    /// a [`Page`]: the daemon answers `{datasets: [...]}`, so this returns a
    /// [`DatasetList`] (unwrap its `datasets` field).
    pub async fn list(&self) -> Result<DatasetList> {
        self.c.get_json("/v1/datasets", &[]).await
    }

    /// `GET /v1/datasets/:id` — one dataset's metadata + schema (`404` if missing).
    pub async fn get(&self, id: i64) -> Result<DatasetMeta> {
        self.c.get_json(&format!("/v1/datasets/{id}"), &[]).await
    }

    /// `GET /v1/datasets/:id/records` — the dataset's row table. Pass query params
    /// through as given (`q`, `filter`, `filters`, `sort_by`, `sort_dir`, `limit`,
    /// `offset`, `include_inputs`, `collection`). Query-engine-shaped, so the
    /// response stays a loosely-typed [`Value`].
    pub async fn records(&self, id: i64, query: &[(&str, &str)]) -> Result<Value> {
        self.c
            .get_json(&format!("/v1/datasets/{id}/records"), query)
            .await
    }

    /// `GET /v1/datasets/:id/export` — raw export text. `format=json|csv|markdown|html`
    /// plus the same filters as [`Datasets::records`], via query params. markdown/html
    /// are content-aware: a crawl's pages export as readable documents, structured data
    /// as a table.
    pub async fn export(&self, id: i64, query: &[(&str, &str)]) -> Result<String> {
        self.c
            .get_text(&format!("/v1/datasets/{id}/export"), query)
            .await
    }

    /// `GET /v1/datasets/:id/records` RENDERED as text — the `?format=` twin of
    /// [`Datasets::records`].
    ///
    /// A non-`json` format returns prose/CSV rather than the JSON envelope, so it
    /// needs its own method (Rust has no return-type overloading). Pass
    /// [`DatasetFormat::Markdown`] to read a crawl's pages as documents, or a
    /// structured dataset as a table.
    pub async fn records_text(
        &self,
        id: i64,
        format: DatasetFormat,
        query: &[(&str, &str)],
    ) -> Result<String> {
        let mut q: Vec<(&str, &str)> = vec![("format", format.as_str())];
        q.extend_from_slice(query);
        self.c
            .get_text(&format!("/v1/datasets/{id}/records"), &q)
            .await
    }

    /// `GET /v1/datasets/search` RENDERED as text — the `?format=` twin of
    /// [`Datasets::search`]. The per-result dataset tag + highlight snippet exist
    /// only in the JSON shape.
    pub async fn search_text(
        &self,
        q: &str,
        format: DatasetFormat,
        params: &[(&str, &str)],
    ) -> Result<String> {
        let mut query: Vec<(&str, &str)> = vec![("q", q), ("format", format.as_str())];
        query.extend_from_slice(params);
        self.c.get_text("/v1/datasets/search", &query).await
    }

    /// `GET /v1/datasets/:id/search` RENDERED as text — the `?format=` twin of
    /// [`Datasets::search_one`].
    pub async fn search_one_text(
        &self,
        id: i64,
        q: &str,
        format: DatasetFormat,
        params: &[(&str, &str)],
    ) -> Result<String> {
        let mut query: Vec<(&str, &str)> = vec![("q", q), ("format", format.as_str())];
        query.extend_from_slice(params);
        self.c
            .get_text(&format!("/v1/datasets/{id}/search"), &query)
            .await
    }

    /// `GET /v1/datasets/search` — full-text search across **all** datasets. `q`
    /// is prepended to `params` (typically `limit`/`offset`) as the `q` query
    /// pair.
    pub async fn search(&self, q: &str, params: &[(&str, &str)]) -> Result<DatasetSearchResult> {
        let mut query: Vec<(&str, &str)> = vec![("q", q)];
        query.extend_from_slice(params);
        self.c.get_json("/v1/datasets/search", &query).await
    }

    /// `GET /v1/datasets/:id/search` — full-text search within one dataset. `q`
    /// is prepended to `params` (typically `limit`/`offset`) as the `q` query
    /// pair.
    pub async fn search_one(
        &self,
        id: i64,
        q: &str,
        params: &[(&str, &str)],
    ) -> Result<DatasetSearchResult> {
        let mut query: Vec<(&str, &str)> = vec![("q", q)];
        query.extend_from_slice(params);
        self.c
            .get_json(&format!("/v1/datasets/{id}/search"), &query)
            .await
    }
}
