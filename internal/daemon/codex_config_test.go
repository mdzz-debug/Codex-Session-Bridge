package daemon

import (
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
