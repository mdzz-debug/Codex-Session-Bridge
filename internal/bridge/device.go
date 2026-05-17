package bridge

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type Device struct {
	DeviceID        string `json:"device_id"`
	UserID          string `json:"user_id,omitempty"`
	Name            string `json:"name"`
	Platform        string `json:"platform"`
	Hostname        string `json:"hostname"`
	DaemonVersion   string `json:"daemon_version"`
	CodexCLIVersion string `json:"codex_cli_version,omitempty"`
	LastSeen        string `json:"last_seen"`
	Online          bool   `json:"online"`
	Revoked         bool   `json:"revoked"`
}

func LoadOrCreateDevice(configDir string, version string) (Device, error) {
	if configDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return Device{}, err
		}
		configDir = filepath.Join(base, "codex-session-bridge")
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return Device{}, err
	}
	path := filepath.Join(configDir, "device.json")

	var d Device
	if b, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(b, &d); err != nil {
			return Device{}, err
		}
	} else if !os.IsNotExist(err) {
		return Device{}, err
	}

	if d.DeviceID == "" {
		id, err := newDeviceID()
		if err != nil {
			return Device{}, err
		}
		d.DeviceID = id
	}
	hostname, _ := os.Hostname()
	if d.Hostname == "" {
		d.Hostname = hostname
	}
	if d.Name == "" {
		d.Name = friendlyName(hostname)
	}
	d.Platform = runtime.GOOS
	d.DaemonVersion = version
	d.LastSeen = time.Now().UTC().Format(time.RFC3339)
	d.Online = true

	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return Device{}, err
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return Device{}, err
	}
	return d, nil
}

func newDeviceID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexed[0:8], hexed[8:12], hexed[12:16], hexed[16:20], hexed[20:32]), nil
}

func friendlyName(hostname string) string {
	hostname = strings.TrimSpace(hostname)
	if hostname == "" {
		return "Local Codex"
	}
	return hostname
}
