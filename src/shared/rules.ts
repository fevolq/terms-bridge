/** Browser and backend share defaults and validation rules, not host services. */
export const API_PREFIX = '/api/terms-bridge';
export const API_PATTERN = /^\/[A-Za-z0-9_/-]+[A-Za-z0-9_-]$/;
export const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const FILE_ID = /^file_[a-f0-9]{32}$/;
export const TOKEN_PATTERN = /^[\x21-\x7e]*$/;
export const PERMISSIONS = ['read-only', 'workspace-write', 'auto', 'danger-full-access'] as const;
export const DEFAULTS = {
  permission_mode: 'workspace-write' as const, max_concurrency: 0,
  max_execution_retries: 3, execution_timeout_seconds: 1800,
  retry_interval_seconds: 60, callback_timeout_seconds: 10,
};
export const LIMITS = {
  json: 1024 * 1024, instruction: 32768, file: 50 * 1024 * 1024,
  files: 20, totalFiles: 200 * 1024 * 1024, numeric: 2_000_000,
  executionRetries: 10000, callbackAttempts: 11, callbackInterval: 60_000,
  transferTimeout: 120_000, uploadsPerProject: 2, uploads: 8,
};
export function callbackUrlValid(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}
export function callbackHeadersError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '请填写 JSON 对象，键和值都使用字符串。';
  const entries = Object.entries(value);
  if (entries.length > 32 || new TextEncoder().encode(JSON.stringify(value)).length > 8192) return '请求头最多 32 项，JSON 总大小不能超过 8 KiB。';
  const reserved = new Set(['content-type', 'x-dsh-protocol-version', 'host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect', 'proxy-connection', 'proxy-authorization', '__proto__', 'constructor', 'prototype']);
  const seen = new Set<string>();
  for (const [name, header] of entries) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return '请求头名称格式不正确，不能包含空格或中文。';
    const key = name.toLowerCase();
    if (reserved.has(key)) return 'Content-Type、X-DSH-Protocol-Version 和连接控制请求头由插件管理，请移除这些字段。';
    if (seen.has(key)) return '请求头名称不能重复，大小写不同也视为重复。';
    if (typeof header !== 'string') return '请求头的值必须是字符串，不能是数字、数组或对象。';
    if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(header)) return '请求头值请使用 HTTP 支持的字符，不可包含换行。';
    seen.add(key);
  }
  return null;
}
