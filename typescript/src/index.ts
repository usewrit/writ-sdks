/**
 * @usewrit/agent-sdk — official TypeScript SDK for the Writ local agent
 * (`writ-agentd`) loopback API.
 *
 * ```ts
 * import { WritAgent } from "@usewrit/agent-sdk";
 * const client = new WritAgent();
 * const run = await client.workflows.runAndWait(3, { inputs: { city: "Paris" } });
 * ```
 */

export { WritAgent } from "./client.js";
export type { WritAgentOptions } from "./client.js";
export {
  AgentApi,
  AutomationsApi,
  CrawlApi,
  DataApi,
  DatasetsApi,
  ExtractorsApi,
  FilesApi,
  KeysApi,
  MonitorsApi,
  PersonasApi,
  RunsApi,
  SecretsApi,
  SelectorsApi,
  VaultApi,
  WorkflowsApi,
} from "./client.js";

export {
  WritError,
  WritApiError,
  WritConnectionError,
  WritDiscoveryError,
  WritApiKeyRequiredError,
  WritInsufficientCreditsError,
  WritRateLimitedError,
  WritRunTimeoutError,
  codeForStatus,
} from "./errors.js";

export { CloudApi } from "./cloud.js";
export type {
  CloudOptions,
  CloudTier,
  KeylessQuota,
  ScrapeResult,
  MapResult,
} from "./cloud.js";

export { discoverAgent, normalizeBaseUrl } from "./discovery.js";
export type { DiscoveryOptions, ResolvedConnection, RuntimeInfo } from "./discovery.js";

export { iterateSseFrames } from "./sse.js";
export type { SseFrame } from "./sse.js";

export { normalizePage, runRowId, isTerminalEvent } from "./types.js";
export type {
  AgentStatus,
  ApiKey,
  ApiKeyCreated,
  Automation,
  AutomationCreate,
  AutomationRunResult,
  AutomationUpdate,
  CancelResult,
  CrawlCancelResult,
  CrawlJob,
  CrawlList,
  CrawlStartBody,
  CrawlStatus,
  DataDeleteBody,
  DataDeleteResult,
  DataQueryParams,
  DataWorkflowSummary,
  DataWorkflows,
  Dataset,
  DatasetFormat,
  DatasetList,
  DatasetSearchHit,
  DatasetSearchResult,
  DatasetTextFormat,
  DryRunReport,
  Extractor,
  ExtractorCreate,
  ExtractorUpdate,
  FileFromDataBody,
  FileMeta,
  FileUploadOptions,
  Health,
  Monitor,
  MonitorCreate,
  MonitorHistory,
  MonitorUpdate,
  OpenEnum,
  Page,
  Persona,
  PersonaRun,
  PersonaWrite,
  RecentChange,
  RunAndWaitOptions,
  RunData,
  RunEvent,
  RunEventError,
  RunEventFinished,
  RunEventProgress,
  RunEventStarted,
  RunEventStep,
  RunFeedItem,
  RunListParams,
  RunOptions,
  RunResults,
  RunStarted,
  RunStatus,
  SecretListParams,
  SecretMeta,
  SecretSetOptions,
  Selector,
  SelectorCreate,
  SelectorUpdate,
  StepStatus,
  Test2faResult,
  ValidateTotpBody,
  ValidateTotpResult,
  VaultStatus,
  Workflow,
  WorkflowCreate,
  WorkflowListParams,
  WorkflowPlaceholder,
  WorkflowSession,
  WorkflowUpdate,
  WsTicket,
  WsTicketRoute,
} from "./types.js";

export { USER_AGENT, VERSION } from "./version.js";
