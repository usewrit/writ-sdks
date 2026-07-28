package writ

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// probeTimeout is the per-candidate liveness budget (matches the daemon's own
// discovery in cli/mcp_stdio.rs).
const probeTimeout = 2 * time.Second

// profileScanCap bounds the ~/.writ/profiles directory scan (matches the
// daemon's take(32)).
const profileScanCap = 32

// runtimeInfo is the discovery descriptor persisted at <home>/runtime.json by
// the daemon (app/runtime_file.rs::RuntimeInfo).
type runtimeInfo struct {
	PID       uint32 `json:"pid"`
	Port      uint16 `json:"port"`
	Token     string `json:"token"`
	Version   string `json:"version"`
	StartedAt string `json:"started_at"`
}

// discoverEndpoint resolves (baseURL, token) per the canonical algorithm:
//
//  1. Env overrides WRIT_API_URL / WRIT_TOKEN. Both set → done. One set →
//     it fills that field and the rest is discovered.
//  2. runtime.json candidates in order: $WRIT_HOME, the active desktop
//     profile, ~/.writ, then every ~/.writ/profiles/* (cap 32, deduped).
//  3. A candidate counts only if GET /v1/agent with its token answers 2xx
//     within 2s; a stale descriptor falls through to the next candidate.
//
// presetURL/presetToken are the explicitly-configured values (they always
// win over both env and files for their own field).
func discoverEndpoint(ctx context.Context, httpc *http.Client, presetURL, presetToken string) (string, string, error) {
	baseURL := presetURL
	token := presetToken
	if baseURL == "" {
		baseURL = strings.TrimRight(os.Getenv("WRIT_API_URL"), "/")
	}
	if token == "" {
		token = os.Getenv("WRIT_TOKEN")
	}
	if baseURL != "" && token != "" {
		return baseURL, token, nil
	}

	for _, path := range candidateRuntimeFiles() {
		info, err := readRuntimeFile(path)
		if err != nil {
			continue
		}
		candidateURL := baseURL
		if candidateURL == "" {
			candidateURL = fmt.Sprintf("http://127.0.0.1:%d", info.Port)
		}
		candidateToken := token
		if candidateToken == "" {
			candidateToken = info.Token
		}
		if probeAgent(ctx, httpc, candidateURL, candidateToken) {
			return candidateURL, candidateToken, nil
		}
	}

	return "", "", &DiscoveryError{
		Message: "no live Writ agent found — is the Writ agent running? " +
			"Pass writ.WithBaseURL(...)/writ.WithToken(...) or set WRIT_API_URL/WRIT_TOKEN " +
			"(or WRIT_HOME to point at the agent's home directory)",
	}
}

// candidateRuntimeFiles returns runtime.json paths in canonical priority
// order, deduped (mirrors cli/mcp_stdio.rs::daemon_candidate_homes).
func candidateRuntimeFiles() []string {
	var out []string
	seen := make(map[string]bool)
	add := func(dir string) {
		if dir == "" {
			return
		}
		p := filepath.Join(dir, "runtime.json")
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}

	// 1. $WRIT_HOME always wins over the rest.
	if home := os.Getenv("WRIT_HOME"); home != "" {
		add(home)
	}

	userHome, err := os.UserHomeDir()
	if err != nil {
		return out
	}
	base := filepath.Join(userHome, ".writ")

	// 2. The desktop's active profile pointer.
	if b, err := os.ReadFile(filepath.Join(base, "active_profile")); err == nil {
		if p := strings.TrimSpace(string(b)); validProfileID(p) {
			add(filepath.Join(base, "profiles", p))
		}
	}

	// 3. The default home.
	add(base)

	// 4. Every other known profile (cap 32, deduped against the above).
	if entries, err := os.ReadDir(filepath.Join(base, "profiles")); err == nil {
		n := 0
		for _, e := range entries {
			if n >= profileScanCap {
				break
			}
			n++
			if e.IsDir() {
				add(filepath.Join(base, "profiles", e.Name()))
			}
		}
	}
	return out
}

// validProfileID mirrors the daemon's active_profile validation: non-empty,
// not "local", at most 128 chars, charset [A-Za-z0-9_-].
func validProfileID(p string) bool {
	if p == "" || p == "local" || len(p) > 128 {
		return false
	}
	for _, c := range p {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}

func readRuntimeFile(path string) (*runtimeInfo, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var info runtimeInfo
	if err := json.Unmarshal(b, &info); err != nil {
		return nil, err
	}
	return &info, nil
}

// probeAgent reports whether GET <base>/v1/agent with the given bearer
// answers 2xx within the probe budget.
func probeAgent(ctx context.Context, httpc *http.Client, baseURL, token string) bool {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/agent", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", userAgent)
	resp, err := httpc.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
