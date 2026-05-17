# Codex Session Bridge Plan

## Goal

Build a desktop client that can be installed on every Mac/Windows computer and controlled from H5 without exposing the user's local network.

Core path:

```text
H5 / mobile
  -> public relay server
  -> desktop client outbound WSS
  -> local daemon
  -> codex app-server
```

The desktop client is:

```text
Electron shell
  + Web UI
  + local Go daemon
  + relay WebSocket client
```

The local daemon must only listen on `127.0.0.1`.

## Architecture

### Desktop Client

Responsibilities:

- Start and supervise the local Go daemon.
- Provide relay login UI and store relay token locally.
- Show local status: device id, relay connection, Codex connection, current project/thread.
- Provide a Web UI for thread list, history, and sending prompts.
- Package for macOS and Windows.
- Keep API keys and Codex credentials local.

### Local Go Daemon

Current MVP exists.

Responsibilities:

- Connect to `codex app-server --listen stdio://`.
- Expose localhost HTTP/WebSocket APIs for the Electron UI.
- Maintain stable `device_id`.
- Read thread list and history.
- Create/resume threads.
- Start turns and stream events.
- Connect outward to the public relay over WSS.

Local API:

- `GET /health`
- `GET /v1/device`
- `GET /v1/events`
- `POST /v1/threads`
- `GET /v1/threads`
- `GET /v1/threads/{thread_id}`
- `GET /v1/threads/{thread_id}/history`
- `GET /v1/threads/{thread_id}/turns`
- `GET /v1/threads/{thread_id}/turns/{turn_id}/items`
- `POST /v1/threads/{thread_id}/turns`
- `POST /v1/threads/{thread_id}/interrupt`
- `POST /v1/threads/{thread_id}/archive`

### Public Relay Server

Responsibilities:

- User auth.
- Issue short-lived access tokens and refresh tokens for desktop/H5 clients.
- Device registration and pairing.
- Maintain online device map.
- Route commands from H5 to a selected desktop daemon.
- Persist normalized history mirror.
- Store device/project/thread mappings.
- Never store OpenAI API keys.

The relay receives only metadata and conversation history needed for sync.

### H5 / Web App

Responsibilities:

- Login.
- List devices.
- List projects and threads.
- Open a thread's history.
- Continue a thread on a selected online device.
- Show streaming assistant output.
- Request interrupt.
- Manage device revoke/logout.

## Device Model

Each desktop installation has one stable `device_id`.

The daemon stores it locally and syncs it to the relay.

```json
{
  "device_id": "",
  "user_id": "",
  "name": "",
  "platform": "macos/windows/linux",
  "hostname": "",
  "daemon_version": "",
  "codex_cli_version": "",
  "last_seen": "",
  "online": false,
  "revoked": false
}
```

Thread mapping:

```json
{
  "bridge_thread_id": "",
  "device_id": "",
  "codex_thread_id": "",
  "project_id": "",
  "created_at": "",
  "last_active": ""
}
```

Do not assume different computers share the same `~/.codex` state.

## Login Model

The desktop client should have a login screen, but it logs into the Bridge relay, not OpenAI.

Flow:

```text
Electron login UI
  -> relay login API
  -> receive relay access token / refresh token
  -> store token locally
  -> daemon uses token to connect WSS
```

Token storage:

- macOS: Keychain
- Windows: Credential Manager
- fallback for development: local config file with restricted permissions

The relay token is used only for:

- device registration
- WSS authentication
- command routing
- history sync

The relay token must not grant direct access to local filesystem APIs. Remote commands still go through daemon permission checks.

OpenAI API keys and Codex credentials stay local and are never sent to the relay.

## Relay Protocol

Use outbound WSS from daemon to relay:

```text
daemon -> wss://relay.example.com/agent
```

Initial hello:

```json
{
  "type": "device.hello",
  "device": {
    "device_id": "",
    "name": "",
    "platform": "",
    "hostname": "",
    "daemon_version": "",
    "codex_cli_version": ""
  },
  "token": ""
}
```

In production, the token should be sent in the WSS `Authorization` header when possible. The JSON `token` field is acceptable only for early MVP debugging.

Command from relay to daemon:

```json
{
  "id": "cmd_...",
  "type": "turn.start",
  "device_id": "",
  "codex_thread_id": "",
  "content": "你好"
}
```

Event from daemon to relay:

```json
{
  "id": "evt_...",
  "command_id": "cmd_...",
  "type": "message.delta",
  "device_id": "",
  "codex_thread_id": "",
  "payload": {}
}
```

The relay protocol must support:

- `device.hello`
- `device.heartbeat`
- `device.status`
- `thread.list`
- `thread.history`
- `thread.start`
- `turn.start`
- `turn.interrupt`
- `event.forward`
- `error`

## Security Rules

- Desktop daemon listens on `127.0.0.1` only.
- Remote access uses daemon-initiated `wss://` only.
- No port mapping.
- No public inbound port on the user's computer.
- API keys never leave the desktop machine.
- Pairing uses short-lived one-time codes.
- Relay tokens are revocable.
- Device revocation immediately closes relay connection.
- Remote commands require project-level permissions.
- Destructive operations need explicit approval mode.
- Store audit logs for remote commands.

## Build Phases

### Phase 1: Local Web UI

Purpose:

Make the existing daemon visible and usable.

Tasks:

- Add `web/` React + Vite app.
- Add placeholder login screen for future relay login.
- Show daemon health and device info.
- List Codex threads.
- Show selected thread history.
- Send prompt to selected thread.
- Subscribe to `/v1/events`.
- Add interrupt button.
- Serve built web assets from Go daemon at `/`.

Success:

Opening `http://127.0.0.1:8787` shows a usable local Codex control panel.

### Phase 2: Electron Shell

Purpose:

Turn the local Web UI into a desktop client.

Tasks:

- Add Electron app.
- Start/supervise Go daemon from Electron main process.
- Detect daemon port.
- Open local Web UI inside Electron window.
- Add relay login window/state, but it can be disabled until relay exists.
- Store relay token through OS credential storage when enabled.
- Add tray icon.
- Add quit/restart daemon actions.
- Add macOS and Windows packaging.

Success:

User can install and open a desktop app without running terminal commands.

### Phase 3: Relay Client

Purpose:

Enable remote control without exposing local ports.

Tasks:

- Add daemon `--relay-url`.
- Add daemon `--relay-token`.
- Implement outbound WSS relay client.
- Send `device.hello`.
- Send heartbeat.
- Receive commands.
- Map relay commands to local daemon actions.
- Forward normalized Codex events to relay.
- Reconnect with backoff.

Success:

Relay can ask an online desktop client to continue a Codex thread.

### Phase 4: Public Relay Server

Purpose:

Provide account, device, and command routing.

Tasks:

- User auth.
- Login API for desktop and H5.
- Access token / refresh token issuance.
- Device registration.
- Pairing code flow.
- Online device map.
- Command routing.
- History mirror database.
- Audit logs.
- H5 API.

Success:

Phone can select a device and send a prompt through the relay.

### Phase 5: H5 Remote UI

Purpose:

Remote mobile/web control.

Tasks:

- Login.
- Device list.
- Thread list.
- History viewer.
- Prompt composer.
- Streaming output.
- Interrupt.
- Device revoke.

Success:

Phone can continue a desktop Codex thread through the public relay.

## Recommended Immediate Next Step

Start with Phase 1.

Reason:

The daemon already controls Codex app-server. A local Web UI gives immediate visibility and becomes the same UI that Electron will later package.
