//! Daemon discovery (DESIGN.md §4) — the same filesystem walk the daemon's own
//! stdio-MCP bridge performs (`cli/mcp_stdio.rs::daemon_candidate_homes` +
//! `app/runtime_file.rs`).
//!
//! Order:
//! 1. Env overrides `WRIT_API_URL` / `WRIT_TOKEN` (both set ⇒ discovery is done).
//! 2. `runtime.json` candidates, first **live** one wins:
//!    1. `$WRIT_HOME/runtime.json` (when `WRIT_HOME` is set — always first)
//!    2. `~/.writ/active_profile` → `~/.writ/profiles/<p>/runtime.json`
//!       (profile id validated: non-empty, ≠ `"local"`, ≤ 128 chars, `[A-Za-z0-9_-]`)
//!    3. `~/.writ/runtime.json`
//!    4. every directory under `~/.writ/profiles/*/runtime.json` (cap 32, deduped)
//! 3. Liveness: `GET /v1/agent` with the candidate token must answer 2xx within 2 s;
//!    a stale descriptor falls through to the next candidate.

use std::path::PathBuf;

use serde::Deserialize;

/// Scan cap on the `~/.writ/profiles/*` directory walk (matches the daemon).
const PROFILE_SCAN_CAP: usize = 32;

/// The subset of `runtime.json`
/// (`{"pid": u32, "port": u16, "token": "wlt_…", "version": str, "started_at": rfc3339}`)
/// discovery needs. Unknown fields are ignored.
#[derive(Debug, Deserialize)]
struct RuntimeDescriptor {
    port: u16,
    token: String,
}

/// One discovery candidate: a base URL + token pair read from a `runtime.json`.
#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub base_url: String,
    pub token: String,
    /// Where the descriptor came from (for error messages only — never the token).
    pub source: PathBuf,
}

/// `$HOME` (unix) / `%USERPROFILE%` (windows) via std::env — no `dirs` crate.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Profile-id validation mirrored from the daemon: non-empty, not `"local"`,
/// ≤ 128 chars, `[A-Za-z0-9_-]` only.
fn is_safe_profile(p: &str) -> bool {
    !p.is_empty()
        && p != "local"
        && p.len() <= 128
        && p.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The ordered, deduped `runtime.json` paths to try.
fn candidate_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(writ_home) = std::env::var_os("WRIT_HOME") {
        paths.push(PathBuf::from(writ_home).join("runtime.json"));
    }
    if let Some(home) = home_dir() {
        let base = home.join(".writ");
        if let Ok(profile) = std::fs::read_to_string(base.join("active_profile")) {
            let p = profile.trim();
            if is_safe_profile(p) {
                paths.push(base.join("profiles").join(p).join("runtime.json"));
            }
        }
        paths.push(base.join("runtime.json"));
        if let Ok(entries) = std::fs::read_dir(base.join("profiles")) {
            for entry in entries.flatten().take(PROFILE_SCAN_CAP) {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    paths.push(entry.path().join("runtime.json"));
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect()
}

/// Read + parse every existing candidate descriptor, in order.
pub(crate) fn runtime_candidates() -> Vec<Candidate> {
    candidate_paths()
        .into_iter()
        .filter_map(|path| {
            let bytes = std::fs::read(&path).ok()?;
            let desc: RuntimeDescriptor = serde_json::from_slice(&bytes).ok()?;
            Some(Candidate {
                base_url: format!("http://127.0.0.1:{}", desc.port),
                token: desc.token,
                source: path,
            })
        })
        .collect()
}

/// Non-empty env var, or `None`.
pub(crate) fn env_var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_id_validation_mirrors_daemon() {
        assert!(is_safe_profile("acct_42-A"));
        assert!(!is_safe_profile(""));
        assert!(!is_safe_profile("local"));
        assert!(!is_safe_profile("../evil"));
        assert!(!is_safe_profile("a b"));
        assert!(!is_safe_profile(&"x".repeat(129)));
        assert!(is_safe_profile(&"x".repeat(128)));
    }
}
