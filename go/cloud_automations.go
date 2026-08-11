package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// CloudAutomationsService is the cloud automations surface, mounted at
// client.Cloud.Automations. It mirrors the local daemon's AutomationsService
// (client.Automations) verb for verb.
//
// On the wire the cloud calls this resource "triggers"; the product, the daemon
// and every SDK call it an AUTOMATION. The rename happens here, once.
//
// Two shape differences from the daemon, both the server's and neither a typo:
//   - the list route is /all, not the collection root
//   - Toggle FLIPS the enabled flag and takes no argument, where the daemon's
//     Enable(id, enabled) sets it — read Enabled off the returned row
//
// Scopes: triggers:*. An action of type "workflow" additionally needs
// workflows:execute, because it arranges a workflow run.
type CloudAutomationsService struct{ c *CloudService }

const cloudAutomationsPath = "/api/triggers"

// CloudAutomationAction is one thing an automation does when it fires. Type is
// "notification", "workflow" or "ai_session"; Config is type-specific.
type CloudAutomationAction struct {
	Type   string         `json:"type"`
	Config map[string]any `json:"config,omitempty"`
}

// CloudAutomation is an event → conditions → actions rule.
type CloudAutomation struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// EventType is change_detected | webhook_received | workflow_completed | …
	EventType           string                  `json:"event_type"`
	Enabled             bool                    `json:"enabled"`
	Priority            int                     `json:"priority"`
	TargetID            *int64                  `json:"target_id"`
	TargetSelectorID    *int64                  `json:"target_selector_id"`
	WorkflowID          *int64                  `json:"workflow_id"`
	WebhookTriggerID    *int64                  `json:"webhook_trigger_id"`
	WebhookTriggerToken string                  `json:"webhook_trigger_token"`
	CustomPath          string                  `json:"custom_path"`
	Conditions          map[string]any          `json:"conditions"`
	Actions             []CloudAutomationAction `json:"actions"`
	Blocks              []map[string]any        `json:"blocks"`
	LastTriggeredAt     *string                 `json:"last_triggered_at"`
	NextScheduledAt     *string                 `json:"next_scheduled_at"`
	TriggerCount        int                     `json:"trigger_count"`
	CreatedAt           *string                 `json:"created_at"`
	UpdatedAt           *string                 `json:"updated_at"`
}

// CloudAutomationParams is the create/update body. Optional fields are pointers
// so an unset field is omitted rather than sent as a zero value.
type CloudAutomationParams struct {
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	// EventType defaults to change_detected.
	EventType        string `json:"event_type,omitempty"`
	Enabled          *bool  `json:"enabled,omitempty"`
	Priority         *int   `json:"priority,omitempty"`
	TargetID         *int64 `json:"target_id,omitempty"`
	TargetSelectorID *int64 `json:"target_selector_id,omitempty"`
	WorkflowID       *int64 `json:"workflow_id,omitempty"`
	WebhookTriggerID *int64 `json:"webhook_trigger_id,omitempty"`
	AISessionID      *int64 `json:"ai_session_id,omitempty"`
	Conditions       map[string]any
	// Actions of type "workflow" require workflows:execute on the key.
	Actions []CloudAutomationAction `json:"actions,omitempty"`
	Blocks  []map[string]any        `json:"blocks,omitempty"`
}

// MarshalJSON keeps Conditions omitted when nil (a map has no omitempty for the
// "present but empty" case we want to preserve on a PATCH).
func (p CloudAutomationParams) MarshalJSON() ([]byte, error) {
	type alias CloudAutomationParams
	raw, err := json.Marshal(alias(p))
	if err != nil {
		return nil, err
	}
	if p.Conditions == nil {
		return raw, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	m["conditions"] = p.Conditions
	return json.Marshal(m)
}

// CloudAutomationListOptions filters CloudAutomationsService.List.
type CloudAutomationListOptions struct {
	EnabledOnly bool
	EventType   string
	WorkflowID  *int64
}

// List returns every automation on the account. opts may be nil.
func (s *CloudAutomationsService) List(ctx context.Context, opts *CloudAutomationListOptions) ([]CloudAutomation, error) {
	if err := s.c.requireKey("Listing cloud automations"); err != nil {
		return nil, err
	}
	q := url.Values{}
	if opts != nil {
		if opts.EnabledOnly {
			q.Set("enabled_only", "true")
		}
		if opts.EventType != "" {
			q.Set("event_type", opts.EventType)
		}
		if opts.WorkflowID != nil {
			q.Set("workflow_id", strconv.FormatInt(*opts.WorkflowID, 10))
		}
	}
	return s.many(ctx, cloudAutomationsPath+"/all", q)
}

// Create creates an automation. A non-empty Name is required.
func (s *CloudAutomationsService) Create(ctx context.Context, body CloudAutomationParams) (*CloudAutomation, error) {
	if err := s.c.requireKey("Creating a cloud automation"); err != nil {
		return nil, err
	}
	return s.one(ctx, http.MethodPost, cloudAutomationsPath, body, nil)
}

// Get returns one automation.
func (s *CloudAutomationsService) Get(ctx context.Context, id int64) (*CloudAutomation, error) {
	if err := s.c.requireKey("Reading a cloud automation"); err != nil {
		return nil, err
	}
	return s.one(ctx, http.MethodGet, fmt.Sprintf("%s/%d", cloudAutomationsPath, id), nil, nil)
}

// Update partially updates an automation — send only what changes.
func (s *CloudAutomationsService) Update(ctx context.Context, id int64, patch CloudAutomationParams) (*CloudAutomation, error) {
	if err := s.c.requireKey("Updating a cloud automation"); err != nil {
		return nil, err
	}
	return s.one(ctx, http.MethodPatch, fmt.Sprintf("%s/%d", cloudAutomationsPath, id), patch, nil)
}

// Delete removes an automation.
func (s *CloudAutomationsService) Delete(ctx context.Context, id int64) error {
	if err := s.c.requireKey("Deleting a cloud automation"); err != nil {
		return err
	}
	_, err := s.c.send(ctx, http.MethodDelete, fmt.Sprintf("%s/%d", cloudAutomationsPath, id), nil)
	return err
}

// Toggle FLIPS the enabled flag and returns the refreshed row.
func (s *CloudAutomationsService) Toggle(ctx context.Context, id int64) (*CloudAutomation, error) {
	if err := s.c.requireKey("Toggling a cloud automation"); err != nil {
		return nil, err
	}
	return s.one(ctx, http.MethodPatch, fmt.Sprintf("%s/%d/toggle", cloudAutomationsPath, id), nil, nil)
}

// Run fires the automation NOW (manual trigger), skipping its event. inputs may
// be nil.
func (s *CloudAutomationsService) Run(ctx context.Context, id int64, inputs map[string]any) (map[string]any, error) {
	if err := s.c.requireKey("Running a cloud automation"); err != nil {
		return nil, err
	}
	var body any
	if inputs != nil {
		body = inputs
	}
	return s.raw(ctx, http.MethodPost, fmt.Sprintf("%s/%d/run", cloudAutomationsPath, id), body)
}

// Test evaluates the rule against a sample event WITHOUT running its actions.
func (s *CloudAutomationsService) Test(ctx context.Context, id int64, body map[string]any) (map[string]any, error) {
	if err := s.c.requireKey("Testing a cloud automation"); err != nil {
		return nil, err
	}
	return s.raw(ctx, http.MethodPost, fmt.Sprintf("%s/%d/test", cloudAutomationsPath, id), body)
}

// Executions returns this automation's execution history.
func (s *CloudAutomationsService) Executions(ctx context.Context, id int64, limit *int) ([]map[string]any, error) {
	if err := s.c.requireKey("Reading cloud automation executions"); err != nil {
		return nil, err
	}
	q := url.Values{}
	if limit != nil {
		q.Set("limit", strconv.Itoa(*limit))
	}
	data, err := s.c.sendQuery(ctx, http.MethodGet, fmt.Sprintf("%s/%d/executions", cloudAutomationsPath, id), nil, q)
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return out, nil
}

// ForMonitor returns the automations wired to one monitor — the other half of
// client.Cloud.Monitors.
func (s *CloudAutomationsService) ForMonitor(ctx context.Context, monitorID int64, enabledOnly bool) ([]CloudAutomation, error) {
	if err := s.c.requireKey("Reading a monitor's cloud automations"); err != nil {
		return nil, err
	}
	q := url.Values{}
	if enabledOnly {
		q.Set("enabled_only", "true")
	}
	return s.many(ctx, fmt.Sprintf("%s/target/%d", cloudAutomationsPath, monitorID), q)
}

// --- internals ---------------------------------------------------------------

func (s *CloudAutomationsService) one(ctx context.Context, method, path string, body any, q url.Values) (*CloudAutomation, error) {
	data, err := s.c.sendQuery(ctx, method, path, body, q)
	if err != nil {
		return nil, err
	}
	var out CloudAutomation
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return &out, nil
}

func (s *CloudAutomationsService) many(ctx context.Context, path string, q url.Values) ([]CloudAutomation, error) {
	data, err := s.c.sendQuery(ctx, http.MethodGet, path, nil, q)
	if err != nil {
		return nil, err
	}
	var out []CloudAutomation
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return out, nil
}

func (s *CloudAutomationsService) raw(ctx context.Context, method, path string, body any) (map[string]any, error) {
	data, err := s.c.send(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if len(data) == 0 {
		return out, nil
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return out, nil
}
