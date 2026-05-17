package daemon

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/luohao/codex-session-bridge/internal/appserver"
	"github.com/luohao/codex-session-bridge/internal/bridge"
)

const (
	relayHandshakeTimeout = 15 * time.Second
	relayHeartbeatEvery   = 25 * time.Second
	relayReadTimeout      = 75 * time.Second
)

type RelayConfig struct {
	Enabled  bool   `json:"enabled"`
	WSSURL   string `json:"wss_url"`
	Token    string `json:"token,omitempty"`
	Username string `json:"username,omitempty"`
}

type RelayStatus struct {
	Enabled     bool   `json:"enabled"`
	Connected   bool   `json:"connected"`
	State       string `json:"state"`
	WSSURL      string `json:"wss_url,omitempty"`
	Username    string `json:"username,omitempty"`
	LastError   string `json:"last_error,omitempty"`
	LastAttempt string `json:"last_attempt,omitempty"`
	ConnectedAt string `json:"connected_at,omitempty"`
	LastSeen    string `json:"last_seen,omitempty"`
}

type RelayManager struct {
	device bridge.Device
	app    *appserver.Client
	logger *slog.Logger
	notify func(RelayStatus)

	mu         sync.Mutex
	cfg        RelayConfig
	status     RelayStatus
	cancel     context.CancelFunc
	generation uint64
}

func NewRelayManager(device bridge.Device, app *appserver.Client, logger *slog.Logger, notify func(RelayStatus)) *RelayManager {
	if logger == nil {
		logger = slog.Default()
	}
	return &RelayManager{
		device: device,
		app:    app,
		logger: logger,
		notify: notify,
		status: RelayStatus{State: "idle"},
	}
}

func (m *RelayManager) Update(cfg RelayConfig) RelayStatus {
	cfg.WSSURL = strings.TrimSpace(cfg.WSSURL)
	cfg.Token = strings.TrimSpace(cfg.Token)
	cfg.Username = strings.TrimSpace(strings.ToLower(cfg.Username))
	cfg.Enabled = cfg.Enabled && cfg.WSSURL != "" && cfg.Token != ""

	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	m.generation++
	generation := m.generation
	m.cfg = cfg
	m.status = RelayStatus{
		Enabled:  cfg.Enabled,
		State:    "idle",
		WSSURL:   cfg.WSSURL,
		Username: cfg.Username,
	}
	if !cfg.Enabled {
		if cfg.WSSURL == "" {
			m.status.State = "missing_wss"
		} else if cfg.Token == "" {
			m.status.State = "missing_token"
		} else {
			m.status.State = "disabled"
		}
		status := m.status
		m.mu.Unlock()
		m.emit(status)
		return status
	}

	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	status := m.status
	m.mu.Unlock()

	m.emit(status)
	go m.loop(ctx, generation, cfg)
	return status
}

func (m *RelayManager) Status() RelayStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

func (m *RelayManager) Stop() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	m.generation++
	m.status.Connected = false
	m.status.State = "stopped"
	status := m.status
	m.mu.Unlock()
	m.emit(status)
}

func (m *RelayManager) loop(ctx context.Context, generation uint64, cfg RelayConfig) {
	backoff := 2 * time.Second
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		m.setStatus(generation, func(status *RelayStatus) {
			status.Enabled = true
			status.Connected = false
			status.State = "connecting"
			status.WSSURL = cfg.WSSURL
			status.Username = cfg.Username
			status.LastAttempt = time.Now().UTC().Format(time.RFC3339)
			status.LastError = ""
		})

		err := m.connectOnce(ctx, generation, cfg)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			m.logger.Warn("relay websocket disconnected", "error", err)
			m.setStatus(generation, func(status *RelayStatus) {
				status.Connected = false
				status.State = "retrying"
				status.LastError = err.Error()
			})
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (m *RelayManager) connectOnce(ctx context.Context, generation uint64, cfg RelayConfig) error {
	header := http.Header{}
	header.Set("Authorization", "Bearer "+cfg.Token)
	dialer := *websocket.DefaultDialer
	dialer.EnableCompression = true
	conn, _, err := dialer.DialContext(ctx, cfg.WSSURL, header)
	if err != nil {
		return err
	}
	defer conn.Close()
	var writeMu sync.Mutex
	writeJSON := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return err
		}
		return conn.WriteJSON(v)
	}
	writeControl := func(messageType int, data []byte, deadline time.Time) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteControl(messageType, data, deadline)
	}

	_ = conn.SetReadDeadline(time.Now().Add(relayReadTimeout))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(relayReadTimeout))
		m.markSeen(generation)
		return nil
	})

	now := time.Now().UTC().Format(time.RFC3339)
	m.setStatus(generation, func(status *RelayStatus) {
		status.Connected = true
		status.State = "connected"
		status.ConnectedAt = now
		status.LastSeen = now
		status.LastError = ""
	})

	if err := writeJSON(m.helloPayload()); err != nil {
		return err
	}

	errCh := make(chan error, 1)
	go func() {
		for {
			var msg relayInboundMessage
			if err := conn.ReadJSON(&msg); err != nil {
				errCh <- err
				return
			}
			m.markSeen(generation)
			if msg.Type == "agent.request" {
				go m.handleRequest(ctx, msg, writeJSON)
			}
		}
	}()

	ticker := time.NewTicker(relayHeartbeatEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = writeControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "stopping"), time.Now().Add(2*time.Second))
			return nil
		case err := <-errCh:
			return err
		case <-ticker.C:
			deadline := time.Now().Add(5 * time.Second)
			if err := writeControl(websocket.PingMessage, []byte("ping"), deadline); err != nil {
				return err
			}
			if err := writeJSON(map[string]any{
				"type":      "agent.heartbeat",
				"device_id": m.device.DeviceID,
			}); err != nil {
				return err
			}
			m.markSeen(generation)
		}
	}
}

type relayInboundMessage struct {
	Type   string          `json:"type"`
	ID     string          `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
}

func (m *RelayManager) handleRequest(ctx context.Context, msg relayInboundMessage, writeJSON func(any) error) {
	id := strings.TrimSpace(msg.ID)
	method := strings.TrimSpace(msg.Method)
	if id == "" || method == "" {
		_ = writeJSON(map[string]any{
			"type":  "agent.error",
			"id":    id,
			"error": "request id and method are required",
		})
		return
	}
	if m.app == nil {
		_ = writeJSON(map[string]any{
			"type":  "agent.error",
			"id":    id,
			"error": "codex app-server unavailable",
		})
		return
	}
	var params any
	if len(msg.Params) > 0 && string(msg.Params) != "null" {
		var decoded any
		if err := json.Unmarshal(msg.Params, &decoded); err != nil {
			_ = writeJSON(map[string]any{
				"type":  "agent.error",
				"id":    id,
				"error": err.Error(),
			})
			return
		}
		params = decoded
	}
	reqCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var result json.RawMessage
	if err := m.app.Request(reqCtx, method, params, &result); err != nil {
		_ = writeJSON(map[string]any{
			"type":  "agent.error",
			"id":    id,
			"error": err.Error(),
		})
		return
	}
	_ = writeJSON(map[string]any{
		"type":   "agent.response",
		"id":     id,
		"result": json.RawMessage(result),
	})
}

func (m *RelayManager) helloPayload() map[string]any {
	return map[string]any{
		"type":           "agent.hello",
		"device_id":      m.device.DeviceID,
		"device_name":    m.device.Name,
		"hostname":       m.device.Hostname,
		"platform":       m.device.Platform,
		"os":             runtime.GOOS,
		"arch":           runtime.GOARCH,
		"daemon_version": m.device.DaemonVersion,
		"codex_version":  m.device.CodexCLIVersion,
	}
}

func (m *RelayManager) markSeen(generation uint64) {
	m.setStatus(generation, func(status *RelayStatus) {
		status.LastSeen = time.Now().UTC().Format(time.RFC3339)
	})
}

func (m *RelayManager) setStatus(generation uint64, update func(*RelayStatus)) {
	m.mu.Lock()
	if generation != m.generation {
		m.mu.Unlock()
		return
	}
	update(&m.status)
	status := m.status
	m.mu.Unlock()
	m.emit(status)
}

func (m *RelayManager) emit(status RelayStatus) {
	if m.notify != nil {
		m.notify(status)
	}
}
