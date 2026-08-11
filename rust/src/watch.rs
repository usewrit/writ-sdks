//! Cursor-driven change watching.
//!
//! Polling a change feed correctly is harder than it looks:
//!
//! * The newest-first view plus a `limit` silently DROPS changes whenever more
//!   than `limit` of them land between two polls. Nothing errors; the rows simply
//!   never arrive.
//! * A change row is UPDATED, not re-inserted, when the same difference recurs,
//!   so `last_detected_at` moves and an id already processed resurfaces at the
//!   head of the feed.
//! * `last_detected_at` is not unique, so ordering on it alone lets two rows
//!   sharing a millisecond straddle a page boundary — and the trailing one is
//!   never returned again.
//!
//! [`watch_changes`] drives the server's keyset cursor instead, which makes
//! "everything after this point" exact. A resurfaced id is delivered as what it
//! actually is: a fresh detection, with a later cursor value.

use std::future::Future;
use std::time::Duration;

use futures_core::Stream;

use crate::cloud::{ChangeListOptions, RecentChange};
use crate::error::Result;

/// Cursor floor used to replay a feed from the beginning.
///
/// NOT the same as omitting `since`: omitting it selects the server's
/// newest-first BROWSING view, whose order runs backwards against a forward
/// walk. A floor cursor keeps the request in keyset mode — oldest-first, strictly
/// advancing — which is the only ordering a watcher can consume.
pub const CURSOR_FLOOR: &str = "1970-01-01T00:00:00+00:00";

/// Tuning for a change watcher. [`WatchOptions::default`] polls every 30 s, 100
/// rows a page, starting from the current head of the feed.
#[derive(Debug, Clone)]
pub struct WatchOptions {
    /// Poll cadence. A watcher never polls faster than this even when a page
    /// comes back full — it drains the backlog first, then resumes the cadence.
    pub interval: Duration,
    /// Rows per request.
    pub page_size: i64,
    /// Resume a previous watcher exactly where it stopped. Persist the last
    /// delivered change's `last_detected_at` and `id`, hand them back here, and
    /// no change detected during the downtime is missed.
    pub since: Option<String>,
    pub since_id: i64,
    /// Start from the beginning of the feed instead of its head. Ignored when
    /// `since` is set. Off by default: a fresh watcher on an account with months
    /// of history should not open by re-delivering all of it.
    pub replay_history: bool,
    /// Stop the stream on the first polling error instead of retrying with
    /// backoff. Off by default: one bad response should not silently kill a
    /// change feed a production system depends on.
    pub stop_on_error: bool,
}

impl Default for WatchOptions {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(30),
            page_size: 100,
            since: None,
            since_id: 0,
            replay_history: false,
            stop_on_error: false,
        }
    }
}

/// Grow the wait after consecutive failures, capped at 10 intervals, so a
/// persistently broken feed does not hammer the API at the full poll rate.
fn error_wait(interval: Duration, failures: u32) -> Duration {
    interval
        .saturating_mul(1u32 << failures.saturating_sub(1).min(10))
        .min(interval.saturating_mul(10))
}

/// The shared cursor loop behind every `watch()`.
///
/// `fetch` takes a [`ChangeListOptions`] and resolves to one page. Errors are
/// yielded as stream items; the stream keeps polling unless
/// [`WatchOptions::stop_on_error`] is set.
pub fn watch_changes<F, Fut>(
    opts: WatchOptions,
    fetch: F,
) -> impl Stream<Item = Result<RecentChange>>
where
    F: Fn(ChangeListOptions) -> Fut,
    Fut: Future<Output = Result<Vec<RecentChange>>>,
{
    async_stream_impl(opts, fetch)
}

/// Hand-rolled generator (no `async-stream` dependency): the state machine is
/// small enough to express with `futures_util::stream::unfold`.
fn async_stream_impl<F, Fut>(
    opts: WatchOptions,
    fetch: F,
) -> impl Stream<Item = Result<RecentChange>>
where
    F: Fn(ChangeListOptions) -> Fut,
    Fut: Future<Output = Result<Vec<RecentChange>>>,
{
    struct State {
        since: Option<String>,
        since_id: i64,
        buffered: std::collections::VecDeque<RecentChange>,
        failures: u32,
        bootstrapped: bool,
        done: bool,
    }

    let interval = opts.interval;
    let page_size = opts.page_size.max(1);
    let replay = opts.replay_history;
    let stop_on_error = opts.stop_on_error;

    let state = State {
        since: opts.since.clone(),
        since_id: opts.since_id,
        buffered: std::collections::VecDeque::new(),
        failures: 0,
        bootstrapped: opts.since.is_some(),
        done: false,
    };

    futures_util::stream::unfold((state, fetch), move |(mut st, fetch)| async move {
        loop {
            if st.done {
                return None;
            }
            if let Some(next) = st.buffered.pop_front() {
                st.since = Some(next.last_detected_at.clone());
                st.since_id = next.id;
                return Some((Ok(next), (st, fetch)));
            }

            // Establish the starting cursor on the first pass.
            if !st.bootstrapped {
                st.bootstrapped = true;
                if replay {
                    st.since = Some(CURSOR_FLOOR.to_string());
                    st.since_id = 0;
                } else {
                    // The no-cursor view IS newest-first: read one row and start
                    // AFTER it, so a fresh watcher opens on "what happens from
                    // now on" rather than the whole archive.
                    let head = fetch(ChangeListOptions::limit(1)).await;
                    match head {
                        Ok(rows) => match rows.first() {
                            Some(row) => {
                                st.since = Some(row.last_detected_at.clone());
                                st.since_id = row.id;
                            }
                            None => {
                                st.since = Some(CURSOR_FLOOR.to_string());
                                st.since_id = 0;
                            }
                        },
                        Err(err) => {
                            st.since = Some(CURSOR_FLOOR.to_string());
                            st.since_id = 0;
                            if stop_on_error {
                                st.done = true;
                            }
                            return Some((Err(err), (st, fetch)));
                        }
                    }
                }
            }

            let page = fetch(ChangeListOptions {
                limit: Some(page_size),
                since: st.since.clone(),
                since_id: Some(st.since_id),
            })
            .await;

            match page {
                Ok(rows) => {
                    st.failures = 0;
                    let full = rows.len() as i64 == page_size;
                    let cursor = st.since.clone().unwrap_or_default();
                    for row in rows {
                        // Guard against a server echoing the cursor row back:
                        // strictly advancing means a malformed page can never
                        // loop forever.
                        if row.last_detected_at < cursor
                            || (row.last_detected_at == cursor && row.id <= st.since_id)
                        {
                            continue;
                        }
                        st.buffered.push_back(row);
                    }
                    if st.buffered.is_empty() {
                        // A full page with nothing new would spin; only sleep
                        // when the page was genuinely short.
                        if !full {
                            tokio::time::sleep(interval).await;
                        } else {
                            tokio::time::sleep(Duration::from_millis(1)).await;
                        }
                    }
                }
                Err(err) => {
                    if stop_on_error {
                        st.done = true;
                        return Some((Err(err), (st, fetch)));
                    }
                    st.failures = st.failures.saturating_add(1);
                    let wait = error_wait(interval, st.failures);
                    let item = Err(err);
                    tokio::time::sleep(wait).await;
                    return Some((item, (st, fetch)));
                }
            }
        }
    })
}
