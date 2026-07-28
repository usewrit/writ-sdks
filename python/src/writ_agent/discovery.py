"""Daemon discovery — the canonical algorithm (DESIGN §4).

Mirrors the daemon's own CLI/MCP discovery
(``src/local/cli/mcp_stdio.rs::daemon_candidate_homes`` +
``src/local/app/runtime_file.rs``):

1. Env overrides ``WRIT_API_URL`` / ``WRIT_TOKEN``. Both set → done (no probe).
   One set → it fills that field; the other is discovered.
2. ``runtime.json`` candidates, in order (first *live* one wins):
   1. ``$WRIT_HOME/runtime.json`` (when ``WRIT_HOME`` is set)
   2. ``~/.writ/active_profile`` → ``~/.writ/profiles/<p>/runtime.json``
      (``p`` non-empty, ``p != "local"``, ``len(p) <= 128``, chars ``[A-Za-z0-9_-]``)
   3. ``~/.writ/runtime.json``
   4. every ``~/.writ/profiles/*/runtime.json`` (cap 32, deduped vs above)
3. ``runtime.json``: ``{"pid", "port", "token", "version", "started_at"}``;
   base URL = ``http://127.0.0.1:<port>``.
4. Liveness probe: ``GET /v1/agent`` with the candidate token must answer 2xx
   within 2 s. A stale descriptor (crashed daemon) falls through to the next
   candidate. Even a single candidate is probed.

Explicit constructor options always win over discovery. If nothing resolves,
a :class:`~writ_agent.errors.WritDiscoveryError` explains how to fix it.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import httpx

from .errors import WritDiscoveryError

__all__ = ["discover_sync", "discover_async"]

#: Liveness-probe budget — loopback and cheap (matches the daemon's own 2 s).
PROBE_TIMEOUT = 2.0

#: Cap on the ``~/.writ/profiles/*`` scan (matches the daemon's ``take(32)``).
PROFILE_SCAN_CAP = 32

_PROFILE_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

_HOW_TO_FIX = (
    "is the Writ agent running? pass base_url=/token=... or set "
    "WRIT_API_URL/WRIT_TOKEN (or point WRIT_HOME at the agent's home directory)"
)


def _writ_base() -> Path:
    return Path(os.path.expanduser("~")) / ".writ"


def _read_runtime(path: Path) -> tuple[str, str] | None:
    """Parse a ``runtime.json`` into ``(base_url, token)``, or ``None`` if unusable."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        info = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(info, dict):
        return None
    port = info.get("port")
    token = info.get("token")
    if not isinstance(port, int) or not (0 < port < 65536):
        return None
    if not isinstance(token, str) or not token:
        return None
    return f"http://127.0.0.1:{port}", token


def _candidate_runtime_files() -> list[Path]:
    """Ordered, deduped ``runtime.json`` candidate paths (DESIGN §4 step 2)."""
    out: list[Path] = []
    seen: set[Path] = set()

    def push(p: Path) -> None:
        if p not in seen:
            seen.add(p)
            out.append(p)

    writ_home = os.environ.get("WRIT_HOME")
    if writ_home and writ_home.strip():
        push(Path(writ_home).expanduser() / "runtime.json")

    base = _writ_base()

    # Desktop's active profile pointer.
    try:
        profile = (base / "active_profile").read_text(encoding="utf-8").strip()
    except OSError:
        profile = ""
    if profile and profile != "local" and _PROFILE_RE.match(profile):
        push(base / "profiles" / profile / "runtime.json")

    push(base / "runtime.json")

    # Every known profile directory (cap 32, sorted for determinism).
    try:
        entries = sorted((base / "profiles").iterdir())[:PROFILE_SCAN_CAP]
    except OSError:
        entries = []
    for entry in entries:
        try:
            if entry.is_dir():
                push(entry / "runtime.json")
        except OSError:
            continue

    return out


def _plan(
    base_url: str | None, token: str | None
) -> tuple[tuple[str, str] | None, list[tuple[str, str]]]:
    """Resolve explicit args + env, then merge with runtime.json candidates.

    Returns ``(fixed, candidates)``: ``fixed`` is a ready ``(base_url, token)``
    when both fields are explicit (args or env — no probe needed); otherwise
    ``candidates`` is the ordered list of merged ``(base_url, token)`` pairs to
    probe (an explicit field overrides that field in every candidate).
    """
    env_base = os.environ.get("WRIT_API_URL")
    env_token = os.environ.get("WRIT_TOKEN")
    base = base_url or (env_base.strip() if env_base and env_base.strip() else None)
    tok = token or (env_token.strip() if env_token and env_token.strip() else None)
    if base:
        base = base.rstrip("/")
    if base and tok:
        return (base, tok), []

    candidates: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for path in _candidate_runtime_files():
        parsed = _read_runtime(path)
        if parsed is None:
            continue
        merged = ((base or parsed[0]).rstrip("/"), tok or parsed[1])
        if merged not in seen:
            seen.add(merged)
            candidates.append(merged)
    return None, candidates


def _no_candidates_error() -> WritDiscoveryError:
    return WritDiscoveryError(
        f"no Writ agent found: no usable runtime.json descriptor — {_HOW_TO_FIX}"
    )


def _all_stale_error(n: int) -> WritDiscoveryError:
    return WritDiscoveryError(
        f"no live Writ agent: {n} candidate descriptor(s) found but none answered "
        f"GET /v1/agent within {PROBE_TIMEOUT:.0f}s — {_HOW_TO_FIX}"
    )


def _probe_headers(token: str, user_agent: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "User-Agent": user_agent}


def discover_sync(
    base_url: str | None = None,
    token: str | None = None,
    *,
    verify: object = True,
    user_agent: str = "writ-sdk-python",
) -> tuple[str, str]:
    """Synchronous discovery. Returns a live ``(base_url, token)`` or raises
    :class:`WritDiscoveryError`."""
    fixed, candidates = _plan(base_url, token)
    if fixed is not None:
        return fixed
    if not candidates:
        raise _no_candidates_error()
    with httpx.Client(timeout=PROBE_TIMEOUT, verify=verify) as probe:  # type: ignore[arg-type]
        for cand_base, cand_token in candidates:
            try:
                resp = probe.get(
                    f"{cand_base}/v1/agent",
                    headers=_probe_headers(cand_token, user_agent),
                )
            except httpx.HTTPError:
                continue  # stale descriptor — fall through to the next candidate
            if resp.is_success:
                return cand_base, cand_token
    raise _all_stale_error(len(candidates))


async def discover_async(
    base_url: str | None = None,
    token: str | None = None,
    *,
    verify: object = True,
    user_agent: str = "writ-sdk-python",
) -> tuple[str, str]:
    """Async twin of :func:`discover_sync` (same algorithm, async probe)."""
    fixed, candidates = _plan(base_url, token)
    if fixed is not None:
        return fixed
    if not candidates:
        raise _no_candidates_error()
    async with httpx.AsyncClient(timeout=PROBE_TIMEOUT, verify=verify) as probe:  # type: ignore[arg-type]
        for cand_base, cand_token in candidates:
            try:
                resp = await probe.get(
                    f"{cand_base}/v1/agent",
                    headers=_probe_headers(cand_token, user_agent),
                )
            except httpx.HTTPError:
                continue
            if resp.is_success:
                return cand_base, cand_token
    raise _all_stale_error(len(candidates))
