const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, dialog, screen } = require('electron');
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const defaultDaemonPort = '8787';
const githubOwner = 'mdzz-debug';
const githubRepo = 'Codex-Session-Bridge';
const githubReleasesUrl = `https://github.com/${githubOwner}/${githubRepo}/releases`;
const devUrl = process.env.CSB_WEB_URL || 'http://127.0.0.1:5178';
let modelUnlockDebugPort = normalizeDebugPort(process.env.CSB_CODEX_MODEL_DEBUG_PORT || process.env.CSB_CODEX_PLUGIN_DEBUG_PORT || '9229');
const commonShellPath = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(path.delimiter);

let mainWindow;
let tray;
let daemonProcess;
let isQuitting = false;
let daemonStoppedByUser = false;
let daemonLoadTimer;
let daemonRestartTimer;
let currentMinimumHeight = 360;
let lastRelayStatus;
let trayStatusRefreshing = false;
let modelUnlockStatus = {
  available: process.platform === 'darwin' || process.platform === 'win32',
  injected: false,
  debugPort: modelUnlockDebugPort,
  message: '尚未注入模型解锁脚本',
};
let desktopPreferences = {
  launchAtLogin: false,
  closeToTray: true,
  hideDockIcon: false,
  daemonPort: defaultDaemonPort,
  usageWidget: {
    enabled: false,
    backendBaseUrl: 'http://127.0.0.1:8317',
    managementKey: '',
    updateIntervalMinutes: 3,
  },
};
let usageWidgetWindow;
let usageWidgetTimer;
let usageWidgetRefreshing = false;

function normalizeDebugPort(value) {
  const port = Number(String(value || '').trim());
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 9229;
}

function normalizeDaemonPort(value) {
  const port = String(value || '').trim();
  const numeric = Number(port);
  return Number.isInteger(numeric) && numeric >= 1024 && numeric <= 65535 ? port : defaultDaemonPort;
}

function normalizeUsageWidgetIntervalMinutes(value) {
  const minutes = Number(String(value || '').trim());
  if (!Number.isFinite(minutes)) return 3;
  return Math.max(3, Math.min(1440, Math.round(minutes)));
}

function normalizeManagementBaseUrl(value) {
  const raw = String(value || '').trim() || 'http://127.0.0.1:8317';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withProtocol);
    url.pathname = url.pathname.replace(/\/+$/g, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/g, '');
  } catch {
    return 'http://127.0.0.1:8317';
  }
}

function normalizeUsageWidgetPreferences(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: Boolean(source.enabled),
    backendBaseUrl: normalizeManagementBaseUrl(source.backendBaseUrl),
    managementKey: typeof source.managementKey === 'string' ? source.managementKey.trim() : '',
    updateIntervalMinutes: normalizeUsageWidgetIntervalMinutes(source.updateIntervalMinutes),
  };
}

function daemonPort() {
  return normalizeDaemonPort(process.env.CSB_PORT || desktopPreferences.daemonPort || defaultDaemonPort);
}

function daemonUrl() {
  return `http://127.0.0.1:${daemonPort()}`;
}

function preferencesPath() {
  return path.join(app.getPath('userData'), 'desktop-preferences.json');
}

function relayStatePath() {
  return path.join(app.getPath('userData'), 'relay-state.json');
}

function sanitizeRelaySettings(settings = {}) {
  return {
    relayApiBase: typeof settings.relayApiBase === 'string' ? settings.relayApiBase : '',
    relayWssUrl: typeof settings.relayWssUrl === 'string' ? settings.relayWssUrl : '',
    autoConnectRelay: Boolean(settings.autoConnectRelay),
  };
}

function sanitizeRelaySession(session) {
  if (!session || typeof session !== 'object') return null;
  if (!session.apiBase || !session.token || !session.username) return null;
  return {
    apiBase: String(session.apiBase),
    token: String(session.token),
    username: String(session.username),
    role: session.role === 'admin' ? 'admin' : 'user',
    expiresAt: typeof session.expiresAt === 'string' ? session.expiresAt : undefined,
  };
}

function readRelayState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(relayStatePath(), 'utf8'));
    return {
      settings: sanitizeRelaySettings(parsed.settings),
      session: sanitizeRelaySession(parsed.session),
    };
  } catch {
    return { settings: null, session: null };
  }
}

function writeRelayState(state = {}) {
  const next = {
    settings: sanitizeRelaySettings(state.settings),
    session: sanitizeRelaySession(state.session),
  };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(relayStatePath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function readDesktopPreferences() {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'));
    desktopPreferences = {
      ...desktopPreferences,
      launchAtLogin: Boolean(parsed.launchAtLogin),
      closeToTray: parsed.closeToTray !== false,
      hideDockIcon: Boolean(parsed.hideDockIcon),
      daemonPort: normalizeDaemonPort(parsed.daemonPort),
      usageWidget: normalizeUsageWidgetPreferences(parsed.usageWidget),
    };
  } catch {
    desktopPreferences.launchAtLogin = app.getLoginItemSettings().openAtLogin;
  }
  applyDesktopPreferences();
}

function writeDesktopPreferences() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(preferencesPath(), JSON.stringify(desktopPreferences, null, 2), { mode: 0o600 });
}

function publicDesktopPreferences() {
  return {
    available: true,
    platform: process.platform,
    version: app.getVersion(),
    ...desktopPreferences,
    usageWidget: {
      ...desktopPreferences.usageWidget,
      managementKey: '',
    },
    daemonUrl: daemonUrl(),
  };
}

function applyDesktopPreferences() {
  app.setLoginItemSettings({ openAtLogin: desktopPreferences.launchAtLogin });
  if (process.platform === 'darwin' && app.dock) {
    if (desktopPreferences.hideDockIcon) {
      app.dock.hide();
    } else {
      app.dock.show();
    }
  }
  syncUsageWidgetState();
}

function daemonCommand() {
  const codexBin = resolveCodexBin();
  const codexArgs = codexBin ? ['--codex-bin', codexBin] : [];
  const env = {
    ...process.env,
    PATH: mergePath(process.env.PATH, commonShellPath),
    CSB_WEB_DIST: app.isPackaged
      ? path.join(process.resourcesPath, 'web', 'dist')
      : path.join(app.getAppPath(), 'web', 'dist'),
  };

  if (!app.isPackaged) {
    return {
      command: 'go',
      args: ['run', './cmd/csb-daemon', '--addr', `127.0.0.1:${daemonPort()}`, ...codexArgs],
      options: { cwd: app.getAppPath(), stdio: 'pipe', env },
    };
  }

  const binName = process.platform === 'win32' ? 'csb-daemon.exe' : 'csb-daemon';
  const command = path.join(process.resourcesPath, 'bin', binName);
  return {
    command,
    args: ['--addr', `127.0.0.1:${daemonPort()}`, ...codexArgs],
    options: { cwd: process.resourcesPath, stdio: 'pipe', env },
  };
}

function mergePath(...values) {
  const seen = new Set();
  return values
    .flatMap((value) => String(value || '').split(path.delimiter))
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .join(path.delimiter);
}

function resolveCodexBin() {
  return firstExistingPath([
    process.env.CSB_CODEX_BIN,
    process.platform === 'darwin' ? '/Applications/Codex.app/Contents/Resources/codex' : '',
    process.platform === 'darwin' && process.env.HOME
      ? path.join(process.env.HOME, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex')
      : '',
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Codex', 'resources', 'codex.exe')
      : '',
  ]);
}

function startDaemon() {
  if (process.env.CSB_SKIP_DAEMON === '1') return;
  if (daemonProcess) return;
  daemonStoppedByUser = false;
  if (daemonRestartTimer) {
    clearTimeout(daemonRestartTimer);
    daemonRestartTimer = undefined;
  }
  const cmd = daemonCommand();
  daemonProcess = spawn(cmd.command, cmd.args, cmd.options);
  daemonProcess.stdout?.on('data', (chunk) => console.log(`[daemon] ${chunk}`));
  daemonProcess.stderr?.on('data', (chunk) => console.error(`[daemon] ${chunk}`));
  daemonProcess.on('exit', (code) => {
    console.log(`daemon exited: ${code}`);
    daemonProcess = null;
    if (!isQuitting && !daemonStoppedByUser) {
      daemonRestartTimer = setTimeout(() => {
        daemonRestartTimer = undefined;
        startDaemon();
        loadAppWhenDaemonReady();
      }, 1800);
    }
  });
}

function stopDaemon() {
  daemonStoppedByUser = true;
  if (daemonRestartTimer) {
    clearTimeout(daemonRestartTimer);
    daemonRestartTimer = undefined;
  }
  if (!daemonProcess) return;
  daemonProcess.kill();
  daemonProcess = null;
}

function restartDaemon() {
  stopDaemon();
  daemonStoppedByUser = false;
  startDaemon();
  loadLoadingPage('正在重启本地服务');
  loadAppWhenDaemonReady();
  updateTrayMenu();
}

function daemonStatus() {
  return {
    running: Boolean(daemonProcess),
    stoppedByUser: daemonStoppedByUser,
    port: daemonPort(),
    url: daemonUrl(),
  };
}

function relayMenuLabel() {
  if (daemonStoppedByUser) return 'daemon 已停止';
  if (!daemonProcess) return 'daemon 启动中';
  if (lastRelayStatus?.connected) {
    return `WSS 已连接${lastRelayStatus.username ? ` · ${lastRelayStatus.username}` : ''}`;
  }
  if (lastRelayStatus?.state === 'retrying') return 'WSS 重试中';
  if (lastRelayStatus?.state === 'connecting') return 'WSS 连接中';
  if (lastRelayStatus?.state === 'missing_token') return 'WSS 未登录';
  if (lastRelayStatus?.last_error) return 'WSS 连接失败';
  return 'daemon 运行中';
}

function refreshTrayRelayStatus() {
  if (trayStatusRefreshing || daemonStoppedByUser || !daemonProcess) return;
  trayStatusRefreshing = true;
  const req = http.get(`${daemonUrl()}/v1/relay/status`, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      trayStatusRefreshing = false;
      try {
        lastRelayStatus = JSON.parse(body);
      } catch {
        lastRelayStatus = undefined;
      }
      updateTrayMenu(false);
    });
  });
  req.on('error', () => {
    trayStatusRefreshing = false;
    lastRelayStatus = undefined;
  });
  req.setTimeout(900, () => {
    req.destroy();
    trayStatusRefreshing = false;
  });
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function requestJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(parsed, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let data = body;
        try {
          data = body ? JSON.parse(body) : null;
        } catch {
          // Surface the raw response below when the server does not return JSON.
        }
        if ((res.statusCode || 0) >= 400) {
          const message =
            data && typeof data === 'object' && typeof data.error === 'string'
              ? data.error
              : data && typeof data === 'object' && typeof data.message === 'string'
                ? data.message
                : body || `HTTP ${res.statusCode}`;
          reject(new Error(message));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(options.timeoutMs || 7000, () => req.destroy(new Error('请求用量接口超时')));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function usageWidgetAuthHeaders() {
  const relayState = readRelayState();
  const key = relayState.session?.token || desktopPreferences.usageWidget?.managementKey || '';
  return key
    ? {
        Authorization: `Bearer ${key}`,
        'X-Management-Key': key,
      }
    : {};
}

function usageWidgetEndpoint(pathname) {
  const relayState = readRelayState();
  const base = normalizeManagementBaseUrl(relayState.session?.apiBase || desktopPreferences.usageWidget?.backendBaseUrl);
  return `${base}${pathname}`;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(value) {
  const number = numberOrNull(value);
  if (number === null) return '-';
  const formatted =
    Math.abs(number) >= 100
      ? number.toFixed(1)
      : Math.abs(number) >= 10
        ? number.toFixed(2)
        : number.toFixed(3).replace(/0+$/g, '').replace(/\.$/g, '');
  return `$${formatted}`;
}

function moneyHTML(value) {
  return escapeHTML(value || '');
}

function buildUsageWidgetState(subscription) {
  const quotaMode = String(subscription?.quotaMode || '').toLowerCase();
  const dailyUsed = numberOrNull(subscription?.dailyUsed) || 0;
  const totalUsed = numberOrNull(subscription?.totalUsed) || 0;
  const dailyQuota = numberOrNull(subscription?.dailyQuota);
  const totalQuota = numberOrNull(subscription?.totalQuota);
  const limitedByTotal = quotaMode === 'total' || (dailyQuota === null && totalQuota !== null);
  const used = limitedByTotal ? totalUsed : dailyUsed;
  const limit = limitedByTotal ? totalQuota : dailyQuota;
  const remaining = limit === null ? null : Math.max(0, limit - used);
  const percent = limit && limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;
  return {
    ok: true,
    planName: subscription?.planName || '订阅卡',
    quotaMode: limitedByTotal ? 'total' : 'daily',
    todayUsed: dailyUsed,
    used,
    limit,
    remaining,
    percent,
    endsAt: subscription?.endsAt || '',
    updatedAt: new Date().toISOString(),
  };
}

async function fetchUsageWidgetState() {
  const prefs = desktopPreferences.usageWidget || {};
  const relayState = readRelayState();
  if (!relayState.session?.token && !prefs.managementKey) {
    return {
      ok: false,
      message: '请先登录中转站账号',
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    const subscription = await requestJSON(usageWidgetEndpoint('/v0/management/subscription/me'), {
      headers: usageWidgetAuthHeaders(),
      timeoutMs: 7000,
    });
    return buildUsageWidgetState(subscription);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '用量接口请求失败',
      updatedAt: new Date().toISOString(),
    };
  }
}

function usageWidgetHTML(state) {
  const updated = state.updatedAt ? new Date(state.updatedAt) : new Date();
  const updatedText = Number.isNaN(updated.getTime())
    ? ''
    : updated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const percent = Number.isFinite(state.percent) ? state.percent : 0;
  const remaining = state.remaining === null || state.remaining === undefined ? '不限' : money(state.remaining);
  const used = state.quotaMode === 'total' ? money(state.used) : money(state.todayUsed ?? state.used);
  const limit = state.limit === null || state.limit === undefined ? '不限' : money(state.limit);
  const title = state.ok ? '至纯 Token' : '用量不可用';
  const subtitle = state.ok
    ? state.quotaMode === 'total' ? '总额度进度' : '每日用量进度'
    : escapeHTML(state.message || '无法读取 CLIProxyAPI');
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Usage Widget</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: transparent;
    color: #182235;
    font: 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    -webkit-user-select: none;
  }
  .widget {
    width: 100vw;
    height: 100vh;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto auto;
    gap: 4px;
    padding: 16px 14px 12px;
    border: 1px solid rgba(94, 108, 130, 0.12);
    border-radius: 18px;
    background: rgba(239, 242, 252, 0.94);
    box-shadow: 0 16px 34px rgba(76, 94, 128, 0.16);
    backdrop-filter: blur(30px) saturate(1.35);
    -webkit-app-region: drag;
  }
  .top { display: flex; align-items: start; justify-content: space-between; gap: 10px; min-width: 0; }
  .title { min-width: 0; }
  .title strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 20px; line-height: 1.08; font-weight: 820; }
  .title span { display: block; margin-top: 6px; color: #516075; font-size: 11px; line-height: 1.15; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
  .badge { min-width: 54px; height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 0 12px; border-radius: 999px; background: rgba(39, 145, 103, 0.11); color: #27835d; font-size: 16px; font-weight: 820; }
  .bolt { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border-radius: 11px; background: #c9f4e5; color: #238365; }
  .bolt svg { width: 15px; height: 15px; display: block; fill: currentColor; }
  .numbers { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 12px; align-items: end; min-height: 54px; }
  .number { min-width: 0; }
  .number.secondary { text-align: right; padding-bottom: 2px; }
  .number span { display: block; color: #526278; font-size: 10px; font-weight: 760; }
  .number strong { display: block; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 20px; line-height: 1; letter-spacing: 0; font-weight: 820; font-variant-numeric: tabular-nums; }
  .number.primary strong { font-size: 34px; }
  .meter { display: grid; gap: 6px; }
  .bar { height: 7px; overflow: hidden; border-radius: 999px; background: #dbe4f4; }
  .fill { width: ${percent.toFixed(2)}%; height: 100%; border-radius: inherit; background: #0d8063; box-shadow: 0 0 0 1px rgba(13, 128, 99, 0.04); }
  .foot { display: flex; justify-content: space-between; gap: 8px; color: #5a6678; font-size: 10px; font-weight: 760; line-height: 1.2; }
  .error { align-self: center; color: #9b332d; line-height: 1.35; }
  @media (prefers-color-scheme: dark) {
    body { color: #eef2ef; }
    .widget { border-color: rgba(75, 122, 177, 0.14); background: rgba(13, 20, 36, 0.93); box-shadow: 0 16px 34px rgba(0, 0, 0, 0.34); }
    .title span, .number span, .foot { color: #90a0b8; }
    .badge { background: rgba(90, 215, 255, 0.14); color: #80dcff; box-shadow: inset 0 0 0 1px rgba(128, 220, 255, 0.16); }
    .bolt { background: rgba(90, 215, 255, 0.14); color: #80dcff; box-shadow: inset 0 0 0 1px rgba(128, 220, 255, 0.16); }
    .bar { background: rgba(85, 99, 124, 0.28); }
    .fill { background: #7fe7ff; box-shadow: 0 0 12px rgba(127, 231, 255, 0.22); }
    .error { color: #ff9b92; }
  }
</style>
<body>
  <main class="widget">
    <div class="top">
      <div class="title"><strong>${title}</strong><span>${subtitle}</span></div>
      <div class="actions"><div class="badge">${state.ok ? `${Math.round(percent)}%` : '离线'}</div><div class="bolt"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.4 2.6 6.8 12h4.6l-1 8.8 6.8-10h-4.7l.9-8.2Z"/></svg></div></div>
    </div>
    ${
      state.ok
        ? `<section class="numbers">
            <div class="number primary"><span>剩余</span><strong>${moneyHTML(remaining)}</strong></div>
            <div class="number secondary"><span>已用</span><strong>${moneyHTML(used)}</strong></div>
          </section>
          <div class="meter"><div class="bar"><div class="fill"></div></div></div>`
        : `<div class="error">${escapeHTML(state.message || '无法读取用量')}</div>`
    }
    <div class="foot"><span>预算: ${escapeHTML(limit)}</span><span>${escapeHTML(updatedText)}</span></div>
  </main>
</body>
</html>`;
}

function positionUsageWidgetWindow() {
  if (!usageWidgetWindow || usageWidgetWindow.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const [width, height] = usageWidgetWindow.getSize();
  usageWidgetWindow.setPosition(area.x + area.width - width - 18, area.y + 18, false);
}

function createUsageWidgetWindow() {
  if (process.platform !== 'darwin') return null;
  if (usageWidgetWindow && !usageWidgetWindow.isDestroyed()) return usageWidgetWindow;
  usageWidgetWindow = new BrowserWindow({
    width: 306,
    height: 164,
    minWidth: 280,
    minHeight: 150,
    resizable: false,
    movable: true,
    frame: false,
    transparent: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    focusable: false,
    hasShadow: false,
    title: 'Codex Usage Widget',
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  usageWidgetWindow.setAlwaysOnTop(false);
  usageWidgetWindow.on('closed', () => {
    usageWidgetWindow = undefined;
  });
  positionUsageWidgetWindow();
  return usageWidgetWindow;
}

async function refreshUsageWidget() {
  if (usageWidgetRefreshing || process.platform !== 'darwin') return null;
  usageWidgetRefreshing = true;
  try {
    const state = await fetchUsageWidgetState();
    const win = createUsageWidgetWindow();
    if (!win || win.isDestroyed()) return state;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(usageWidgetHTML(state))}`);
    if (desktopPreferences.usageWidget?.enabled && !win.isVisible()) {
      positionUsageWidgetWindow();
      win.showInactive();
    }
    return state;
  } finally {
    usageWidgetRefreshing = false;
  }
}

function syncUsageWidgetState() {
  if (usageWidgetTimer) {
    clearInterval(usageWidgetTimer);
    usageWidgetTimer = undefined;
  }
  const prefs = desktopPreferences.usageWidget || {};
  if (process.platform !== 'darwin' || !prefs.enabled) {
    if (usageWidgetWindow && !usageWidgetWindow.isDestroyed()) usageWidgetWindow.hide();
    return;
  }
  void refreshUsageWidget();
  usageWidgetTimer = setInterval(() => {
    void refreshUsageWidget();
  }, normalizeUsageWidgetIntervalMinutes(prefs.updateIntervalMinutes) * 60 * 1000);
}

function waitForDaemon(timeoutMs = 12000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(`${daemonUrl()}/health`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('daemon did not become ready'));
          return;
        }
        setTimeout(check, 300);
      });
      req.setTimeout(1000, () => req.destroy());
    };
    check();
  });
}

function loadingHTML(message = '正在启动本地监听服务') {
  const escaped = String(message).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Session Bridge</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    height: 100vh;
    display: grid;
    place-items: center;
    background: #f5f5f7;
    color: #1d1d1f;
    font: 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  }
  .panel { display: grid; gap: 10px; place-items: center; }
  .mark {
    width: 34px; height: 34px; border-radius: 12px;
    display: grid; place-items: center;
    background: rgba(63, 83, 76, 0.09);
    color: #53665f; font-size: 18px;
  }
  strong { font-size: 14px; }
  span { color: #6e6e73; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1c1e; color: #f5f5f7; }
    .mark { background: rgba(255,255,255,0.08); color: #d7dfdb; }
    span { color: #98989d; }
  }
</style>
<body><div class="panel"><div class="mark">Z</div><strong>Codex Bridge</strong><span>${escaped}</span></div></body>
</html>`;
}

function loadLoadingPage(message) {
  if (!mainWindow) return;
  loadURLIfChanged(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHTML(message))}`);
}

function loadURLIfChanged(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const currentURL = mainWindow.webContents.getURL();
  if (currentURL && normalizeWindowURL(currentURL) === normalizeWindowURL(url)) return;
  mainWindow.loadURL(url);
}

function normalizeWindowURL(value) {
  try {
    return new URL(value).toString();
  } catch {
    return String(value || '');
  }
}

function loadAppWhenDaemonReady() {
  if (!mainWindow) return;
  if (!app.isPackaged) {
    loadURLIfChanged(devUrl);
    return;
  }
  clearTimeout(daemonLoadTimer);
  waitForDaemon(180000)
    .then(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      loadURLIfChanged(daemonUrl());
    })
    .catch((error) => {
      console.error(error);
      loadLoadingPage('本地服务仍在启动，正在重试');
      daemonLoadTimer = setTimeout(loadAppWhenDaemonReady, 2000);
    });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 500,
    minWidth: 500,
    minHeight: 360,
    title: 'Codex Session Bridge',
    backgroundColor: '#f5f5f7',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loadLoadingPage();
  mainWindow.webContents.on('did-fail-load', (_event, _code, _description, validatedURL) => {
    if (app.isPackaged && validatedURL.startsWith(daemonUrl())) {
      loadLoadingPage('页面加载失败，正在重新连接本地服务');
      daemonLoadTimer = setTimeout(loadAppWhenDaemonReady, 1000);
    }
  });
  loadAppWhenDaemonReady();
  mainWindow.on('close', (event) => {
    if (desktopPreferences.closeToTray && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function firstExistingPath(candidates) {
  return candidates.find((candidate) => {
    try {
      return candidate && fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function trayIconImage() {
  const iconPath = firstExistingPath([
    app.isPackaged ? path.join(process.resourcesPath, 'web', 'dist', 'logo.png') : '',
    app.isPackaged ? path.join(app.getAppPath(), 'web', 'dist', 'logo.png') : '',
    path.join(app.getAppPath(), 'web', 'public', 'logo.png'),
    path.join(process.resourcesPath || '', 'icon.icns'),
  ]);
  let image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(path.join(app.getAppPath(), 'web', 'dist', 'logo.png'));
  }
  image = image.resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') {
    image.setTemplateImage(true);
  }
  return image;
}

function createTray() {
  tray = new Tray(trayIconImage());
  tray.setToolTip('Codex Session Bridge');
  updateTrayMenu();
}

function updateTrayMenu(refreshStatus = true) {
  if (!tray) return;
  const relayLabel = relayMenuLabel();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: relayLabel, enabled: false },
      { type: 'separator' },
      { label: '打开面板', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      {
        label: desktopPreferences.usageWidget?.enabled ? '隐藏用量小组件' : '显示用量小组件',
        visible: process.platform === 'darwin',
        click: () => {
          desktopPreferences.usageWidget = normalizeUsageWidgetPreferences({
            ...desktopPreferences.usageWidget,
            enabled: !desktopPreferences.usageWidget?.enabled,
          });
          writeDesktopPreferences();
          syncUsageWidgetState();
          updateTrayMenu(false);
        },
      },
      {
        label: '刷新用量小组件',
        visible: process.platform === 'darwin',
        enabled: Boolean(desktopPreferences.usageWidget?.enabled),
        click: () => { void refreshUsageWidget(); },
      },
      { label: '启动 daemon', enabled: !daemonProcess, click: () => { daemonStoppedByUser = false; startDaemon(); loadAppWhenDaemonReady(); updateTrayMenu(); } },
      { label: '停止 daemon', enabled: Boolean(daemonProcess), click: () => { stopDaemon(); loadLoadingPage('本地服务已停止'); updateTrayMenu(); } },
      { label: '重启 daemon', click: restartDaemon },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit(); } },
    ]),
  );
  if (refreshStatus) refreshTrayRelayStatus();
}

function compareVersions(left, right) {
  const a = String(left || '0').replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right || '0').replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return 1;
    if ((a[index] || 0) < (b[index] || 0)) return -1;
  }
  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Codex-Session-Bridge/${app.getVersion()}`,
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if ((res.statusCode || 0) >= 400) {
          let message = `GitHub 返回 ${res.statusCode || '错误状态'}`;
          try {
            const data = JSON.parse(body);
            if (typeof data.message === 'string' && data.message.toLowerCase().includes('rate limit')) {
              message = 'GitHub API 限流，请稍后再试';
            }
          } catch {
            // Keep the HTTP status message.
          }
          const error = new Error(message);
          error.statusCode = res.statusCode;
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(7000, () => req.destroy(new Error('检查更新超时')));
  });
}

async function checkGithubUpdates() {
  const currentVersion = app.getVersion();
  try {
    const release = await fetchJson(`https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`);
    const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '') || currentVersion;
    const releaseUrl = release.html_url || githubReleasesUrl;
    return {
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl,
    };
  } catch (error) {
    const isRateLimited = error?.statusCode === 403 || String(error?.message || '').includes('限流');
    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      releaseUrl: githubReleasesUrl,
      error: isRateLimited ? '' : error instanceof Error ? error.message : '检查更新失败',
      message: isRateLimited ? 'GitHub API 限流，可打开 Releases 页面查看' : undefined,
    };
  }
}

async function openPrivacySettings() {
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    return { opened: true, target: 'macos-full-disk-access' };
  }
  if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:privacy-broadfilesystemaccess');
    return { opened: true, target: 'windows-filesystem-access' };
  }
  return { opened: false, target: process.platform };
}

async function chooseProjectFolder() {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Codex 项目文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return { path: result.filePaths[0] };
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function codexDesktopRunning() {
  if (process.platform === 'darwin') {
    const result = await execFileAsync('osascript', ['-e', 'application "Codex" is running']);
    return String(result.stdout || '').trim() === 'true';
  }
  if (process.platform === 'win32') {
    try {
      const result = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', 'if (Get-Process -Name Codex -ErrorAction SilentlyContinue) { "true" } else { "false" }']);
      return String(result.stdout || '').trim() === 'true';
    } catch {
      return false;
    }
  }
  return false;
}

async function restartCodexDesktopIfRunning() {
  const status = {
    wasRunning: false,
    restarted: false,
    skipped: true,
    error: '',
  };
  try {
    status.wasRunning = await codexDesktopRunning();
    if (!status.wasRunning) return status;
    status.skipped = false;
    if (process.platform === 'darwin') {
      await execFileAsync('osascript', ['-e', 'tell application "Codex" to quit']);
      await new Promise((resolve) => setTimeout(resolve, 900));
      await execFileAsync('open', ['-a', 'Codex']);
      status.restarted = true;
      return status;
    }
    if (process.platform === 'win32') {
      await execFileAsync('powershell.exe', ['-NoProfile', '-Command', 'Stop-Process -Name Codex -ErrorAction SilentlyContinue']);
      const codexApp = process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Codex', 'Codex.exe')
        : '';
      if (codexApp && fs.existsSync(codexApp)) {
        spawn(codexApp, [], { detached: true, stdio: 'ignore' }).unref();
        status.restarted = true;
      } else {
        status.error = '未找到 Codex 桌面端安装路径';
      }
      return status;
    }
    status.error = `${process.platform} 暂不支持自动重启 Codex 桌面端`;
    return status;
  } catch (error) {
    status.error = error instanceof Error ? error.message : '重启 Codex 桌面端失败';
    return status;
  }
}

function updateModelUnlockStatus(patch) {
  modelUnlockStatus = {
    ...modelUnlockStatus,
    debugPort: modelUnlockDebugPort,
    ...patch,
  };
  return modelUnlockStatus;
}

function uniqueNumbers(values) {
  return Array.from(new Set(values.filter((value) => Number.isInteger(value) && value >= 1024 && value <= 65535)));
}

function modelUnlockPortCandidates() {
  return uniqueNumbers([
    modelUnlockStatus.debugPort,
    modelUnlockDebugPort,
    normalizeDebugPort(process.env.CSB_CODEX_MODEL_DEBUG_PORT || process.env.CSB_CODEX_PLUGIN_DEBUG_PORT || '9229'),
    ...Array.from({ length: 20 }, (_, index) => 9230 + index),
    ...Array.from({ length: 20 }, (_, index) => 19329 + index),
  ]);
}

function isLoopbackPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function resolveModelUnlockDebugPort() {
  for (const port of modelUnlockPortCandidates()) {
    try {
      await currentCodexCdpTarget(port);
      modelUnlockDebugPort = port;
      updateModelUnlockStatus({ debugPort: port });
      return port;
    } catch {
      // The port is either closed or not a usable Codex CDP endpoint.
    }
    if (await isLoopbackPortAvailable(port)) {
      modelUnlockDebugPort = port;
      updateModelUnlockStatus({ debugPort: port });
      return port;
    }
  }
  throw new Error('没有找到可用的 Codex 调试端口，请关闭占用 9229/9230 附近端口的进程后重试');
}

function httpGetJson(url, timeoutMs = 1400) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if ((res.statusCode || 0) >= 400) {
          reject(new Error(`CDP 返回 ${res.statusCode || '错误状态'}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('连接 Codex 调试端口超时')));
  });
}

async function listCdpTargets(port) {
  const targets = await httpGetJson(`http://127.0.0.1:${port}/json`);
  return Array.isArray(targets) ? targets : [];
}

function pickCodexCdpTarget(targets) {
  const pages = targets.filter((target) => (
    target?.type === 'page'
    && typeof target.webSocketDebuggerUrl === 'string'
    && target.webSocketDebuggerUrl.trim()
  ));
  return pages.find((target) => `${target.title || ''} ${target.url || ''}`.toLowerCase().includes('codex')) || pages[0] || null;
}

async function waitForCodexCdpTarget(port, timeoutMs = 45000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const target = pickCodexCdpTarget(await listCdpTargets(port));
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const detail = lastError instanceof Error ? `：${lastError.message}` : '';
  throw new Error(`连接 Codex 调试端口 ${port} 超时${detail}。请确认 Codex 已完全退出后重试，或检查该端口是否被其它程序占用。`);
}

async function currentCodexCdpTarget(port) {
  const target = pickCodexCdpTarget(await listCdpTargets(port));
  if (!target) throw new Error('未找到可注入的 Codex 页面');
  return target;
}

function resolveCodexDesktopExecutable() {
  return firstExistingPath([
    process.env.CSB_CODEX_DESKTOP,
    process.platform === 'darwin' ? '/Applications/Codex.app' : '',
    process.platform === 'darwin' && process.env.HOME ? path.join(process.env.HOME, 'Applications', 'Codex.app') : '',
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Codex', 'Codex.exe')
      : '',
  ]);
}

function resolveInjectorBin() {
  const name = process.platform === 'win32' ? 'csb-injector.exe' : 'csb-injector';
  return firstExistingPath([
    process.env.CSB_INJECTOR_BIN,
    app.isPackaged ? path.join(process.resourcesPath, 'bin', name) : '',
    path.join(app.getAppPath(), 'dist', 'bin', name),
    path.join(__dirname, '..', 'dist', 'bin', name),
  ]);
}

async function readModelUnlockModelCatalog() {
  try {
    return await httpGetJson(`${daemonUrl()}/v1/codex/model-catalog`, 12000);
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
      model: '',
      default_model: '',
      model_provider: '',
      provider_name: '',
      models: [],
    };
  }
}

async function writeModelUnlockScript() {
  const scriptPath = path.join(app.getPath('userData'), 'model-unlock.js');
  const modelCatalog = await readModelUnlockModelCatalog();
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, modelUnlockScript(modelCatalog), { mode: 0o600 });
  return scriptPath;
}

function parseInjectorResult(raw) {
  try {
    return JSON.parse(String(raw || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
  } catch {
    return null;
  }
}

async function runRustInjector(port) {
  const injector = resolveInjectorBin();
  if (!injector) return null;
  const scriptPath = await writeModelUnlockScript();
  const args = [
    '--debug-port', String(port || modelUnlockDebugPort),
    '--daemon-url', daemonUrl(),
    '--script-path', scriptPath,
    '--timeout-ms', '45000',
  ];
  const codexApp = resolveCodexDesktopExecutable();
  if (codexApp) args.push('--app-path', codexApp);
  try {
    const result = await execFileAsync(injector, args, {
      timeout: 70000,
      env: { ...process.env, PATH: mergePath(process.env.PATH, commonShellPath) },
    });
    return parseInjectorResult(result.stdout) || {
      status: 'ok',
      injected: true,
      message: '模型白名单解锁已注入',
    };
  } catch (error) {
    const parsed = parseInjectorResult(error?.stdout);
    if (parsed) return parsed;
    throw error;
  }
}

async function quitCodexDesktop() {
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('osascript', ['-e', 'tell application "Codex" to quit']);
    } catch {
      // Codex may not be running yet.
    }
    const started = Date.now();
    while (Date.now() - started < 10000) {
      try {
        if (!(await codexDesktopRunning())) break;
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return;
  }
  if (process.platform === 'win32') {
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-Command', 'Stop-Process -Name Codex -ErrorAction SilentlyContinue']);
    } catch {
      // Codex may not be running yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
}

async function launchCodexWithDebugPort(port) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  ];
  const codexApp = resolveCodexDesktopExecutable();
  if (process.platform === 'darwin') {
    await quitCodexDesktop();
    const openArgs = codexApp && codexApp.endsWith('.app')
      ? ['-n', codexApp, '--args', ...args]
      : ['-n', '-a', codexApp || 'Codex', '--args', ...args];
    await execFileAsync('open', openArgs);
    return;
  }
  if (process.platform === 'win32') {
    await quitCodexDesktop();
    if (!codexApp) throw new Error('未找到 Codex 桌面端安装路径');
    spawn(codexApp, args, { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  throw new Error(`${process.platform} 暂不支持自动启动 Codex 桌面端模型解锁`);
}

function modelUnlockScript(initialModelCatalog = null) {
  const modelCatalogUrl = `${daemonUrl()}/v1/codex/model-catalog`;
  return `
(() => {
  const config = ${JSON.stringify({
    modelWhitelistUnlock: true,
    modelCatalogUrl,
    initialModelCatalog,
  })};
  let modelCatalog = (config.initialModelCatalog && typeof config.initialModelCatalog === "object")
    ? config.initialModelCatalog
    : { status: "loading", model: "", default_model: "", model_provider: "", provider_name: "", models: [] };
  let modelCatalogPromise = null;
  let modelCatalogLoadedAt = modelCatalog?.models?.length ? Date.now() : 0;
  const modelRequestPatchVersion = "4";
  const appModulePromises = new Map();
  const modelListRequestIds = new Set();

  function uniqueValues(values) {
    return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0)));
  }

  function modelUnlockEnabled() {
    return !!config.modelWhitelistUnlock;
  }

  function modelNames() {
    return uniqueValues([
      modelCatalog.default_model,
      modelCatalog.model,
      ...(Array.isArray(modelCatalog.models) ? modelCatalog.models : []),
    ]);
  }

  async function loadModelCatalog(force = false) {
    if (!modelUnlockEnabled() || !config.modelCatalogUrl) return modelCatalog;
    if (!force && modelCatalogPromise) return modelCatalogPromise;
    if (!force && modelCatalogLoadedAt && Date.now() - modelCatalogLoadedAt < 10000) return modelCatalog;
    modelCatalogPromise = fetch(config.modelCatalogUrl, { headers: { "Accept": "application/json" } })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("model catalog HTTP " + response.status)))
      .then((result) => {
        modelCatalog = result && typeof result === "object" ? result : { status: "failed", model: "", default_model: "", model_provider: "", provider_name: "", models: [] };
        window.__csbModelCatalog = modelCatalog;
        modelCatalogLoadedAt = Date.now();
        installModelUnlockPatches();
        return modelCatalog;
      })
      .catch((error) => {
        if (!modelNames().length) {
          modelCatalog = { status: "failed", message: String(error?.message || error), model: "", default_model: "", model_provider: "", provider_name: "", models: [] };
        } else {
          modelCatalog = { ...modelCatalog, status: modelCatalog.status || "ok", message: String(error?.message || error) };
        }
        window.__csbModelCatalog = modelCatalog;
        modelCatalogLoadedAt = Date.now();
        return modelCatalog;
      })
      .finally(() => {
        modelCatalogPromise = null;
      });
    return modelCatalogPromise;
  }

  function modelReasoningEfforts() {
    return ["minimal", "low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort + " effort" }));
  }

  function modelDescriptor(modelName) {
    return {
      model: modelName,
      id: modelName,
      slug: modelName,
      name: modelName,
      displayName: modelName,
      label: modelName,
      title: modelName,
      description: modelCatalog.provider_name || modelCatalog.model_provider || "Custom model",
      hidden: false,
      disabled: false,
      enabled: true,
      available: true,
      supported: true,
      isAvailable: true,
      isHidden: false,
      isDisabled: false,
      isDefault: (modelCatalog.default_model || modelCatalog.model) === modelName,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: modelReasoningEfforts(),
      capabilities: { text: true, tools: true, reasoning: true },
    };
  }

  function modelNameFromItem(item) {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    return item.model || item.id || item.slug || item.name || item.displayName || "";
  }

  function patchModelItem(item) {
    if (!item || typeof item !== "object") return item;
    item.hidden = false;
    item.isHidden = false;
    item.disabled = false;
    item.isDisabled = false;
    item.enabled = true;
    item.available = true;
    item.supported = true;
    item.isAvailable = true;
    const name = modelNameFromItem(item);
    if (name) {
      if (!item.model) item.model = name;
      if (!item.id) item.id = name;
      if (!item.slug) item.slug = name;
      if (!item.name) item.name = name;
      if (!item.displayName) item.displayName = name;
      if (!item.label) item.label = name;
      if (!item.title) item.title = name;
    }
    if (!item.supportedReasoningEfforts) item.supportedReasoningEfforts = modelReasoningEfforts();
    if (!item.defaultReasoningEffort) item.defaultReasoningEffort = "medium";
    if (!item.capabilities) item.capabilities = { text: true, tools: true, reasoning: true };
    return item;
  }

  function patchModelNameArray(models) {
    if (!Array.isArray(models) || !models.every((item) => typeof item === "string")) return false;
    const names = modelNames();
    if (!names.length) return false;
    let changed = false;
    names.forEach((name) => {
      if (!models.includes(name)) {
        models.push(name);
        changed = true;
      }
    });
    return changed;
  }

  function patchModelArray(models, allowEmpty = false) {
    if (!Array.isArray(models) || (!allowEmpty && models.length === 0)) return false;
    const names = modelNames();
    if (!names.length) return false;
    if (models.every((item) => typeof item === "string")) return patchModelNameArray(models);
    if (!models.every((item) => item && typeof item === "object")) return false;
    let changed = false;
    const existing = new Map(models.map((item) => [modelNameFromItem(item), item]).filter(([name]) => !!name));
    models.forEach((item) => {
      if (names.includes(modelNameFromItem(item))) {
        patchModelItem(item);
        changed = true;
      }
    });
    names.forEach((name) => {
      if (!existing.has(name)) {
        models.push(modelDescriptor(name));
        changed = true;
      }
    });
    return changed;
  }

  function patchArrayFilterForModels() {
    if (window.__csbModelArrayFilterPatchInstalled === "1") return;
    window.__csbModelArrayFilterPatchInstalled = "1";
    const originalFilter = Array.prototype.filter;
    Array.prototype.filter = function csbModelSafeFilter(...args) {
      const result = originalFilter.apply(this, args);
      try {
        if (!modelUnlockEnabled()) return result;
        const names = modelNames();
        if (!names.length || !Array.isArray(result)) return result;
        const sourceItems = Array.from(this);
        const sourceNames = sourceItems.map(modelNameFromItem).filter(Boolean);
        if (!sourceNames.length || !sourceNames.some((name) => names.includes(name))) return result;
        const resultNames = new Set(result.map(modelNameFromItem).filter(Boolean));
        sourceItems.forEach((item) => {
          const name = modelNameFromItem(item);
          if (!names.includes(name) || resultNames.has(name)) return;
          result.push(patchModelItem(item));
          resultNames.add(name);
        });
      } catch {
      }
      return result;
    };
  }

  function appAssetUrl(namePart) {
    const urls = [
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map((link) => link.href),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].filter(Boolean);
    return urls.find((url) => url.includes("/assets/") && url.includes(namePart) && url.split("?")[0].endsWith(".js")) || "";
  }

  async function findAppAssetUrl(namePart) {
    const direct = appAssetUrl(namePart);
    if (direct) return direct;
    const bases = [
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].filter((url) => url && url.includes("/assets/") && url.split("?")[0].endsWith(".js"));
    const baseUrl = bases[0] || "app://-/assets/index.js";
    const knownAssets = namePart === "app-server-manager-signals-"
      ? ["app-server-manager-signals-7MlBpIlX.js"]
      : [];
    for (const sourceUrl of bases.slice(0, 8)) {
      try {
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timeout = controller ? setTimeout(() => controller.abort(), 900) : null;
        const text = await fetch(sourceUrl, controller ? { signal: controller.signal } : undefined)
          .then((response) => response.ok ? response.text() : "")
          .finally(() => {
            if (timeout) clearTimeout(timeout);
          });
        if (!text) continue;
        const index = text.indexOf(namePart);
        if (index < 0) continue;
        const match = text.slice(index).match(/^[A-Za-z0-9_.-]+\\.js/);
        if (match?.[0]) return new URL(match[0], sourceUrl).href;
      } catch {
      }
    }
    for (const assetName of knownAssets) {
      try {
        return new URL(assetName, baseUrl).href;
      } catch {
      }
    }
    return "";
  }

  async function loadAppModule(namePart) {
    if (!appModulePromises.has(namePart)) {
      const promise = Promise.resolve().then(async () => {
        const url = await findAppAssetUrl(namePart);
        if (!url) throw new Error("未找到 Codex App asset: " + namePart);
        return await import(url);
      }).catch((error) => {
        appModulePromises.delete(namePart);
        throw error;
      });
      appModulePromises.set(namePart, promise);
    }
    return await appModulePromises.get(namePart);
  }

  function patchModelContainer(value) {
    if (!value || typeof value !== "object") return false;
    let changed = false;
    if (patchModelArray(value.models, "defaultModel" in value || "availableModels" in value)) changed = true;
    if (patchModelNameArray(value.models)) changed = true;
    if (patchModelArray(value.data)) changed = true;
    if (patchModelArray(value.result)) changed = true;
    if (patchModelArray(value.pages?.[0]?.data)) changed = true;
    if (patchModelArray(value.result?.data)) changed = true;
    if (patchModelArray(value.result?.models)) changed = true;
    if (patchModelArray(value.message?.result?.data)) changed = true;
    if (patchModelArray(value.message?.result?.models)) changed = true;
    const names = modelNames();
    for (const key of ["availableModels", "available_models"]) {
      if (value[key] instanceof Set) {
        names.forEach((name) => {
          if (!value[key].has(name)) {
            value[key].add(name);
            changed = true;
          }
        });
      } else if (Array.isArray(value[key])) {
        names.forEach((name) => {
          if (!value[key].includes(name)) {
            value[key].push(name);
            changed = true;
          }
        });
      }
    }
    for (const key of ["hiddenModels", "hidden_models"]) {
      if (Array.isArray(value[key])) {
        const before = value[key].length;
        value[key] = value[key].filter((name) => !names.includes(name));
        if (value[key].length !== before) changed = true;
      }
    }
    for (const key of ["disabledModels", "disabled_models", "unsupportedModels", "unsupported_models"]) {
      if (Array.isArray(value[key])) {
        const before = value[key].length;
        value[key] = value[key].filter((name) => !names.includes(name));
        if (value[key].length !== before) changed = true;
      }
    }
    if (value.defaultModel == null && names.length > 0) {
      value.defaultModel = modelDescriptor(names[0]);
      changed = true;
    } else if (typeof value.defaultModel === "string" && names.includes(value.defaultModel) && value.model == null) {
      value.model = value.defaultModel;
      changed = true;
    }
    return changed;
  }

  function patchObjectGraphForModels(root, visited, depth = 0) {
    if (!root || typeof root !== "object" || visited.has(root) || depth > 5) return false;
    visited.add(root);
    let changed = patchModelContainer(root);
    if (patchAppServerModelRequestClient(root)) changed = true;
    if (patchAppServerListModelsClient(root)) changed = true;
    if (root instanceof Element || root === window || root === document || root === document.body || root === document.documentElement) return changed;
    for (const key of Object.keys(root)) {
      if (key === "ownerDocument" || key === "parentElement" || key === "parentNode" || key === "children" || key === "childNodes") continue;
      let value;
      try {
        value = root[key];
      } catch {
        continue;
      }
      if (value && typeof value === "object" && patchObjectGraphForModels(value, visited, depth + 1)) changed = true;
    }
    return changed;
  }

  function payloadMayContainModelData(root, visited = new WeakSet(), depth = 0) {
    if (!root || typeof root !== "object" || visited.has(root) || depth > 4) return false;
    visited.add(root);
    if (Array.isArray(root)) {
      return root.some((item) => (
        (item && typeof item === "object" && typeof item.model === "string")
        || payloadMayContainModelData(item, visited, depth + 1)
      ));
    }
    const keys = Object.keys(root);
    if (keys.some((key) => /^(models|availableModels|available_models|hiddenModels|hidden_models|disabledModels|disabled_models|unsupportedModels|unsupported_models|defaultModel|default_model)$/i.test(key))) {
      return true;
    }
    if (typeof root.model === "string" && (typeof root.id === "string" || typeof root.name === "string" || typeof root.displayName === "string")) {
      return true;
    }
    return keys.slice(0, 30).some((key) => payloadMayContainModelData(root[key], visited, depth + 1));
  }

  function responseUrlMayContainModelData(response) {
    const url = String(response?.url || "");
    return /\\/models?\\b|model-list|available-model|dynamic_config|statsig|app-server/i.test(url);
  }

  async function patchModelJsonResponse(payload, response = null) {
    if (!modelUnlockEnabled()) return payload;
    if (!payload || typeof payload !== "object") return payload;
    if (!responseUrlMayContainModelData(response) && !payloadMayContainModelData(payload)) return payload;
    if (!modelNames().length) await loadModelCatalog();
    if (!modelNames().length) return payload;
    patchModelContainer(payload);
    patchObjectGraphForModels(payload, new WeakSet(), 0);
    return payload;
  }

  function installModelJsonResponsePatch() {
    if (window.__csbModelJsonResponsePatchInstalled === "1") return;
    window.__csbModelJsonResponsePatchInstalled = "1";
    const originalJson = Response.prototype.json;
    if (typeof originalJson !== "function") return;
    Response.prototype.json = async function csbPatchedResponseJson(...args) {
      const payload = await originalJson.apply(this, args);
      return await patchModelJsonResponse(payload, this);
    };
  }

  function patchStatsigModelDynamicConfig(configValue) {
    const names = modelNames();
    const value = configValue?.value;
    if (!names.length || !value || typeof value !== "object") return configValue;
    const availableModels = Array.isArray(value.available_models) ? [...value.available_models] : [];
    let changed = false;
    names.forEach((name) => {
      if (!availableModels.includes(name)) {
        availableModels.push(name);
        changed = true;
      }
    });
    const nextValue = { ...value, available_models: availableModels, default_model: names[0] || value.default_model };
    if (!changed && nextValue.default_model === value.default_model) return configValue;
    try {
      configValue.value = nextValue;
    } catch {
      return { ...configValue, value: nextValue };
    }
    return configValue;
  }

  function patchStatsigModelWhitelist() {
    const root = window.__STATSIG__ || globalThis.__STATSIG__;
    if (!root || typeof root !== "object") return;
    const clients = [root.firstInstance, typeof root.instance === "function" ? root.instance() : null, ...Object.values(root.instances || {})]
      .filter((client, index, array) => client && typeof client === "object" && array.indexOf(client) === index);
    clients.forEach((client) => {
      if (typeof client.getDynamicConfig !== "function") return;
      if (!client.__csbModelWhitelistPatched) {
        const originalGetDynamicConfig = client.getDynamicConfig.bind(client);
        client.getDynamicConfig = (name, options) => patchStatsigModelDynamicConfig(originalGetDynamicConfig(name, options));
        client.__csbModelWhitelistPatched = true;
      }
      try {
        patchStatsigModelDynamicConfig(client.getDynamicConfig("107580212", { disableExposureLog: true }));
      } catch {
      }
    });
  }

  function reactFiberKeys(element) {
    return Object.keys(element).filter((key) => key.startsWith("__reactFiber") || key.startsWith("__reactInternalInstance") || key.startsWith("__reactProps"));
  }

  function patchReactModelState() {
    const visited = new WeakSet();
    const nodes = [document.body, ...document.querySelectorAll("button, [role='menu'], [role='dialog'], [data-radix-popper-content-wrapper]")].filter(Boolean);
    for (const node of nodes.slice(0, 40)) {
      for (const key of reactFiberKeys(node)) {
        patchObjectGraphForModels(node[key], visited);
      }
    }
  }

  function patchMcpModelResponseData(data) {
    if (data?.type !== "mcp-response") return false;
    const message = data.message || data.response;
    const requestId = message?.id != null ? String(message.id) : "";
    if (modelListRequestIds.size > 0 && !modelListRequestIds.has(requestId)) return false;
    modelListRequestIds.delete(requestId);
    return patchModelContainer(data) || patchModelContainer(message) || patchModelContainer(message?.result) || patchModelContainer(message?.result?.data);
  }

  function patchAppServerModelMessages() {
    if (window.__csbModelMessagePatchInstalled) return;
    window.__csbModelMessagePatchInstalled = true;
    const originalDispatchEvent = window.dispatchEvent;
    window.dispatchEvent = function csbPatchedDispatchEvent(event) {
      try {
        const detail = event?.detail;
        const request = detail?.request;
        if (event?.type === "codex-message-from-view" && detail?.type === "mcp-request" && request?.method === "model/list") {
          request.params = { ...(request.params || {}), includeHidden: true };
          if (request.id != null) modelListRequestIds.add(String(request.id));
        }
        if (event?.type === "message") patchMcpModelResponseData(event.data);
      } catch {
      }
      return originalDispatchEvent.call(this, event);
    };
    window.addEventListener("message", (event) => {
      try {
        patchMcpModelResponseData(event?.data);
      } catch {
      }
    }, true);
  }

  function appServerModelRequestMethod(method, params) {
    if (method === "send-cli-request-for-host" && params?.method) return String(params.method);
    return String(method || "");
  }

  function patchAppServerModelResult(method, result) {
    if (!["model/list", "list-models-for-host"].includes(method)) return result;
    try {
      const before = {
        arrayCount: Array.isArray(result) ? result.length : null,
        dataCount: Array.isArray(result?.data) ? result.data.length : null,
        modelCount: Array.isArray(result?.models) ? result.models.length : null,
      };
      if (Array.isArray(result)) patchModelArray(result, true);
      if (Array.isArray(result?.data)) patchModelArray(result.data, true);
      if (Array.isArray(result?.models)) patchModelArray(result.models, true);
      patchModelContainer(result);
      patchObjectGraphForModels(result, new WeakSet(), 0);
      window.__csbLastModelPatch = {
        method,
        before,
        names: modelNames(),
        arrayCount: Array.isArray(result) ? result.length : null,
        dataCount: Array.isArray(result?.data) ? result.data.length : null,
        modelCount: Array.isArray(result?.models) ? result.models.length : null,
        at: Date.now(),
      };
    } catch {
    }
    return result;
  }

  function rememberModelRequestCall(call) {
    try {
      const calls = Array.isArray(window.__csbSendRequestCalls) ? window.__csbSendRequestCalls : [];
      calls.push({ ...call, at: Date.now() });
      window.__csbSendRequestCalls = calls.slice(-40);
    } catch {
    }
  }

  function patchAppServerModelHandler(handler) {
    if (typeof handler !== "function") return handler;
    if (handler.__csbModelHandlerPatch === modelRequestPatchVersion) return handler;
    const patched = async function csbModelPatchedMessageHandler(method, params, ...rest) {
      const normalizedMethod = appServerModelRequestMethod(String(method || ""), params);
      rememberModelRequestCall({ method: normalizedMethod, rawMethod: String(method || ""), via: "messageHandler" });
      const result = await handler.call(this, method, params, ...rest);
      if (!modelUnlockEnabled()) return result;
      if (!modelNames().length) await loadModelCatalog();
      return patchAppServerModelResult(normalizedMethod, result);
    };
    patched.__csbModelHandlerPatch = modelRequestPatchVersion;
    patched.__csbOriginalHandler = handler;
    return patched;
  }

  function patchAppServerModelRequestClient(client) {
    if (!client || typeof client.sendRequest !== "function") return false;
    if (client.__csbModelRequestPatch === modelRequestPatchVersion) return true;
    const originalSendRequest = client.__csbModelOriginalSendRequest || client.sendRequest.bind(client);
    client.__csbModelOriginalSendRequest = originalSendRequest;
    client.sendRequest = async function csbModelPatchedSendRequest(method, params, options) {
      const normalizedMethod = appServerModelRequestMethod(String(method || ""), params);
      rememberModelRequestCall({ method: normalizedMethod, rawMethod: String(method || ""), via: "sendRequest" });
      const result = await originalSendRequest(method, params, options);
      if (!modelUnlockEnabled()) return result;
      if (!modelNames().length) await loadModelCatalog();
      return patchAppServerModelResult(normalizedMethod, result);
    };
    if (typeof client.setMessageHandler === "function" && client.__csbSetMessageHandlerPatch !== modelRequestPatchVersion) {
      const originalSetMessageHandler = client.__csbOriginalSetMessageHandler || client.setMessageHandler.bind(client);
      client.__csbOriginalSetMessageHandler = originalSetMessageHandler;
      client.setMessageHandler = function csbPatchedSetMessageHandler(handler) {
        return originalSetMessageHandler(patchAppServerModelHandler(handler));
      };
      client.__csbSetMessageHandlerPatch = modelRequestPatchVersion;
    }
    if (typeof client.messageHandler === "function") {
      client.messageHandler = patchAppServerModelHandler(client.messageHandler);
    }
    client.__csbModelRequestPatch = modelRequestPatchVersion;
    return true;
  }

  function patchAppServerListModelsClient(client) {
    if (!client || typeof client.listModels !== "function") return false;
    if (client.__csbListModelsPatch === modelRequestPatchVersion) return true;
    const originalListModels = client.__csbOriginalListModels || client.listModels;
    client.__csbOriginalListModels = originalListModels;
    client.listModels = async function csbPatchedListModels(...args) {
      rememberModelRequestCall({ method: "model/list", rawMethod: "listModels", via: "listModels" });
      const result = await originalListModels.apply(this, args);
      if (!modelUnlockEnabled()) return result;
      if (!modelNames().length) await loadModelCatalog();
      return patchAppServerModelResult("model/list", result);
    };
    client.__csbListModelsPatch = modelRequestPatchVersion;
    return true;
  }

  function installAppServerModelRequestPatch() {
    if (window.__csbAppServerModelRequestPatchInstalled === modelRequestPatchVersion) return;
    const patch = async () => {
      try {
        const module = await loadAppModule("app-server-manager-signals-");
        const candidates = Object.values(module).filter((value) => value && (typeof value === "object" || typeof value === "function"));
        let patchedCount = 0;
        for (const candidate of candidates) {
          if (patchAppServerModelRequestClient(candidate)) patchedCount += 1;
          if (patchAppServerListModelsClient(candidate)) patchedCount += 1;
          if (candidate?.prototype) {
            if (patchAppServerModelRequestClient(candidate.prototype)) patchedCount += 1;
            if (patchAppServerListModelsClient(candidate.prototype)) patchedCount += 1;
          }
          if (typeof candidate.sendRequest !== "function" && typeof candidate.get === "function") {
            try {
              const value = candidate.get();
              if (patchAppServerModelRequestClient(value)) patchedCount += 1;
              if (patchAppServerListModelsClient(value)) patchedCount += 1;
            } catch {
            }
          }
        }
        if (patchedCount > 0) window.__csbAppServerModelRequestPatchInstalled = modelRequestPatchVersion;
      } catch {
      }
    };
    void patch();
  }

  function installModelUnlockPatches() {
    if (!modelUnlockEnabled()) return;
    installModelJsonResponsePatch();
    patchAppServerModelMessages();
    installAppServerModelRequestPatch();
    if (!modelNames().length) {
      void loadModelCatalog();
      return;
    }
    patchStatsigModelWhitelist();
    requestAnimationFrame(() => {
      try {
        patchReactModelState();
      } catch {
      }
    });
  }

  function scan() {
    installModelUnlockPatches();
  }

  if (window.__csbPluginUnlock?.observer) {
    window.__csbPluginUnlock.observer.disconnect();
    clearInterval(window.__csbPluginUnlock.timer);
    clearInterval(window.__csbPluginUnlock.modelTimer);
    clearTimeout(window.__csbPluginUnlock.scanTimer);
  }
  if (window.__csbModelUnlock?.observer) {
    window.__csbModelUnlock.observer.disconnect();
    clearInterval(window.__csbModelUnlock.timer);
    clearInterval(window.__csbModelUnlock.modelTimer);
    clearTimeout(window.__csbModelUnlock.scanTimer);
  }
  let scanTimer = 0;
  const observer = null;
  const timer = 0;
  let modelPatchAttempts = 0;
  const modelTimer = setInterval(() => {
    modelPatchAttempts += 1;
    installModelUnlockPatches();
    if (window.__csbAppServerModelRequestPatchInstalled === modelRequestPatchVersion || modelPatchAttempts >= 20) {
      clearInterval(modelTimer);
    }
  }, 3000);
  window.__csbModelUnlock = { version: 4, observer, timer, modelTimer, scanTimer, scan };
  if (typeof document.title === "string" && document.title.startsWith("CSB:")) document.title = "Codex";
  window.__csbModelCatalog = modelCatalog;
  installModelUnlockPatches();
  void loadModelCatalog(false);
  scan();
})();
`;
}

function cdpClient(webSocketUrl) {
  if (typeof globalThis.WebSocket === 'function') {
    return browserWebSocketCdpClient(webSocketUrl);
  }
  return rawSocketCdpClient(webSocketUrl);
}

function browserWebSocketCdpClient(webSocketUrl) {
  const WebSocketCtor = globalThis.WebSocket;
  return new Promise((resolve, reject) => {
    const socket = new WebSocketCtor(webSocketUrl);
    const pending = new Map();
    let nextId = 1;
    const failTimer = setTimeout(() => {
      reject(new Error('连接 Codex 调试 WebSocket 超时'));
      try {
        socket.close();
      } catch {
        // Ignore close errors.
      }
    }, 5000);

    socket.onopen = () => {
      clearTimeout(failTimer);
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((commandResolve, commandReject) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              commandReject(new Error(`CDP 命令超时：${method}`));
            }, 5000);
            pending.set(id, { resolve: commandResolve, reject: commandReject, timer });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    };
    socket.onerror = () => {
      clearTimeout(failTimer);
      reject(new Error('连接 Codex 调试 WebSocket 失败'));
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      clearTimeout(callback.timer);
      if (message.error) {
        callback.reject(new Error(message.error.message || 'CDP 命令失败'));
      } else {
        callback.resolve(message);
      }
    };
    socket.onclose = () => {
      clearTimeout(failTimer);
      pending.forEach((callback) => {
        clearTimeout(callback.timer);
        callback.reject(new Error('Codex 调试 WebSocket 已关闭'));
      });
      pending.clear();
    };
  });
}

function rawSocketCdpClient(webSocketUrl) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(webSocketUrl);
    } catch {
      reject(new Error('Codex 调试 WebSocket 地址无效'));
      return;
    }
    if (parsed.protocol !== 'ws:') {
      reject(new Error('仅支持本机 ws:// Codex 调试连接'));
      return;
    }

    const port = Number(parsed.port || 80);
    const socket = net.createConnection({ host: parsed.hostname, port });
    const pending = new Map();
    let nextId = 1;
    let connected = false;
    let headerBuffer = Buffer.alloc(0);
    let frameBuffer = Buffer.alloc(0);
    const key = crypto.randomBytes(16).toString('base64');
    const failTimer = setTimeout(() => {
      reject(new Error('连接 Codex 调试 WebSocket 超时'));
      socket.destroy();
    }, 5000);

    const sendFrame = (text) => {
      const payload = Buffer.from(text);
      const headerLength = payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10;
      const frame = Buffer.alloc(headerLength + 4 + payload.length);
      frame[0] = 0x81;
      if (payload.length < 126) {
        frame[1] = 0x80 | payload.length;
      } else if (payload.length < 65536) {
        frame[1] = 0x80 | 126;
        frame.writeUInt16BE(payload.length, 2);
      } else {
        frame[1] = 0x80 | 127;
        frame.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const maskOffset = headerLength;
      const mask = crypto.randomBytes(4);
      mask.copy(frame, maskOffset);
      for (let index = 0; index < payload.length; index += 1) {
        frame[maskOffset + 4 + index] = payload[index] ^ mask[index % 4];
      }
      socket.write(frame);
    };

    const closePending = (error) => {
      pending.forEach((callback) => {
        clearTimeout(callback.timer);
        callback.reject(error);
      });
      pending.clear();
    };

    const client = {
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((commandResolve, commandReject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            commandReject(new Error(`CDP 命令超时：${method}`));
          }, 5000);
          pending.set(id, { resolve: commandResolve, reject: commandReject, timer });
          sendFrame(JSON.stringify({ id, method, params }));
        });
      },
      close() {
        try {
          socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
        } catch {
          // Ignore close errors.
        }
        socket.end();
      },
    };

    const handleMessage = (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      clearTimeout(callback.timer);
      if (message.error) {
        callback.reject(new Error(message.error.message || 'CDP 命令失败'));
      } else {
        callback.resolve(message);
      }
    };

    const parseFrames = () => {
      while (frameBuffer.length >= 2) {
        const first = frameBuffer[0];
        const second = frameBuffer[1];
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let payloadLength = second & 0x7f;
        let offset = 2;
        if (payloadLength === 126) {
          if (frameBuffer.length < offset + 2) return;
          payloadLength = frameBuffer.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLength === 127) {
          if (frameBuffer.length < offset + 8) return;
          const bigLength = frameBuffer.readBigUInt64BE(offset);
          if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            socket.destroy(new Error('CDP WebSocket 消息过大'));
            return;
          }
          payloadLength = Number(bigLength);
          offset += 8;
        }
        let mask;
        if (masked) {
          if (frameBuffer.length < offset + 4) return;
          mask = frameBuffer.subarray(offset, offset + 4);
          offset += 4;
        }
        if (frameBuffer.length < offset + payloadLength) return;
        let payload = frameBuffer.subarray(offset, offset + payloadLength);
        frameBuffer = frameBuffer.subarray(offset + payloadLength);
        if (masked && mask) {
          payload = Buffer.from(payload);
          for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % 4];
          }
        }
        if (opcode === 0x1) {
          handleMessage(payload.toString('utf8'));
        } else if (opcode === 0x8) {
          socket.end();
          return;
        } else if (opcode === 0x9) {
          socket.write(Buffer.from([0x8a, 0]));
        }
      }
    };

    socket.on('connect', () => {
      const pathname = `${parsed.pathname}${parsed.search}`;
      socket.write([
        `GET ${pathname || '/'} HTTP/1.1`,
        `Host: ${parsed.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });

    socket.on('data', (chunk) => {
      if (!connected) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const headerEnd = headerBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = headerBuffer.subarray(0, headerEnd).toString('utf8');
        const rest = headerBuffer.subarray(headerEnd + 4);
        headerBuffer = Buffer.alloc(0);
        if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
          reject(new Error('Codex 调试 WebSocket 握手失败'));
          socket.destroy();
          return;
        }
        connected = true;
        clearTimeout(failTimer);
        resolve(client);
        if (rest.length > 0) {
          frameBuffer = Buffer.concat([frameBuffer, rest]);
          parseFrames();
        }
        return;
      }
      frameBuffer = Buffer.concat([frameBuffer, chunk]);
      parseFrames();
    });

    socket.on('error', (error) => {
      clearTimeout(failTimer);
      if (!connected) {
        reject(error);
        return;
      }
      closePending(error);
    });
    socket.on('close', () => {
      clearTimeout(failTimer);
      closePending(new Error('Codex 调试 WebSocket 已关闭'));
    });
  });
}

async function injectModelUnlockIntoTarget(target) {
  const client = await cdpClient(target.webSocketDebuggerUrl);
  const source = modelUnlockScript(await readModelUnlockModelCatalog());
  try {
    await client.send('Runtime.enable');
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source });
    const result = await client.send('Runtime.evaluate', {
      expression: source,
      awaitPromise: false,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (result?.result?.exceptionDetails) {
      throw new Error(result.result.exceptionDetails.text || '模型解锁脚本执行失败');
    }
  } finally {
    client.close();
  }
}

async function getModelUnlockStatus() {
  if (!modelUnlockStatus.available) {
    return updateModelUnlockStatus({
      injected: false,
      message: `${process.platform} 暂不支持自动注入模型解锁脚本`,
    });
  }
  try {
    const port = await resolveModelUnlockDebugPort();
    const target = await currentCodexCdpTarget(port);
    return updateModelUnlockStatus({
      message: modelUnlockStatus.injected ? '模型解锁脚本已注入' : 'Codex 调试端口已连接，可注入',
      targetTitle: target.title || '',
      targetUrl: target.url || '',
      error: '',
    });
  } catch (error) {
    return updateModelUnlockStatus({
      injected: false,
      message: 'Codex 尚未以解锁模式启动',
      targetTitle: '',
      targetUrl: '',
      error: error instanceof Error ? error.message : '无法连接 Codex 调试端口',
    });
  }
}

async function applyModelUnlock() {
  if (!modelUnlockStatus.available) return getModelUnlockStatus();
  updateModelUnlockStatus({ injected: false, message: '正在连接 Codex 调试端口', error: '' });
  try {
    const port = await resolveModelUnlockDebugPort();
    const helperResult = await runRustInjector(port);
    if (helperResult) {
      return updateModelUnlockStatus({
        injected: helperResult.injected !== false && helperResult.status !== 'failed',
        message: helperResult.status === 'failed' ? (helperResult.message || '模型解锁注入失败') : '模型白名单解锁已注入',
        debugPort: port,
        targetTitle: helperResult.targetTitle || '',
        targetUrl: helperResult.targetUrl || '',
        error: helperResult.error || '',
      });
    }
    updateModelUnlockStatus({ message: '正在以解锁模式重启 Codex 桌面端' });
    await launchCodexWithDebugPort(port);
    const target = await waitForCodexCdpTarget(port);
    await injectModelUnlockIntoTarget(target);
    return updateModelUnlockStatus({
      injected: true,
      message: '模型白名单解锁已注入',
      debugPort: port,
      targetTitle: target.title || '',
      targetUrl: target.url || '',
      error: '',
    });
  } catch (error) {
    return updateModelUnlockStatus({
      injected: false,
      message: '解锁注入失败',
      error: error instanceof Error ? error.message : '解锁注入失败',
    });
  }
}

app.whenReady().then(async () => {
  readDesktopPreferences();
  ipcMain.handle('desktop:get-preferences', () => publicDesktopPreferences());
  ipcMain.handle('desktop:get-relay-state', () => readRelayState());
  ipcMain.handle('desktop:set-relay-state', (_event, state = {}) => writeRelayState(state));
  ipcMain.handle('desktop:set-preferences', (_event, patch = {}) => {
    desktopPreferences = {
      ...desktopPreferences,
      launchAtLogin: typeof patch.launchAtLogin === 'boolean' ? patch.launchAtLogin : desktopPreferences.launchAtLogin,
      closeToTray: typeof patch.closeToTray === 'boolean' ? patch.closeToTray : desktopPreferences.closeToTray,
      hideDockIcon: typeof patch.hideDockIcon === 'boolean' ? patch.hideDockIcon : desktopPreferences.hideDockIcon,
      daemonPort: patch.daemonPort === undefined ? desktopPreferences.daemonPort : normalizeDaemonPort(patch.daemonPort),
      usageWidget: patch.usageWidget === undefined
        ? desktopPreferences.usageWidget
        : normalizeUsageWidgetPreferences({
            ...desktopPreferences.usageWidget,
            ...patch.usageWidget,
          }),
    };
    applyDesktopPreferences();
    writeDesktopPreferences();
    updateTrayMenu(false);
    return publicDesktopPreferences();
  });
  ipcMain.handle('desktop:get-daemon-status', () => daemonStatus());
  ipcMain.handle('desktop:start-daemon', () => {
    daemonStoppedByUser = false;
    startDaemon();
    loadAppWhenDaemonReady();
    updateTrayMenu();
    return daemonStatus();
  });
  ipcMain.handle('desktop:stop-daemon', () => {
    stopDaemon();
    loadLoadingPage('本地服务已停止');
    updateTrayMenu();
    return daemonStatus();
  });
  ipcMain.handle('desktop:restart-daemon', () => {
    restartDaemon();
    return daemonStatus();
  });
  ipcMain.handle('desktop:resize-window', (_event, height) => {
    if (!mainWindow || !Number.isFinite(height)) return false;
    const targetHeight = Math.max(360, Math.min(860, Math.ceil(height)));
    const [, windowHeight] = mainWindow.getSize();
    const [width, currentHeight] = mainWindow.getContentSize();
    const frameHeight = Math.max(0, windowHeight - currentHeight);
    const targetMinimumHeight = targetHeight + frameHeight;
    if (Math.abs(targetMinimumHeight - currentMinimumHeight) >= 2) {
      currentMinimumHeight = targetMinimumHeight;
      mainWindow.setMinimumSize(500, targetMinimumHeight);
    }
    if (Math.abs(currentHeight - targetHeight) < 2) return true;
    mainWindow.setContentSize(width, targetHeight, true);
    return true;
  });
  ipcMain.handle('desktop:get-app-info', () => ({
    version: app.getVersion(),
    repo: `${githubOwner}/${githubRepo}`,
    releaseUrl: githubReleasesUrl,
  }));
  ipcMain.handle('desktop:check-updates', () => checkGithubUpdates());
  ipcMain.handle('desktop:open-update-page', (_event, url) => shell.openExternal(String(url || githubReleasesUrl)));
  ipcMain.handle('desktop:open-privacy-settings', () => openPrivacySettings());
  ipcMain.handle('desktop:choose-project-folder', () => chooseProjectFolder());
  ipcMain.handle('desktop:restart-codex-desktop-if-running', () => restartCodexDesktopIfRunning());
  ipcMain.handle('desktop:get-model-unlock-status', () => getModelUnlockStatus());
  ipcMain.handle('desktop:apply-model-unlock', () => applyModelUnlock());
  ipcMain.handle('desktop:get-plugin-unlock-status', () => getModelUnlockStatus());
  ipcMain.handle('desktop:apply-plugin-unlock', () => applyModelUnlock());
  ipcMain.handle('desktop:show-usage-widget', async () => {
    if (process.platform !== 'darwin') return { available: false };
    desktopPreferences.usageWidget = normalizeUsageWidgetPreferences({
      ...desktopPreferences.usageWidget,
      enabled: true,
    });
    writeDesktopPreferences();
    syncUsageWidgetState();
    updateTrayMenu(false);
    const state = await refreshUsageWidget();
    return { available: true, state, preferences: publicDesktopPreferences() };
  });
  ipcMain.handle('desktop:hide-usage-widget', () => {
    desktopPreferences.usageWidget = normalizeUsageWidgetPreferences({
      ...desktopPreferences.usageWidget,
      enabled: false,
    });
    writeDesktopPreferences();
    syncUsageWidgetState();
    updateTrayMenu(false);
    return publicDesktopPreferences();
  });
  ipcMain.handle('desktop:refresh-usage-widget', async () => refreshUsageWidget());
  startDaemon();
  createWindow();
  createTray();
  updateTrayMenu();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (usageWidgetTimer) clearInterval(usageWidgetTimer);
  stopDaemon();
});
