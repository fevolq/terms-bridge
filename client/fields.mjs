import { API_PREFIX, API_PATTERN, DEFAULTS, LIMITS, PERMISSIONS, PROJECT_ID, TOKEN_PATTERN, callbackHeadersError, callbackUrlValid } from '../dist/shared/rules.js';

export const DEFAULT_CONFIG = { api_prefix: API_PREFIX, projects: {} };
export const DEFAULT_PROJECT = { ...DEFAULTS, name: '', workspace_path: '', provider: '', model: '', agent_preset: '',
  max_concurrency: '', callback_url: '', request_token: '', callback_headers: '' };
export const FIELDS = [
  { name: 'name', label: '项目名称', placeholder: '例如：新闻摘要服务' },
  { name: 'workspace_path', label: '工作区路径', wide: true, placeholder: '例如：~/Documents/test', hint: '可留空：按 dsh 的 Documents 目录配置自动创建以项目 ID 命名的文件夹。' },
  { name: 'provider', label: '模型提供方', required: true, hidden: true },
  { name: 'model', label: '模型', required: true, wide: true },
  { name: 'agent_preset', label: 'Agent 预设', required: true },
  { name: 'permission_mode', label: '权限模式', required: true, options: PERMISSIONS.map((id, index) => [id, ['仅可查看', '工作区内修改', '自动审查', '完全权限'][index]]) },
  { name: 'max_concurrency', label: '最大并发', min: 0, placeholder: '留空或 0 表示不限制', advanced: true, wide: true,
    tip: '留空或 0 表示不限制；正整数表示同时执行的任务上限，超出的任务按顺序排队。' },
  { name: 'callback_url', label: '结果回调地址', required: true, wide: true, placeholder: 'https://example.com/api/dsh/results' },
  { name: 'request_token', label: '请求令牌', secret: true, placeholder: '可选', tip: 'Authorization: Bearer <令牌>' },
  { name: 'callback_headers', label: '回调请求头（JSON）', json: true, wide: true, placeholder: '{\n  "Authorization": "Bearer xxx",\n  "X-API-Key": "xxx"\n}' },
  { name: 'max_execution_retries', label: '执行重试次数', min: 0, max: LIMITS.executionRetries, advanced: true },
  { name: 'retry_interval_seconds', label: '执行重试间隔（秒）', min: 1, advanced: true },
  { name: 'execution_timeout_seconds', label: '执行超时（秒）', min: 1, advanced: true },
  { name: 'callback_timeout_seconds', label: '单次回调超时（秒）', min: 1, advanced: true, tip: '回调固定重试 10 次，间隔 60 秒（加上首次发送，最多 11 次）。回调失败不会重新执行业务。' },
];
export function validateDraft(draft) {
  const errors = {}, config = { api_prefix: draft.api_prefix.trim(), projects: {} };
  if (!API_PATTERN.test(config.api_prefix)) errors.api_prefix = '填写以 / 开头且不以 / 结尾的接口路径。';
  const ids = new Set(), paths = new Set();
  for (const row of draft.rows) {
    const id = row.id.trim(), fail = (field, text) => { errors[row.key + '.' + field] = text; };
    if (!PROJECT_ID.test(id)) fail('id', '使用 1–64 位小写字母、数字、短横线或下划线，首位为字母或数字。');
    if (ids.has(id)) fail('id', '项目 ID 不能重复。');
    ids.add(id);
    const project = row.created_at ? { created_at: row.created_at } : {};
    for (const field of FIELDS) {
      const raw = String(row[field.name] ?? ''), text = field.secret ? raw : raw.trim();
      if (field.min !== undefined) {
        const value = Number(text);
        if ((!text && field.name !== 'max_concurrency') || !Number.isInteger(value) || value < field.min || value > (field.max ?? LIMITS.numeric)) fail(field.name, `请输入 ${field.min}–${field.max ?? LIMITS.numeric} 之间的整数。`);
        else project[field.name] = value;
      } else if (field.json) {
        try {
          const value = text ? JSON.parse(text) : {}, error = callbackHeadersError(value);
          if (error) fail(field.name, error); else project[field.name] = value;
        } catch { fail(field.name, 'JSON 格式不正确，请使用双引号并检查逗号。'); }
      } else {
        if (field.options && !field.options.some(([id]) => id === text)) fail(field.name, '请选择' + field.label + '。');
        if (!text && field.required) fail(field.name, '请填写' + field.label + '。');
        if (text) project[field.name] = text;
      }
    }
    const path = project.workspace_path;
    if (path) {
      if (!/^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|~(?:\/|$))/.test(path)) fail('workspace_path', '请填写绝对目录或以 ~/ 开头的目录。');
      const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
      const key = /^[A-Za-z]:|^\/\//.test(normalized) ? normalized.toLowerCase() : normalized;
      if (paths.has(key)) fail('workspace_path', '一个工作区目录只能分配给一个项目。');
      paths.add(key);
    }
    if (project.callback_url && !callbackUrlValid(project.callback_url)) fail('callback_url', '填写有效的 HTTP(S) 地址，不含用户名、密码或 # 片段。');
    if (project.request_token && !TOKEN_PATTERN.test(project.request_token)) fail('request_token', '令牌只能包含可打印的 ASCII 字符，不能包含空格或换行。');
    Object.defineProperty(config.projects, id, { value: project, enumerable: true, configurable: true });
  }
  return { config, errors };
}
