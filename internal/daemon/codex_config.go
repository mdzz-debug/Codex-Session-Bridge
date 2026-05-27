package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

type CodexConfig struct {
	Path                   string         `json:"path"`
	CodexHome              string         `json:"codex_home"`
	Platform               string         `json:"platform"`
	Exists                 bool           `json:"exists"`
	Profile                string         `json:"profile"`
	Model                  string         `json:"model"`
	ModelProvider          string         `json:"model_provider"`
	ModelReasoningEffort   string         `json:"model_reasoning_effort"`
	ApprovalPolicy         string         `json:"approval_policy"`
	SandboxMode            string         `json:"sandbox_mode"`
	FileOpener             string         `json:"file_opener"`
	WebSearch              bool           `json:"web_search"`
	DisableResponseStorage bool           `json:"disable_response_storage"`
	HistoryPersistence     string         `json:"history_persistence"`
	BaseURL                string         `json:"base_url"`
	ProviderName           string         `json:"provider_name"`
	RequiresOpenAIAuth     bool           `json:"requires_openai_auth"`
	WireAPI                string         `json:"wire_api"`
	APIKeyConfigured       bool           `json:"api_key_configured"`
	APIKey                 string         `json:"api_key,omitempty"`
	NetworkAccess          bool           `json:"network_access"`
	Projects               []CodexProject `json:"projects"`
	Warnings               []string       `json:"warnings,omitempty"`
}

type CodexProject struct {
	Path       string `json:"path"`
	TrustLevel string `json:"trust_level"`
}

type tomlDoc struct {
	lines   []string
	entries map[string]map[string]int
	headers map[string]int
}

func defaultCodexHome() string {
	if value := strings.TrimSpace(os.Getenv("CODEX_HOME")); value != "" {
		return value
	}
	if runtime.GOOS == "windows" {
		if value := strings.TrimSpace(os.Getenv("USERPROFILE")); value != "" {
			return filepath.Join(value, ".codex")
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".codex")
	}
	return ".codex"
}

func codexConfigPath() (string, string) {
	home := defaultCodexHome()
	return home, filepath.Join(home, "config.toml")
}

func codexAuthPath() (string, string) {
	home := defaultCodexHome()
	return home, filepath.Join(home, "auth.json")
}

func readCodexConfig() (CodexConfig, *tomlDoc, error) {
	home, path := codexConfigPath()
	cfg := CodexConfig{
		Path:      path,
		CodexHome: home,
		Platform:  runtime.GOOS,
		Exists:    false,
		Projects:  []CodexProject{},
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, parseToml(""), nil
		}
		return cfg, nil, err
	}
	cfg.Exists = true
	doc := parseToml(string(raw))
	cfg.Profile = doc.stringValue("", "profile")
	cfg.Model = doc.stringValue("", "model")
	cfg.ModelProvider = doc.stringValue("", "model_provider")
	cfg.ModelReasoningEffort = doc.stringValue("", "model_reasoning_effort")
	cfg.ApprovalPolicy = doc.stringValue("", "approval_policy")
	cfg.SandboxMode = doc.stringValue("", "sandbox_mode")
	if cfg.Profile != "" {
		profileSection := "profiles." + cfg.Profile
		cfg.Model = firstNonEmpty(doc.stringValue(profileSection, "model"), cfg.Model)
		cfg.ModelReasoningEffort = firstNonEmpty(doc.stringValue(profileSection, "model_reasoning_effort"), cfg.ModelReasoningEffort)
		cfg.ApprovalPolicy = firstNonEmpty(doc.stringValue(profileSection, "approval_policy"), cfg.ApprovalPolicy)
		cfg.SandboxMode = firstNonEmpty(doc.stringValue(profileSection, "sandbox_mode"), cfg.SandboxMode)
	}
	cfg.FileOpener = doc.stringValue("", "file_opener")
	cfg.WebSearch = doc.webSearchEnabled()
	cfg.DisableResponseStorage = doc.boolValue("", "disable_response_storage")
	cfg.HistoryPersistence = doc.stringValue("history", "persistence")
	providerSection := "model_providers." + cfg.ModelProvider
	if cfg.ModelProvider == "" || doc.headers[providerSection] == 0 && doc.entries[providerSection] == nil {
		providerSection = "model_providers.codex"
	}
	cfg.BaseURL = doc.stringValue(providerSection, "base_url")
	cfg.ProviderName = doc.stringValue(providerSection, "name")
	cfg.RequiresOpenAIAuth = doc.boolValue(providerSection, "requires_openai_auth")
	cfg.WireAPI = doc.stringValue(providerSection, "wire_api")
	cfg.APIKey = doc.stringValue(providerSection, "experimental_bearer_token")
	apiKey, err := readCodexAPIKey()
	if err != nil {
		cfg.Warnings = append(cfg.Warnings, "读取 auth.json 失败: "+err.Error())
	} else if apiKey != "" {
		cfg.APIKeyConfigured = true
		cfg.APIKey = apiKey
	} else if cfg.APIKey != "" {
		cfg.APIKeyConfigured = true
	}
	cfg.NetworkAccess = doc.boolValue("sandbox_workspace_write", "network_access")
	cfg.Projects = doc.projects()
	return cfg, doc, nil
}

func writeCodexConfig(next CodexConfig) (CodexConfig, error) {
	current, doc, err := readCodexConfig()
	if err != nil {
		return current, err
	}
	if doc == nil {
		doc = parseToml("")
	}
	setString(doc, "", "model", next.Model)
	setString(doc, "", "model_provider", next.ModelProvider)
	setString(doc, "", "model_reasoning_effort", next.ModelReasoningEffort)
	setString(doc, "", "approval_policy", next.ApprovalPolicy)
	setString(doc, "", "sandbox_mode", next.SandboxMode)
	profile := strings.TrimSpace(current.Profile)
	if profile == "" {
		profile = strings.TrimSpace(next.Profile)
	}
	if profile != "" {
		profileSection := "profiles." + profile
		setString(doc, profileSection, "model", next.Model)
		setString(doc, profileSection, "model_reasoning_effort", next.ModelReasoningEffort)
		setString(doc, profileSection, "approval_policy", next.ApprovalPolicy)
		setString(doc, profileSection, "sandbox_mode", next.SandboxMode)
	}
	setString(doc, "", "file_opener", next.FileOpener)
	setWebSearch(doc, next.WebSearch)
	setBool(doc, "", "disable_response_storage", next.DisableResponseStorage)
	if strings.TrimSpace(next.HistoryPersistence) != "" {
		setString(doc, "history", "persistence", next.HistoryPersistence)
	}
	provider := strings.TrimSpace(next.ModelProvider)
	if provider == "" {
		provider = "codex"
	}
	providerSection := "model_providers." + provider
	setString(doc, providerSection, "base_url", next.BaseURL)
	setString(doc, providerSection, "name", next.ProviderName)
	setBool(doc, providerSection, "requires_openai_auth", next.RequiresOpenAIAuth)
	setString(doc, providerSection, "wire_api", next.WireAPI)
	if strings.TrimSpace(next.APIKey) != "" {
		if err := writeCodexAPIKey(next.APIKey); err != nil {
			return current, err
		}
	}
	setBool(doc, "sandbox_workspace_write", "network_access", next.NetworkAccess)
	for _, project := range next.Projects {
		projectPath := strings.TrimSpace(project.Path)
		if projectPath == "" {
			continue
		}
		setString(doc, projectSection(projectPath), "trust_level", project.TrustLevel)
	}
	if err := os.MkdirAll(filepath.Dir(current.Path), 0o700); err != nil {
		return current, err
	}
	if err := os.WriteFile(current.Path, []byte(strings.Join(doc.lines, "\n")+"\n"), 0o600); err != nil {
		return current, err
	}
	updated, _, err := readCodexConfig()
	return updated, err
}

func parseToml(raw string) *tomlDoc {
	doc := &tomlDoc{
		lines:   strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n"),
		entries: map[string]map[string]int{},
		headers: map[string]int{},
	}
	if raw == "" {
		doc.lines = []string{}
	}
	doc.reindex()
	return doc
}

func (d *tomlDoc) reindex() {
	d.entries = map[string]map[string]int{}
	d.headers = map[string]int{}
	section := ""
	for index, line := range d.lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			section = strings.Trim(trimmed, "[]")
			d.headers[section] = index
			continue
		}
		key, ok := tomlKey(trimmed)
		if !ok {
			continue
		}
		if d.entries[section] == nil {
			d.entries[section] = map[string]int{}
		}
		d.entries[section][key] = index
	}
}

func (d *tomlDoc) rawValue(section string, key string) string {
	if d.entries[section] == nil {
		return ""
	}
	index, ok := d.entries[section][key]
	if !ok {
		return ""
	}
	parts := strings.SplitN(d.lines[index], "=", 2)
	if len(parts) != 2 {
		return ""
	}
	return stripTomlComment(strings.TrimSpace(parts[1]))
}

func (d *tomlDoc) stringValue(section string, key string) string {
	value := d.rawValue(section, key)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, "\"") {
		if parsed, err := strconv.Unquote(value); err == nil {
			return parsed
		}
	}
	return strings.Trim(value, "'\"")
}

func (d *tomlDoc) boolValue(section string, key string) bool {
	return strings.EqualFold(d.rawValue(section, key), "true")
}

func (d *tomlDoc) webSearchEnabled() bool {
	value := strings.ToLower(d.stringValue("", "web_search"))
	switch value {
	case "live", "cached":
		return true
	case "disabled":
		return false
	default:
		return d.boolValue("", "web_search")
	}
}

func (d *tomlDoc) projects() []CodexProject {
	projects := []CodexProject{}
	for section := range d.headers {
		if !strings.HasPrefix(section, "projects.") {
			continue
		}
		path := strings.TrimPrefix(section, "projects.")
		if strings.HasPrefix(path, "\"") {
			if parsed, err := strconv.Unquote(path); err == nil {
				path = parsed
			}
		}
		projects = append(projects, CodexProject{
			Path:       path,
			TrustLevel: d.stringValue(section, "trust_level"),
		})
	}
	sort.Slice(projects, func(i, j int) bool {
		return strings.ToLower(projects[i].Path) < strings.ToLower(projects[j].Path)
	})
	return projects
}

func tomlKey(trimmed string) (string, bool) {
	if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "[") {
		return "", false
	}
	left, _, ok := strings.Cut(trimmed, "=")
	if !ok {
		return "", false
	}
	key := strings.TrimSpace(left)
	if key == "" || strings.ContainsAny(key, " \t") {
		return "", false
	}
	return key, true
}

func stripTomlComment(value string) string {
	inString := false
	escaped := false
	for index, char := range value {
		if escaped {
			escaped = false
			continue
		}
		if char == '\\' && inString {
			escaped = true
			continue
		}
		if char == '"' {
			inString = !inString
			continue
		}
		if char == '#' && !inString {
			return strings.TrimSpace(value[:index])
		}
	}
	return value
}

func setString(doc *tomlDoc, section string, key string, value string) {
	setRaw(doc, section, key, strconv.Quote(value))
}

func setBool(doc *tomlDoc, section string, key string, value bool) {
	if value {
		setRaw(doc, section, key, "true")
		return
	}
	setRaw(doc, section, key, "false")
}

func setWebSearch(doc *tomlDoc, value bool) {
	if value {
		setString(doc, "", "web_search", "live")
		return
	}
	setString(doc, "", "web_search", "disabled")
}

func setRaw(doc *tomlDoc, section string, key string, value string) {
	if doc.entries[section] != nil {
		if index, ok := doc.entries[section][key]; ok {
			doc.lines[index] = key + " = " + value
			doc.reindex()
			return
		}
	}
	insertAt := len(doc.lines)
	if section != "" {
		headerIndex, ok := doc.headers[section]
		if !ok {
			if len(doc.lines) > 0 && strings.TrimSpace(doc.lines[len(doc.lines)-1]) != "" {
				doc.lines = append(doc.lines, "")
			}
			doc.lines = append(doc.lines, "["+section+"]")
			doc.lines = append(doc.lines, key+" = "+value)
			doc.reindex()
			return
		}
		insertAt = headerIndex + 1
		for insertAt < len(doc.lines) {
			trimmed := strings.TrimSpace(doc.lines[insertAt])
			if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
				break
			}
			insertAt++
		}
	} else {
		for insertAt = 0; insertAt < len(doc.lines); insertAt++ {
			trimmed := strings.TrimSpace(doc.lines[insertAt])
			if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
				break
			}
		}
	}
	doc.lines = append(doc.lines, "")
	copy(doc.lines[insertAt+1:], doc.lines[insertAt:])
	doc.lines[insertAt] = key + " = " + value
	doc.reindex()
}

func projectSection(path string) string {
	return "projects." + strconv.Quote(path)
}

func readCodexAPIKey() (string, error) {
	_, path := codexAuthPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", err
	}
	value, _ := data["OPENAI_API_KEY"].(string)
	return strings.TrimSpace(value), nil
}

func writeCodexAPIKey(value string) error {
	apiKey := strings.TrimSpace(value)
	if apiKey == "" {
		return nil
	}
	home, path := codexAuthPath()
	data := map[string]any{}
	if raw, err := os.ReadFile(path); err == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &data)
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	data["OPENAI_API_KEY"] = apiKey
	if _, ok := data["auth_mode"]; !ok {
		data["auth_mode"] = "apikey"
	}
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o600)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
