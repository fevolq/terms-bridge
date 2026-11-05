import Schema from '@deepseek-ai/schemastery';
import { API_PATTERN, API_PREFIX, DEFAULTS, LIMITS, PERMISSIONS, TOKEN_PATTERN } from '../shared/rules.js';
import { parseConfig } from '../projects/config.js';
import { validateProjectWorkspaces } from '../projects/workspaces.js';
import type { ResolvedProject } from '../domain/types.js';
import type { TaskStore } from '../storage/tasks.js';
import type { Host } from './host.js';

const integer = (min: number, max = LIMITS.numeric) => Schema.number().step(1).min(min).max(max);
const project = Schema.object({
  name: Schema.string().min(1), workspace_path: Schema.string(),
  provider: Schema.string().min(1).required(), model: Schema.string().min(1).required(), agent_preset: Schema.string(),
  permission_mode: Schema.union([...PERMISSIONS]).default(DEFAULTS.permission_mode),
  max_concurrency: integer(0).default(DEFAULTS.max_concurrency),
  callback_url: Schema.string().pattern(/^https?:\/\/[^\s]+$/).required(),
  request_token: Schema.string().pattern(TOKEN_PATTERN).role('secret'), callback_headers: Schema.dict(Schema.string()).default({}),
  max_execution_retries: integer(0, LIMITS.executionRetries).default(DEFAULTS.max_execution_retries),
  execution_timeout_seconds: integer(1).default(DEFAULTS.execution_timeout_seconds),
  retry_interval_seconds: integer(1).default(DEFAULTS.retry_interval_seconds),
  callback_timeout_seconds: integer(1).default(DEFAULTS.callback_timeout_seconds),
});
export const Config = Schema.object({
  api_prefix: Schema.string().pattern(API_PATTERN).default(API_PREFIX).volatile(),
  projects: Schema.dict(project).default({}).volatile(),
});
export function readConfig(raw: unknown): unknown {
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([key, value]) => {
    const resolved = value && typeof value === 'object' && 'get' in value && typeof value.get === 'function' ? value.get() : value;
    return [key, structuredClone(resolved)];
  }));
}
export function watchProjectConfig(host: Host, projects: ReadonlyMap<string, ResolvedProject>, store: TaskStore): (() => void) | undefined {
  if (!host.fiber) return;
  return host.on?.('internal/config', function (value, next) {
    const candidate = typeof next === 'function' ? next() : value;
    if (this !== host.fiber) return candidate;
    const config = parseConfig(candidate);
    validateProjectWorkspaces(host, config, projects);
    for (const [, task] of store.list()) {
      const id = task.request.metadata.project_id;
      if (store.active(task) && !Object.hasOwn(config.projects, id)) throw new Error(`项目 ${id} 仍有未完成任务，请等待任务执行和结果回调结束后再移除`);
    }
    return candidate;
  });
}
