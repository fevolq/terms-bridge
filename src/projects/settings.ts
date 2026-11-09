import { z } from 'zod';
import { parseConfig, projectSchema } from './config.js';
import { workspaceBindings } from './workspaces.js';
import type { PluginConfig, ProjectState } from '../domain/types.js';
import { PROJECT_ID } from '../shared/rules.js';
import { BridgeDatabase } from '../storage/database.js';

import { parseOperations } from '../shared/settings.js';
const fields = new Set(Object.keys(projectSchema.shape));
export interface SettingsView { value: PluginConfig; revision: number; writable: boolean; secrets: { path: string[]; set: boolean }[] }
export class ConfigurationError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export function mutateConfig(current: PluginConfig, input: unknown): PluginConfig {
  const operations = parseOperations(input), next = structuredClone(current);
  for (const operation of operations) {
    const [root, id, field] = operation.path;
    if (root === 'api_prefix' && operation.path.length === 1 && operation.op === 'set') {
      next.api_prefix = operation.value as string; continue;
    }
    if (root !== 'projects' || !id || !PROJECT_ID.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new ConfigurationError('INVALID_CONFIG', '配置字段路径无效');
    if (operation.path.length === 2) {
      if (operation.op === 'unset') delete next.projects[id];
      else {
        if (Object.hasOwn(current.projects, id)) throw new ConfigurationError('INVALID_CONFIG', '已有项目必须按字段修改');
        next.projects[id] = { ...projectSchema.parse(operation.value), name: id, created_at: new Date().toISOString() };
        const value = operation.value as Record<string, unknown>;
        if (typeof value.name === 'string') next.projects[id]!.name = value.name;
      }
    } else {
      if (!field || !fields.has(field) || field === 'created_at' || !Object.hasOwn(next.projects, id)) throw new ConfigurationError('INVALID_CONFIG', '项目配置字段无效');
      if (field === 'workspace_path' && Object.hasOwn(current.projects, id)) throw new ConfigurationError('INVALID_CONFIG', '项目保存后工作区路径不可修改');
      const project = next.projects[id]! as unknown as Record<string, unknown>;
      if (operation.op === 'unset') delete project[field]; else project[field] = operation.value;
    }
  }
  return parseConfig(next);
}

/** One write queue owns validation, persistence and runtime activation. */
export class ProjectSettings {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private database: BridgeDatabase, private writable: () => boolean,
    private activate: (config: PluginConfig, persist: (projects: Map<string, ProjectState>) => void) => Promise<void>) {}
  view(): SettingsView {
    const { config, revision } = this.database.readSettings(), secrets: SettingsView['secrets'] = [];
    for (const [id, project] of Object.entries(config.projects)) {
      secrets.push({ path: ['projects', id, 'request_token'], set: !!project.request_token });
      delete project.request_token;
    }
    return { value: config, revision, writable: !this.closed && this.writable(), secrets };
  }
  async mutate(ops: unknown, revision: unknown) {
    const operation = this.queue.then(async () => {
      let candidate: PluginConfig | undefined;
      try {
        if (this.closed || !this.writable()) throw new ConfigurationError('READ_ONLY', '当前配置不可写');
        const current = this.database.readSettings();
        if (!Number.isSafeInteger(revision) || revision !== current.revision) throw new ConfigurationError('REVISION_CONFLICT', '配置已被其他页面修改，请重新载入后再编辑');
        candidate = mutateConfig(current.config, ops);
        await this.activate(candidate, projects => {
          if (this.closed || !this.writable()) throw new ConfigurationError('READ_ONLY', '当前配置不可写');
          this.database.transaction(() => {
            if (this.database.readSettings().revision !== revision) throw new ConfigurationError('REVISION_CONFLICT', '配置版本已变化，请重新载入');
            this.database.writeSettings(candidate!, current.revision + 1);
            this.database.writeBindings(workspaceBindings(projects));
          });
        });
        return { accepted: true as const, view: this.view() };
      } catch (error) {
        let message = error instanceof z.ZodError ? '配置字段格式不正确，请检查项目设置' : error instanceof Error ? error.message : '配置保存失败';
        for (const config of [this.database.readSettings().config, candidate]) if (config) for (const project of Object.values(config.projects))
          for (const secret of [project.request_token, ...Object.values(project.callback_headers)]) if (secret) message = message.split(secret).join('[已隐藏凭证]');
        return { accepted: false as const, error: { code: error instanceof ConfigurationError ? error.code : 'CONFIG_REJECTED', message: message.slice(0, 500) }, view: this.view() };
      }
    });
    this.queue = operation.then(() => {}, () => {}); return operation;
  }
  async close(): Promise<void> { this.closed = true; await this.queue; }
}
