"""``WritAgent`` — the synchronous client."""

from __future__ import annotations

import time
from typing import Any, Iterator

import httpx

from . import _ops as ops
from . import discovery
from .cloud import Cloud
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

__all__ = ["WritAgent"]


def _timeout_message(run_id: int, wait_timeout: float) -> str:
    return (
        f"run {run_id} did not finish within {wait_timeout:g}s — the run was NOT "
        "cancelled and may still be executing (call runs.cancel to stop it)"
    )


class WritAgent(BaseClient):
    """Synchronous client for the Writ local agent.

    With no ``base_url``/``token``, the constructor performs daemon discovery
    (env → ``runtime.json`` candidates → 2 s liveness probe; DESIGN §4) and
    raises :class:`WritDiscoveryError` when no live daemon is found. Explicit
    options always win over discovery.

    Usable as a context manager::

        with WritAgent() as client:
            print(client.agent.status())
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
        # Tiered Writ Cloud surface (scrape/map/crawl) — its own base URL + credential,
        # independent of the local-daemon transport above.
        self.cloud = Cloud(
            api_key=api_key, cloud_url=cloud_url, client_id=client_id,
            timeout=timeout, verify=self._verify, retry=retry,
        )
        resolved_base, resolved_token = discovery.discover_sync(
            self._init_base,
            self._init_token,
            verify=self._verify,
            user_agent=USER_AGENT,
        )
        self._base_url = resolved_base
        self._token = resolved_token
        client_kwargs: dict[str, Any] = {
            "base_url": resolved_base,
            "headers": self._headers(),
            "timeout": self._timeout,
            "verify": self._verify,
        }
        if transport is not None:
            client_kwargs["transport"] = transport
        self._http = httpx.Client(**client_kwargs)

    # -- lifecycle -----------------------------------------------------------

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "WritAgent":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- transport -----------------------------------------------------------

    def _call(self, op: ops.Op) -> Any:
        response = self._request_with_retry(op)
        return decode_response(op, check_response(op, response))

    def _request_with_retry(self, op: ops.Op) -> httpx.Response:
        """Issue the request, retrying transient failures per ``self._retry``.

        Unsafe methods are NOT retried here: this transport talks to the local
        daemon, which has no ``Idempotency-Key`` lane to make a repeated POST
        safe. See ``_retry.RetryPolicy``.
        """
        policy = self._retry
        attempts = policy.attempts_for(op.method)
        last_exc: Exception | None = None

        for attempt in range(1, attempts + 1):
            response: httpx.Response | None = None
            try:
                response = self._http.request(op.method, op.path, **request_kwargs(op))
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
            time.sleep(wait)

        raise AssertionError("unreachable")  # pragma: no cover

    # -- SSE (DESIGN §8) -----------------------------------------------------

    def _run_events(
        self,
        run_id: int,
        _deadline: float | None = None,
        max_reconnects: int = MAX_EVENT_RECONNECTS,
    ) -> Iterator[RunEvent]:
        """Yield a run's SSE lifecycle events, reconnecting across drops.

        A stream that ends BEFORE a terminal event is reconnected up to
        ``max_reconnects`` times with backoff. Reconnecting replays the run's
        events from the start, so already-delivered frames are suppressed by
        sequence: the caller sees one continuous, gap-free, duplicate-free stream
        across a proxy timeout or a daemon restart.

        ``run_and_wait`` passes ``max_reconnects=0`` — it has a strictly better
        fallback (polling), so a drop should reach it immediately rather than
        burning the reconnect ladder's backoff first.
        """
        path = ops.runs_events_path(run_id)
        timeout = httpx.Timeout(
            self._timeout, read=None if _deadline is None else SSE_READ_TIMEOUT
        )
        # The daemon has no Last-Event-ID lane, so resumption is client-side:
        # replay and skip what we have already handed to the caller.
        delivered = 0
        attempts = 0

        while True:
            seen = 0
            terminal = False
            drop_exc: Exception | None = None
            try:
                with self._http.stream("GET", path, timeout=timeout) as response:
                    if response.status_code >= 400:
                        response.read()
                        raise api_error_from_response(response)
                    decoder = SSEDecoder()
                    for line in response.iter_lines():
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
            # A clean end with no terminal event is a drop too: the run is still
            # going and the connection simply went away.
            attempts += 1
            if attempts > max_reconnects:
                if drop_exc is not None:
                    raise drop_exc
                return
            time.sleep(backoff_seconds(DEFAULT_RETRY, attempts))

    # -- run_and_wait (DESIGN §8) ---------------------------------------------

    def _run_and_wait(
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
        started = self._call(
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
            for event in self._run_events(run_id, _deadline=deadline, max_reconnects=0):
                if event.get("event") in TERMINAL_EVENTS:
                    terminal_seen = True
                    break
        except WritTimeoutError:
            raise WritTimeoutError(_timeout_message(run_id, wait_timeout)) from None
        except (WritConnectionError, WritApiError):
            # SSE failed or dropped pre-terminal → poll (DESIGN §8 step 3).
            terminal_seen = False

        if terminal_seen:
            final: RunFeedItem = self._call(ops.runs_get(run_id))
        else:
            while True:
                final = self._call(ops.runs_get(run_id))
                if final.get("status") != "running":
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise WritTimeoutError(_timeout_message(run_id, wait_timeout))
                time.sleep(min(poll_interval, remaining))

        if include_results:
            final = dict(final)  # type: ignore[assignment]
            final["results"] = self._call(ops.runs_results(run_id))
        return final
