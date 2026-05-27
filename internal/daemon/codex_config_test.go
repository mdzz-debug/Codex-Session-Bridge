package daemon

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadCodexConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	raw := `model = "gpt-5.2"
model_provider = "codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
web_search = true

[history]
persistence = "save-all"

[model_providers.codex]
base_url = "https://api.openai.com/v1"
name = "OpenAI"
requires_openai_auth = true
wire_api = "responses"

[sandbox_workspace_write]
network_access = true

[projects."/tmp/example"]
trust_level = "trusted"
`
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, _, err := readCodexConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Exists || cfg.Model != "gpt-5.2" || cfg.BaseURL != "https://api.openai.com/v1" {
		t.Fatalf("unexpected config: %#v", cfg)
	}
	if !cfg.WebSearch || !cfg.NetworkAccess || len(cfg.Projects) != 1 || cfg.Projects[0].TrustLevel != "trusted" {
		t.Fatalf("missing structured values: %#v", cfg)
	}
}

func TestReadCodexConfigAcceptsStringWebSearch(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	raw := `web_search = "cached"
`
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, _, err := readCodexConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.WebSearch {
		t.Fatalf("expected string web_search to be enabled: %#v", cfg)
	}
}

func TestWriteCodexConfigPreservesUnknownSections(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	path := filepath.Join(home, "config.toml")
	raw := `model = "old"

[plugins."browser@openai-bundled"]
enabled = true
`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}

	next := CodexConfig{
		Model:                  "new-model",
		ModelProvider:          "codex",
		ModelReasoningEffort:   "high",
		ApprovalPolicy:         "never",
		SandboxMode:            "workspace-write",
		HistoryPersistence:     "save-all",
		BaseURL:                "https://example.test/v1",
		ProviderName:           "Example",
		RequiresOpenAIAuth:     false,
		WireAPI:                "responses",
		NetworkAccess:          true,
		DisableResponseStorage: true,
		Projects: []CodexProject{{
			Path:       "/tmp/project",
			TrustLevel: "trusted",
		}},
	}
	if _, err := writeCodexConfig(next); err != nil {
		t.Fatal(err)
	}
	updatedBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	updated := string(updatedBytes)
	for _, want := range []string{
		`model = "new-model"`,
		`web_search = "disabled"`,
		`[plugins."browser@openai-bundled"]`,
		`enabled = true`,
		`base_url = "https://example.test/v1"`,
		`[projects."/tmp/project"]`,
		`trust_level = "trusted"`,
	} {
		if !strings.Contains(updated, want) {
			t.Fatalf("updated config missing %q:\n%s", want, updated)
		}
	}
}

func TestWriteCodexConfigPreservesHistoryWhenDraftIsDefault(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	path := filepath.Join(home, "config.toml")
	raw := `model = "old"
web_search = true

[history]
persistence = "save-all"
`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}

	next := CodexConfig{
		Model:     "new-model",
		WebSearch: true,
	}
	if _, err := writeCodexConfig(next); err != nil {
		t.Fatal(err)
	}
	updatedBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	updated := string(updatedBytes)
	for _, want := range []string{
		`web_search = "live"`,
		`[history]`,
		`persistence = "save-all"`,
	} {
		if !strings.Contains(updated, want) {
			t.Fatalf("updated config missing %q:\n%s", want, updated)
		}
	}
	if strings.Contains(updated, `persistence = ""`) {
		t.Fatalf("history persistence should not be cleared:\n%s", updated)
	}
}

func TestCodexConfigUsesAndUpdatesActiveProfile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	path := filepath.Join(home, "config.toml")
	raw := `profile = "auto-max"
sandbox_mode = "danger-full-access"
approval_policy = "never"
model = "gpt-5.5"
model_reasoning_effort = "medium"

[profiles.auto-max]
sandbox_mode = "workspace-write"
approval_policy = "on-request"
model = "gpt-5.2"
model_reasoning_effort = "low"
`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, _, err := readCodexConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Profile != "auto-max" || cfg.SandboxMode != "workspace-write" || cfg.ApprovalPolicy != "on-request" || cfg.Model != "gpt-5.2" {
		t.Fatalf("expected active profile to override top-level values: %#v", cfg)
	}

	cfg.SandboxMode = "danger-full-access"
	cfg.ApprovalPolicy = "never"
	cfg.Model = "gpt-5.5"
	cfg.ModelReasoningEffort = "high"
	if _, err := writeCodexConfig(cfg); err != nil {
		t.Fatal(err)
	}
	updatedBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	updated := string(updatedBytes)
	for _, want := range []string{
		`[profiles.auto-max]`,
		`model = "gpt-5.5"`,
		`model_reasoning_effort = "high"`,
		`approval_policy = "never"`,
		`sandbox_mode = "danger-full-access"`,
	} {
		if !strings.Contains(updated, want) {
			t.Fatalf("updated profile config missing %q:\n%s", want, updated)
		}
	}
}

func TestCodexConfigReadsAndWritesAPIKey(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(`model = "gpt-5.2"
`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"auth_mode":"apikey","OPENAI_API_KEY":"sk-existing1234"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, _, err := readCodexConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.APIKeyConfigured || cfg.APIKey != "sk-existing1234" {
		t.Fatalf("unexpected API key metadata: %#v", cfg)
	}

	cfg.APIKey = "sk-new5678"
	if _, err := writeCodexConfig(cfg); err != nil {
		t.Fatal(err)
	}
	apiKey, err := readCodexAPIKey()
	if err != nil {
		t.Fatal(err)
	}
	if apiKey != "sk-new5678" {
		t.Fatalf("unexpected written API key %q", apiKey)
	}
}

func TestReadCodexModelCatalogFetchesProviderModels(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			t.Fatalf("unexpected auth header: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"relay-a"},{"id":"relay-b"}]}`))
	}))
	defer upstream.Close()
	raw := `model = "relay-a"
model_provider = "relay"

[model_providers.relay]
base_url = "` + upstream.URL + `/v1"
name = "Relay"
wire_api = "responses"
`
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"OPENAI_API_KEY":"sk-test"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := readCodexModelCatalog()
	if catalog.Status != "ok" || catalog.DefaultModel != "relay-a" || len(catalog.Models) != 2 {
		t.Fatalf("unexpected catalog: %#v", catalog)
	}
	if catalog.Models[0] != "relay-a" || catalog.Models[1] != "relay-b" {
		t.Fatalf("unexpected models: %#v", catalog.Models)
	}
}
