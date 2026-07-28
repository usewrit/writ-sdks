//! Runtime-agnostic helpers.
//!
//! The library deliberately does **not** depend on tokio (DESIGN.md keeps the
//! dependency set lean; tokio is a dev-dependency only), so the 1 s polling cadence
//! of `run_and_wait` cannot use `tokio::time::sleep`. Instead we run a short-lived
//! OS thread that parks for the duration and wakes the task — one thread per poll
//! tick, on the (rare) SSE-fallback path only. Deadlines are enforced with
//! `std::time::Instant` checks plus per-request reqwest timeouts.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

#[derive(Debug, Default)]
struct SleepState {
    done: bool,
    waker: Option<Waker>,
}

/// A future that completes after `dur`, driven by a detached helper thread.
#[derive(Debug)]
pub(crate) struct ThreadSleep {
    shared: Arc<Mutex<SleepState>>,
}

/// Sleep without a runtime dependency. Spawns one short-lived thread.
pub(crate) fn sleep(dur: Duration) -> ThreadSleep {
    let shared = Arc::new(Mutex::new(SleepState::default()));
    let thread_shared = Arc::clone(&shared);
    std::thread::spawn(move || {
        std::thread::sleep(dur);
        let mut st = thread_shared.lock().unwrap_or_else(|e| e.into_inner());
        st.done = true;
        if let Some(waker) = st.waker.take() {
            waker.wake();
        }
    });
    ThreadSleep { shared }
}

impl Future for ThreadSleep {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let mut st = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        if st.done {
            Poll::Ready(())
        } else {
            st.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}
