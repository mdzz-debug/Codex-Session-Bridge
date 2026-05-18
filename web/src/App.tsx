import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Circle,
  Download,
  FolderOpen,
  KeyRound,
  Laptop,
  Loader2,
  LogIn,
  LogOut,
  Moon,
  RefreshCw,
  Router,
  Settings2,
  Shield,
  Sun,
  Wifi,
} from 'lucide-react';
import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import {
  bridgeApi,
  eventsUrl,
  loginRelay,
  relayStatusText,
  type BridgeEvent,
  type CodexConfig,
  type CodexProjectConfig,
  type DeviceInfo,
  type HealthInfo,
  type RelayRuntimeStatus,
} from './services/bridgeApi';
import {
  clearRelaySession,
  readDesktopSection,
  readRelaySession,
  readSettings,
  saveDesktopSection,
  saveRelaySession,
  saveSettings,
  type BridgeSettings,
  type RelaySession,
  type SettingsSection,
  type ThemeName,
} from './services/storage';

type Section = SettingsSection;

interface DesktopPreferences {
  available: boolean;
  platform: string;
  version?: string;
  launchAtLogin: boolean;
  closeToTray: boolean;
  hideDockIcon: boolean;
  daemonPort: string;
  daemonUrl?: string;
}

interface DaemonDesktopStatus {
  running: boolean;
  stoppedByUser: boolean;
  port: string;
  url: string;
}

interface DesktopAppInfo {
  version: string;
  repo: string;
  releaseUrl: string;
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  error?: string;
  message?: string;
}

const fallbackDesktopPrefs: DesktopPreferences = {
  available: true,
  platform: 'darwin',
  version: '1.0.0',
  launchAtLogin: false,
  closeToTray: true,
  hideDockIcon: false,
  daemonPort: '8787',
  daemonUrl: 'http://127.0.0.1:8787',
};

function App() {
  const [settings, setSettings] = useState<BridgeSettings>(() => readSettings());
  const [relayDraft, setRelayDraft] = useState(() => ({
    relayApiBase: settings.relayApiBase,
    relayWssUrl: settings.relayWssUrl,
    autoConnectRelay: settings.autoConnectRelay,
  }));
  const [session, setSession] = useState<RelaySession | null>(() => readRelaySession());
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [relayRuntime, setRelayRuntime] = useState<RelayRuntimeStatus | null>(null);
  const [events, setEvents] = useState<BridgeEvent[]>([]);
  const [eventConnected, setEventConnected] = useState(false);
  const [desktopPrefs, setDesktopPrefs] = useState<DesktopPreferences>(fallbackDesktopPrefs);
  const [daemonDesktop, setDaemonDesktop] = useState<DaemonDesktopStatus | null>(null);
  const [daemonPortDraft, setDaemonPortDraft] = useState(fallbackDesktopPrefs.daemonPort);
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [codexConfig, setCodexConfig] = useState<CodexConfig | null>(null);
  const [codexDraft, setCodexDraft] = useState<CodexConfig | null>(null);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [section, setSection] = useState<Section>(() => readDesktopSection());
  const [loading, setLoading] = useState({ boot: true, desktop: false });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const shellRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const eventRef = useRef<WebSocket | null>(null);
  const lastResizeHeightRef = useRef(0);
  const resizeTimerRef = useRef<number | null>(null);
  const generalHeightRef = useRef(0);
  const relayConnection = relayConnectionState(session, settings, relayRuntime);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    setRelayDraft({
      relayApiBase: settings.relayApiBase,
      relayWssUrl: settings.relayWssUrl,
      autoConnectRelay: settings.autoConnectRelay,
    });
  }, [settings.relayApiBase, settings.relayWssUrl, settings.autoConnectRelay]);

  useEffect(() => {
    void bootstrap();
    void loadDesktopPreferences();
    void loadDesktopRelayState();
    void loadDaemonDesktopStatus();
    void loadAppInfo();
  }, []);

  useEffect(() => {
    connectEvents();
    return () => eventRef.current?.close();
  }, [settings.daemonBase]);

  useEffect(() => {
    void syncRelayConfig();
  }, [settings.daemonBase, settings.relayWssUrl, settings.autoConnectRelay, session?.token, session?.username]);

  useEffect(() => {
    saveDesktopSection(section);
    if (section === 'about' || section === 'relay') void refreshRelayRuntime();
    if (section === 'codex') void loadCodexConfig();
  }, [section]);

  useEffect(() => {
    if (!settings.autoConnectRelay || !session) return;
    const timer = window.setInterval(() => {
      void refreshRelayRuntime();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [settings.daemonBase, settings.autoConnectRelay, session?.token]);

  useEffect(() => {
    if (!window.bridgeDesktop?.resizeWindow || !shellRef.current || !mainRef.current) return;
    let frame = 0;
    const resize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const headerHeight = headerRef.current?.offsetHeight || 0;
        const main = mainRef.current;
        const mainHeight = main ? Math.max(main.scrollHeight, main.offsetHeight) : 0;
        const contentHeight = headerHeight + mainHeight;
        if (section === 'general') {
          generalHeightRef.current = Math.ceil(contentHeight);
        }
        const generalHeight = generalHeightRef.current;
        const height =
          section === 'codex'
            ? generalHeight || Math.min(contentHeight, 620)
            : Math.max(contentHeight, generalHeight);
        const targetHeight = Math.max(360, Math.min(860, Math.ceil(height)));
        if (Math.abs(targetHeight - lastResizeHeightRef.current) < 2) return;
        lastResizeHeightRef.current = targetHeight;
        if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = window.setTimeout(() => {
          resizeTimerRef.current = null;
          void window.bridgeDesktop?.resizeWindow?.(targetHeight);
        }, 90);
      });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(shellRef.current);
    observer.observe(mainRef.current);
    return () => {
      window.cancelAnimationFrame(frame);
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      observer.disconnect();
    };
  }, [
    section,
    error,
    notice,
    loading.boot,
    loading.desktop,
    session?.username,
    relayRuntime?.state,
    relayRuntime?.last_error,
    desktopPrefs.hideDockIcon,
    daemonPortDraft,
    updateInfo?.latestVersion,
    codexDraft?.path,
    codexDraft?.projects.length,
    selectedFolder,
  ]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function bootstrap() {
    setLoading((next) => ({ ...next, boot: true }));
    try {
      const [nextHealth, nextDevice, nextRelay] = await Promise.allSettled([
        bridgeApi.health(settings),
        bridgeApi.device(settings),
        bridgeApi.relayStatus(settings),
      ]);
      if (nextHealth.status === 'fulfilled') setHealth(nextHealth.value);
      if (nextDevice.status === 'fulfilled') setDevice(nextDevice.value);
      if (nextRelay.status === 'fulfilled') setRelayRuntime(nextRelay.value);
      if (nextHealth.status === 'rejected' && nextDevice.status === 'rejected') throw nextHealth.reason;
      setError(nextHealth.status === 'rejected' || nextDevice.status === 'rejected' ? '部分本地状态暂时不可用，可以点击刷新重试' : '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接本地 daemon');
    } finally {
      setLoading((next) => ({ ...next, boot: false }));
    }
  }

  async function syncRelayConfig() {
    try {
      const nextStatus = await bridgeApi.configureRelay(settings, session);
      setRelayRuntime(nextStatus);
    } catch (err) {
      setRelayRuntime((current) => ({
        ...(current || {}),
        enabled: Boolean(session && settings.autoConnectRelay),
        connected: false,
        state: 'local_error',
        wss_url: settings.relayWssUrl,
        username: session?.username,
        last_error: err instanceof Error ? err.message : '无法同步中转站配置',
      }));
    }
  }

  async function refreshRelayRuntime() {
    try {
      setRelayRuntime(await bridgeApi.relayStatus(settings));
    } catch {
      // Older daemons do not expose relay status. syncRelayConfig/bootstrap will surface the actionable error.
    }
  }

  async function loadDesktopPreferences() {
    if (!window.bridgeDesktop?.getPreferences) return;
    try {
      const next = await window.bridgeDesktop.getPreferences();
      setDesktopPrefs(next);
      setDaemonPortDraft(next.daemonPort || '8787');
    } catch {
      setDesktopPrefs(fallbackDesktopPrefs);
    }
  }

  async function loadDesktopRelayState() {
    if (!window.bridgeDesktop?.getRelayState) return;
    try {
      const state = await window.bridgeDesktop.getRelayState();
      if (state.session?.apiBase && state.session.token && state.session.username) {
        const nextSession: RelaySession = {
          apiBase: state.session.apiBase,
          token: state.session.token,
          username: state.session.username,
          role: state.session.role === 'admin' ? 'admin' : 'user',
          expiresAt: state.session.expiresAt,
        };
        saveRelaySession(nextSession, true);
        setSession(nextSession);
      }
      if (state.settings) {
        setSettings((current) => {
          const next = {
            ...current,
            relayApiBase: state.settings?.relayApiBase ?? current.relayApiBase,
            relayWssUrl: state.settings?.relayWssUrl ?? current.relayWssUrl,
            autoConnectRelay: typeof state.settings?.autoConnectRelay === 'boolean' ? state.settings.autoConnectRelay : current.autoConnectRelay,
          };
          saveSettings(next);
          return next;
        });
      }
    } catch {
      // LocalStorage remains the fallback when the desktop bridge is unavailable.
    }
  }

  async function loadDaemonDesktopStatus() {
    if (!window.bridgeDesktop?.getDaemonStatus) return;
    try {
      const next = await window.bridgeDesktop.getDaemonStatus();
      setDaemonDesktop(next);
      setDaemonPortDraft(next.port || desktopPrefs.daemonPort || '8787');
    } catch {
      setDaemonDesktop(null);
    }
  }

  async function loadAppInfo() {
    if (!window.bridgeDesktop?.getAppInfo) {
      setAppInfo({ version: '1.0.0', repo: 'mdzz-debug/Codex-Session-Bridge', releaseUrl: 'https://github.com/mdzz-debug/Codex-Session-Bridge/releases' });
      return;
    }
    try {
      setAppInfo(await window.bridgeDesktop.getAppInfo());
    } catch {
      setAppInfo({ version: desktopPrefs.version || '1.0.0', repo: 'mdzz-debug/Codex-Session-Bridge', releaseUrl: 'https://github.com/mdzz-debug/Codex-Session-Bridge/releases' });
    }
  }

  async function controlDaemon(action: 'start' | 'stop' | 'restart') {
    if (!window.bridgeDesktop) return;
    setLoading((current) => ({ ...current, desktop: true }));
    try {
      const next =
        action === 'start'
          ? await window.bridgeDesktop.startDaemon?.()
          : action === 'stop'
            ? await window.bridgeDesktop.stopDaemon?.()
            : await window.bridgeDesktop.restartDaemon?.();
      if (next) setDaemonDesktop(next);
      setError('');
      if (action !== 'stop') {
        window.setTimeout(() => void bootstrap(), 900);
      } else {
        setHealth(null);
        setEventConnected(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'daemon 操作失败');
    } finally {
      setLoading((current) => ({ ...current, desktop: false }));
    }
  }

  async function updateDesktopPreferences(patch: Partial<DesktopPreferences>) {
    const next = { ...desktopPrefs, ...patch };
    setDesktopPrefs(next);
    if (!window.bridgeDesktop?.setPreferences) return;
    setLoading((current) => ({ ...current, desktop: true }));
    try {
      setDesktopPrefs(await window.bridgeDesktop.setPreferences(patch));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存桌面设置失败');
    } finally {
      setLoading((current) => ({ ...current, desktop: false }));
    }
  }

  async function applyDaemonPort() {
    const normalized = normalizePort(daemonPortDraft);
    if (!normalized) {
      setError('端口需要在 1024 到 65535 之间');
      return;
    }
    if (normalized === (desktopPrefs.daemonPort || daemonDesktop?.port || '8787')) return;
    const confirmed = window.confirm('修改本地 daemon 端口需要重启监听服务，是否现在应用？');
    if (!confirmed) {
      setDaemonPortDraft(desktopPrefs.daemonPort || daemonDesktop?.port || '8787');
      return;
    }
    await updateDesktopPreferences({ daemonPort: normalized });
    setDaemonPortDraft(normalized);
    await controlDaemon('restart');
    window.setTimeout(() => {
      void loadDaemonDesktopStatus();
      void bootstrap();
    }, 900);
  }

  async function checkUpdates() {
    if (!window.bridgeDesktop?.checkUpdates) return;
    setLoading((current) => ({ ...current, desktop: true }));
    try {
      const next = await window.bridgeDesktop.checkUpdates();
      setUpdateInfo(next);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '检查更新失败');
    } finally {
      setLoading((current) => ({ ...current, desktop: false }));
    }
  }

  async function openPrivacySettings() {
    try {
      await window.bridgeDesktop?.openPrivacySettings?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法打开系统隐私设置');
    }
  }

  async function chooseProjectFolder() {
    try {
      const result = await window.bridgeDesktop?.chooseProjectFolder?.();
      if (result?.path) setSelectedFolder(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法选择项目文件夹');
    }
  }

  async function loadCodexConfig() {
    try {
      const next = await bridgeApi.codexConfig(settings);
      setCodexConfig(next);
      setCodexDraft(next);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 Codex 配置失败');
    }
  }

  async function saveCodexConfig() {
    if (!codexDraft) return;
    setLoading((current) => ({ ...current, desktop: true }));
    try {
      const next = await bridgeApi.updateCodexConfig(settings, normalizeCodexConfigDraft(codexDraft));
      setCodexConfig(next);
      setCodexDraft(next);
      const restartMessages: string[] = [];
      try {
        const cliRestart = await bridgeApi.restartCodex(settings);
        restartMessages.push(cliRestart.restarted ? 'Codex CLI 已重启' : 'Codex CLI 未运行，未启动');
      } catch (restartErr) {
        restartMessages.push(restartErr instanceof Error ? `Codex CLI 重启失败：${restartErr.message}` : 'Codex CLI 重启失败');
      }
      try {
        const desktopRestart = await window.bridgeDesktop?.restartCodexDesktopIfRunning?.();
        if (desktopRestart?.restarted) {
          restartMessages.push('Codex 桌面端已重启');
        } else if (desktopRestart?.wasRunning) {
          restartMessages.push(desktopRestart.error ? `Codex 桌面端重启失败：${desktopRestart.error}` : 'Codex 桌面端未重启');
        } else {
          restartMessages.push('Codex 桌面端未运行，未启动');
        }
      } catch (restartErr) {
        restartMessages.push(restartErr instanceof Error ? `Codex 桌面端检测失败：${restartErr.message}` : 'Codex 桌面端检测失败');
      }
      setError('');
      setNotice(`配置保存成功。${restartMessages.join('；')}。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 Codex 配置失败');
      setNotice('');
    } finally {
      setLoading((current) => ({ ...current, desktop: false }));
    }
  }

  function updateCodexDraft(patch: Partial<CodexConfig>) {
    setNotice('');
    setCodexDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function updateCodexProject(index: number, patch: Partial<CodexProjectConfig>) {
    setNotice('');
    setCodexDraft((current) => {
      if (!current) return current;
      const projects = current.projects.map((project, projectIndex) => (projectIndex === index ? { ...project, ...patch } : project));
      return { ...current, projects };
    });
  }

  function removeCodexProject(index: number) {
    setNotice('');
    setCodexDraft((current) => {
      if (!current) return current;
      return { ...current, projects: current.projects.filter((_, projectIndex) => projectIndex !== index) };
    });
  }

  async function addCodexProject() {
    try {
      const result = await window.bridgeDesktop?.chooseProjectFolder?.();
      if (!result?.path) return;
      setNotice('');
      setCodexDraft((current) => {
        if (!current) return current;
        if (current.projects.some((project) => project.path === result.path)) return current;
        return { ...current, projects: [...current.projects, { path: result.path, trust_level: 'trusted' }] };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法选择项目文件夹');
    }
  }

  function updateSettings(patch: Partial<BridgeSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function updateRelayApiBaseDraft(value: string) {
    setRelayDraft((current) => {
      const currentDerivedWss = relayWssFromApiBase(current.relayApiBase);
      const nextDerivedWss = relayWssFromApiBase(value);
      return {
        ...current,
        relayApiBase: value,
        relayWssUrl: !current.relayWssUrl.trim() || current.relayWssUrl.trim() === currentDerivedWss ? nextDerivedWss : current.relayWssUrl,
      };
    });
  }

  function saveRelayConfig() {
    const relayApiBase = normalizeRelayApiBase(relayDraft.relayApiBase);
    const relayWssUrl = relayDraft.relayWssUrl.trim() || relayWssFromApiBase(relayApiBase);
    const nextSettings = {
      ...settings,
      relayApiBase,
      relayWssUrl,
      autoConnectRelay: relayDraft.autoConnectRelay,
    };
    setSettings(nextSettings);
    saveSettings(nextSettings);
    void persistDesktopRelayState(nextSettings, session);
    setError('');
    setNotice('中转站连接配置已保存。');
  }

  async function persistDesktopRelayState(nextSettings: BridgeSettings, nextSession: RelaySession | null) {
    await window.bridgeDesktop?.setRelayState?.({
      settings: {
        relayApiBase: nextSettings.relayApiBase,
        relayWssUrl: nextSettings.relayWssUrl,
        autoConnectRelay: nextSettings.autoConnectRelay,
      },
      session: nextSession,
    });
  }

  function connectEvents() {
    eventRef.current?.close();
    const socket = new WebSocket(eventsUrl(settings));
    eventRef.current = socket;
    socket.onopen = () => setEventConnected(true);
    socket.onclose = () => setEventConnected(false);
    socket.onerror = () => setEventConnected(false);
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data as string) as BridgeEvent;
        if (event.type === 'relay.status_changed' && event.status && typeof event.status === 'object') {
          setRelayRuntime(event.status as RelayRuntimeStatus);
        }
        setEvents((current) => [event, ...current].slice(0, 5));
      } catch {
        // Ignore malformed event payloads.
      }
    };
  }

  return (
    <div className="settings-shell" ref={shellRef}>
      <header className="app-toolbar" ref={headerRef}>
        <div className="title-row">
          <div className="window-spacer" />
          <div className="title-lockup">
            <img src="/logo.png" alt="Codex Session Bridge" />
            <strong>Codex Bridge</strong>
          </div>
          <div className="toolbar-actions">
            <StatusPill ok={Boolean(health?.ok)} label={health?.ok ? 'daemon 在线' : 'daemon 离线'} />
            <button className="icon-button" title="刷新状态" onClick={() => void bootstrap()}>
              {loading.boot ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
            </button>
          </div>
        </div>

        <nav className="settings-tabs" aria-label="设置">
          <NavButton icon={<Settings2 size={26} />} label="通用" active={section === 'general'} onClick={() => setSection('general')} />
          <NavButton icon={<Router size={26} />} label="中转站" active={section === 'relay'} onClick={() => setSection('relay')} />
          <NavButton icon={<KeyRound size={26} />} label="Codex" active={section === 'codex'} onClick={() => setSection('codex')} />
          <NavButton icon={<Shield size={26} />} label="关于" active={section === 'about'} onClick={() => setSection('about')} />
        </nav>
      </header>

      <main className={`settings-main ${section === 'codex' ? 'scrollable' : ''}`} ref={mainRef}>
        {error && (
          <div className="alert">
            <AlertCircle size={17} />
            {error}
          </div>
        )}
        {notice && !error && (
          <div className="alert success">
            <CheckCircle2 size={17} />
            {notice}
          </div>
        )}

        {section === 'general' && (
          <SettingsStack>
            <Card title="监听服务" subtitle="本机 daemon 只绑定 127.0.0.1，桌面端负责配置和状态观察。">
              <StatusGrid compact>
                <Metric icon={<Cpu size={17} />} label="设备" value={device?.name || '未知'} detail={device?.device_id || '-'} />
                <Metric icon={<Circle size={17} />} label="daemon" value={daemonDesktop?.running ? '运行中' : daemonDesktop?.stoppedByUser ? '已停止' : '启动中'} detail={daemonDesktop?.url || settings.daemonBase || '127.0.0.1'} />
              </StatusGrid>
              <div className="daemon-actions">
                <button type="button" disabled={loading.desktop || daemonDesktop?.running} onClick={() => void controlDaemon('start')}>开启</button>
                <button type="button" disabled={loading.desktop || !daemonDesktop?.running} onClick={() => void controlDaemon('stop')}>停止</button>
                <button type="button" disabled={loading.desktop} onClick={() => void controlDaemon('restart')}>重启</button>
              </div>
              <div className="port-row">
                <label className="field">
                  <span>本地 daemon 端口</span>
                  <input
                    value={daemonPortDraft}
                    inputMode="numeric"
                    placeholder="8787"
                    onChange={(event) => setDaemonPortDraft(event.target.value.replace(/[^\d]/g, '').slice(0, 5))}
                  />
                </label>
                <button type="button" disabled={loading.desktop || daemonPortDraft === (daemonDesktop?.port || desktopPrefs.daemonPort)} onClick={() => void applyDaemonPort()}>
                  应用
                </button>
              </div>
            </Card>

            <Card title="桌面行为" subtitle="控制窗口、菜单栏和后台常驻方式。">
              <ToggleRow
                title="登录时自动启动"
                detail="开机后自动启动后台监听服务。"
                checked={desktopPrefs.launchAtLogin}
                disabled={loading.desktop}
                onChange={(checked) => void updateDesktopPreferences({ launchAtLogin: checked })}
              />
              <ToggleRow
                title="关闭窗口时隐藏到菜单栏"
                detail="窗口关闭后 daemon 继续运行，可从菜单栏/托盘重新打开。"
                checked={desktopPrefs.closeToTray}
                disabled={loading.desktop}
                onChange={(checked) => void updateDesktopPreferences({ closeToTray: checked })}
              />
              {desktopPrefs.platform === 'darwin' && (
                <ToggleRow
                  title="隐藏 Dock 图标"
                  detail="只保留菜单栏入口，让它更像常驻 agent。"
                  checked={desktopPrefs.hideDockIcon}
                  disabled={loading.desktop}
                  onChange={(checked) => void updateDesktopPreferences({ hideDockIcon: checked })}
                />
              )}
            </Card>

            <Card title="文件访问权限" subtitle="Codex 读取项目时由系统权限控制，桌面端只提供授权入口。">
              <div className="permission-actions">
                <button className="icon-text" type="button" onClick={() => void chooseProjectFolder()}>
                  <FolderOpen size={15} />
                  选择项目文件夹
                </button>
                <button className="icon-text" type="button" onClick={() => void openPrivacySettings()}>
                  <Shield size={15} />
                  打开隐私设置
                </button>
              </div>
              <code>{selectedFolder || (desktopPrefs.platform === 'win32' ? 'Windows 文件系统权限' : 'macOS 隐私与安全性')}</code>
            </Card>
          </SettingsStack>
        )}

        {section === 'relay' && (
          <SettingsStack>
            <RelayLoginCard
              settings={settings}
              session={session}
              onApiBaseChange={updateRelayApiBaseDraft}
              onSettings={setSettings}
              onLogin={(nextSession) => {
                saveRelaySession(nextSession, true);
                setSession(nextSession);
                const nextSettings = (() => {
                  const current = settings;
                  const currentDerivedWss = relayWssFromApiBase(current.relayApiBase);
                  const nextDerivedWss = relayWssFromApiBase(nextSession.apiBase);
                  return {
                    ...current,
                    relayApiBase: nextSession.apiBase,
                    relayWssUrl: !current.relayWssUrl.trim() || current.relayWssUrl.trim() === currentDerivedWss ? nextDerivedWss : current.relayWssUrl,
                  };
                })();
                setSettings(nextSettings);
                saveSettings(nextSettings);
                void persistDesktopRelayState(nextSettings, nextSession);
                setNotice('中转站账号已保存。');
              }}
              onLogout={() => {
                clearRelaySession();
                setSession(null);
                void persistDesktopRelayState(settings, null);
                setNotice('');
              }}
            />

            <Card title="连接配置" subtitle="WSS 是 agent 主动连出去的外网地址，不需要把本机端口暴露到公网。">
              <label className="field">
                <span>中转站 API Base</span>
                <input value={relayDraft.relayApiBase} onChange={(event) => updateRelayApiBaseDraft(event.target.value)} placeholder="https://<your-relay-host>" />
              </label>
              <label className="field">
                <span>中转站 WSS 地址</span>
                <input value={relayDraft.relayWssUrl} onChange={(event) => setRelayDraft((current) => ({ ...current, relayWssUrl: event.target.value }))} placeholder="wss://<your-relay-host>/agent" />
              </label>
              <ToggleRow
                title="启动后自动连接中转站 WSS"
                detail={relayStatusText(session, settings, relayRuntime)}
                checked={relayDraft.autoConnectRelay}
                onChange={(checked) => setRelayDraft((current) => ({ ...current, autoConnectRelay: checked }))}
              />
              <div className="update-row">
                <span>{relayConfigChanged(settings, relayDraft) ? '有未保存的连接配置' : '连接配置已保存'}</span>
                <button className="primary icon-text" type="button" disabled={!relayConfigChanged(settings, relayDraft)} onClick={saveRelayConfig}>
                  <CheckCircle2 size={15} />
                  保存链接配置
                </button>
              </div>
            </Card>
          </SettingsStack>
        )}

        {section === 'codex' && (
          <SettingsStack>
            {!codexDraft ? (
              <Card title="Codex 配置" subtitle="读取本机 Codex 配置文件，按平台自动定位。">
                <button className="icon-text" type="button" onClick={() => void loadCodexConfig()}>
                  <RefreshCw size={15} />
                  读取配置
                </button>
              </Card>
            ) : (
              <>
                <Card title="配置位置" subtitle={codexDraft.exists ? '已读取本机 config.toml。' : '未找到配置文件，保存后会创建。'}>
                  <StatusGrid compact>
                    <Metric icon={<FolderOpen size={17} />} label={codexDraft.platform === 'windows' ? 'Windows 路径' : 'macOS 路径'} value={codexDraft.exists ? '已找到' : '待创建'} detail={codexDraft.path} />
                    <Metric icon={<Cpu size={17} />} label="CODEX_HOME" value={codexDraft.codex_home ? '已定位' : '默认'} detail={codexDraft.codex_home || '~/.codex'} />
                  </StatusGrid>
                </Card>

                <Card title="模型服务" subtitle="只编辑常用模型和 provider 字段，认证信息仍留在 Codex 自己的 auth 文件中。">
                  <div className="config-grid">
                    <label className="field">
                      <span>模型</span>
                      <input value={codexDraft.model} onChange={(event) => updateCodexDraft({ model: event.target.value })} placeholder="gpt-5.2" />
                    </label>
                    <label className="field">
                      <span>模型服务</span>
                      <input value={codexDraft.model_provider} onChange={(event) => updateCodexDraft({ model_provider: event.target.value })} placeholder="codex" />
                    </label>
                  </div>
                  <label className="field">
                    <span>接口地址</span>
                    <input value={codexDraft.base_url} onChange={(event) => updateCodexDraft({ base_url: event.target.value })} placeholder="https://api.openai.com/v1" />
                  </label>
                  <label className="field">
                    <span>API Key</span>
                    <input
                      type="text"
                      value={codexDraft.api_key || ''}
                      onChange={(event) => updateCodexDraft({ api_key: event.target.value })}
                      placeholder="OPENAI_API_KEY"
                      autoComplete="off"
                    />
                  </label>
                  <div className="config-grid">
                    <label className="field">
                      <span>服务名称</span>
                      <input value={codexDraft.provider_name} onChange={(event) => updateCodexDraft({ provider_name: event.target.value })} placeholder="OpenAI" />
                    </label>
                    <label className="field">
                      <span>接口协议</span>
                      <select value={codexDraft.wire_api} onChange={(event) => updateCodexDraft({ wire_api: event.target.value })}>
                        <option value="">默认</option>
                        <option value="responses">Responses API</option>
                        <option value="chat">Chat Completions</option>
                      </select>
                    </label>
                  </div>
                  <ToggleRow
                    title="使用 OpenAI 登录鉴权"
                    detail="写入 provider 的 requires_openai_auth。"
                    checked={codexDraft.requires_openai_auth}
                    onChange={(checked) => updateCodexDraft({ requires_openai_auth: checked })}
                  />
                </Card>

                <Card title="运行与持久化" subtitle="控制推理强度、历史持久化和响应内容存储。">
                  <div className="config-grid">
                    <label className="field">
                      <span>推理强度</span>
                      <select value={codexDraft.model_reasoning_effort} onChange={(event) => updateCodexDraft({ model_reasoning_effort: event.target.value })}>
                        <option value="">默认</option>
                        <option value="minimal">极低</option>
                        <option value="low">低</option>
                        <option value="medium">中</option>
                        <option value="high">高</option>
                        <option value="xhigh">极高</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>历史记录</span>
                      <select value={codexDraft.history_persistence} onChange={(event) => updateCodexDraft({ history_persistence: event.target.value })}>
                        <option value="">默认</option>
                        <option value="save-all">保存全部</option>
                        <option value="none">不保存</option>
                      </select>
                    </label>
                  </div>
                  <ToggleRow
                    title="禁用响应内容存储"
                    detail="写入 disable_response_storage，用于减少本机保留的响应内容。"
                    checked={codexDraft.disable_response_storage}
                    onChange={(checked) => updateCodexDraft({ disable_response_storage: checked })}
                  />
                  <ToggleRow
                    title="启用 Web Search"
                    detail="写入 web_search。"
                    checked={codexDraft.web_search}
                    onChange={(checked) => updateCodexDraft({ web_search: checked })}
                  />
                </Card>

                <Card title="权限" subtitle="配置 Codex 的审批策略、沙箱模式和 workspace-write 网络权限。">
                  <div className="config-grid">
                    <label className="field">
                      <span>审批策略</span>
                      <select value={codexDraft.approval_policy} onChange={(event) => updateCodexDraft({ approval_policy: event.target.value })}>
                        <option value="">默认</option>
                        <option value="never">永不询问</option>
                        <option value="on-request">按需询问</option>
                        <option value="on-failure">失败时询问</option>
                        <option value="untrusted">不受信任</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>沙箱模式</span>
                      <select value={codexDraft.sandbox_mode} onChange={(event) => updateCodexDraft({ sandbox_mode: event.target.value })}>
                        <option value="">默认</option>
                        <option value="read-only">只读</option>
                        <option value="workspace-write">允许写入工作区</option>
                        <option value="danger-full-access">完全访问</option>
                      </select>
                    </label>
                  </div>
                  <ToggleRow
                    title="workspace-write 允许网络"
                    detail="写入 sandbox_workspace_write.network_access。"
                    checked={codexDraft.network_access}
                    onChange={(checked) => updateCodexDraft({ network_access: checked })}
                  />
                </Card>

                <Card title="项目权限" subtitle="按项目配置 trust_level，不显示其它项目原始配置。">
                  <div className="project-list">
                    {codexDraft.projects.length === 0 && <span className="empty-note">还没有项目权限记录。</span>}
                    {codexDraft.projects.map((project, index) => (
                      <div className="project-row" key={project.path || index}>
                        <code>{project.path || '未设置路径'}</code>
                        <select value={project.trust_level} onChange={(event) => updateCodexProject(index, { trust_level: event.target.value })}>
                          <option value="">默认</option>
                          <option value="trusted">信任</option>
                          <option value="untrusted">不信任</option>
                        </select>
                        <button className="icon-button" type="button" title="移除" onClick={() => removeCodexProject(index)}>
                          <LogOut size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="update-row">
                    <button className="icon-text" type="button" onClick={() => void addCodexProject()}>
                      <FolderOpen size={15} />
                      添加项目
                    </button>
                    <button className="primary icon-text" type="button" disabled={loading.desktop || !codexConfigChanged(codexConfig, codexDraft)} onClick={() => void saveCodexConfig()}>
                      {loading.desktop ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
                      保存配置
                    </button>
                  </div>
                </Card>
              </>
            )}
          </SettingsStack>
        )}

        {section === 'about' && (
          <SettingsStack>
            <Card title="主题" subtitle="保留最接近系统设置的三档，减少无意义的装饰主题。">
              <div className="theme-segment">
                <ThemeButton icon={<Laptop size={17} />} label="跟随系统" value="system" current={settings.theme} onClick={updateSettings} />
                <ThemeButton icon={<Sun size={17} />} label="浅色" value="light" current={settings.theme} onClick={updateSettings} />
                <ThemeButton icon={<Moon size={17} />} label="暗黑" value="dark" current={settings.theme} onClick={updateSettings} />
              </div>
            </Card>
            <Card title="Codex Session Bridge" subtitle="后台 agent 的本地配置窗口。">
              <StatusGrid>
                <Metric
                  icon={<Shield size={17} />}
                  label="本机 daemon"
                  value={health?.ok ? '已连接' : '未连接'}
                  detail={eventConnected ? '事件通道在线' : '等待本机健康检查'}
                />
                <Metric icon={<Router size={17} />} label="中转站 WSS" value={relayConnection.value} detail={relayConnection.detail} />
                <Metric icon={<Cpu size={17} />} label="平台" value={desktopPrefs.platform} detail="桌面配置窗口" />
                <Metric icon={<Download size={17} />} label="版本" value={appInfo?.version || desktopPrefs.version || '1.0.0'} detail={appInfo?.repo || 'Codex-Session-Bridge'} />
              </StatusGrid>
              <div className="update-row">
                <button className="icon-text" type="button" disabled={loading.desktop} onClick={() => void checkUpdates()}>
                  {loading.desktop ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                  检查更新
                </button>
                {updateInfo && (
                  <span>
                    {updateInfo.error
                      ? updateInfo.error
                      : updateInfo.updateAvailable
                        ? `发现 ${updateInfo.latestVersion}`
                        : updateInfo.message || `已是最新 ${updateInfo.currentVersion}`}
                  </span>
                )}
                {updateInfo?.releaseUrl && (
                  <button className="icon-button" title="打开 GitHub Releases" type="button" onClick={() => void window.bridgeDesktop?.openUpdatePage?.(updateInfo.releaseUrl)}>
                    <Download size={15} />
                  </button>
                )}
              </div>
            </Card>
          </SettingsStack>
        )}
      </main>

    </div>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SettingsStack({ children }: { children: ReactNode }) {
  return <section className="settings-stack">{children}</section>;
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      <div className="card-head">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

function StatusGrid({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return <div className={`status-grid ${compact ? 'compact' : ''}`}>{children}</div>;
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`status-pill ${ok ? 'ok' : ''}`}>
      {ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
      {label}
    </span>
  );
}

function relayConnectionState(session: RelaySession | null, settings: BridgeSettings, status: RelayRuntimeStatus | null) {
  if (!session) {
    return { value: '未登录', detail: '登录后才会使用 token 连接' };
  }
  const wssUrl = settings.relayWssUrl.trim();
  if (!wssUrl) {
    return { value: '未配置', detail: '需要填写 WSS 地址' };
  }
  if (!settings.autoConnectRelay) {
    return { value: '未自动连接', detail: wssUrl };
  }
  if (status?.connected) {
    return { value: '已连接', detail: status.last_seen ? `最后心跳 ${formatTime(status.last_seen)}` : wssUrl };
  }
  if (status?.state === 'connecting') {
    return { value: '正在连接', detail: wssUrl };
  }
  if (status?.state === 'retrying') {
    return { value: '重试中', detail: status.last_error || wssUrl };
  }
  if (status?.last_error) {
    return { value: '连接失败', detail: status.last_error };
  }
  return { value: '等待后台接入', detail: wssUrl };
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

function normalizePort(value: string) {
  const port = value.trim();
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric < 1024 || numeric > 65535) return '';
  return String(numeric);
}

function normalizeRelayApiBase(value: string) {
  let base = value.trim();
  if (!base) return '';
  base = base.replace(/\/?v0\/management\/?$/i, '');
  base = base.replace(/\/+$/g, '');
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base;
}

function relayWssFromApiBase(value: string) {
  const base = normalizeRelayApiBase(value);
  if (!base) return '';
  try {
    const url = new URL(base);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    url.pathname = '/agent';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function relayConfigChanged(
  saved: BridgeSettings,
  draft: Pick<BridgeSettings, 'relayApiBase' | 'relayWssUrl' | 'autoConnectRelay'>,
) {
  return (
    normalizeRelayApiBase(saved.relayApiBase) !== normalizeRelayApiBase(draft.relayApiBase) ||
    saved.relayWssUrl.trim() !== draft.relayWssUrl.trim() ||
    saved.autoConnectRelay !== draft.autoConnectRelay
  );
}

function normalizeCodexConfigDraft(config: CodexConfig): CodexConfig {
  const projects = config.projects
    .map((project) => ({ path: project.path.trim(), trust_level: project.trust_level.trim() }))
    .filter((project) => project.path)
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    ...config,
    model: config.model.trim(),
    model_provider: config.model_provider.trim() || 'codex',
    model_reasoning_effort: config.model_reasoning_effort.trim(),
    approval_policy: config.approval_policy.trim(),
    sandbox_mode: config.sandbox_mode.trim(),
    file_opener: config.file_opener.trim(),
    history_persistence: config.history_persistence.trim(),
    base_url: config.base_url.trim(),
    provider_name: config.provider_name.trim(),
    wire_api: config.wire_api.trim(),
    api_key: config.api_key?.trim() || '',
    projects,
  };
}

function codexConfigChanged(saved: CodexConfig | null, draft: CodexConfig | null) {
  if (!draft) return false;
  if (!saved) return true;
  return JSON.stringify(normalizeCodexConfigDraft(saved)) !== JSON.stringify(normalizeCodexConfigDraft(draft));
}

function Metric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <code>{detail}</code>
      </div>
    </div>
  );
}

function ToggleRow({
  title,
  detail,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`toggle-row ${disabled ? 'disabled' : ''}`}>
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function ThemeButton({
  icon,
  label,
  value,
  current,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: ThemeName;
  current: ThemeName;
  onClick: (patch: Partial<BridgeSettings>) => void;
}) {
  return (
    <button className={`theme-option ${current === value ? 'active' : ''}`} onClick={() => onClick({ theme: value })}>
      {icon}
      {label}
    </button>
  );
}

function RelayLoginCard({
  settings,
  session,
  onApiBaseChange,
  onSettings,
  onLogin,
  onLogout,
}: {
  settings: BridgeSettings;
  session: RelaySession | null;
  onApiBaseChange: (value: string) => void;
  onSettings: (settings: BridgeSettings) => void;
  onLogin: (session: RelaySession) => void;
  onLogout: () => void;
}) {
  const [apiBase, setApiBase] = useState(session?.apiBase || settings.relayApiBase);
  const [username, setUsername] = useState(session?.username || '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const next = await loginRelay(apiBase, username, password);
      onSettings({ ...settings, relayApiBase: next.apiBase });
      onLogin(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  if (session) {
    return (
      <Card title="中转站账号" subtitle="已登录，后台 agent 会使用这个 token 进行设备注册和 WSS 鉴权。">
        <div className="account-card">
          <div className="account-avatar">
            <Shield size={17} />
          </div>
          <div>
            <strong>{session.username}</strong>
            <span>{session.apiBase}</span>
          </div>
          <button className="icon-text" onClick={onLogout}>
            <LogOut size={15} />
            退出
          </button>
        </div>
      </Card>
    );
  }

  return (
    <section className="settings-group login-card">
      <form className="card-body" onSubmit={(event) => void submit(event)}>
        <div className="card-head">
          <h2>中转站登录</h2>
          <p>登录后设备会使用 token 注册和连接 WSS，Codex/OpenAI 凭据仍留在本机。</p>
        </div>
        {error && <div className="alert compact">{error}</div>}
        <label className="field">
          <span>中转站 API Base</span>
          <input
            value={apiBase}
            onChange={(event) => {
              setApiBase(event.target.value);
              onApiBaseChange(event.target.value);
            }}
            placeholder="https://<your-relay-host>"
          />
        </label>
        <label className="field">
          <span>用户名</span>
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </label>
        <label className="field">
          <span>密码</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
        </label>
        <div className="login-actions">
          <span>登录信息会保存在本机</span>
          <button className="primary icon-text" disabled={loading || !username.trim() || !password}>
            {loading ? <Loader2 className="spin" size={16} /> : <LogIn size={16} />}
            登录
          </button>
        </div>
      </form>
    </section>
  );
}

export { App };
