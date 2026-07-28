package writ

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// Field-level shapes below mirror the Rust daemon source (wire truth):
// writ-agent/src/local/api/v1/*.rs and store/*.rs. Stable scalar
// columns are strongly typed; dynamic/JSON-ish fields (workflow steps, run
// results, …) are json.RawMessage. Unknown extra fields on the wire are
// ignored by encoding/json, so additive daemon changes never break decoding.

// AgentStatus is GET /v1/agent (server.rs::agent_status).
type AgentStatus struct {
	Status      string  `json:"status"`
	Version     string  `json:"version"`
	ActiveRuns  int64   `json:"active_runs"`
	Encrypted   bool    `json:"encrypted"`
	DueMonitors int64   `json:"due_monitors"`
	LastTickAt  *string `json:"last_tick_at"`
	WarmBrowser bool    `json:"warm_browser"`
}

// AgentHealth is GET /v1/health (server.rs::health).
type AgentHealth struct {
	Status        string `json:"status"`
	Version       string `json:"version"`
	CipherPresent bool   `json:"cipher_present"`
	DBOk          bool   `json:"db_ok"`
	KeyringOk     bool   `json:"keyring_ok"`
	ActiveRuns    int64  `json:"active_runs"`
	Scheduler     struct {
		LastTickAt  *string `json:"last_tick_at"`
		DueMonitors int64   `json:"due_monitors"`
	} `json:"scheduler"`
	WarmBrowser bool `json:"warm_browser"`
	CloudLink   struct {
		Linked    bool    `json:"linked"`
		AccountID *string `json:"account_id"`
	} `json:"cloud_link"`
}

// Workflow is a redacted workflow row (store/workflows.rs::Workflow shaped
// through api/v1/workflows.rs::redact — no credentials_encrypted; JSON-TEXT
// columns re-hydrated to real JSON; has_credentials/credential_keys/
// placeholders/has_login attached).
type Workflow struct {
	ID           int64   `json:"id"`
	Name         string  `json:"name"`
	Description  *string `json:"description"`
	WorkflowType string  `json:"workflow_type"`
	EntryURL     *string `json:"entry_url"`

	Steps            json.RawMessage `json:"steps"`
	RawReplay        json.RawMessage `json:"raw_replay"`
	FormData         json.RawMessage `json:"form_data"`
	ExitCondition    json.RawMessage `json:"exit_condition"`
	InputRules       json.RawMessage `json:"input_rules"`
	APIFunctions     json.RawMessage `json:"api_functions"`
	StreamingConfig  json.RawMessage `json:"streaming_config"`
	Functions        json.RawMessage `json:"functions"`
	LoginURLPatterns json.RawMessage `json:"login_url_patterns"`
	AuthConfig       json.RawMessage `json:"auth_config"`

	TimeoutMS       int64 `json:"timeout_ms"`
	RetryCount      int64 `json:"retry_count"`
	Headless        int64 `json:"headless"`
	FastMode        int64 `json:"fast_mode"`
	IsActive        int64 `json:"is_active"`
	IsVerified      int64 `json:"is_verified"`
	ScheduleEnabled int64 `json:"schedule_enabled"`

	ScheduleIntervalMS *int64  `json:"schedule_interval_ms"`
	ScheduleKind       *string `json:"schedule_kind"`
	ScheduleTime       *string `json:"schedule_time"`
	ScheduleDays       *string `json:"schedule_days"`
	ScheduleTZ         *string `json:"schedule_tz"`
	LastScheduledAt    *string `json:"last_scheduled_at"`
	NextScheduledAt    *string `json:"next_scheduled_at"`

	SessionPersistence int64  `json:"session_persistence"`
	SessionTTLSeconds  *int64 `json:"session_ttl_seconds"`
	ReloginMaxRetries  int64  `json:"relogin_max_retries"`
	HTTPCapable        int64  `json:"http_capable"`
	DefaultPersonaID   *int64 `json:"default_persona_id"`

	EstimatedDurationMS *int64 `json:"estimated_duration_ms"`
	UsageCount          int64  `json:"usage_count"`
	TotalRunCount       int64  `json:"total_run_count"`
	TotalFailureCount   int64  `json:"total_failure_count"`
	ConsecutiveFailures int64  `json:"consecutive_failures"`

	LastRunAt               *string `json:"last_run_at"`
	LastRunStatus           *string `json:"last_run_status"`
	LastRunDurationMS       *int64  `json:"last_run_duration_ms"`
	LastRunHasExtractedData *int64  `json:"last_run_has_extracted_data"`
	LastFailureAt           *string `json:"last_failure_at"`
	LastFailureError        *string `json:"last_failure_error"`
	CloudCallable           int64   `json:"cloud_callable"`
	ExecutionTarget         *string `json:"execution_target"`
	MarketplaceSlug         *string `json:"marketplace_slug"`
	CreatedAt               string  `json:"created_at"`
	UpdatedAt               *string `json:"updated_at"`

	// Attached by the daemon's redact() — never the ciphertext itself.
	HasCredentials bool            `json:"has_credentials"`
	CredentialKeys []string        `json:"credential_keys"`
	Placeholders   json.RawMessage `json:"placeholders"`
	HasLogin       bool            `json:"has_login"`

	// Marketplace attach projection (detail responses of PROXY rows only).
	Marketplace json.RawMessage `json:"marketplace,omitempty"`
}

// RunOptions is the body of POST /v1/workflows/:id/run
// (api/v1/workflows.rs::RunBody). The daemon also accepts "form_data" as an
// alias for inputs; the SDK exposes only Inputs. WaitTimeout applies only to
// RunAndWait (default 600s) and never crosses the wire.
type RunOptions struct {
	// Inputs is the free-form {NAME: value} object resolved over
	// {{NAME}}/{{input.NAME}} placeholders.
	Inputs map[string]any `json:"inputs,omitempty"`
	// PersonaID overrides the workflow's pinned default persona for this run.
	PersonaID *int64 `json:"persona_id,omitempty"`
	// Files binds the workflow's declared upload slots to vault file ids
	// ({slot: file_id}).
	Files map[string]string `json:"files,omitempty"`
	// WaitTimeout is the RunAndWait overall deadline (default 600s). Not
	// serialized.
	WaitTimeout time.Duration `json:"-"`
	// Wait asks the DAEMON to block until the run is terminal (?wait=true) and
	// answer with the run's own result, instead of returning a handle to observe.
	// Sent as a query parameter, not in the body.
	//
	// Use RunAndWait instead when you want live events, the enriched run feed
	// item, or a deadline longer than the daemon's own ceiling.
	Wait bool `json:"-"`
	// Timeout is how long the daemon may block when Wait is set. Clamped
	// server-side to [1s, 3600s]; default 120s. Sent as a query parameter.
	Timeout time.Duration `json:"-"`
}

// RunStarted is the 202 response of POST /v1/workflows/:id/run.
type RunStarted struct {
	RunID  int64  `json:"run_id"`
	Status string `json:"status"`
}

// RunCompleted is the 200 response of POST /v1/workflows/:id/run?wait=true —
// the run's terminal document.
//
// A FAILED run arrives here as a normal result with Status "failed", NOT as an
// error: the call succeeded in reporting the outcome. Check Status.
type RunCompleted struct {
	RunID int64 `json:"run_id"`
	// One of: success, failed, timeout, cancelled.
	Status string `json:"status"`
	Done   bool   `json:"done"`
	// Data is the run's result payload, when it produced one.
	Data json.RawMessage `json:"data,omitempty"`
	// Error explains a non-success terminal state.
	Error      string `json:"error,omitempty"`
	DurationMS int64  `json:"duration_ms,omitempty"`
	// StatusURL/EventsURL are populated only on the 504 (still-running) body.
	StatusURL string `json:"status_url,omitempty"`
	EventsURL string `json:"events_url,omitempty"`
}

// WorkflowCancelResult is POST /v1/workflows/:id/cancel — either
// 202 {id, run_id, status:"cancel_requested"} or 409 {id, status:"not_running"}
// (the 409 is a valid answer, returned as a result, not an error).
type WorkflowCancelResult struct {
	ID     int64  `json:"id"`
	RunID  int64  `json:"run_id,omitempty"`
	Status string `json:"status"`
}

// WorkflowSession is GET /v1/workflows/:id/session.
type WorkflowSession struct {
	WorkflowID int64   `json:"workflow_id"`
	HasSession bool    `json:"has_session"`
	Engine     *string `json:"engine,omitempty"`
	ExpiresAt  *string `json:"expires_at,omitempty"`
	LastUsedAt *string `json:"last_used_at,omitempty"`
}

// WorkflowDeleted is DELETE /v1/workflows/:id. Uninstall is present only when
// deleting a marketplace PROXY row (the delete doubles as the uninstall).
type WorkflowDeleted struct {
	ID        int64           `json:"id"`
	Deleted   bool            `json:"deleted"`
	Uninstall json.RawMessage `json:"uninstall,omitempty"`
}

// RunFeedItem is the enriched run projection returned by GET /v1/runs and
// GET /v1/runs/:id (api/v1/runs.rs::RunFeedItem). ID is a composite string
// "<run_type>-<row_id>" (e.g. "workflow-3"); use RowID for the numeric id
// that get/cancel/events take. Statuses are open string enums: running,
// success, failed, cancelled, timeout, captcha_required, twofa_required.
type RunFeedItem struct {
	ID             string  `json:"id"`
	RunType        string  `json:"run_type"`
	EntityID       *int64  `json:"entity_id"`
	EntityName     *string `json:"entity_name"`
	Status         string  `json:"status"`
	StartedAt      *string `json:"started_at"`
	FinishedAt     *string `json:"finished_at"`
	DurationMS     *int64  `json:"duration_ms"`
	TriggerSource  *string `json:"trigger_source"`
	Error          *string `json:"error"`
	DetailURLHint  *string `json:"detail_url_hint"`
	DataURLHint    *string `json:"data_url_hint"`
	RowsExtracted  *int64  `json:"rows_extracted"`
	ChangeDetected *bool   `json:"change_detected"`
	Engine         *string `json:"engine,omitempty"`
}

// RowID extracts the numeric run row id from the composite feed id
// ("workflow-3" → 3, true). It returns (0, false) when the id carries no
// parseable numeric suffix.
func (r *RunFeedItem) RowID() (int64, bool) {
	i := strings.LastIndexByte(r.ID, '-')
	if i < 0 || i == len(r.ID)-1 {
		return 0, false
	}
	n, err := strconv.ParseInt(r.ID[i+1:], 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// RunResults is GET /v1/runs/:id/results.
type RunResults struct {
	RunID  int64           `json:"run_id"`
	Status string          `json:"status"`
	Result json.RawMessage `json:"result"`
}

// RunData is GET /v1/runs/:id/data (JSON lane; see RunsService.DataCSV for
// the CSV lane).
type RunData struct {
	RunID  int64           `json:"run_id"`
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data"`
}

// CancelResult is POST /v1/runs/:id/cancel — either
// 202 {run_id, status:"cancel_requested"} or 409 {run_id, status:"not_running",
// run_status?}. The 409 is a valid answer, returned as a result, not an error.
type CancelResult struct {
	RunID  int64  `json:"run_id"`
	Status string `json:"status"`
	// RunStatus is the row's terminal status when the run was not cancellable.
	RunStatus string `json:"run_status,omitempty"`
}

// RunEvent is one frame of the GET /v1/runs/:id/events SSE stream
// (engine/events.rs::RunEvent, serde-tagged on "event"). Event is one of
// started | step | progress | finished | error; the other fields are
// populated per variant:
//
//	started:  RunID, TotalSteps
//	step:     RunID, Index, StepType, Status (running|succeeded|failed|skipped)
//	progress: RunID, Completed, Total
//	finished: RunID, Status (terminal run status) — stream-closing
//	error:    RunID, Message — stream-closing
type RunEvent struct {
	Event      string `json:"event"`
	RunID      int64  `json:"run_id"`
	TotalSteps int    `json:"total_steps,omitempty"`
	Index      int    `json:"index,omitempty"`
	StepType   string `json:"step_type,omitempty"`
	Status     string `json:"status,omitempty"`
	Completed  int    `json:"completed,omitempty"`
	Total      int    `json:"total,omitempty"`
	Message    string `json:"message,omitempty"`
}

// Terminal reports whether this event closes the stream (finished/error).
func (e RunEvent) Terminal() bool {
	return e.Event == "finished" || e.Event == "error"
}

// Monitor is a target row (store/targets.rs::Target), enriched on list/get
// with live check state and counts (api/v1/monitors.rs::enrich). setup_steps
// is credential-redacted by the daemon.
type Monitor struct {
	ID                 int64   `json:"id"`
	URL                string  `json:"url"`
	CheckType          string  `json:"check_type"`
	Selector           *string `json:"selector"`
	IgnoreRegex        *string `json:"ignore_regex"`
	CheckPeriodMS      *int64  `json:"check_period_ms"`
	ExpectedStatusCode *int64  `json:"expected_status_code"`
	TimeoutMS          *int64  `json:"timeout_ms"`
	MaxResponseTimeMS  *int64  `json:"max_response_time_ms"`
	CheckSSL           *int64  `json:"check_ssl"`
	Enabled            int64   `json:"enabled"`
	RequiresPlaywright int64   `json:"requires_playwright"`

	BaselineHash       *string         `json:"baseline_hash"`
	BaselineFetchedAt  *string         `json:"baseline_fetched_at"`
	PreCheckWorkflowID *int64          `json:"pre_check_workflow_id"`
	SetupSteps         json.RawMessage `json:"setup_steps"`

	OnChangeWorkflowID *int64          `json:"on_change_workflow_id"`
	OnChangeEnabled    int64           `json:"on_change_enabled"`
	OnChangeConditions json.RawMessage `json:"on_change_conditions"`
	OnChangeInSession  int64           `json:"on_change_in_session"`

	PersonaID                    *int64          `json:"persona_id"`
	NotificationProviders        json.RawMessage `json:"notification_providers"`
	ProviderNotificationSettings json.RawMessage `json:"provider_notification_settings"`
	NotificationTitle            *string         `json:"notification_title"`
	NotificationMessage          *string         `json:"notification_message"`
	NotificationPriority         *int64          `json:"notification_priority"`

	NextRunAt    *string `json:"next_run_at"`
	ScheduleKind *string `json:"schedule_kind"`
	ScheduleTime *string `json:"schedule_time"`
	ScheduleDays *string `json:"schedule_days"`
	ScheduleTZ   *string `json:"schedule_tz"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    *string `json:"updated_at"`

	// Enrichment (list/get only): the live monitor_state snapshot + counts.
	State          *string `json:"state,omitempty"`
	LastCheckedAt  *string `json:"last_checked_at,omitempty"`
	StatusCode     *int64  `json:"status_code,omitempty"`
	IsUp           *bool   `json:"is_up,omitempty"`
	LastChangeAt   *string `json:"last_change_at,omitempty"`
	StateUpdatedAt *string `json:"state_updated_at,omitempty"`
	ChangesCount   *int64  `json:"changes_count,omitempty"`
	SelectorCount  *int64  `json:"selector_count,omitempty"`
}

// MonitorChanges is GET /v1/monitors/:id/changes — both history series
// paginated against the same window.
type MonitorChanges struct {
	MonitorID    int64           `json:"monitor_id"`
	Limit        int64           `json:"limit"`
	Offset       int64           `json:"offset"`
	HasMore      bool            `json:"has_more"`
	Changes      json.RawMessage `json:"changes"`
	UptimeChecks json.RawMessage `json:"uptime_checks"`
}

// Selector is a target_selectors row (store/target_selectors.rs).
type Selector struct {
	ID                int64           `json:"id"`
	TargetID          int64           `json:"target_id"`
	Name              string          `json:"name"`
	Selector          string          `json:"selector"`
	Description       *string         `json:"description"`
	Enabled           int64           `json:"enabled"`
	ContentType       *string         `json:"content_type"`
	VisualRegion      json.RawMessage `json:"visual_region"`
	IgnoreRegex       *string         `json:"ignore_regex"`
	Priority          *int64          `json:"priority"`
	BaselineHash      *string         `json:"baseline_hash"`
	BaselineFetchedAt *string         `json:"baseline_fetched_at"`
	LastContentHash   *string         `json:"last_content_hash"`
	LastCheckedAt     *string         `json:"last_checked_at"`
	ChangeCount       *int64          `json:"change_count"`
	CreatedAt         string          `json:"created_at"`
	UpdatedAt         *string         `json:"updated_at"`
}

// SelectorToggle is POST /v1/monitors/:id/selectors/:sid/toggle.
type SelectorToggle struct {
	SelectorID int64 `json:"selector_id"`
	Enabled    bool  `json:"enabled"`
}

// Extractor is a selector_extractors row (store/selector_extractors.rs).
type Extractor struct {
	ID               int64           `json:"id"`
	TargetSelectorID int64           `json:"target_selector_id"`
	Name             string          `json:"name"`
	OutputName       string          `json:"output_name"`
	Enabled          int64           `json:"enabled"`
	ExtractType      string          `json:"extract_type"`
	Config           json.RawMessage `json:"config"`
	IsArray          int64           `json:"is_array"`
	DefaultValue     *string         `json:"default_value"`
}

// Automation is an automations row (store/automations.rs::Automation) with
// its JSON-TEXT columns (conditions/actions/blocks) parsed to real JSON by
// the daemon (api/v1/automations.rs::automation_response).
type Automation struct {
	ID               int64           `json:"id"`
	TargetID         *int64          `json:"target_id"`
	EventType        string          `json:"event_type"`
	TargetSelectorID *int64          `json:"target_selector_id"`
	WorkflowID       *int64          `json:"workflow_id"`
	WebhookTriggerID *int64          `json:"webhook_trigger_id"`
	Name             string          `json:"name"`
	Description      *string         `json:"description"`
	Enabled          int64           `json:"enabled"`
	Priority         *int64          `json:"priority"`
	Conditions       json.RawMessage `json:"conditions"`
	Actions          json.RawMessage `json:"actions"`
	Blocks           json.RawMessage `json:"blocks"`
	LastTriggeredAt  *string         `json:"last_triggered_at"`
	TriggerCount     *int64          `json:"trigger_count"`
	CreatedAt        string          `json:"created_at"`
	UpdatedAt        *string         `json:"updated_at"`
}

// AutomationRunResult is POST /v1/automations/:id/run — either an execution
// outcome or {status:"skipped", reason} when the trigger gate didn't match.
type AutomationRunResult struct {
	ExecutionID *int64          `json:"execution_id,omitempty"`
	Status      string          `json:"status"`
	Results     json.RawMessage `json:"results,omitempty"`
	Error       *string         `json:"error,omitempty"`
	Reason      *string         `json:"reason,omitempty"`
}

// Persona is the cloud-parity persona projection
// (api/v1/personas.rs::shape) — has_* booleans and linked names only; no
// secret material ever crosses the API.
type Persona struct {
	ID               int64           `json:"id"`
	Name             string          `json:"name"`
	Description      *string         `json:"description"`
	TargetDomain     *string         `json:"target_domain"`
	LoginUsername    *string         `json:"login_username"`
	HasPassword      bool            `json:"has_password"`
	TwofaMethod      string          `json:"twofa_method"`
	HasTOTPSeed      bool            `json:"has_totp_seed"`
	EmailOTPMode     *string         `json:"email_otp_mode"`
	RelayAddress     *string         `json:"relay_address"`
	HasFingerprint   bool            `json:"has_fingerprint"`
	HasProxy         bool            `json:"has_proxy"`
	IsActive         bool            `json:"is_active"`
	ValidationStatus *string         `json:"validation_status"`
	HasWarmSession   bool            `json:"has_warm_session"`
	SessionExpiresAt *string         `json:"session_expires_at"`
	LastLoginAt      *string         `json:"last_login_at"`
	LastUsedAt       *string         `json:"last_used_at"`
	CreatedAt        string          `json:"created_at"`
	UpdatedAt        *string         `json:"updated_at"`
	LinkedWorkflows  json.RawMessage `json:"linked_workflows"`
	LinkedSecrets    json.RawMessage `json:"linked_secrets"`
}

// PersonaRun is one item of GET /v1/personas/:id/runs.
type PersonaRun struct {
	TaskID       int64   `json:"task_id"`
	WorkflowID   *int64  `json:"workflow_id"`
	WorkflowName *string `json:"workflow_name"`
	Status       string  `json:"status"`
	Success      *bool   `json:"success"`
	StartedAt    *string `json:"started_at"`
	CompletedAt  *string `json:"completed_at"`
	Error        *string `json:"error"`
}

// Secret is the metadata-only secret projection (api/v1/secrets.rs::meta).
// The value never leaves the daemon.
type Secret struct {
	ID           int64   `json:"id"`
	Key          string  `json:"key"`
	Name         string  `json:"name"`
	Description  *string `json:"description"`
	Category     *string `json:"category"`
	IsCredential bool    `json:"is_credential"`
	IsCard       bool    `json:"is_card"`
	Username     *string `json:"username"`
	CardLast4    *string `json:"card_last4"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    *string `json:"updated_at"`
	LastUsedAt   *string `json:"last_used_at"`
	UseCount     int64   `json:"use_count"`
}

// SecretCreate is the body of POST /v1/secrets (api/v1/secrets.rs::CreateBody).
// A single-value secret supplies Value; a credential secret supplies
// Username+Password; a card secret supplies Card.
type SecretCreate struct {
	Name        string            `json:"name,omitempty"`
	Value       string            `json:"value,omitempty"`
	Username    string            `json:"username,omitempty"`
	Password    string            `json:"password,omitempty"`
	Card        map[string]string `json:"card,omitempty"`
	Description string            `json:"description,omitempty"`
	Category    string            `json:"category,omitempty"`
}

// VaultStatus is GET /v1/vault/status.
type VaultStatus struct {
	Enabled         bool  `json:"enabled"`
	Locked          bool  `json:"locked"`
	IdleTimeoutSecs int64 `json:"idle_timeout_secs"`
}

// StoredFile is the OpenAI-style file handle (api/v1/files.rs::WireStoredFile).
// CreatedAt is UNIX epoch seconds.
type StoredFile struct {
	ID          string `json:"id"`
	Object      string `json:"object"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Bytes       int64  `json:"bytes"`
	CreatedAt   int64  `json:"created_at"`
	Status      string `json:"status"`
	Source      string `json:"source"`
	Purpose     string `json:"purpose"`
}

// DataDeleteResult is DELETE /v1/workflows/:id/data.
type DataDeleteResult struct {
	Deleted   int            `json:"deleted"`
	Resolved  map[string]int `json:"resolved"`
	Unmatched []string       `json:"unmatched"`
}

// APIKey is a scoped wlk_ key record (store/local_api_keys.rs::LocalApiKey;
// the key_hash never serializes).
type APIKey struct {
	ID         int64   `json:"id"`
	Name       string  `json:"name"`
	Prefix     string  `json:"prefix"`
	Scopes     string  `json:"scopes"`
	Enabled    int64   `json:"enabled"`
	LastUsedAt *string `json:"last_used_at"`
	CreatedAt  string  `json:"created_at"`
	RevokedAt  *string `json:"revoked_at"`
}

// APIKeyCreated is POST /v1/keys — the record plus the plaintext key, which
// appears ONLY in this response and cannot be recovered later.
type APIKeyCreated struct {
	APIKey
	Key string `json:"key"`
}

// WSTicket is POST /v1/ws-ticket.
type WSTicket struct {
	Ticket        string `json:"ticket"`
	ExpiresInSecs int64  `json:"expires_in_secs"`
}
