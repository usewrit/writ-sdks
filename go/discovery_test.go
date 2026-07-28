package writ

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
)

// deadPort returns a loopback port with nothing listening on it.
func deadPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return port
}

// The desktop's active_profile pointer resolves the profile's runtime.json:
// port + token come from the descriptor and the probe confirms liveness.
func TestDiscoverViaActiveProfile(t *testing.T) {
	home := isolateHome(t)
	srv, _ := mockAgent(t, "wlt_profile_token", "profile")

	base := filepath.Join(home, ".writ")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "active_profile"), []byte("work\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeRuntime(t, filepath.Join(base, "profiles", "work"), serverPort(t, srv), "wlt_profile_token")

	c, err := Discover(ctxT(t))
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	status, err := c.Agent.Status(ctxT(t))
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Version != "profile" {
		t.Fatalf("wrong daemon answered: %q", status.Version)
	}
}

// A stale descriptor (crashed daemon) fails the 2s probe and falls through
// to the next candidate in order.
func TestDiscoverStaleFallthrough(t *testing.T) {
	home := isolateHome(t)
	live, _ := mockAgent(t, "wlt_live", "live")

	base := filepath.Join(home, ".writ")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	// Priority candidate: the active profile — but its daemon is gone.
	if err := os.WriteFile(filepath.Join(base, "active_profile"), []byte("team"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeRuntime(t, filepath.Join(base, "profiles", "team"), deadPort(t), "wlt_stale")
	// Next candidate: the base home, alive.
	writeRuntime(t, base, serverPort(t, live), "wlt_live")

	c, err := Discover(ctxT(t))
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	status, err := c.Agent.Status(ctxT(t))
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Version != "live" {
		t.Fatalf("stale candidate did not fall through, got %q", status.Version)
	}
}

// WRIT_API_URL + WRIT_TOKEN short-circuit discovery entirely, beating any
// runtime.json on disk.
func TestDiscoverEnvOverrideWins(t *testing.T) {
	home := isolateHome(t)
	fileDaemon, _ := mockAgent(t, "wlt_file", "file")
	envDaemon, _ := mockAgent(t, "wlt_env", "env")

	writeRuntime(t, filepath.Join(home, ".writ"), serverPort(t, fileDaemon), "wlt_file")
	t.Setenv("WRIT_API_URL", envDaemon.URL)
	t.Setenv("WRIT_TOKEN", "wlt_env")

	c, err := Discover(ctxT(t))
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	status, err := c.Agent.Status(ctxT(t))
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Version != "env" {
		t.Fatalf("env override lost to runtime.json, got %q", status.Version)
	}
}

// With only WRIT_TOKEN set, the base URL is still discovered from
// runtime.json — and the env token wins over the descriptor's token.
func TestDiscoverPartialEnvTokenWins(t *testing.T) {
	home := isolateHome(t)
	srv, _ := mockAgent(t, "wlt_env_only", "partial")
	// The descriptor carries a WRONG token; only the env token authenticates.
	writeRuntime(t, filepath.Join(home, ".writ"), serverPort(t, srv), "wlt_wrong")
	t.Setenv("WRIT_TOKEN", "wlt_env_only")

	c, err := Discover(ctxT(t))
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	status, err := c.Agent.Status(ctxT(t))
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Version != "partial" {
		t.Fatalf("got %q", status.Version)
	}
}

// $WRIT_HOME always wins over ~/.writ, even when both daemons are live.
func TestDiscoverWritHomeWins(t *testing.T) {
	home := isolateHome(t)
	writHomeDaemon, _ := mockAgent(t, "wlt_wh", "writ-home")
	baseDaemon, _ := mockAgent(t, "wlt_base", "base")

	writHome := t.TempDir()
	writeRuntime(t, writHome, serverPort(t, writHomeDaemon), "wlt_wh")
	writeRuntime(t, filepath.Join(home, ".writ"), serverPort(t, baseDaemon), "wlt_base")
	t.Setenv("WRIT_HOME", writHome)

	c, err := Discover(ctxT(t))
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	status, err := c.Agent.Status(ctxT(t))
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Version != "writ-home" {
		t.Fatalf("WRIT_HOME lost, got %q", status.Version)
	}
}

// No env, no descriptors → a *DiscoveryError with a how-to-fix message.
func TestDiscoverMissingIsDiscoveryError(t *testing.T) {
	isolateHome(t)
	_, err := Discover(ctxT(t))
	if err == nil {
		t.Fatal("expected a discovery error")
	}
	var de *DiscoveryError
	if !errors.As(err, &de) {
		t.Fatalf("want *DiscoveryError, got %T: %v", err, err)
	}
	var we Error
	if !errors.As(err, &we) {
		t.Fatalf("*DiscoveryError must satisfy writ.Error")
	}
}

// A profile scan finds daemons in ~/.writ/profiles/* even without an
// active_profile pointer.
func TestDiscoverProfilesScan(t *testing.T) {
	home := isolateHome(t)
	srv, _ := mockAgent(t, "wlt_scan", "scanned")
	writeRuntime(t, filepath.Join(home, ".writ", "profiles", "other"), serverPort(t, srv), "wlt_scan")

	c, err := Discover(ctxT(t))
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	status, err := c.Agent.Status(ctxT(t))
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Version != "scanned" {
		t.Fatalf("got %q", status.Version)
	}
}

// New() performs no I/O; the first request runs discovery once.
func TestLazyDiscoveryOnFirstRequest(t *testing.T) {
	home := isolateHome(t)
	srv, _ := mockAgent(t, "wlt_lazy", "lazy")
	writeRuntime(t, filepath.Join(home, ".writ"), serverPort(t, srv), "wlt_lazy")

	c := New() // no options, no I/O yet
	status, err := c.Agent.Status(ctxT(t))
	if err != nil {
		t.Fatalf("lazy discovery failed: %v", err)
	}
	if status.Version != "lazy" {
		t.Fatalf("got %q", status.Version)
	}
}

// A failed lazy discovery surfaces as *DiscoveryError and is memoized
// (single-flight) for subsequent calls.
func TestLazyDiscoveryFailureIsMemoized(t *testing.T) {
	isolateHome(t)
	c := New()
	for i := 0; i < 2; i++ {
		_, err := c.Agent.Status(ctxT(t))
		var de *DiscoveryError
		if !errors.As(err, &de) {
			t.Fatalf("call %d: want *DiscoveryError, got %T: %v", i, err, err)
		}
	}
}

func TestValidProfileID(t *testing.T) {
	valid := []string{"work", "Team-2", "a_b-C9"}
	for _, p := range valid {
		if !validProfileID(p) {
			t.Errorf("%q should be valid", p)
		}
	}
	invalid := []string{"", "local", "has space", "dot.dot", "../evil", string(make([]byte, 129))}
	for _, p := range invalid {
		if validProfileID(p) {
			t.Errorf("%q should be invalid", p)
		}
	}
}
