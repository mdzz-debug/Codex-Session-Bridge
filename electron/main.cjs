const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, dialog } = require('electron');
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
};

function normalizeDebugPort(value) {
  const port = Number(String(value || '').trim());
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 9229;
}

function normalizeDaemonPort(value) {
  const port = String(value || '').trim();
  const numeric = Number(port);
  return Number.isInteger(numeric) && numeric >= 1024 && numeric <= 65535 ? port : defaultDaemonPort;
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
    };
  } catch {
    desktopPreferences.launchAtLogin = app.getLoginItemSettings().openAtLogin;
  }
  applyDesktopPreferences();
}

function writeDesktopPreferences() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(preferencesPath(), JSON.stringify(desktopPreferences, null, 2));
}

function publicDesktopPreferences() {
  return {
    available: true,
    platform: process.platform,
    version: app.getVersion(),
    ...desktopPreferences,
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


function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const timeout = typeof options.timeout === 'number' ? options.timeout : 120000;
    const child = spawn(command, args, {
      cwd: options.cwd || undefined,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      shell: true,
      timeout,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', (err) => {
      resolve({ code: 1, stdout: stdout.trim(), stderr: err.message });
    });
  });
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
    };
    applyDesktopPreferences();
    writeDesktopPreferences();
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
  ipcMain.handle('desktop:run-command', async (_event, command, args = [], options = {}) => {
    return runCommand(command, args, options);
  });
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
  stopDaemon();
});
