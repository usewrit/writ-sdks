//! # writ-client
//!
//! Official Rust SDK for the **Writ local agent** (`writ-agentd`) — the loopback
//! HTTP API on `127.0.0.1:8131` (see `sdks/DESIGN.md` and
//! `sdks/openapi/writ-agent.yaml` in the Writ repository).
//!
//! ```no_run
//! use writ_client::{WritAgent, RunOptions};
//!
//! # async fn demo() -> Result<(), writ_client::WritError> {
//! let agent = WritAgent::discover().await?; // env → ~/.writ/runtime.json → probe
//! let workflows = agent.workflows().list().await?;
//! let first = &workflows.data[0];
//! let outcome = agent
//!     .workflows()
//!     .run_and_wait(first.id, &RunOptions::default())
//!     .await?;
//! println!("{} → {}", first.name, outcome.run.status);
//! # Ok(())
//! # }
//! ```
//!
//! ## Design notes
//! - **Async-only**, built on `reqwest`; the library itself has no tokio
//!   dependency (any reqwest-compatible runtime works).
//! - Every list method returns a uniform [`Page`], whatever envelope the daemon
//!   used on the wire.
//! - Errors are the three-kind model of DESIGN.md §5: [`WritError::Api`],
//!   [`WritError::Connection`], [`WritError::Discovery`]. No automatic retries.
//! - Models type the stable scalar fields and keep everything else in an
//!   `extra` map, so a newer daemon never breaks deserialization.

// [`WritError`] is a deliberately flat, public error enum: every non-2xx shape
// (including the cloud-tier `RateLimited`/`ApiKeyRequired`/`InsufficientCredits`
// variants) carries its parsed `body` and fields inline rather than behind a
// `Box`, so callers can match on them without indirection. That makes the enum
// wider than clippy's `result_large_err` threshold — an accepted trade-off for an
// SDK error type; boxing would only muddy the public API.
#![allow(clippy::result_large_err)]

mod client;
mod cloud;
mod discovery;
mod error;
mod models;
mod page;
mod resources;
mod retry;
mod sse;
mod util;
mod watch;
pub mod webhook;

pub use bytes::Bytes;
pub use client::{WritAgent, WritAgentBuilder};
pub use cloud::{
    ChangeListOptions, CloudAutomation, CloudAutomationAction, CloudAutomationListOptions,
    CloudAutomations, CloudBuild, CloudBuildParams, CloudBuilds, CloudClient, CloudClientBuilder,
    CloudMonitor, CloudMonitorChange, CloudMonitorListOptions, CloudMonitorRun, CloudMonitors,
    CloudPersona, CloudPersonas, CloudTier, KeylessCrawlLimits, KeylessCrawlOptions,
    KeylessCrawlPage, KeylessCrawlResult, KeylessQuota, MapCounts, MapEntry, MapOptions, MapResult,
    RecentChange, ScrapeOptions, ScrapeResult, TotpValidation, TERMINAL_BUILD_STATUSES,
};
pub use error::{Result, WritError};
pub use models::{file_slots, output_files};
pub use models::{
    AgentStatus, ApiKey, Automation, Brand, CacheStamp, CancelOutcome, CrawlCancel, CrawlDataTable,
    CrawlDefinition, CrawlDefinitionList, CrawlFileEntry, CrawlFilesResult, CrawlJob, CrawlList,
    CrawlStartParams, Dataset, DatasetFormat, DatasetList, DatasetMeta, DatasetRef,
    DatasetSearchHit, DatasetSearchResult, Extra, Extractor, FileSlot, Health, Monitor,
    MonitorHistory, OutputFile, Persona, RunCompleted, RunData, RunEvent, RunFeedItem, RunOutcome,
    RunResults, RunSavedCrawlParams, RunStarted, SaveCrawlParams, SavedCrawlData,
    SavedCrawlFilesResult, SavedCrawlRun, SecretMeta, Selector, StoredFile, VaultStatus, Workflow,
    WsTicket,
};
pub use page::{auto_page, Page, DEFAULT_AUTO_PAGE_SIZE};
pub use resources::{
    Agent, Automations, Crawl, Data, Datasets, Extractors, Files, Keys, Monitors, Personas,
    RunEventStream, RunOptions, Runs, Secrets, Selectors, Vault, Workflows,
};
pub use retry::RetryPolicy;
pub use watch::{watch_changes, WatchOptions, CURSOR_FLOOR};
