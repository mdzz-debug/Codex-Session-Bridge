import type { ThreadItem } from './bridgeApi';

export function formatDate(value?: number | string | null) {
  if (!value) return '未知';
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(ms)) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

export function itemRole(item: ThreadItem) {
  if (item.type === 'userMessage') return '你';
  if (item.phase === 'final_answer') return 'Codex';
  if (item.phase === 'commentary') return '状态';
  if (item.type === 'agentMessage') return 'Codex';
  if (item.type === 'commandExecution') return '命令';
  if (item.type === 'fileChange') return '文件';
  return item.type || '事件';
}

export function itemText(item: ThreadItem) {
  if (typeof item.text === 'string') return sanitizeLocalPaths(item.text);
  if (Array.isArray(item.content)) {
    const text = item.content
      .map((entry) => {
        if (entry.type === 'text') return entry.text || '';
        if (entry.type === 'image') return '[图片]';
        return `[${entry.type}]`;
      })
      .filter(Boolean)
      .join('\n');
    return sanitizeLocalPaths(text);
  }
  return itemSummary(item);
}

export function itemSummary(item: ThreadItem) {
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes
      .map((change) => (change && typeof change === 'object' && 'path' in change ? String(change.path || '') : ''))
      .filter(Boolean);
    if (paths.length === 1) return `文件变更：${compactPath(paths[0])}`;
    if (paths.length > 1) return `文件变更：${paths.length} 个文件`;
    return '文件变更';
  }
  if (item.type === 'webSearch') {
    const query = typeof item.query === 'string' && item.query.trim() ? item.query.trim() : webSearchLabel(item.action);
    return query ? `网页检索：${truncateText(query, 120)}` : '网页检索';
  }
  if (item.type === 'commandExecution') {
    const command = typeof item.command === 'string' ? item.command : typeof item.cmd === 'string' ? item.cmd : '';
    return command ? `命令：${truncateText(command, 120)}` : '命令执行';
  }
  return item.type || '事件';
}

export function itemDetail(item: ThreadItem) {
  if (item.type === 'fileChange' && Array.isArray(item.changes)) {
    return item.changes
      .map((change) => {
        if (!change || typeof change !== 'object') return '';
        const record = change as Record<string, unknown>;
        const path = typeof record.path === 'string' ? compactPath(record.path) : '未知文件';
        const diff = typeof record.diff === 'string' ? truncateText(sanitizeLocalPaths(record.diff), 2400) : '';
        return `${path}${diff ? `\n${diff}` : ''}`;
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return truncateText(sanitizeLocalPaths(JSON.stringify(item, jsonReplacer, 2)), 2400);
}

export function isConversationItem(item: ThreadItem) {
  return item.type === 'userMessage' || item.type === 'agentMessage';
}

export function compactPath(path: string) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join('/');
}

export function truncateText(text: string, max = 1200) {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n...`;
}

export function sanitizeLocalPaths(text: string) {
  return text.replace(/(?:\/Users\/[^\s)\]]+|\/home\/[^\s)\]]+|[A-Za-z]:\\Users\\[^\s)\]]+)/g, (match) =>
    compactPath(match.replace(/\\/g, '/')),
  );
}

function webSearchLabel(action: unknown) {
  if (!action || typeof action !== 'object') return '';
  const record = action as Record<string, unknown>;
  if (typeof record.url === 'string' && record.url) return record.url;
  if (typeof record.query === 'string' && record.query) return record.query;
  if (typeof record.pattern === 'string' && record.pattern) return record.pattern;
  if (Array.isArray(record.queries)) return record.queries.map(String).join(', ');
  return typeof record.type === 'string' ? record.type : '';
}

function jsonReplacer(key: string, value: unknown) {
  if (key === 'url' && typeof value === 'string' && value.startsWith('data:image/')) {
    return '[内嵌图片数据]';
  }
  if (typeof value === 'string') return truncateText(value, 1200);
  return value;
}
