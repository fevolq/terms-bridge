import Schema from '@deepseek-ai/schemastery';
import { API_PATTERN, API_PREFIX, DEFAULTS, LIMITS, PERMISSIONS, TOKEN_PATTERN } from '../shared/rules.js';
import { parseConfig } from '../projects/config.js';
import { validateProjectWorkspaces } from '../projects/workspaces.js';
import type { ProjectState } from '../domain/types.js';
import type { TaskStore } from '../storage/tasks.js';
import type { Host } from './host.js';

const integer = (min: number, max = LIMITS.numeric) => Schema.number().step(1).min(min).max(max);
const project = Schema.object({
  name: Schema.string().min(1), created_at: Schema.string(), workspace_path: Schema.string(),
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
/** Persist missing timestamps after startup through DSH's serialized configuration editor. */
export function initializeProjectTimestamps(host: Host, raw: unknown): void {
  const owner = host.fiber;
  if (!owner) return;
  host.inject?.(['configEditor'], scope => {
    void (async () => {
      // Editing an initializing plugin would wait for its own Loader reconciliation.
      await owner.await();
      if (owner.state !== 2 || Object.values(parseConfig(readConfig(raw)).projects).every(project => project.created_at)) return;
      const entry = scope.configEditor.entries().find(entry => entry.fiber === owner);
      if (!entry) throw new Error('Project configuration entry is unavailable');
      await scope.configEditor.edit(entry, current => {
        const config = parseConfig(current), created_at = new Date().toISOString();
        const projects = { ...(current.projects as Record<string, object>) };
        for (const [id, project] of Object.entries(config.projects)) {
          if (!project.created_at) projects[id] = { ...projects[id], created_at };
        }
        return { ...current, projects };
      });
    })().catch(error => host.logger?.('terms-bridge').error('Project creation time initialization failed: ' + (error instanceof Error ? error.message : String(error))));
  });
}
export function watchProjectConfig(host: Host, projects: ReadonlyMap<string, ProjectState>, store: TaskStore): (() => void) | undefined {
  if (!host.fiber) return;
  return host.on?.('internal/config', function (value, next) {
    const candidate = typeof next === 'function' ? next() : value;
    if (this !== host.fiber) return candidate;
    const config = parseConfig(candidate);
    // Only new manual paths can be checked synchronously; automatic additions await the native lookup during creation.
    if (Object.entries(config.projects).some(([id, project]) => !projects.has(id) && project.workspace_path)) {
      const manual = Object.fromEntries(Object.entries(config.projects).filter(([id, project]) => projects.has(id) || project.workspace_path));
      validateProjectWorkspaces({ ...config, projects: manual }, projects);
    }
    for (const [, task] of store.list()) {
      const id = task.request.metadata.project_id;
      if (store.active(task) && !Object.hasOwn(config.projects, id)) throw new Error(`项目 ${id} 仍有未完成任务，请等待任务执行和结果回调结束后再移除`);
    }
    return candidate;
  });
}
