const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, dialog } = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const defaultDaemonPort = '8787';
const githubOwner = 'mdzz-debug';
const githubRepo = 'Codex-Session-Bridge';
const githubReleasesUrl = `https://github.com/${githubOwner}/${githubRepo}/releases`;
const devUrl = process.env.CSB_WEB_URL || 'http://127.0.0.1:5178';
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
let desktopPreferences = {
  launchAtLogin: false,
  closeToTray: true,
  hideDockIcon: false,
  daemonPort: defaultDaemonPort,
};

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
