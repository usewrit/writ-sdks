package writ

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// testClient builds a client pinned to a mock server (no discovery).
func testClient(srvURL string) *Client {
	return New(WithBaseURL(srvURL), WithToken("test-token"))
}

// isolateHome points $HOME at an empty temp dir and clears every WRIT_* env
// override so discovery tests never touch the real ~/.writ (or a real
// daemon). Empty values are treated as unset by the SDK.
func isolateHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("WRIT_HOME", "")
	t.Setenv("WRIT_API_URL", "")
	t.Setenv("WRIT_TOKEN", "")
	return home
}

// mockAgent serves GET /v1/agent behind a bearer check, reporting the given
// version so tests can tell servers apart. Extra routes may be added on mux.
func mockAgent(t *testing.T, token, version string) (*httptest.Server, *http.ServeMux) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/agent", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized","code":"unauthorized"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","version":"` + version + `","active_runs":0,"encrypted":true,"due_monitors":0,"last_tick_at":null,"warm_browser":false}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, mux
}

// serverPort extracts the TCP port of an httptest server.
func serverPort(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	_, portStr, ok := cutLast(srv.Listener.Addr().String(), ':')
	if !ok {
		t.Fatalf("no port in %s", srv.Listener.Addr())
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("bad port: %v", err)
	}
	return port
}

func cutLast(s string, sep byte) (string, string, bool) {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == sep {
			return s[:i], s[i+1:], true
		}
	}
	return s, "", false
}

// writeRuntime writes a runtime.json descriptor under dir.
func writeRuntime(t *testing.T, dir string, port int, token string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	info := map[string]any{
		"pid":        1234,
		"port":       port,
		"token":      token,
		"version":    "1.0.0",
		"started_at": "2026-07-13T00:00:00+00:00",
	}
	b, _ := json.Marshal(info)
	if err := os.WriteFile(filepath.Join(dir, "runtime.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func ctxT(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}
