package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// CloudMonitorsService is the cloud monitors surface, mounted at
// client.Cloud.Monitors. It mirrors the local daemon's MonitorsService
// (client.Monitors) verb for verb, so the same program runs against either venue
// by changing which service it talks to.
//
// On the wire the cloud calls this resource "targets"; the product, the daemon
// and every SDK call it a MONITOR. The rename happens here, once.
//
// Every verb is metered-only: the keyless tier has no account to own a monitor,
// so these return *APIKeyRequiredError BEFORE any network call rather than
// sending a request that could only come back 401.
type CloudMonitorsService struct{ c *CloudService }

const cloudMonitorsPath = "/api/targets"

// CloudMonitor is a monitor as the CLOUD serialises it — camelCase, because
// /api/targets answers with its own aliases. The daemon's Monitor is the same
// concept in snake_case; they are deliberately separate types so neither
// service's wire format is silently claimed for the other.
type CloudMonitor struct {
	ID                 int64   `json:"id"`
	URL                string  `json:"url"`
	CheckType          string  `json:"checkType"`
	Selector           *string `json:"selector"`
	IgnoreRegex        *string `json:"ignoreRegex"`
	CheckPeriodMs      *int64  `json:"checkPeriodMs"`
	ScheduleKind       *string `json:"scheduleKind"`
	ScheduleTime       *string `json:"scheduleTime"`
	ScheduleDays       []int   `json:"scheduleDays"`
	ScheduleTz         *string `json:"scheduleTz"`
	Enabled            bool    `json:"enabled"`
	ExpectedStatusCode *int    `json:"expectedStatusCode"`
	TimeoutMs          *int64  `json:"timeoutMs"`
	MaxResponseTimeMs  *int64  `json:"maxResponseTimeMs"`
	CheckSSL           *bool   `json:"checkSsl"`
	RequiresPlaywright bool    `json:"requiresPlaywright"`
	PreferredRegion    *string `json:"preferredRegion"`
	UseResidential     *bool   `json:"useResidential"`
	ResidentialCountry *string `json:"residentialCountry"`
	CreatedAt          string  `json:"createdAt"`
	UpdatedAt          *string `json:"updatedAt"`
	LastCheckedAt      *string `json:"lastCheckedAt"`
	ChangesCount       int     `json:"changesCount"`
	// State is live health from the monitoring state: up|down|ok|stale|never.
	State        *string `json:"state"`
	StatusCode   *int    `json:"statusCode"`
	LastChangeAt *string `json:"lastChangeAt"`
}

// CloudMonitorParams is the create/update body. snake_case on purpose: the cloud
// ACCEPTS snake_case and ANSWERS camelCase (CloudMonitor). That asymmetry is the
// server's, and hiding it would mean guessing wrong the first time a field is
// added. Every optional field is a pointer so an unset field is omitted rather
// than sent as a zero value — a PATCH with Enabled:false must mean "disable",
// and an omitted Enabled must mean "leave it alone".
type CloudMonitorParams struct {
	URL string `json:"url,omitempty"`
	// CheckType is "content" (default — watch the page or a selector) or
	// "uptime" (watch availability).
	CheckType   string  `json:"check_type,omitempty"`
	Selector    *string `json:"selector,omitempty"`
	IgnoreRegex *string `json:"ignore_regex,omitempty"`
	// CheckPeriodMs is how often to check. Below your plan's minimum check
	// interval the API answers 402 interval_too_short naming the floor — it is
	// never silently clamped. JS-rendered checks (RequiresPlaywright) have their
	// own, longer floor.
	CheckPeriodMs      *int64 `json:"check_period_ms,omitempty"`
	ScheduleKind       string `json:"schedule_kind,omitempty"`
	ScheduleTime       string `json:"schedule_time,omitempty"`
	ScheduleDays       []int  `json:"schedule_days,omitempty"`
	ScheduleTz         string `json:"schedule_tz,omitempty"`
	Enabled            *bool  `json:"enabled,omitempty"`
	RequiresPlaywright *bool  `json:"requires_playwright,omitempty"`
	PreferredRegion    string `json:"preferred_region,omitempty"`
	ExpectedStatusCode *int   `json:"expected_status_code,omitempty"`
	TimeoutMs          *int64 `json:"timeout_ms,omitempty"`
	MaxResponseTimeMs  *int64 `json:"max_response_time_ms,omitempty"`
	CheckSSL           *bool  `json:"check_ssl,omitempty"`
	UseResidential     *bool  `json:"use_residential,omitempty"`
	ResidentialCountry string `json:"residential_country,omitempty"`
}

// CloudMonitorListOptions filters CloudMonitorsService.List. Limit is a pointer
// so an unset value returns every monitor rather than the API's default page.
type CloudMonitorListOptions struct {
	EnabledOnly bool
	// CheckType filters to "content" or "uptime"; empty means both.
	CheckType string
	// Limit is 1-1000, newest first. Nil returns all of them.
	Limit  *int
	Offset int
}

// CloudMonitorChange is one detected change in ONE monitor's history, as
// GET /api/targets/{id}/changes serialises it: camelCase, with string ids.
//
// It is deliberately NOT the type the GLOBAL feed returns — see
// CloudRecentChange. The two routes answer genuinely different shapes (different
// casing, different id types, different fields), and every SDK used to model
// both with this one struct: the global feed's numeric `id` could not decode
// into a Go string at all, so RecentChanges failed on every real response.
type CloudMonitorChange struct {
	ID         string `json:"id"`
	TargetID   string `json:"targetId"`
	OldContent string `json:"oldContent"`
	NewContent string `json:"newContent"`
	Diff       string `json:"diff"`
	DetectedBy string `json:"detectedBy"`
	// Timestamp is when this change was FIRST seen — the same value as
	// FirstDetectedAt, kept under its original name for existing callers.
	Timestamp string `json:"timestamp"`
	// FirstDetectedAt / LastDetectedAt are the two real timestamps behind a
	// change row. The feed is ORDERED by LastDetectedAt, so that — not Timestamp
	// — is what a client sorts or advances a cursor on. Sorting on Timestamp
	// silently disagrees with the server's own order.
	FirstDetectedAt string  `json:"firstDetectedAt"`
	LastDetectedAt  string  `json:"lastDetectedAt"`
	SelectorID      *int64  `json:"selectorId"`
	SelectorName    *string `json:"selectorName"`
	// Same-origin proxy paths, present only when that snapshot has stored bytes.
	ScreenshotBefore *string `json:"screenshotBefore"`
	ScreenshotAfter  *string `json:"screenshotAfter"`
	ScreenshotDiff   *string `json:"screenshotDiff"`
}

// CloudRecentChange is one row of the GLOBAL recent-changes feed
// (GET /api/targets/changes/recent).
//
// It is an ALIAS of RecentChange, not a copy: the cloud's global feed and the
// local daemon's `/v1/changes/recent` serialise the identical shape, so one type
// lets the same watcher drive either venue. (The per-monitor routes genuinely do
// differ — that is why CloudMonitorChange stays separate.)
type CloudRecentChange = RecentChange

// CloudChangeListOptions filters either change feed.
//
// Leaving Since empty gives the newest-first browsing view. Setting it switches
// the server to an oldest-first keyset walk returning only what was detected
// AFTER that point — which is what a poller wants: newest-first + limit silently
// drops changes whenever more than `limit` of them land between two polls.
type CloudChangeListOptions struct {
	// Limit caps the page. Nil uses the API default.
	Limit *int
	// Since is an ISO-8601 timestamp cursor — the LastDetectedAt of the last row
	// you processed.
	Since string
	// SinceID is the id of that same row, breaking ties between changes sharing
	// one timestamp. Without it, two rows in the same millisecond can straddle
	// the page boundary and the trailing one is never returned again.
	SinceID *int64
}

func (o *CloudChangeListOptions) values() url.Values {
	q := url.Values{}
	if o == nil {
		return q
	}
	if o.Limit != nil {
		q.Set("limit", strconv.Itoa(*o.Limit))
	}
	if o.Since != "" {
		q.Set("since", o.Since)
	}
	if o.SinceID != nil {
		q.Set("since_id", strconv.FormatInt(*o.SinceID, 10))
	}
	return q
}

// CloudMonitorRunResult is the outcome of an out-of-schedule check. OK is false
// with a Detail when no recorder is assigned to the monitor yet — the check
// still happens on its next scheduled cycle.
type CloudMonitorRunResult struct {
	OK         bool   `json:"ok"`
	Dispatched int    `json:"dispatched"`
	Detail     string `json:"detail,omitempty"`
}

// List returns every monitor on the account, newest first. opts may be nil.
func (s *CloudMonitorsService) List(ctx context.Context, opts *CloudMonitorListOptions) ([]CloudMonitor, error) {
	if err := s.c.requireKey("Listing cloud monitors"); err != nil {
		return nil, err
	}
	q := url.Values{}
	if opts != nil {
		if opts.EnabledOnly {
			q.Set("enabled_only", "true")
		}
		if opts.CheckType != "" {
			q.Set("check_type", opts.CheckType)
		}
		if opts.Limit != nil {
			q.Set("limit", strconv.Itoa(*opts.Limit))
		}
		if opts.Offset > 0 {
			q.Set("offset", strconv.Itoa(opts.Offset))
		}
	}
	data, err := s.c.sendQuery(ctx, http.MethodGet, cloudMonitorsPath, nil, q)
	if err != nil {
		return nil, err
	}
	var out []CloudMonitor
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return out, nil
}

// Create creates a monitor. A non-empty URL is required. A CheckPeriodMs below
// the plan's minimum check interval fails with a 402 interval_too_short naming
// the floor rather than being silently slowed down.
func (s *CloudMonitorsService) Create(ctx context.Context, body CloudMonitorParams) (*CloudMonitor, error) {
	if err := s.c.requireKey("Creating a cloud monitor"); err != nil {
		return nil, err
	}
	return s.one(ctx, http.MethodPost, cloudMonitorsPath, body, nil)
}

// Get returns one monitor, enriched with its live check state.
func (s *CloudMonitorsService) Get(ctx context.Context, id int64) (*CloudMonitor, error) {
	if err := s.c.requireKey("Reading a cloud monitor"); err != nil {
		return nil, err
	}
	return s.one(ctx, http.MethodGet, fmt.Sprintf("%s/%d", cloudMonitorsPath, id), nil, nil)
}

// Update partially updates a monitor — send only the fields you are changing.
func (s *CloudMonitorsService) Update(ctx context.Context, id int64, patch CloudMonitorParams) (*CloudMonitor, error) {
	if err := s.c.requireKey("Updating a cloud monitor"); err != nil {
		return nil, err
	}
	return s.one(ctx, http.MethodPatch, fmt.Sprintf("%s/%d", cloudMonitorsPath, id), patch, nil)
}

// Delete removes a monitor with its selectors, triggers and notification
// history. The cloud answers 204, so there is no body to return.
func (s *CloudMonitorsService) Delete(ctx context.Context, id int64) error {
	if err := s.c.requireKey("Deleting a cloud monitor"); err != nil {
		return err
	}
	_, err := s.c.send(ctx, http.MethodDelete, fmt.Sprintf("%s/%d", cloudMonitorsPath, id), nil)
	return err
}

// Toggle pauses or resumes a monitor without deleting it.
func (s *CloudMonitorsService) Toggle(ctx context.Context, id int64, enabled bool) (*CloudMonitor, error) {
	if err := s.c.requireKey("Toggling a cloud monitor"); err != nil {
		return nil, err
	}
	q := url.Values{"enabled": {strconv.FormatBool(enabled)}}
	return s.one(ctx, http.MethodPatch, fmt.Sprintf("%s/%d/toggle", cloudMonitorsPath, id), nil, q)
}

// Run checks this monitor NOW, out of schedule.
func (s *CloudMonitorsService) Run(ctx context.Context, id int64) (*CloudMonitorRunResult, error) {
	if err := s.c.requireKey("Running a cloud monitor"); err != nil {
		return nil, err
	}
	data, err := s.c.send(ctx, http.MethodPost, fmt.Sprintf("%s/%d/run", cloudMonitorsPath, id), nil)
	if err != nil {
		return nil, err
	}
	var out CloudMonitorRunResult
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return &out, nil
}

// Changes returns this monitor's detected-change history, newest first — or,
// when opts.Since is set, the changes detected after that cursor, oldest first.
// opts may be nil.
func (s *CloudMonitorsService) Changes(ctx context.Context, id int64, opts *CloudChangeListOptions) ([]CloudMonitorChange, error) {
	if err := s.c.requireKey("Reading cloud monitor changes"); err != nil {
		return nil, err
	}
	path := fmt.Sprintf("%s/%d/changes", cloudMonitorsPath, id)
	data, err := s.c.sendQuery(ctx, http.MethodGet, path, nil, opts.values())
	if err != nil {
		return nil, err
	}
	var out []CloudMonitorChange
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return out, nil
}

// RecentChanges returns the newest detected changes across ALL monitors on the
// account (limit 1-200) — or, when opts.Since is set, everything detected after
// that cursor, oldest first. opts may be nil.
//
// For a continuous feed prefer Watch, which drives this call with a correctly
// advanced cursor and de-duplicates re-detections for you.
func (s *CloudMonitorsService) RecentChanges(ctx context.Context, opts *CloudChangeListOptions) ([]CloudRecentChange, error) {
	if err := s.c.requireKey("Reading recent cloud changes"); err != nil {
		return nil, err
	}
	data, err := s.c.sendQuery(ctx, http.MethodGet, cloudMonitorsPath+"/changes/recent", nil, opts.values())
	if err != nil {
		return nil, err
	}
	var out []CloudRecentChange
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return out, nil
}

// --- internals ---------------------------------------------------------------

func (s *CloudMonitorsService) one(ctx context.Context, method, path string, body any, q url.Values) (*CloudMonitor, error) {
	data, err := s.c.sendQuery(ctx, method, path, body, q)
	if err != nil {
		return nil, err
	}
	var out CloudMonitor
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("writ: decode response: %w", err)
	}
	return &out, nil
}
