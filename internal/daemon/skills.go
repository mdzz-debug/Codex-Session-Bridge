package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// SkillCommandArg describes a single argument for a skill command.
type SkillCommandArg struct {
	Name        string `json:"name"`
	Required    bool   `json:"required"`
	Default     string `json:"default,omitempty"`
	Description string `json:"description,omitempty"`
}

// SkillCommand describes a runnable command that a skill provides.
type SkillCommand struct {
	ID          string            `json:"id"`
	Label       string            `json:"label"`
	Description string            `json:"description,omitempty"`
	Args        []SkillCommandArg `json:"args,omitempty"`
	ProjectLevel bool             `json:"projectLevel"`
}

// SkillMeta is the static definition of a skill in the registry.
type SkillMeta struct {
	ID          string         `json:"id"`
	NPMPackage  string         `json:"npmPackage"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Binary      string         `json:"binary"`
	Commands    []SkillCommand `json:"commands"`
}

// SkillInfo is the API response for a skill including runtime status.
type SkillInfo struct {
	SkillMeta
	Installed      bool   `json:"installed"`
	CurrentVersion string `json:"currentVersion,omitempty"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	UpdateAvail    bool   `json:"updateAvailable"`
	Running        bool   `json:"running"`
}

// SkillRunResult is the response after executing a skill command.
type SkillRunResult struct {
	Success bool   `json:"success"`
	Output  string `json:"output,omitempty"`
	Error   string `json:"error,omitempty"`
}

// SkillInstallResult is the response after installing/upgrading a skill.
type SkillInstallResult struct {
	Success  bool   `json:"success"`
	Version  string `json:"version,omitempty"`
	Error    string `json:"error,omitempty"`
	NoNode   bool   `json:"noNode,omitempty"`
}

var skillRegistry = []SkillMeta{
	{
		ID:          "codegraph",
		NPMPackage:  "@colbymchenry/codegraph",
		Name:        "CodeGraph",
		Description: "本地优先的代码语义智能 — 为 AI Agent 提供符号关系、调用图和代码结构的预索引知识图谱。",
		Binary:      "codegraph",
		Commands: []SkillCommand{
			{
				ID:           "init",
				Label:        "初始化项目",
				Description:  "在项目目录初始化 CodeGraph 索引 (codegraph init -i)",
				Args:         []SkillCommandArg{{Name: "-i", Required: false, Default: "-i", Description: "交互模式"}},
				ProjectLevel: true,
			},
			{
				ID:           "sync",
				Label:        "同步索引",
				Description:  "手动同步 CodeGraph 索引 (codegraph sync)",
				ProjectLevel: true,
			},
			{
				ID:           "status",
				Label:        "查看状态",
				Description:  "查看索引状态 (codegraph status)",
				ProjectLevel: true,
			},
			{
				ID:           "uninit",
				Label:        "移除索引",
				Description:  "移除项目的 CodeGraph 索引 (codegraph uninit)",
				ProjectLevel: true,
			},
		},
	},
}

func getSkillRegistry() []SkillMeta {
	return skillRegistry
}

func findNpmBinary() string {
	if runtime.GOOS == "windows" {
		return findBinaryWindows("npm")
	}
	return findBinaryUnix("npm")
}

func findNpxBinary() string {
	if runtime.GOOS == "windows" {
		return findBinaryWindows("npx")
	}
	return findBinaryUnix("npx")
}

func findBinaryUnix(name string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	home, _ := os.UserHomeDir()
	candidates := []string{
		filepath.Join(home, ".nvm/versions/node", latestNvmVersion(), "bin", name),
		filepath.Join(home, ".fnm/node-versions", latestFnmVersion(), "installation/bin", name),
		filepath.Join(home, ".volta/bin", name),
		"/opt/homebrew/bin/" + name,
		"/usr/local/bin/" + name,
		"/usr/bin/" + name,
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

func findBinaryWindows(name string) string {
	if !strings.HasSuffix(name, ".cmd") {
		nameCmd := name + ".cmd"
		if p, err := exec.LookPath(nameCmd); err == nil {
			return p
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	appData := os.Getenv("APPDATA")
	if appData != "" {
		c := filepath.Join(appData, "npm", name+".cmd")
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

func latestNvmVersion() string {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".nvm/versions/node")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) == 0 {
		return ""
	}
	return entries[len(entries)-1].Name()
}

func latestFnmVersion() string {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".fnm/node-versions")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) == 0 {
		return ""
	}
	return entries[len(entries)-1].Name()
}

func checkNpmAvailable() error {
	if findNpmBinary() == "" && findNpxBinary() == "" {
		return fmt.Errorf("未检测到 Node.js / npm / npx，请先安装 Node.js >= 18: https://nodejs.org/")
	}
	return nil
}

func runNpmCommand(ctx context.Context, args []string, dir string) (string, error) {
	npmPath := findNpmBinary()
	if npmPath == "" {
		npxPath := findNpxBinary()
		if npxPath == "" {
			return "", fmt.Errorf("未找到 npm 或 npx，请先安装 Node.js")
		}
		npmPath = npxPath
	}

	cmd := exec.CommandContext(ctx, npmPath, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Env = append(os.Environ(), "NODE_NO_WARNINGS=1")

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	output := strings.TrimSpace(stdout.String())
	errOutput := strings.TrimSpace(stderr.String())

	if err != nil {
		if output != "" && errOutput != "" {
			return output + "\n" + errOutput, err
		}
		if errOutput != "" {
			return errOutput, err
		}
		if output != "" {
			return output, err
		}
		return "", fmt.Errorf("命令执行失败: %w", err)
	}

	if errOutput != "" {
		if output != "" {
			return output + "\n" + errOutput, nil
		}
		return errOutput, nil
	}
	return output, nil
}

func getInstalledVersion(npmPackage string) (string, bool) {
	npmPath := findNpmBinary()
	if npmPath == "" {
		return "", false
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, npmPath, "list", npmPackage, "--global", "--depth=0", "--json")
	cmd.Env = append(os.Environ(), "NODE_NO_WARNINGS=1")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	_ = cmd.Run()

	var result struct {
		Dependencies map[string]struct {
			Version string `json:"version"`
		} `json:"dependencies"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &result); err == nil {
		if dep, ok := result.Dependencies[npmPackage]; ok && dep.Version != "" {
			return dep.Version, true
		}
	}

	cmd2 := exec.CommandContext(ctx, npmPath, "list", npmPackage, "--depth=0", "--json")
	cmd2.Env = append(os.Environ(), "NODE_NO_WARNINGS=1")
	var stdout2 bytes.Buffer
	cmd2.Stdout = &stdout2
	_ = cmd2.Run()

	var result2 struct {
		Dependencies map[string]struct {
			Version string `json:"version"`
		} `json:"dependencies"`
	}
	if err := json.Unmarshal(stdout2.Bytes(), &result2); err == nil {
		if dep, ok := result2.Dependencies[npmPackage]; ok && dep.Version != "" {
			return dep.Version, true
		}
	}

	return "", false
}

func getLatestVersion(npmPackage string) (string, error) {
	npmPath := findNpmBinary()
	if npmPath == "" {
		return "", fmt.Errorf("npm not found")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, npmPath, "view", npmPackage, "version")
	cmd.Env = append(os.Environ(), "NODE_NO_WARNINGS=1")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	_ = cmd.Run()

	version := strings.TrimSpace(stdout.String())
	if version == "" {
		return "", fmt.Errorf("无法获取版本信息")
	}
	return version, nil
}

// findSkillBinaryLocate tries to find the binary for an installed skill.
func findSkillBinaryLocate(binary string) string {
	if runtime.GOOS == "windows" {
		return findBinaryWindows(binary)
	}
	return findBinaryUnix(binary)
}

// --- HTTP Handlers ---

func (s *Server) handleSkillsList(w http.ResponseWriter, r *http.Request) {
	if err := checkNpmAvailable(); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"skills":  []SkillInfo{},
			"noNode":  true,
			"message": err.Error(),
		})
		return
	}

	registry := getSkillRegistry()
	skills := make([]SkillInfo, 0, len(registry))

	for _, meta := range registry {
		info := SkillInfo{
			SkillMeta: meta,
			Installed: false,
			Running:   false,
		}

		if version, ok := getInstalledVersion(meta.NPMPackage); ok {
			info.Installed = true
			info.CurrentVersion = version
		}

		if latest, err := getLatestVersion(meta.NPMPackage); err == nil {
			info.LatestVersion = latest
			if info.Installed && info.CurrentVersion != "" && latest != info.CurrentVersion {
				info.UpdateAvail = true
			}
		}

		skills = append(skills, info)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"skills":  skills,
		"noNode":  false,
		"message": "",
	})
}

func (s *Server) handleSkillInstall(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SkillID string `json:"skillId"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	if err := checkNpmAvailable(); err != nil {
		writeJSON(w, http.StatusOK, SkillInstallResult{
			Success: false,
			Error:   err.Error(),
			NoNode:  true,
		})
		return
	}

	var meta *SkillMeta
	for _, s := range skillRegistry {
		if s.ID == req.SkillID {
			meta = &s
			break
		}
	}
	if meta == nil {
		writeJSON(w, http.StatusBadRequest, SkillInstallResult{
			Success: false,
			Error:   fmt.Sprintf("未知技能: %s", req.SkillID),
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()

	_, err := runNpmCommand(ctx, []string{"install", "-g", meta.NPMPackage}, "")
	if err != nil {
		writeJSON(w, http.StatusBadGateway, SkillInstallResult{
			Success: false,
			Error:   fmt.Sprintf("安装失败: %v", err),
		})
		return
	}

	version, _ := getInstalledVersion(meta.NPMPackage)
	writeJSON(w, http.StatusOK, SkillInstallResult{
		Success: true,
		Version: version,
	})
}

func (s *Server) handleSkillUpgrade(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SkillID string `json:"skillId"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	if err := checkNpmAvailable(); err != nil {
		writeJSON(w, http.StatusOK, SkillInstallResult{
			Success: false,
			Error:   err.Error(),
			NoNode:  true,
		})
		return
	}

	var meta *SkillMeta
	for _, s := range skillRegistry {
		if s.ID == req.SkillID {
			meta = &s
			break
		}
	}
	if meta == nil {
		writeJSON(w, http.StatusBadRequest, SkillInstallResult{
			Success: false,
			Error:   fmt.Sprintf("未知技能: %s", req.SkillID),
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()

	_, err := runNpmCommand(ctx, []string{"install", "-g", meta.NPMPackage + "@latest"}, "")
	if err != nil {
		writeJSON(w, http.StatusBadGateway, SkillInstallResult{
			Success: false,
			Error:   fmt.Sprintf("升级失败: %v", err),
		})
		return
	}

	version, _ := getInstalledVersion(meta.NPMPackage)
	writeJSON(w, http.StatusOK, SkillInstallResult{
		Success: true,
		Version: version,
	})
}

func (s *Server) handleSkillRun(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SkillID string   `json:"skillId"`
		Command string   `json:"command"`
		Args    []string `json:"args,omitempty"`
		Dir     string   `json:"dir,omitempty"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	if err := checkNpmAvailable(); err != nil {
		writeJSON(w, http.StatusOK, SkillRunResult{
			Success: false,
			Error:   err.Error(),
		})
		return
	}

	var meta *SkillMeta
	for _, s := range skillRegistry {
		if s.ID == req.SkillID {
			meta = &s
			break
		}
	}
	if meta == nil {
		writeJSON(w, http.StatusBadRequest, SkillRunResult{
			Success: false,
			Error:   fmt.Sprintf("未知技能: %s", req.SkillID),
		})
		return
	}

	var cmdMeta *SkillCommand
	for _, cmd := range meta.Commands {
		if cmd.ID == req.Command {
			cmdMeta = &cmd
			break
		}
	}
	if cmdMeta == nil {
		writeJSON(w, http.StatusBadRequest, SkillRunResult{
			Success: false,
			Error:   fmt.Sprintf("未知命令: %s", req.Command),
		})
		return
	}

	binaryPath := findSkillBinaryLocate(meta.Binary)
	if binaryPath == "" {
		writeJSON(w, http.StatusOK, SkillRunResult{
			Success: false,
			Error:   fmt.Sprintf("未找到 %s 命令，请先安装技能", meta.Binary),
		})
		return
	}

	args := []string{req.Command}
	args = append(args, req.Args...)

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()

	output, err := runBinaryCommand(ctx, binaryPath, args, req.Dir)
	if err != nil {
		writeJSON(w, http.StatusOK, SkillRunResult{
			Success: false,
			Output:  output,
			Error:   err.Error(),
		})
		return
	}

	writeJSON(w, http.StatusOK, SkillRunResult{
		Success: true,
		Output:  output,
	})
}

func runBinaryCommand(ctx context.Context, binary string, args []string, dir string) (string, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Env = append(os.Environ(), "NODE_NO_WARNINGS=1")

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	output := strings.TrimSpace(stdout.String())
	errOutput := strings.TrimSpace(stderr.String())

	if err != nil {
		combined := output
		if errOutput != "" {
			if combined != "" {
				combined += "\n"
			}
			combined += errOutput
		}
		return combined, fmt.Errorf("命令执行失败: %w", err)
	}

	if errOutput != "" {
		if output != "" {
			return output + "\n" + errOutput, nil
		}
		return errOutput, nil
	}
	return output, nil
}
