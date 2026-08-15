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
  WritPlanLimitError,
  WritRunTimeoutError,
  codeForStatus,
} from "./errors.js";

export {
  CloudApi,
  CloudMonitors,
  CloudAutomations,
  CloudPersonas,
  CloudBuilds,
  TERMINAL_BUILD_STATUSES,
} from "./cloud.js";
export type {
  CloudOptions,
  CloudTier,
  KeylessQuota,
  ScrapeResult,
  MapResult,
  CloudMonitor,
  CloudMonitorCreate,
  CloudMonitorPatch,
  CloudMonitorListParams,
  CloudMonitorChange,
  CloudMonitorRunResult,
  CloudAutomation,
  CloudAutomationCreate,
  CloudAutomationListParams,
  CloudPersona,
  CloudPersonaCreate,
  TotpValidation,
  CloudBuild,
  CloudBuildOptions,
  KeylessCrawlResult,
} from "./cloud.js";

export { discoverAgent, normalizeBaseUrl } from "./discovery.js";
export type { DiscoveryOptions, ResolvedConnection, RuntimeInfo } from "./discovery.js";

export { iterateSseFrames } from "./sse.js";
export type { SseFrame } from "./sse.js";

export { watchChanges } from "./cloud.js";
export type { WatchOptions } from "./cloud.js";

export {
  DEFAULT_RETRY_POLICY,
  backoffMs,
  isSafeMethod,
  newIdempotencyKey,
  retryAfterMs,
  withRetry,
} from "./retry.js";
export type { RetryPolicy } from "./retry.js";

export {
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_V1_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WritWebhookVerificationError,
  signWebhookRequest,
  verifyWebhook,
} from "./webhook.js";
export type { HeaderSource, VerifyWebhookOptions, WebhookFailureReason } from "./webhook.js";

export {
  DEFAULT_AUTO_PAGE_SIZE,
  autoPage,
  normalizePage,
  runRowId,
  fileSlots,
  outputFiles,
  isTerminalEvent,
  crawlBrandName,
} from "./types.js";
export type {
  AgentStatus,
  ApiKey,
  ApiKeyCreated,
  Automation,
  AutomationCreate,
  AutomationRunResult,
  AutomationUpdate,
  CancelResult,
  ChangeListParams,
  CrawlCancelResult,
  CrawlFileEntry,
  CrawlFilesResult,
  CrawlJob,
  CrawlList,
  CacheStamp,
  CrawlDataTable,
  SavedCrawlFilesResult,
  CrawlDefinition,
  CrawlDefinitionList,
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
  FileSlot,
  FileUploadOptions,
  Health,
  Monitor,
  MonitorCreate,
  MonitorHistory,
  MonitorUpdate,
  OpenEnum,
  OutputFile,
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
  RunSavedCrawlOptions,
  SaveCrawlBody,
  SavedCrawlData,
  SavedCrawlRun,
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
  CrawlBrand,
} from "./types.js";

export { USER_AGENT, VERSION } from "./version.js";
