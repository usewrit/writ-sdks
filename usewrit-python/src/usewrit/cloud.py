"""Writ Cloud runs with the developer's API key, through the existing run API.

- ``POST {base}/api/automation/workflows/{workflow_id}/run`` with
  ``{function_name?, form_data, mutation_mode?}`` answers ``{task_id, status}``;
- ``GET {base}/api/automation/tasks/{task_id}/results`` answers
  ``{status, success, result_data, extracted_data, error}``, polled with a backoff (1 s, growing
  by 1.5 up to 5 s, jittered) until the task is terminal or the deadline passes.

The data is the run's ``extracted_data``, else its ``result_data``. Same rules as the Node twin's
``runOnCloud``.
"""

from __future__ import annotations

import asyncio
import email.utils
import json
import random
import time
from collections.abc import Mapping
from typing import Any, Final
from urllib.parse import quote

import httpx

from ._version import __version__
from .constants import (
    CLOUD_POLL_GROWTH,
    CLOUD_POLL_INITIAL_MS,
    CLOUD_POLL_JITTER,
    CLOUD_POLL_MAX_MS,
    CLOUD_REQUEST_TIMEOUT_MS,
    CLOUD_UNRECOGNISED_READS,
)
from .contract import CloudMapping
from .errors import WritBridgeError

__all__ = ["CloudRunner", "CloudTiming"]

#: Every spelling of a task status Writ has used (the Arrivos driver's sets).
SUCCESS: Final = frozenset({"success", "succeeded", "completed", "complete", "done", "finished"})
TIMED_OUT: Final = frozenset({"timeout", "timed_out"})
CANCELLED: Final = frozenset({"cancelled", "canceled", "aborted", "stopped", "killed"})
FAILED: Final = frozenset({"failed", "failure", "error", "errored", "rejected"})
PENDING: Final = frozenset(
    {
        "",
        "pending",
        "queued",
        "running",
        "started",
        "in_progress",
        "processing",
        "scheduled",
        "waiting",
        "created",
        "dispatched",
        "retrying",
        "accepted",
    }
)


class CloudTiming:
    """How the result polling backs off, in milliseconds (tests shorten it)."""

    def __init__(self, initial_ms: float = CLOUD_POLL_INITIAL_MS, max_ms: float = CLOUD_POLL_MAX_MS) -> None:
        self.initial_ms = max(1.0, float(initial_ms))
        self.max_ms = max(self.initial_ms, float(max_ms))


class CloudRunner:
    """Runs mapped workflows on Writ Cloud with one ``httpx.AsyncClient``.

    Pass ``client`` to use your own (its lifetime stays yours); otherwise the runner opens one per
    event loop and closes it in :meth:`aclose`.
    """

    def __init__(
        self,
        *,
        base: str,
        api_key: str,
        client: httpx.AsyncClient | None = None,
        timing: CloudTiming | None = None,
    ) -> None:
        self._base = base.rstrip("/")
        self._api_key = api_key
        self._injected = client
        self._client: httpx.AsyncClient | None = None
        self._client_loop: asyncio.AbstractEventLoop | None = None
        self.timing = timing or CloudTiming()

    def _http(self) -> httpx.AsyncClient:
        if self._injected is not None:
            return self._injected
        loop = asyncio.get_running_loop()
        if self._client is None or self._client_loop is not loop or self._client.is_closed:
            # A client belongs to the loop it was made in; a new loop (a test, a restarted
            # server) gets a new one.
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(CLOUD_REQUEST_TIMEOUT_MS / 1000),
                headers={"user-agent": f"usewrit-python/{__version__}"},
                follow_redirects=False,
            )
            self._client_loop = loop
        return self._client

    async def aclose(self) -> None:
        """Close the client the runner opened (on this loop)."""
        client, self._client = self._client, None
        if client is None or client.is_closed:
            return
        try:
            same_loop = self._client_loop is asyncio.get_running_loop()
        except RuntimeError:
            same_loop = False
        if same_loop:
            await client.aclose()

    async def run(
        self,
        *,
        mapping: CloudMapping,
        key: str,
        inputs: Mapping[str, Any],
        timeout_ms: int,
        dry_run: bool = False,
    ) -> Any:
        """Run a mapped workflow on Writ Cloud and wait for its data.

        Raises :class:`~usewrit.errors.WritBridgeError`: ``NOT_GRANTED`` (401/403),
        ``QUOTA_EXCEEDED`` (402), ``CLOUD_NOT_CONFIGURED`` (no such workflow or function),
        ``INPUT_INVALID`` (400/422), ``RATE_LIMITED`` (429), ``CLOUD_UNAVAILABLE`` (unreachable,
        5xx, unreadable answers), ``RUN_FAILED`` / ``TIMEOUT`` / ``CANCELLED`` (how the task
        ended), ``TIMEOUT`` (still running at the deadline; the run itself continues on Writ
        Cloud).
        """
        client = self._http()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_ms / 1000.0
        headers = {
            "authorization": f"Bearer {self._api_key}",
            "content-type": "application/json",
            "accept": "application/json",
        }
        body: dict[str, Any] = {"form_data": dict(inputs)}
        if mapping.function is not None:
            body["function_name"] = mapping.function
        if dry_run:
            body["mutation_mode"] = "dry_run"

        run_url = f"{self._base}/api/automation/workflows/{mapping.workflow_id}/run"
        budget = min(CLOUD_REQUEST_TIMEOUT_MS / 1000, max(0.001, deadline - loop.time()))
        try:
            dispatch = await client.post(
                run_url,
                content=json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                headers=headers,
                timeout=httpx.Timeout(budget),
            )
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise WritBridgeError(
                "CLOUD_UNAVAILABLE",
                f"{key}: Writ Cloud could not be reached; the run was not sent, or its answer was lost.",
            ) from exc
        if dispatch.status_code >= 400:
            raise _dispatch_refused(key, dispatch)
        dispatched = _read_json(dispatch)
        task_id = dispatched.get("task_id") if isinstance(dispatched, dict) else None
        if isinstance(task_id, bool) or not isinstance(task_id, (int, str)) or str(task_id).strip() == "":
            raise WritBridgeError("CLOUD_UNAVAILABLE", f"{key}: Writ Cloud accepted the run but answered no task id.")

        results_url = f"{self._base}/api/automation/tasks/{quote(str(task_id), safe='')}/results"
        details = {"task_id": task_id, "workflow_id": mapping.workflow_id}
        interval = self.timing.initial_ms
        max_interval = self.timing.max_ms
        unrecognised = 0
        last_status = "pending"
        read_headers = {"authorization": headers["authorization"], "accept": "application/json"}

        while True:
            read_budget = min(CLOUD_REQUEST_TIMEOUT_MS / 1000, max(1.0, deadline - loop.time()))
            reply: httpx.Response | None
            try:
                reply = await client.get(results_url, headers=read_headers, timeout=httpx.Timeout(read_budget))
            except httpx.HTTPError:
                # A slow read, a dropped connection, a Writ Cloud deploy: not an answer either way.
                reply = None
            pause_ms: float | None = None
            if reply is not None:
                status = reply.status_code
                if status in (401, 403):
                    raise WritBridgeError(
                        "NOT_GRANTED",
                        f"{key}: Writ Cloud refused WRIT_API_KEY while reading the result.",
                        details={**details, "status": status},
                    )
                if status == 429:
                    retry = _retry_after_ms(reply)
                    pause_ms = retry if retry is not None else interval
                elif status >= 500 or status == 404:
                    pass  # A gateway answering for a restarting Writ Cloud, or a task a moment too new.
                elif status >= 400:
                    raise WritBridgeError(
                        "CLOUD_UNAVAILABLE",
                        f"{key}: Writ Cloud answered HTTP {status} to the result read.",
                        details={**details, "status": status},
                    )
                else:
                    result = _read_json(reply)
                    if isinstance(result, dict):
                        raw_status = result.get("status")
                        state = ("" if raw_status is None else str(raw_status)).strip().lower()
                        last_status = state or last_status
                        if state in SUCCESS or (result.get("success") is True and state not in PENDING):
                            return _data_of(key, result, details)
                        if (
                            state in FAILED
                            or state in TIMED_OUT
                            or state in CANCELLED
                            or result.get("success") is False
                        ):
                            raise _run_failure(key, state, result, details)
                        if state in PENDING:
                            unrecognised = 0
                        else:
                            unrecognised += 1
                            if unrecognised >= CLOUD_UNRECOGNISED_READS:
                                raise WritBridgeError(
                                    "RUN_FAILED",
                                    f"{key}: the Writ Cloud run ended with a status this SDK does not know "
                                    f"({state[:40]}).",
                                    details=details,
                                )
            left = deadline - loop.time()
            if left <= 0:
                raise WritBridgeError(
                    "TIMEOUT",
                    f"{key}: the Writ Cloud run did not finish within {round(timeout_ms / 1000)} s "
                    f"(last status: {last_status or 'pending'}).",
                    details=details,
                )
            if pause_ms is None:
                pause_ms = interval * (1 - CLOUD_POLL_JITTER + random.random() * 2 * CLOUD_POLL_JITTER)
            await asyncio.sleep(max(0.0, min(pause_ms / 1000.0, left)))
            interval = min(max_interval, interval * CLOUD_POLL_GROWTH)


def _read_json(response: httpx.Response) -> Any:
    try:
        text = response.text
        return None if text == "" else json.loads(text)
    except ValueError:
        return None


def _data_of(key: str, result: Mapping[str, Any], details: Mapping[str, Any]) -> Any:
    error = result.get("error")
    if isinstance(error, str) and error.strip() != "" and result.get("success") is not True:
        raise WritBridgeError("RUN_FAILED", f"{key}: {error}", details=details)
    if result.get("extracted_data") is not None:
        return result["extracted_data"]
    if "result_data" in result:
        return result["result_data"]
    return None


def _run_failure(key: str, status: str, result: Mapping[str, Any], details: Mapping[str, Any]) -> WritBridgeError:
    error = result.get("error")
    reason = error.strip() if isinstance(error, str) and error.strip() != "" else (status or "no reason given")
    if status in TIMED_OUT:
        return WritBridgeError("TIMEOUT", f"{key}: the Writ Cloud run timed out ({reason}).", details=details)
    if status in CANCELLED:
        return WritBridgeError("CANCELLED", f"{key}: the Writ Cloud run was cancelled ({reason}).", details=details)
    return WritBridgeError("RUN_FAILED", f"{key}: the Writ Cloud run failed: {reason}", details=details)


def _dispatch_refused(key: str, response: httpx.Response) -> WritBridgeError:
    status = response.status_code
    body = _read_json(response)
    detail = body.get("detail") if isinstance(body, dict) else None
    detail_code = detail.get("code") if isinstance(detail, dict) and isinstance(detail.get("code"), str) else None
    if isinstance(detail, dict) and isinstance(detail.get("message"), str):
        detail_message: str | None = detail["message"]
    elif isinstance(detail, str):
        detail_message = detail
    else:
        detail_message = None
    details: dict[str, Any] = {"status": status}
    if detail_code is not None:
        details["cloud_code"] = detail_code
    suffix = f": {detail_message[:300]}" if detail_message is not None else ""

    if status in (401, 403):
        return WritBridgeError(
            "NOT_GRANTED",
            f"{key}: Writ Cloud refused WRIT_API_KEY for this workflow (HTTP {status}){suffix}.",
            details=details,
        )
    if status == 402:
        return WritBridgeError(
            "QUOTA_EXCEEDED", f"{key}: the Writ Cloud plan behind WRIT_API_KEY is out of runs{suffix}.", details=details
        )
    if status == 404:
        return WritBridgeError(
            "CLOUD_NOT_CONFIGURED",
            f"{key}: the mapped Writ Cloud workflow does not exist in the WRIT_API_KEY account.",
            details=details,
        )
    if status == 422 and detail_code == "unknown_function":
        return WritBridgeError(
            "CLOUD_NOT_CONFIGURED", f"{key}: the mapped Writ Cloud workflow has no such function{suffix}.", details=details
        )
    if status in (400, 422):
        return WritBridgeError("INPUT_INVALID", f"{key}: Writ Cloud refused the run{suffix}.", details=details)
    if status == 429:
        retry = _retry_after_ms(response)
        if retry is not None:
            details["retry_after_ms"] = retry
        return WritBridgeError(
            "RATE_LIMITED", f"{key}: Writ Cloud is limiting runs; try again later{suffix}.", details=details
        )
    if status >= 500:
        return WritBridgeError(
            "CLOUD_UNAVAILABLE",
            f"{key}: Writ Cloud answered HTTP {status} to the run; whether it started is unknown.",
            details=details,
        )
    return WritBridgeError("RUN_FAILED", f"{key}: Writ Cloud refused the run (HTTP {status}){suffix}.", details=details)


def _retry_after_ms(response: httpx.Response) -> float | None:
    """Writ Cloud's ``Retry-After`` in ms (seconds or an HTTP date), capped at 60 s."""
    raw = response.headers.get("retry-after")
    if raw is None:
        return None
    raw = raw.strip()
    try:
        seconds = float(raw)
    except ValueError:
        seconds = None
    if seconds is not None and seconds >= 0 and seconds == seconds and seconds != float("inf"):
        return min(seconds * 1000.0, 60_000.0)
    try:
        when = email.utils.parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    return min(max(0.0, (when.timestamp() - time.time()) * 1000.0), 60_000.0)
