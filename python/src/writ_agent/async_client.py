"""``AsyncWritAgent`` — the asynchronous client."""

from __future__ import annotations

import asyncio
import time
from typing import Any, AsyncIterator

import httpx

from . import _ops as ops
from . import discovery
from .cloud import AsyncCloud
from ._base import (
    MAX_EVENT_RECONNECTS,
    SSE_READ_TIMEOUT,
    USER_AGENT,
    BaseClient,
    check_response,
    connection_error,
    decode_response,
    request_kwargs,
)
from ._retry import (
    DEFAULT_RETRY,
    RetryPolicy,
    backoff_seconds,
    retry_after_seconds,
    should_retry_status,
)
from ._sse import SSEDecoder
from .errors import (
    WritApiError,
    WritConnectionError,
    WritError,
    WritTimeoutError,
    api_error_from_response,
)
from .types import TERMINAL_EVENTS, RunEvent, RunFeedItem

__all__ = ["AsyncWritAgent"]


def _timeout_message(run_id: int, wait_timeout: float) -> str:
    return (
        f"run {run_id} did not finish within {wait_timeout:g}s — the run was NOT "
        "cancelled and may still be executing (call runs.cancel to stop it)"
    )


class AsyncWritAgent(BaseClient):
    """Asynchronous client for the Writ local agent.

    Same surface as :class:`~writ_agent.WritAgent`; every resource method
    returns an awaitable of the same shape, and ``runs.events`` is an async
    generator (``async for``).

    **Discovery is lazy**: when ``base_url``/``token`` are fully known from
    arguments or ``WRIT_API_URL``/``WRIT_TOKEN``, the client is ready
    immediately; otherwise filesystem discovery + the liveness probe run on
    ``async with`` entry (or transparently before the first request) and may
    raise :class:`WritDiscoveryError` there. ::

        async with AsyncWritAgent() as client:
            print(await client.agent.status())
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        timeout: float = 30.0,
        verify: Any = True,
        ca_file: Any = None,
        transport: Any = None,
        api_key: str | None = None,
        cloud_url: str | None = None,
        client_id: str | None = None,
        retry: RetryPolicy | None = None,
    ) -> None:
        super().__init__(
            base_url,
            token,
            timeout=timeout,
            verify=verify,
            ca_file=ca_file,
            transport=transport,
        )
        # Unsafe methods are forced off: the local daemon has no idempotency
        # lane, so a repeated POST creates a second resource.
        self._retry = (retry or DEFAULT_RETRY).with_unsafe(False)
        # Tiered Writ Cloud surface (scrape/map/crawl) — its own base URL + credential.
        self.cloud = AsyncCloud(
            api_key=api_key, cloud_url=cloud_url, client_id=client_id,
            timeout=timeout, verify=self._verify, retry=retry,
        )
        self._http: httpx.AsyncClient | None = None
        self._ensure_lock = asyncio.Lock()
        # No probe is needed when both fields are explicit (args or env) —
        # configure eagerly so `.base_url`/`.token` are usable immediately.
        fixed, _ = discovery._plan(self._init_base, self._init_token)
        if fixed is not None:
            self._configure(*fixed)

    def _configure(self, base_url: str, token: str) -> None:
        self._base_url = base_url
        self._token = token
        client_kwargs: dict[str, Any] = {
            "base_url": base_url,
            "headers": self._headers(),
            "timeout": self._timeout,
            "verify": self._verify,
        }
        if self._transport is not None:
            client_kwargs["transport"] = self._transport
        self._http = httpx.AsyncClient(**client_kwargs)

    async def _ensure(self) -> httpx.AsyncClient:
        if self._http is not None:
            return self._http
        async with self._ensure_lock:
            if self._http is None:
                resolved = await discovery.discover_async(
                    self._init_base,
                    self._init_token,
                    verify=self._verify,
                    user_agent=USER_AGENT,
                )
                self._configure(*resolved)
        assert self._http is not None
        return self._http

    # -- lifecycle -----------------------------------------------------------

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()

    async def __aenter__(self) -> "AsyncWritAgent":
        await self._ensure()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    # -- transport -----------------------------------------------------------

    async def _call(self, op: ops.Op) -> Any:
        response = await self._request_with_retry(op)
        return decode_response(op, check_response(op, response))

    async def _request_with_retry(self, op: ops.Op) -> httpx.Response:
        """Issue the request, retrying transient failures per ``self._retry``.

        Unsafe methods are NOT retried here: this transport talks to the local
        daemon, which has no ``Idempotency-Key`` lane to make a repeated POST
        safe. See ``_retry.RetryPolicy``.
        """
        http = await self._ensure()
        policy = self._retry
        attempts = policy.attempts_for(op.method)
        last_exc: Exception | None = None

        for attempt in range(1, attempts + 1):
            response: httpx.Response | None = None
            try:
                response = await http.request(op.method, op.path, **request_kwargs(op))
                if not should_retry_status(response.status_code):
                    return response
            except httpx.TransportError as exc:
                last_exc = exc

            if attempt >= attempts:
                if response is not None:
                    return response
                assert last_exc is not None
                raise connection_error(self._base_url, last_exc) from last_exc

            wait = backoff_seconds(policy, attempt)
            requested = retry_after_seconds(response)
            if requested is not None:
                if requested > policy.max_retry_after and response is not None:
                    # The server says this will not clear any time soon. Hand the
                    # caller the real answer now — it carries the reset time.
                    return response
                wait = requested
            await asyncio.sleep(wait)

        raise AssertionError("unreachable")  # pragma: no cover

    # -- SSE (DESIGN §8) -----------------------------------------------------

    async def _run_events(
        self,
        run_id: int,
        _deadline: float | None = None,
        max_reconnects: int = MAX_EVENT_RECONNECTS,
    ) -> AsyncIterator[RunEvent]:
        """Async twin of ``WritAgent._run_events`` — same reconnect + de-dupe
        contract; see that docstring for why replayed frames are suppressed by
        sequence rather than by a Last-Event-ID the daemon does not serve."""
        http = await self._ensure()
        path = ops.runs_events_path(run_id)
        timeout = httpx.Timeout(
            self._timeout, read=None if _deadline is None else SSE_READ_TIMEOUT
        )
        delivered = 0
        attempts = 0

        while True:
            seen = 0
            terminal = False
            drop_exc: Exception | None = None
            try:
                async with http.stream("GET", path, timeout=timeout) as response:
                    if response.status_code >= 400:
                        await response.aread()
                        raise api_error_from_response(response)
                    decoder = SSEDecoder()
                    async for line in response.aiter_lines():
                        if _deadline is not None and time.monotonic() > _deadline:
                            raise WritTimeoutError(
                                f"run {run_id} event stream exceeded the wait deadline"
                            )
                        event = decoder.feed(line)
                        if event is None:
                            continue
                        seen += 1
                        if seen <= delivered:
                            continue  # replayed frame from before the drop
                        delivered = seen
                        yield event  # type: ignore[misc]
                        if event.get("event") in TERMINAL_EVENTS:
                            terminal = True
                            break
            except httpx.TransportError as exc:
                drop_exc = connection_error(self._base_url, exc)

            if terminal:
                return
            attempts += 1
            if attempts > max_reconnects:
                if drop_exc is not None:
                    raise drop_exc
                return
            await asyncio.sleep(backoff_seconds(DEFAULT_RETRY, attempts))

    # -- run_and_wait (DESIGN §8) ---------------------------------------------

    async def _run_and_wait(
        self,
        workflow_id: int,
        *,
        inputs: dict[str, Any] | None,
        persona_id: int | None,
        files: dict[str, str] | None,
        wait_timeout: float,
        poll_interval: float,
        include_results: bool,
    ) -> RunFeedItem:
        started = await self._call(
            ops.workflows_run(workflow_id, inputs, persona_id, False, files)
        )
        run_id = started.get("run_id") if isinstance(started, dict) else None
        if not isinstance(run_id, int):
            raise WritError(f"run did not return a run_id: {started!r}")
        deadline = time.monotonic() + wait_timeout

        terminal_seen = False
        try:
            # max_reconnects=0: the polling fallback below is strictly better
            # than reconnecting, so a dropped stream should reach it at once.
            async for event in self._run_events(
                run_id, _deadline=deadline, max_reconnects=0
            ):
                if event.get("event") in TERMINAL_EVENTS:
                    terminal_seen = True
                    break
        except WritTimeoutError:
            raise WritTimeoutError(_timeout_message(run_id, wait_timeout)) from None
        except (WritConnectionError, WritApiError):
            # SSE failed or dropped pre-terminal → poll (DESIGN §8 step 3).
            terminal_seen = False

        if terminal_seen:
            final: RunFeedItem = await self._call(ops.runs_get(run_id))
        else:
            while True:
                final = await self._call(ops.runs_get(run_id))
                if final.get("status") != "running":
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise WritTimeoutError(_timeout_message(run_id, wait_timeout))
                await asyncio.sleep(min(poll_interval, remaining))

        if include_results:
            final = dict(final)  # type: ignore[assignment]
            final["results"] = await self._call(ops.runs_results(run_id))
        return final
