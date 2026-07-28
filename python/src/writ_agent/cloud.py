"""Tiered Writ Cloud surface: ``scrape``, ``map``, and whole-site ``crawl``.

Unlike the rest of this SDK (which talks to the LOCAL daemon), these verbs run on
Writ Cloud — never on the calling machine — with a Firecrawl-style tier model
resolved from your credential:

  * **Metered** — an API key (``api_key`` arg → ``WRIT_API_KEY`` env) → the authed
    ``/api/crawl/*`` surface, billed per page. ``scrape``, ``map`` AND ``crawl`` work.
  * **Keyless** — no key → the free ``/v1/keyless/*`` tier, daily-capped per install
    (a stable client-id header) AND per IP. ``scrape`` + ``map`` only; ``crawl``
    raises :class:`WritApiKeyRequiredError`.

The credential fallback chain (``api_key`` → ``WRIT_API_KEY`` → keyless) mirrors
Firecrawl's, so the same code scales from an anonymous test to a metered key.
"""

from __future__ import annotations

import base64
import os
import secrets
from pathlib import Path
from typing import Any, Optional

import httpx

from .errors import (
    WritApiError,
    WritApiKeyRequiredError,
    WritConnectionError,
    WritInsufficientCreditsError,
    WritRateLimitedError,
    code_for_status,
)

DEFAULT_CLOUD_URL = "https://api.usewrit.app"
CLIENT_ID_HEADER = "X-Writ-Client-Id"

__all__ = ["Cloud", "AsyncCloud", "DEFAULT_CLOUD_URL"]


def _resolve_api_key(api_key: Optional[str]) -> Optional[str]:
    return api_key or os.environ.get("WRIT_API_KEY") or None


def _resolve_cloud_url(cloud_url: Optional[str]) -> str:
    return (cloud_url or os.environ.get("WRIT_CLOUD_URL") or DEFAULT_CLOUD_URL).rstrip("/")


def _mint_id() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(16)).decode("ascii").rstrip("=")


def load_or_mint_client_id(override: Optional[str] = None) -> str:
    """The stable keyless device id: ``override`` → ``WRIT_CLIENT_ID`` → ``~/.writ/client_id``."""
    if override:
        return override
    env = os.environ.get("WRIT_CLIENT_ID")
    if env:
        return env
    try:
        path = Path.home() / ".writ" / "client_id"
        if path.exists():
            existing = path.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        cid = _mint_id()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(cid, encoding="utf-8")
            os.chmod(path, 0o600)
        except OSError:
            pass  # read-only fs → use the ephemeral id
        return cid
    except OSError:
        return _mint_id()


def _decode(resp: httpx.Response) -> Any:
    if not resp.text:
        return {}
    try:
        return resp.json()
    except ValueError:
        return resp.text


def _cloud_error(status: int, body: Any) -> WritApiError:
    detail = body.get("detail") if isinstance(body, dict) else None
    d = detail if isinstance(detail, dict) else {}
    code = d.get("code") or (body.get("code") if isinstance(body, dict) else None) or code_for_status(status)
    message = d.get("message") or (detail if isinstance(detail, str) else None) or f"HTTP {status}"
    if status == 429:
        return WritRateLimitedError(
            status, code, message, body,
            reset_at=d.get("reset_at"),
            requests_remaining=d.get("requests_remaining"),
            pages_remaining=d.get("pages_remaining"),
        )
    if status == 402 and code == "api_key_required":
        return WritApiKeyRequiredError(status, code, message, body)
    if status == 402:
        return WritInsufficientCreditsError(status, code, message, body)
    return WritApiError(status, code, message, body)


class _CloudConfig:
    """Shared credential/URL/client-id resolution for the sync + async cloud clients."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        cloud_url: Optional[str] = None,
        client_id: Optional[str] = None,
        timeout: float = 30.0,
        verify: Any = True,
        transport: Any = None,
    ) -> None:
        self._api_key = _resolve_api_key(api_key)
        self._base = _resolve_cloud_url(cloud_url)
        self._client_id_override = client_id
        self._client_id: Optional[str] = None
        self._timeout = timeout
        self._verify = verify
        self._transport = transport

    @property
    def tier(self) -> str:
        """``"metered"`` when an API key is present, else ``"keyless"``."""
        return "metered" if self._api_key else "keyless"

    def _headers(self) -> dict[str, str]:
        if self._api_key:
            return {"Authorization": f"Bearer {self._api_key}"}
        if self._client_id is None:
            self._client_id = load_or_mint_client_id(self._client_id_override)
        return {CLIENT_ID_HEADER: self._client_id}

    def _scrape_path(self) -> str:
        return "/api/crawl/scrape" if self._api_key else "/v1/keyless/scrape"

    def _map_path(self) -> str:
        return "/api/crawl/map" if self._api_key else "/v1/keyless/map"

    def _require_key(self, what: str) -> None:
        if not self._api_key:
            raise WritApiKeyRequiredError(
                402,
                "api_key_required",
                f"{what} needs an API key — set api_key or WRIT_API_KEY. "
                "Keyless access covers scrape and map only.",
                None,
            )


class Cloud(_CloudConfig):
    """Synchronous tiered cloud surface. Mounted as ``client.cloud``."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._http: Optional[httpx.Client] = None

    def _client(self) -> httpx.Client:
        if self._http is None:
            kw: dict[str, Any] = {"base_url": self._base, "timeout": self._timeout, "verify": self._verify}
            if self._transport is not None:
                kw["transport"] = self._transport
            self._http = httpx.Client(**kw)
        return self._http

    def _send(self, method: str, path: str, json: Any = None) -> Any:
        try:
            resp = self._client().request(method, path, json=json, headers=self._headers())
        except httpx.TransportError as exc:
            raise WritConnectionError(f"cloud request to {path} failed: {exc}") from exc
        body = _decode(resp)
        if resp.is_success:
            return body
        raise _cloud_error(resp.status_code, body)

    def scrape(self, url: str) -> dict[str, Any]:
        """Scrape ONE page to clean markdown. Works on both tiers."""
        out = self._send("POST", self._scrape_path(), {"url": url})
        if isinstance(out, dict):
            out.setdefault("tier", self.tier)
        return out

    def map(self, url: str, *, search: Optional[str] = None, limit: Optional[int] = None) -> dict[str, Any]:
        """Map a site's URLs, ranked by an optional ``search``. Works on both tiers."""
        body: dict[str, Any] = {"url": url, "search": search or ""}
        if limit is not None:
            body["limit"] = limit
        out = self._send("POST", self._map_path(), body)
        if isinstance(out, dict):
            out.setdefault("tier", self.tier)
        return out

    def crawl(self, url: str, **options: Any) -> dict[str, Any]:
        """Start a whole-site crawl. METERED ONLY — raises :class:`WritApiKeyRequiredError`
        (before any network call) on the keyless tier."""
        self._require_key("Whole-site crawl")
        return self._send("POST", "/api/crawl", {"url": url, **options})

    def crawl_status(self, crawl_id: int) -> dict[str, Any]:
        """Poll a metered crawl's status (requires an API key)."""
        self._require_key("Crawl status")
        return self._send("GET", f"/api/crawl/{crawl_id}")

    def quota(self) -> Optional[dict[str, Any]]:
        """Remaining keyless allowance for this install (``None`` when metered)."""
        if self._api_key:
            return None
        return self._send("GET", "/v1/keyless/quota")

    def close(self) -> None:
        if self._http is not None:
            self._http.close()


class AsyncCloud(_CloudConfig):
    """Asynchronous tiered cloud surface. Mounted as ``client.cloud`` on the async client."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._http: Optional[httpx.AsyncClient] = None

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            kw: dict[str, Any] = {"base_url": self._base, "timeout": self._timeout, "verify": self._verify}
            if self._transport is not None:
                kw["transport"] = self._transport
            self._http = httpx.AsyncClient(**kw)
        return self._http

    async def _send(self, method: str, path: str, json: Any = None) -> Any:
        try:
            resp = await self._client().request(method, path, json=json, headers=self._headers())
        except httpx.TransportError as exc:
            raise WritConnectionError(f"cloud request to {path} failed: {exc}") from exc
        body = _decode(resp)
        if resp.is_success:
            return body
        raise _cloud_error(resp.status_code, body)

    async def scrape(self, url: str) -> dict[str, Any]:
        out = await self._send("POST", self._scrape_path(), {"url": url})
        if isinstance(out, dict):
            out.setdefault("tier", self.tier)
        return out

    async def map(self, url: str, *, search: Optional[str] = None, limit: Optional[int] = None) -> dict[str, Any]:
        body: dict[str, Any] = {"url": url, "search": search or ""}
        if limit is not None:
            body["limit"] = limit
        out = await self._send("POST", self._map_path(), body)
        if isinstance(out, dict):
            out.setdefault("tier", self.tier)
        return out

    async def crawl(self, url: str, **options: Any) -> dict[str, Any]:
        self._require_key("Whole-site crawl")
        return await self._send("POST", "/api/crawl", {"url": url, **options})

    async def crawl_status(self, crawl_id: int) -> dict[str, Any]:
        self._require_key("Crawl status")
        return await self._send("GET", f"/api/crawl/{crawl_id}")

    async def quota(self) -> Optional[dict[str, Any]]:
        if self._api_key:
            return None
        return await self._send("GET", "/v1/keyless/quota")

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
