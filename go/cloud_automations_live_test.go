package writ

import (
	"os"
	"testing"
)

// Env-gated LIVE test for the cloud automations + personas surfaces. See
// cloud_monitors_live_test.go for how to run it and which scopes the key needs
// (add triggers:* and personas:*; a workflow ACTION also needs workflows:execute).
func TestCloudAutomationsAndPersonasLive(t *testing.T) {
	if os.Getenv("WRIT_E2E") != "1" {
		t.Skip("set WRIT_E2E=1 (plus WRIT_CLOUD_URL/WRIT_API_KEY) to run against a live coordinator")
	}
	ctx := ctxT(t)
	c := New(WithAPIKey(os.Getenv("WRIT_API_KEY")), WithCloudURL(envOr("WRIT_CLOUD_URL", "http://localhost:8000")))

	// SELF-HEALING: a live tenant is not a fixture. A run that died before its
	// cleanup must not poison every run after it.
	if existing, err := c.Cloud.Automations.List(ctx, nil); err == nil {
		for _, a := range existing {
			if a.Name == "go-e2e-automation" {
				_ = c.Cloud.Automations.Delete(ctx, a.ID)
			}
		}
	}

	a, err := c.Cloud.Automations.Create(ctx, CloudAutomationParams{
		Name: "go-e2e-automation", EventType: "change_detected",
		Actions: []CloudAutomationAction{{
			Type:   "notification",
			Config: map[string]any{"channels": []string{"email"}},
		}},
	})
	if err != nil {
		t.Fatalf("create automation: %v", err)
	}
	defer func() { _ = c.Cloud.Automations.Delete(ctx, a.ID) }()

	if !a.Enabled {
		t.Error("a new automation should be enabled")
	}
	if len(a.Actions) != 1 || a.Actions[0].Type != "notification" {
		t.Errorf("actions did not round-trip: %+v", a.Actions)
	}
	if list, err := c.Cloud.Automations.List(ctx, nil); err != nil || !containsAutomation(list, a.ID) {
		t.Fatalf("list: %v", err)
	}
	if got, err := c.Cloud.Automations.Get(ctx, a.ID); err != nil || got.Name != "go-e2e-automation" {
		t.Fatalf("get: %v", err)
	}
	desc := "e2e"
	if upd, err := c.Cloud.Automations.Update(ctx, a.ID, CloudAutomationParams{Description: desc}); err != nil || upd.Description != desc {
		t.Fatalf("update: %v (%q)", err, upd.Description)
	}
	// Toggle FLIPS; it takes no value.
	off, err := c.Cloud.Automations.Toggle(ctx, a.ID)
	if err != nil || off.Enabled {
		t.Fatalf("toggle off: %v enabled=%v", err, off.Enabled)
	}
	if on, err := c.Cloud.Automations.Toggle(ctx, a.ID); err != nil || !on.Enabled {
		t.Fatalf("toggle on: %v", err)
	}
	if _, err := c.Cloud.Automations.Executions(ctx, a.ID, Ptr(5)); err != nil {
		t.Fatalf("executions: %v", err)
	}
	if _, err := c.Cloud.Automations.ForMonitor(ctx, 999999, false); err != nil {
		t.Fatalf("for monitor: %v", err)
	}
}

// The contract that matters for personas: a secret goes IN and never comes back.
func TestCloudPersonaSecretsAreWriteOnlyLive(t *testing.T) {
	if os.Getenv("WRIT_E2E") != "1" {
		t.Skip("live only")
	}
	ctx := ctxT(t)
	c := New(WithAPIKey(os.Getenv("WRIT_API_KEY")), WithCloudURL(envOr("WRIT_CLOUD_URL", "http://localhost:8000")))

	// Personas are unique by name — clear a stale one before creating.
	if existing, err := c.Cloud.Personas.List(ctx, ""); err == nil {
		for _, p := range existing {
			if p.Name == "go-e2e-persona" {
				_ = c.Cloud.Personas.Delete(ctx, p.ID)
			}
		}
	}

	p, err := c.Cloud.Personas.Create(ctx, CloudPersonaParams{
		Name: "go-e2e-persona", TargetDomain: Ptr("example.com"),
	})
	if err != nil {
		t.Fatalf("create persona: %v", err)
	}
	defer func() { _ = c.Cloud.Personas.Delete(ctx, p.ID) }()

	if p.HasPassword {
		t.Error("no secret was sent, so has_password must be false")
	}
	upd, err := c.Cloud.Personas.Update(ctx, p.ID, CloudPersonaParams{
		Password: Ptr("e2e-not-a-real-credential"),
	})
	if err != nil {
		t.Fatalf("update persona: %v", err)
	}
	if !upd.HasPassword {
		t.Error("a written secret must flip has_password to true")
	}
	if got, err := c.Cloud.Personas.Get(ctx, p.ID); err != nil || got.Name != "go-e2e-persona" {
		t.Fatalf("get persona: %v", err)
	}
	if _, err := c.Cloud.Personas.Runs(ctx, p.ID, Ptr(5)); err != nil {
		t.Fatalf("persona runs: %v", err)
	}
	// Checking a seed must not require storing it anywhere.
	v, err := c.Cloud.Personas.ValidateTOTP(ctx, "JBSWY3DPEHPK3PXP", "")
	if err != nil || !v.ValidBase32 {
		t.Fatalf("validate totp: %v %+v", err, v)
	}
}

func containsAutomation(rows []CloudAutomation, id int64) bool {
	for _, r := range rows {
		if r.ID == id {
			return true
		}
	}
	return false
}
