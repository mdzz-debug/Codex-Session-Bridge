package daemon

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/luohao/codex-session-bridge/internal/appserver"
	"github.com/luohao/codex-session-bridge/internal/bridge"
)

type Server struct {
	app    *appserver.Client
	device bridge.Device
	logger *slog.Logger
	relay  *RelayManager

	eventsMu sync.Mutex
	clients  map[net.Conn]struct{}
}

type Options struct {
	App    *appserver.Client
	Device bridge.Device
	Logger *slog.Logger
}

func New(opts Options) *Server {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	s := &Server{
		app:     opts.App,
		device:  opts.Device,
		logger:  logger,
		clients: make(map[net.Conn]struct{}),
	}
	s.relay = NewRelayManager(opts.Device, opts.App, logger, func(status RelayStatus) {
		s.broadcast(map[string]any{
			"type":        "relay.status_changed",
			"device_id":   opts.Device.DeviceID,
			"status":      status,
			"received_at": time.Now().UTC().Format(time.RFC3339Nano),
		})
	})
	ch, _ := s.app.Subscribe()
	go s.forwardAppEvents(ch)
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /v1/device", s.handleDevice)
	mux.HandleFunc("GET /v1/relay/status", s.handleRelayStatus)
	mux.HandleFunc("PUT /v1/relay/config", s.handleRelayConfig)
	mux.HandleFunc("POST /v1/relay/config", s.handleRelayConfig)
	mux.HandleFunc("GET /v1/codex/config", s.handleCodexConfigRead)
	mux.HandleFunc("PUT /v1/codex/config", s.handleCodexConfigWrite)
	mux.HandleFunc("GET /v1/codex/model-catalog", s.handleCodexModelCatalog)
	mux.HandleFunc("POST /v1/codex/model-catalog", s.handleCodexModelCatalogPreview)
	mux.HandleFunc("POST /v1/codex/restart", s.handleCodexRestart)
	mux.HandleFunc("GET /v1/skills", s.handleSkillsList)
	mux.HandleFunc("POST /v1/skills/install", s.handleSkillInstall)
	mux.HandleFunc("POST /v1/skills/upgrade", s.handleSkillUpgrade)
	mux.HandleFunc("POST /v1/skills/run", s.handleSkillRun)
	mux.HandleFunc("GET /v1/events", s.handleEvents)
	mux.HandleFunc("POST /v1/threads", s.handleThreadStart)
	mux.HandleFunc("GET /v1/threads", s.handleThreadList)
	mux.HandleFunc("/v1/threads/", s.handleThreadSubroute)
	mux.HandleFunc("/", s.handleWebApp)
	return withCORS(mux)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"device_id": s.device.DeviceID,
		"time":      time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleDevice(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.device)
}

func (s *Server) handleRelayStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.relay.Status())
}

func (s *Server) handleRelayConfig(w http.ResponseWriter, r *http.Request) {
	var cfg RelayConfig
	if !decodeJSON(w, r, &cfg) {
		return
	}
	writeJSON(w, http.StatusOK, s.relay.Update(cfg))
}

func (s *Server) handleCodexConfigRead(w http.ResponseWriter, r *http.Request) {
	cfg, _, err := readCodexConfig()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) handleCodexConfigWrite(w http.ResponseWriter, r *http.Request) {
	var cfg CodexConfig
	if !decodeJSON(w, r, &cfg) {
		return
	}
	next, err := writeCodexConfig(cfg)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, next)
}

func (s *Server) handleCodexModelCatalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, readCodexModelCatalog())
}

func (s *Server) handleCodexModelCatalogPreview(w http.ResponseWriter, r *http.Request) {
	var cfg CodexConfig
	if !decodeJSON(w, r, &cfg) {
		return
	}
	writeJSON(w, http.StatusOK, readCodexModelCatalogFromConfig(cfg))
}

func (s *Server) handleCodexRestart(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	if err := s.app.Restart(ctx); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"restarted": true,
	})
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	conn, br, err := upgradeWebSocket(w, r)
	if err != nil {
		s.logger.Warn("upgrade websocket", "error", err)
		return
	}
	s.eventsMu.Lock()
	s.clients[conn] = struct{}{}
	s.eventsMu.Unlock()

	_ = writeWebSocketJSON(conn, map[string]any{
		"type":      "bridge.connected",
		"device_id": s.device.DeviceID,
		"at":        time.Now().UTC().Format(time.RFC3339),
	})

	go func() {
		defer func() {
			s.eventsMu.Lock()
			delete(s.clients, conn)
			s.eventsMu.Unlock()
			_ = conn.Close()
		}()
		for {
			if err := readWebSocketFrame(br); err != nil {
				return
			}
		}
	}()
}

func (s *Server) handleThreadStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CWD            string         `json:"cwd"`
		Model          string         `json:"model"`
		Effort         string         `json:"effort"`
		ApprovalPolicy string         `json:"approval_policy"`
		Sandbox        string         `json:"sandbox"`
		Config         map[string]any `json:"config"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	params := map[string]any{
		"cwd":    nullableString(req.CWD),
		"model":  nullableString(req.Model),
		"config": nullableMap(req.Config),
	}
	if req.Effort != "" {
		params["effort"] = req.Effort
	}
	if req.ApprovalPolicy != "" {
		params["approvalPolicy"] = req.ApprovalPolicy
	}
	if req.Sandbox != "" {
		params["sandbox"] = req.Sandbox
	}

	var result map[string]any
	if err := s.request(r, "thread/start", params, &result); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleThreadList(w http.ResponseWriter, r *http.Request) {
	params := map[string]any{}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		params["cursor"] = cursor
	}
	var result map[string]any
	if err := s.request(r, "thread/list", params, &result); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleThreadSubroute(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/threads/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	threadID := parts[0]

	switch {
	case r.Method == http.MethodGet && len(parts) == 1:
		s.handleThreadRead(w, r, threadID)
	case r.Method == http.MethodGet && len(parts) == 2 && parts[1] == "history":
		s.handleThreadHistory(w, r, threadID)
	case r.Method == http.MethodGet && len(parts) == 2 && parts[1] == "turns":
		s.handleThreadTurns(w, r, threadID)
	case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "turns":
		s.handleTurnStart(w, r, threadID)
	case r.Method == http.MethodGet && len(parts) == 4 && parts[1] == "turns" && parts[3] == "items":
		s.handleTurnItems(w, r, threadID, parts[2])
	case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "interrupt":
		s.handleTurnInterrupt(w, r, threadID)
	case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "archive":
		s.handleThreadArchive(w, r, threadID)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleThreadRead(w http.ResponseWriter, r *http.Request, threadID string) {
	var result map[string]any
	if err := s.request(r, "thread/read", map[string]any{"threadId": threadID}, &result); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleThreadHistory(w http.ResponseWriter, r *http.Request, threadID string) {
	var resumed map[string]any
	if err := s.request(r, "thread/resume", map[string]any{
		"threadId":     threadID,
		"excludeTurns": true,
	}, &resumed); err != nil {
		writeError(w, err)
		return
	}

	var turns map[string]any
	params := map[string]any{
		"threadId":      threadID,
		"itemsView":     queryString(r, "itemsView", "full"),
		"limit":         queryLimit(r, 30),
		"sortDirection": queryString(r, "sortDirection", "desc"),
	}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		params["cursor"] = cursor
	}
	if err := s.request(r, "thread/turns/list", params, &turns); err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"thread":          valueFromMap(resumed, "thread"),
		"turns":           valueFromMap(turns, "data"),
		"cursor":          valueFromMap(turns, "nextCursor"),
		"nextCursor":      valueFromMap(turns, "nextCursor"),
		"backwardsCursor": valueFromMap(turns, "backwardsCursor"),
	})
}

func (s *Server) handleThreadTurns(w http.ResponseWriter, r *http.Request, threadID string) {
	params := map[string]any{
		"threadId":      threadID,
		"itemsView":     queryString(r, "itemsView", "full"),
		"sortDirection": queryString(r, "sortDirection", "asc"),
		"limit":         queryLimit(r, 50),
	}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		params["cursor"] = cursor
	}
	var result map[string]any
	if err := s.request(r, "thread/turns/list", params, &result); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleTurnItems(w http.ResponseWriter, r *http.Request, threadID string, turnID string) {
	params := map[string]any{
		"threadId":      threadID,
		"turnId":        turnID,
		"sortDirection": "asc",
	}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		params["cursor"] = cursor
	}
	var result map[string]any
	if err := s.request(r, "thread/turns/items/list", params, &result); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleTurnStart(w http.ResponseWriter, r *http.Request, threadID string) {
	var req struct {
		Content        string           `json:"content"`
		Input          []map[string]any `json:"input"`
		Model          string           `json:"model"`
		Effort         string           `json:"effort"`
		CWD            string           `json:"cwd"`
		ApprovalPolicy string           `json:"approval_policy"`
		SandboxPolicy  map[string]any   `json:"sandbox_policy"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	input := req.Input
	if len(input) == 0 && strings.TrimSpace(req.Content) != "" {
		input = []map[string]any{{"type": "text", "text": req.Content}}
	}
	if len(input) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "content or input is required"})
		return
	}
	params := map[string]any{
		"threadId": threadID,
		"input":    input,
	}
	if req.Model != "" {
		params["model"] = req.Model
	}
	if req.Effort != "" {
		params["effort"] = req.Effort
	}
	if req.CWD != "" {
		params["cwd"] = req.CWD
	}
	if req.ApprovalPolicy != "" {
		params["approvalPolicy"] = req.ApprovalPolicy
	}
	if req.SandboxPolicy != nil {
		params["sandboxPolicy"] = req.SandboxPolicy
	}

	var result map[string]any
	if err := s.request(r, "turn/start", params, &result); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleTurnInterrupt(w http.ResponseWriter, r *http.Request, threadID string) {
	var req struct {
		TurnID string `json:"turn_id"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.TurnID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "turn_id is required"})
		return
	}
	var result map[string]any
	if err := s.request(r, "turn/interrupt", map[string]any{"threadId": threadID, "turnId": req.TurnID}, &result); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleThreadArchive(w http.ResponseWriter, r *http.Request, threadID string) {
	var result map[string]any
	if err := s.request(r, "thread/archive", map[string]any{"threadId": threadID}, &result); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) forwardAppEvents(ch <-chan appserver.Notification) {
	for n := range ch {
		event := normalizeEvent(s.device.DeviceID, n)
		s.broadcast(event)
	}
}

func normalizeEvent(deviceID string, n appserver.Notification) map[string]any {
	eventType := "codex." + strings.ReplaceAll(n.Method, "/", ".")
	switch n.Method {
	case "thread/started":
		eventType = "thread.started"
	case "thread/status/changed":
		eventType = "thread.status_changed"
	case "thread/archived":
		eventType = "thread.archived"
	case "thread/unarchived":
		eventType = "thread.unarchived"
	case "turn/started":
		eventType = "turn.started"
	case "turn/completed":
		eventType = "turn.completed"
	case "turn/diff/updated":
		eventType = "turn.diff_updated"
	case "turn/plan/updated":
		eventType = "turn.plan_updated"
	case "item/agentMessage/delta":
		eventType = "message.delta"
	case "thread/tokenUsage/updated":
		eventType = "thread.token_usage_updated"
	}
	return map[string]any{
		"type":           eventType,
		"device_id":      deviceID,
		"app_request_id": n.ID,
		"app_request":    n.Request,
		"codex_method":   n.Method,
		"codex_params":   n.Params,
		"received_at":    time.Now().UTC().Format(time.RFC3339Nano),
	}
}

func (s *Server) broadcast(event map[string]any) {
	s.eventsMu.Lock()
	defer s.eventsMu.Unlock()
	for conn := range s.clients {
		if err := writeWebSocketJSON(conn, event); err != nil {
			_ = conn.Close()
			delete(s.clients, conn)
		}
	}
}

func (s *Server) handleWebApp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}
	root := webDistRoot()
	requestPath := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if requestPath == "." || requestPath == "" {
		requestPath = "index.html"
	}
	full := filepath.Join(root, requestPath)
	rel, err := filepath.Rel(root, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		full = filepath.Join(root, "index.html")
	}
	data, err := os.ReadFile(full)
	if err != nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("<!doctype html><title>Codex Session Bridge</title><body style=\"font-family:system-ui;padding:32px\"><h1>Codex Session Bridge</h1><p>Web UI has not been built yet. Run <code>npm run build:web</code> or <code>npm run dev:web</code>.</p></body>"))
		return
	}
	if contentType := mime.TypeByExtension(filepath.Ext(full)); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	_, _ = w.Write(data)
}

func webDistRoot() string {
	candidates := []string{}
	if envRoot := strings.TrimSpace(os.Getenv("CSB_WEB_DIST")); envRoot != "" {
		candidates = append(candidates, envRoot)
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "web", "dist"))
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, "web", "dist"),
			filepath.Join(exeDir, "..", "web", "dist"),
			filepath.Join(exeDir, "..", "..", "web", "dist"),
		)
	}
	candidates = append(candidates, filepath.Join("web", "dist"))

	for _, candidate := range candidates {
		if info, err := os.Stat(filepath.Join(candidate, "index.html")); err == nil && !info.IsDir() {
			if abs, err := filepath.Abs(candidate); err == nil {
				return abs
			}
			return filepath.Clean(candidate)
		}
	}
	if len(candidates) > 0 {
		if abs, err := filepath.Abs(candidates[0]); err == nil {
			return abs
		}
		return filepath.Clean(candidates[0])
	}
	return filepath.Join("web", "dist")
}

func upgradeWebSocket(w http.ResponseWriter, r *http.Request) (net.Conn, *bufio.Reader, error) {
	if !headerContains(r.Header.Get("Connection"), "upgrade") || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, nil, errors.New("missing websocket upgrade headers")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, nil, errors.New("missing Sec-WebSocket-Key")
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, nil, err
	}
	accept := websocketAccept(key)
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := rw.WriteString(resp); err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	return conn, rw.Reader, nil
}

func websocketAccept(key string) string {
	const magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	sum := sha1.Sum([]byte(key + magic))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func headerContains(header string, token string) bool {
	for _, part := range strings.Split(header, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

func writeWebSocketJSON(conn net.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return writeWebSocketText(conn, b)
}

func writeWebSocketText(conn net.Conn, payload []byte) error {
	header := []byte{0x81}
	switch {
	case len(payload) < 126:
		header = append(header, byte(len(payload)))
	case len(payload) <= 0xffff:
		header = append(header, 126, byte(len(payload)>>8), byte(len(payload)))
	default:
		var extended [8]byte
		binary.BigEndian.PutUint64(extended[:], uint64(len(payload)))
		header = append(header, 127)
		header = append(header, extended[:]...)
	}
	if _, err := conn.Write(header); err != nil {
		return err
	}
	_, err := conn.Write(payload)
	return err
}

func readWebSocketFrame(r *bufio.Reader) error {
	var header [2]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return err
	}
	opcode := header[0] & 0x0f
	masked := header[1]&0x80 != 0
	length := uint64(header[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return err
		}
	}
	if length > 0 {
		if _, err := io.CopyN(io.Discard, r, int64(length)); err != nil {
			return err
		}
	}
	if opcode == 0x8 {
		return fmt.Errorf("websocket closed")
	}
	return nil
}

func (s *Server) request(r *http.Request, method string, params any, out any) error {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	return s.app.Request(ctx, method, params, out)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
}

func nullableString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func nullableMap(v map[string]any) any {
	if v == nil {
		return nil
	}
	return v
}

func queryString(r *http.Request, key string, fallback string) string {
	value := strings.TrimSpace(r.URL.Query().Get(key))
	if value == "" {
		return fallback
	}
	return value
}

func queryLimit(r *http.Request, fallback int) int {
	raw := strings.TrimSpace(r.URL.Query().Get("limit"))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	if value > 100 {
		return 100
	}
	return value
}

func valueFromMap(m map[string]any, key string) any {
	if m == nil {
		return nil
	}
	return m[key]
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
