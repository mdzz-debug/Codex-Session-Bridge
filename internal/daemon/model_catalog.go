package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type CodexModelCatalog struct {
	Status        string             `json:"status"`
	Path          string             `json:"path"`
	Model         string             `json:"model"`
	ModelProvider string             `json:"model_provider"`
	ProviderName  string             `json:"provider_name"`
	DefaultModel  string             `json:"default_model"`
	Models        []string           `json:"models"`
	Sources       []CodexModelSource `json:"sources"`
	Message       string             `json:"message,omitempty"`
}

type CodexModelSource struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Name     string `json:"name"`
	BaseURL  string `json:"base_url"`
	Endpoint string `json:"endpoint"`
	Auth     string `json:"auth"`
	Status   string `json:"status"`
	Models   int    `json:"models"`
	Message  string `json:"message,omitempty"`
}

func readCodexModelCatalog() CodexModelCatalog {
	cfg, _, err := readCodexConfig()
	if err != nil {
		return CodexModelCatalog{
			Status:  "failed",
			Message: err.Error(),
		}
	}
	return readCodexModelCatalogFromConfig(cfg)
}

func readCodexModelCatalogFromConfig(cfg CodexConfig) CodexModelCatalog {
	models, source := fetchCodexProviderModels(cfg)
	models = uniqueStrings(append([]string{cfg.Model}, models...))
	defaultModel := ""
	if containsString(models, cfg.Model) {
		defaultModel = cfg.Model
	} else if len(models) > 0 {
		defaultModel = models[0]
	}
	status := "ok"
	if len(models) == 0 {
		status = "not_configured"
		if source.Message != "" {
			status = "failed"
		}
	}
	return CodexModelCatalog{
		Status:        status,
		Path:          cfg.Path,
		Model:         cfg.Model,
		ModelProvider: cfg.ModelProvider,
		ProviderName:  firstNonEmpty(cfg.ProviderName, cfg.ModelProvider),
		DefaultModel:  defaultModel,
		Models:        models,
		Sources:       []CodexModelSource{source},
		Message:       source.Message,
	}
}

func fetchCodexProviderModels(cfg CodexConfig) ([]string, CodexModelSource) {
	endpoint := modelsEndpoint(cfg.BaseURL)
	source := CodexModelSource{
		ID:       "config:" + firstNonEmpty(cfg.ModelProvider, cfg.ProviderName, "codex"),
		Type:     "config",
		Name:     firstNonEmpty(cfg.ProviderName, cfg.ModelProvider, "Codex provider"),
		BaseURL:  cfg.BaseURL,
		Endpoint: endpoint,
		Auth:     "missing",
		Status:   "not_configured",
	}
	apiKey := strings.TrimSpace(cfg.APIKey)
	if apiKey != "" {
		source.Auth = "present"
	}
	if endpoint == "" {
		source.Message = "provider base_url is empty"
		return nil, source
	}

	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		source.Status = "failed"
		source.Message = err.Error()
		return nil, source
	}
	req.Header.Set("Accept", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		source.Status = "failed"
		source.Message = err.Error()
		return nil, source
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		source.Status = "failed"
		source.Message = fmt.Sprintf("HTTP %d", resp.StatusCode)
		return nil, source
	}
	var payload any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		source.Status = "failed"
		source.Message = err.Error()
		return nil, source
	}
	models := uniqueStrings(parseModelPayload(payload))
	source.Status = "ok"
	source.Models = len(models)
	return models, source
}

func modelsEndpoint(baseURL string) string {
	cleaned := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if cleaned == "" {
		return ""
	}
	parsed, err := url.Parse(cleaned)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	if strings.HasSuffix(parsed.Path, "/models") {
		return parsed.String()
	}
	if strings.HasSuffix(parsed.Path, "/v1") {
		parsed.Path += "/models"
		return parsed.String()
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/v1/models"
	return parsed.String()
}

func parseModelPayload(payload any) []string {
	switch value := payload.(type) {
	case []any:
		models := []string{}
		for _, item := range value {
			models = append(models, parseModelPayload(item)...)
		}
		return models
	case map[string]any:
		for _, key := range []string{"data", "models", "items"} {
			if nested, ok := value[key]; ok {
				if models := parseModelPayload(nested); len(models) > 0 {
					return models
				}
			}
		}
		for _, key := range []string{"id", "model", "name"} {
			if text, ok := value[key].(string); ok && strings.TrimSpace(text) != "" {
				return []string{strings.TrimSpace(text)}
			}
		}
	case string:
		if strings.TrimSpace(value) != "" {
			return []string{strings.TrimSpace(value)}
		}
	}
	return nil
}

func uniqueStrings(values []string) []string {
	seen := map[string]struct{}{}
	next := []string{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		next = append(next, trimmed)
	}
	return next
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
