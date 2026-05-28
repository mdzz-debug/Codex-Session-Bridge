export type ThemeName = 'system' | 'light' | 'dark';
export type SettingsSection = 'general' | 'relay' | 'codex' | 'about';

export interface BridgeSettings {
  daemonBase: string;
  relayApiBase: string;
  relayWssUrl: string;
  theme: ThemeName;
  autoConnectRelay: boolean;
}

export interface RelaySession {
  apiBase: string;
  token: string;
  username: string;
  role: 'admin' | 'user';
  expiresAt?: string;
}

const SETTINGS_KEY = 'csb.settings.v1';
const SESSION_KEY = 'csb.relay.session.v1';
const SECTION_KEY = 'csb.desktop.section.v1';
const LEGACY_RELAY_HOSTS = [atob('emMubHVvaGFvLm9ubGluZQ==')];

export const defaultSettings: BridgeSettings = {
  daemonBase: '',
  relayApiBase: '',
  relayWssUrl: '',
  theme: 'system',
  autoConnectRelay: false,
};

export function readSettings(): BridgeSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    const parsed = { ...defaultSettings, ...(JSON.parse(raw) as Partial<BridgeSettings>) };
    if (!['system', 'light', 'dark'].includes(parsed.theme)) parsed.theme = 'system';
    parsed.relayApiBase = scrubLegacyRelayUrl(parsed.relayApiBase);
    parsed.relayWssUrl = scrubLegacyRelayUrl(parsed.relayWssUrl);
    return parsed;
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(settings: BridgeSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function readRelaySession(): RelaySession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RelaySession>;
    const apiBase = scrubLegacyRelayUrl(parsed.apiBase || '');
    if (!apiBase && parsed.apiBase) {
      clearRelaySession();
      return null;
    }
    if (!parsed.apiBase || !parsed.token || !parsed.username) return null;
    return {
      apiBase,
      token: parsed.token,
      username: parsed.username,
      role: parsed.role === 'admin' ? 'admin' : 'user',
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export function saveRelaySession(session: RelaySession, persistent: boolean) {
  const raw = JSON.stringify(session);
  if (persistent) {
    localStorage.setItem(SESSION_KEY, raw);
    sessionStorage.removeItem(SESSION_KEY);
  } else {
    sessionStorage.setItem(SESSION_KEY, raw);
    localStorage.removeItem(SESSION_KEY);
  }
}

export function clearRelaySession() {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}

export function readDesktopSection(): SettingsSection {
  try {
    const value = localStorage.getItem(SECTION_KEY);
    if (value === 'appearance') return 'about';
    return value === 'relay' || value === 'codex' || value === 'about' ? value : 'general';
  } catch {
    return 'general';
  }
}

export function saveDesktopSection(section: SettingsSection) {
  localStorage.setItem(SECTION_KEY, section);
}

function scrubLegacyRelayUrl(value: string) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  return LEGACY_RELAY_HOSTS.some((host) => lower.includes(host)) ? '' : trimmed;
}
