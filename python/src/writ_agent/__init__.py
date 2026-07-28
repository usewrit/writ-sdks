"""writ-agent — official Python SDK for the Writ local agent (writ-agentd).

Quickstart::

    from writ_agent import WritAgent, run_row_id

    with WritAgent() as client:            # discovers the local daemon
        for wf in client.workflows.list():
            print(wf["id"], wf["name"])
        run = client.workflows.run_and_wait(3, inputs={"city": "Paris"})
        print(run["status"], client.runs.data(run_row_id(run))["data"])

See the package README for the full surface, discovery, and error handling.
"""

from ._version import __version__
from .async_client import AsyncWritAgent
from .client import WritAgent
from .cloud import AsyncCloud, Cloud
from .errors import (
    WritApiError,
    WritApiKeyRequiredError,
    WritConnectionError,
    WritDiscoveryError,
    WritError,
    WritInsufficientCreditsError,
    WritRateLimitedError,
    WritRunTimeoutError,
    WritTimeoutError,
)
from .pagination import Page
from .types import (
    TERMINAL_EVENTS,
    AgentHealth,
    AgentStatus,
    ApiKey,
    Automation,
    CancelResult,
    CrawlJob,
    CrawlList,
    CrawlStartBody,
    CrawlStatus,
    Dataset,
    DatasetList,
    ErrorEvent,
    Extractor,
    FinishedEvent,
    Monitor,
    MonitorHistory,
    Persona,
    ProgressEvent,
    RecentChange,
    RunData,
    RunEvent,
    RunFeedItem,
    RunResults,
    RunCompleted,
    RunStarted,
    SecretMeta,
    Selector,
    StartedEvent,
    StepEvent,
    StoredFile,
    VaultStatus,
    Workflow,
    WsTicket,
    run_row_id,
)

__all__ = [
    "__version__",
    "WritAgent",
    "AsyncWritAgent",
    "Page",
    "WritError",
    "WritApiError",
    "WritApiKeyRequiredError",
    "WritInsufficientCreditsError",
    "WritRateLimitedError",
    "Cloud",
    "AsyncCloud",
    "WritConnectionError",
    "WritDiscoveryError",
    "WritRunTimeoutError",
    "WritTimeoutError",
    "run_row_id",
    "TERMINAL_EVENTS",
    # types
    "AgentStatus",
    "AgentHealth",
    "Workflow",
    "RunCompleted",
    "RunStarted",
    "CancelResult",
    "RunFeedItem",
    "RunResults",
    "RunData",
    "Monitor",
    "MonitorHistory",
    "RecentChange",
    "Selector",
    "Extractor",
    "Automation",
    "Persona",
    "SecretMeta",
    "VaultStatus",
    "StoredFile",
    "ApiKey",
    "CrawlStatus",
    "CrawlStartBody",
    "CrawlJob",
    "CrawlList",
    "Dataset",
    "DatasetList",
    "WsTicket",
    "StartedEvent",
    "StepEvent",
    "ProgressEvent",
    "FinishedEvent",
    "ErrorEvent",
    "RunEvent",
]
