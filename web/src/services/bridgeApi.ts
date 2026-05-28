import type { BridgeSettings, RelaySession } from './storage';
import type { SkillInstallResult, SkillListResponse, SkillRunResult } from './skillRegistry';

export interface DeviceInfo {
  device_id: string;
  user_id?: string;
  name: string;
  platform: string;
  hostname: string;
  daemon_version: string;
  codex_cli_version?: string;
  last_seen: string;
  online: boolean;
  revoked: boolean;
}

export interface HealthInfo {
  ok: boolean;
  device_id: string;
  time: string;
}

export interface RelayRuntimeStatus {
  enabled: boolean;
  connected: boolean;
  state: string;
  wss_url?: string;
  username?: string;
  last_error?: string;
  last_attempt?: string;
  connected_at?: string;
  last_seen?: string;
}

export interface CodexThread {
  id: string;
  sessionId?: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  updatedAt?: number;
  createdAt?: number;
  status?: { type?: string };
  modelProvider?: string;
  source?: string;
  path?: string;
}

export interface TextContent {
  type: string;
  text?: string;
  url?: string;
  [key: string]: unknown;
}

export interface ThreadItem {
  id?: string;
  type: string;
  phase?: string;
  text?: string;
  content?: TextContent[];
  [key: string]: unknown;
}

export interface ThreadTurn {
  id: string;
  status: string;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  error?: unknown;
  items?: ThreadItem[];
  itemsView?: string;
}

export interface ThreadListResponse {
  data: CodexThread[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface ThreadHistoryResponse {
  thread: CodexThread;
  turns: ThreadTurn[];
  cursor?: string | null;
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface BridgeEvent {
  type: string;
  device_id?: string;
  codex_method?: string;
  codex_params?: Record<string, unknown>;
  received_at?: string;
  [key: string]: unknown;
}

export interface LoginResponse {
  authenticated?: boolean;
  role?: 'admin' | 'user';
  username?: string;
  token?: string;
  expires_at?: string;
}

export interface CodexProjectConfig {
  path: string;
  trust_level: string;
}

export interface CodexConfig {
  path: string;
  codex_home: string;
  platform: string;
  exists: boolean;
  profile: string;
  model: string;
  model_provider: string;
  model_reasoning_effort: string;
  approval_policy: string;
  sandbox_mode: string;
  file_opener: string;
  web_search: boolean;
  disable_response_storage: boolean;
  history_persistence: string;
  base_url: string;
  provider_name: string;
  requires_openai_auth: boolean;
  wire_api: string;
  api_key_configured: boolean;
  api_key?: string;
  network_access: boolean;
  projects: CodexProjectConfig[];
  warnings?: string[];
}

export interface CodexModelSource {
  id: string;
  type: string;
  name: string;
  base_url: string;
  endpoint: string;
  auth: string;
  status: string;
  models: number;
  message?: string;
}

export interface CodexModelCatalog {
  status: string;
  path: string;
  model: string;
  model_provider: string;
  provider_name: string;
  default_model: string;
  models: string[];
  sources: CodexModelSource[];
  message?: string;
}

export interface CodexRestartResult {
  restarted: boolean;
}

function normalizeApiBase(input: string): string {
  let base = input.trim();
  if (!base) return '';
  base = base.replace(/\/?v0\/management\/?$/i, '');
  base = base.replace(/\/+$/g, '');
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base;
}

function daemonUrl(settings: BridgeSettings, path: string) {
  const base = settings.daemonBase.trim().replace(/\/+$/g, '');
  return `${base}${path}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error?: unknown }).error || '请求失败')
        : data && typeof data === 'object' && 'message' in data
          ? String((data as { message?: unknown }).message || '请求失败')
          : typeof data === 'string' && data.trim()
            ? data
            : '请求失败';
    throw new Error(message);
  }
  return data as T;
}

export const bridgeApi = {
  health: (settings: BridgeSettings) => request<HealthInfo>(daemonUrl(settings, '/health')),
  device: (settings: BridgeSettings) => request<DeviceInfo>(daemonUrl(settings, '/v1/device')),
  relayStatus: (settings: BridgeSettings) => request<RelayRuntimeStatus>(daemonUrl(settings, '/v1/relay/status')),
  codexConfig: (settings: BridgeSettings) => request<CodexConfig>(daemonUrl(settings, '/v1/codex/config')),
  codexModelCatalog: (settings: BridgeSettings, config: CodexConfig) =>
    request<CodexModelCatalog>(daemonUrl(settings, '/v1/codex/model-catalog'), {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  updateCodexConfig: (settings: BridgeSettings, config: CodexConfig) =>
    request<CodexConfig>(daemonUrl(settings, '/v1/codex/config'), {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  restartCodex: (settings: BridgeSettings) =>
    request<CodexRestartResult>(daemonUrl(settings, '/v1/codex/restart'), {
      method: 'POST',
    }),
  configureRelay: (settings: BridgeSettings, session: RelaySession | null) =>
    request<RelayRuntimeStatus>(daemonUrl(settings, '/v1/relay/config'), {
      method: 'PUT',
      body: JSON.stringify({
        enabled: Boolean(session && settings.autoConnectRelay),
        wss_url: settings.relayWssUrl,
        token: session?.token || '',
        username: session?.username || '',
      }),
    }),
  threads: (settings: BridgeSettings) => request<ThreadListResponse>(daemonUrl(settings, '/v1/threads')),
  history: (
    settings: BridgeSettings,
    threadId: string,
    options: { cursor?: string | null; limit?: number; sortDirection?: 'asc' | 'desc' } = {},
  ) => {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit || 12));
    params.set('sortDirection', options.sortDirection || 'desc');
    if (options.cursor) params.set('cursor', options.cursor);
    return request<ThreadHistoryResponse>(
      daemonUrl(settings, `/v1/threads/${encodeURIComponent(threadId)}/history?${params.toString()}`),
    );
  },
  createThread: (settings: BridgeSettings, cwd: string) =>
    request<Record<string, unknown>>(daemonUrl(settings, '/v1/threads'), {
      method: 'POST',
      body: JSON.stringify({ cwd: cwd || undefined }),
    }),
  sendTurn: (settings: BridgeSettings, threadId: string, content: string) =>
    request<Record<string, unknown>>(daemonUrl(settings, `/v1/threads/${encodeURIComponent(threadId)}/turns`), {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  interrupt: (settings: BridgeSettings, threadId: string, turnId: string) =>
    request<Record<string, unknown>>(daemonUrl(settings, `/v1/threads/${encodeURIComponent(threadId)}/interrupt`), {
      method: 'POST',
      body: JSON.stringify({ turn_id: turnId }),
    }),

  // --- Skills ---
  skillList: (settings: BridgeSettings) =>
    request<SkillListResponse>(daemonUrl(settings, '/v1/skills')),

  skillInstall: (settings: BridgeSettings, skillId: string) =>
    request<SkillInstallResult>(daemonUrl(settings, '/v1/skills/install'), {
      method: 'POST',
      body: JSON.stringify({ skillId }),
    }),

  skillUpgrade: (settings: BridgeSettings, skillId: string) =>
    request<SkillInstallResult>(daemonUrl(settings, '/v1/skills/upgrade'), {
      method: 'POST',
      body: JSON.stringify({ skillId }),
    }),

  skillRun: (settings: BridgeSettings, skillId: string, command: string, args?: string[], dir?: string) =>
    request<SkillRunResult>(daemonUrl(settings, '/v1/skills/run'), {
      method: 'POST',
      body: JSON.stringify({ skillId, command, args, dir }),
    }),
};

export async function loginRelay(apiBase: string, username: string, password: string): Promise<RelaySession> {
  const normalized = normalizeApiBase(apiBase);
  const response = await request<LoginResponse>(`${normalized}/v0/management/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ username: username.trim().toLowerCase(), password }),
  });
  if (!response.token) {
    throw new Error('登录接口未返回 token');
  }
  return {
    apiBase: normalized,
    token: response.token,
    username: response.username || username.trim().toLowerCase(),
    role: response.role === 'admin' ? 'admin' : 'user',
    expiresAt: response.expires_at,
  };
}

export function eventsUrl(settings: BridgeSettings) {
  const base = settings.daemonBase.trim();
  const url = new URL(`${base || window.location.origin}/v1/events`, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function relayStatusText(session: RelaySession | null, settings: BridgeSettings, status?: RelayRuntimeStatus | null) {
  if (!session) return '未登录';
  if (!settings.relayWssUrl.trim()) return '未配置 WSS';
  if (status?.connected) return `已连接 ${status.username || session.username}`;
  if (status?.state === 'connecting') return '正在连接中转站';
  if (status?.state === 'retrying') return status.last_error ? `重试中：${status.last_error}` : '连接断开，正在重试';
  if (status?.state === 'missing_token') return '缺少登录 token';
  return settings.autoConnectRelay ? '等待 daemon 接入' : '已保存，未自动连接';
}
