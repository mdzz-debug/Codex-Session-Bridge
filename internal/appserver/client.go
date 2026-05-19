package appserver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

type Message map[string]any

type Notification struct {
	ID      int64          `json:"id,omitempty"`
	Method  string         `json:"method"`
	Params  map[string]any `json:"params,omitempty"`
	Request map[string]any `json:"request,omitempty"`
}

type Client struct {
	ctx       context.Context
	bin       string
	codexHome string
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	logger    *slog.Logger

	processMu sync.RWMutex

	nextID  atomic.Int64
	writeMu sync.Mutex

	pendingMu sync.Mutex
	pending   map[int64]chan response

	notifyMu    sync.Mutex
	subscribers map[chan Notification]struct{}
}

type response struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  any             `json:"error,omitempty"`
}

type Options struct {
	CodexBin  string
	CodexHome string
	Logger    *slog.Logger
}

func Start(ctx context.Context, opts Options) (*Client, error) {
	bin := opts.CodexBin
	if bin == "" {
		bin = "codex"
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	cmd := exec.CommandContext(ctx, bin, "app-server", "--listen", "stdio://")
	if opts.CodexHome != "" {
		cmd.Env = append(os.Environ(), "CODEX_HOME="+opts.CodexHome)
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	c := &Client{
		ctx:         ctx,
		bin:         bin,
		codexHome:   opts.CodexHome,
		cmd:         cmd,
		stdin:       stdin,
		logger:      logger,
		pending:     make(map[int64]chan response),
		subscribers: make(map[chan Notification]struct{}),
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	c.watchCommand(cmd, stdout, stderr)

	initParams := map[string]any{
		"clientInfo": map[string]any{
			"name":    "codex-session-bridge",
			"title":   "Codex Session Bridge",
			"version": "0.1.0",
		},
		"capabilities": map[string]any{
			"experimentalApi": true,
		},
	}
	var initResult map[string]any
	if err := c.Request(ctx, "initialize", initParams, &initResult); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("initialize codex app-server: %w", err)
	}
	logger.Info("connected to codex app-server", "user_agent", initResult["userAgent"], "codex_home", initResult["codexHome"])

	return c, nil
}

func (c *Client) Request(ctx context.Context, method string, params any, out any) error {
	id := c.nextID.Add(1)
	ch := make(chan response, 1)

	msg := map[string]any{
		"id":     id,
		"method": method,
		"params": params,
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	c.writeMu.Lock()
	c.processMu.RLock()
	stdin := c.stdin
	if stdin == nil {
		err = errors.New("codex app-server is not running")
	} else {
		c.pendingMu.Lock()
		c.pending[id] = ch
		c.pendingMu.Unlock()
		_, err = stdin.Write(append(b, '\n'))
	}
	c.processMu.RUnlock()
	c.writeMu.Unlock()
	if err != nil {
		c.deletePending(id)
		return err
	}

	select {
	case res := <-ch:
		if res.Error != nil {
			return fmt.Errorf("app-server %s failed: %v", method, res.Error)
		}
		if out == nil {
			return nil
		}
		if len(res.Result) == 0 {
			return nil
		}
		return json.Unmarshal(res.Result, out)
	case <-ctx.Done():
		c.deletePending(id)
		return ctx.Err()
	}
}

func (c *Client) Respond(id int64, result any) error {
	if id == 0 {
		return errors.New("response id is required")
	}
	msg := map[string]any{
		"id":     id,
		"result": result,
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	c.processMu.RLock()
	stdin := c.stdin
	if stdin == nil {
		err = errors.New("codex app-server is not running")
	} else {
		_, err = stdin.Write(append(b, '\n'))
	}
	c.processMu.RUnlock()
	c.writeMu.Unlock()
	return err
}

func (c *Client) Subscribe() (<-chan Notification, func()) {
	ch := make(chan Notification, 128)
	c.notifyMu.Lock()
	c.subscribers[ch] = struct{}{}
	c.notifyMu.Unlock()

	cancel := func() {
		c.notifyMu.Lock()
		if _, ok := c.subscribers[ch]; ok {
			delete(c.subscribers, ch)
			close(ch)
		}
		c.notifyMu.Unlock()
	}
	return ch, cancel
}

func (c *Client) Close() error {
	c.processMu.Lock()
	c.closeCommandLocked()
	c.processMu.Unlock()
	return nil
}

func (c *Client) Restart(ctx context.Context) error {
	c.writeMu.Lock()
	c.processMu.Lock()
	c.failPending(errors.New("codex app-server restarting"))
	c.closeCommandLocked()

	cmd := exec.CommandContext(c.ctx, c.bin, "app-server", "--listen", "stdio://")
	if c.codexHome != "" {
		cmd.Env = append(os.Environ(), "CODEX_HOME="+c.codexHome)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		c.processMu.Unlock()
		c.writeMu.Unlock()
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		c.processMu.Unlock()
		c.writeMu.Unlock()
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		c.processMu.Unlock()
		c.writeMu.Unlock()
		return err
	}
	if err := cmd.Start(); err != nil {
		c.processMu.Unlock()
		c.writeMu.Unlock()
		return err
	}
	c.cmd = cmd
	c.stdin = stdin
	c.watchCommand(cmd, stdout, stderr)
	c.processMu.Unlock()
	c.writeMu.Unlock()

	initParams := map[string]any{
		"clientInfo": map[string]any{
			"name":    "codex-session-bridge",
			"title":   "Codex Session Bridge",
			"version": "0.1.0",
		},
		"capabilities": map[string]any{
			"experimentalApi": true,
		},
	}
	var initResult map[string]any
	if err := c.Request(ctx, "initialize", initParams, &initResult); err != nil {
		return fmt.Errorf("initialize codex app-server: %w", err)
	}
	c.logger.Info("restarted codex app-server", "user_agent", initResult["userAgent"], "codex_home", initResult["codexHome"])
	return nil
}

func (c *Client) closeCommandLocked() {
	if c.stdin != nil {
		_ = c.stdin.Close()
		c.stdin = nil
	}
	cmd := c.cmd
	c.cmd = nil
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Signal(os.Interrupt)
		time.Sleep(150 * time.Millisecond)
		_ = cmd.Process.Kill()
	}
}

func (c *Client) watchCommand(cmd *exec.Cmd, stdout io.Reader, stderr io.Reader) {
	go c.readStdout(stdout)
	go c.readStderr(stderr)
	go func() {
		err := cmd.Wait()
		c.processMu.RLock()
		isCurrent := c.cmd == cmd
		c.processMu.RUnlock()
		if err != nil {
			c.logger.Warn("codex app-server exited", "error", err)
		}
		if isCurrent {
			c.failPending(fmt.Errorf("codex app-server exited: %w", err))
		}
	}()
}

func (c *Client) readStdout(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(line, &raw); err != nil {
			c.logger.Warn("invalid app-server stdout", "error", err)
			continue
		}

		if idRaw, hasID := raw["id"]; hasID {
			if _, hasMethod := raw["method"]; !hasMethod {
				var id int64
				if err := json.Unmarshal(idRaw, &id); err != nil {
					c.logger.Warn("invalid app-server response id", "error", err)
					continue
				}
				res := response{Result: raw["result"]}
				if errRaw, ok := raw["error"]; ok {
					var errValue any
					_ = json.Unmarshal(errRaw, &errValue)
					res.Error = errValue
				}
				c.resolvePending(id, res)
				continue
			}
		}

		if methodRaw, ok := raw["method"]; ok {
			var id int64
			if idRaw, hasID := raw["id"]; hasID {
				_ = json.Unmarshal(idRaw, &id)
			}
			var method string
			if err := json.Unmarshal(methodRaw, &method); err != nil {
				continue
			}
			params := map[string]any{}
			if paramsRaw, ok := raw["params"]; ok && len(paramsRaw) > 0 {
				_ = json.Unmarshal(paramsRaw, &params)
			}
			request := map[string]any{}
			for key, value := range raw {
				var decoded any
				if err := json.Unmarshal(value, &decoded); err == nil {
					request[key] = decoded
				}
			}
			c.publish(Notification{ID: id, Method: method, Params: params, Request: request})
			continue
		}

		if idRaw, ok := raw["id"]; ok {
			var id int64
			if err := json.Unmarshal(idRaw, &id); err != nil {
				c.logger.Warn("invalid app-server response id", "error", err)
				continue
			}
			res := response{Result: raw["result"]}
			if errRaw, ok := raw["error"]; ok {
				var errValue any
				_ = json.Unmarshal(errRaw, &errValue)
				res.Error = errValue
			}
			c.resolvePending(id, res)
			continue
		}
	}
	if err := scanner.Err(); err != nil {
		c.logger.Warn("read app-server stdout", "error", err)
	}
}

func (c *Client) readStderr(r io.Reader) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		c.logger.Debug("codex app-server stderr", "line", scanner.Text())
	}
}

func (c *Client) resolvePending(id int64, res response) {
	c.pendingMu.Lock()
	ch, ok := c.pending[id]
	if ok {
		delete(c.pending, id)
	}
	c.pendingMu.Unlock()
	if ok {
		ch <- res
		close(ch)
	}
}

func (c *Client) deletePending(id int64) {
	c.pendingMu.Lock()
	delete(c.pending, id)
	c.pendingMu.Unlock()
}

func (c *Client) failPending(err error) {
	if err == nil {
		err = errors.New("codex app-server exited")
	}
	c.pendingMu.Lock()
	pending := c.pending
	c.pending = make(map[int64]chan response)
	c.pendingMu.Unlock()
	for _, ch := range pending {
		ch <- response{Error: err.Error()}
		close(ch)
	}
}

func (c *Client) publish(n Notification) {
	c.notifyMu.Lock()
	defer c.notifyMu.Unlock()
	for ch := range c.subscribers {
		select {
		case ch <- n:
		default:
			c.logger.Warn("dropping app-server notification for slow subscriber", "method", n.Method)
		}
	}
}
