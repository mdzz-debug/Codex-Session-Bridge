# Codex Session Bridge

Local daemon for controlling Codex through `codex app-server` without driving the desktop GUI.

## MVP

- Starts `codex app-server --listen stdio://`
- Initializes the app-server protocol
- Exposes a local HTTP API
- Broadcasts normalized Codex events over WebSocket
- Maintains a stable local `device_id`
- Serves a modern local Web UI at `/`
- Provides an Electron shell for macOS/Windows packaging
- Includes relay login UI for the existing `/v0/management/auth/login` API

## Run

```sh
go run ./cmd/csb-daemon
```

Open:

```text
http://127.0.0.1:8787
```

Web development:

```sh
npm install
npm run dev:web
```

Electron development:

```sh
npm run dev:electron
```

If Electron binary download is unstable, use the mirror:

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run build:electron -- --mac dir
```

Build checks:

```sh
npm run check
```

Use a temporary Codex home while probing:

```sh
go run ./cmd/csb-daemon --codex-home /private/tmp/csb-codex-home --debug
```

## API

- `GET /health`
- `GET /v1/device`
- `GET /v1/events` WebSocket
- `POST /v1/threads`
- `GET /v1/threads`
- `GET /v1/threads/{thread_id}`
- `GET /v1/threads/{thread_id}/history`
- `GET /v1/threads/{thread_id}/turns`
- `GET /v1/threads/{thread_id}/turns/{turn_id}/items`
- `POST /v1/threads/{thread_id}/turns`
- `POST /v1/threads/{thread_id}/interrupt`
- `POST /v1/threads/{thread_id}/archive`

Create a thread:

```sh
curl -s http://127.0.0.1:8787/v1/threads \
  -H 'content-type: application/json' \
  -d '{"cwd":"/Users/luohao/Desktop/mineProject/cli"}'
```

Start a turn:

```sh
curl -s http://127.0.0.1:8787/v1/threads/<thread_id>/turns \
  -H 'content-type: application/json' \
  -d '{"content":"hello"}'
```


npm run build:desktop -- mac
npm run build:desktop -- win
npm run build:desktop -- all