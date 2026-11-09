import { join, isAbsolute } from 'node:path';
import { ApiError } from './domain/request.js';
import { makeRunner } from './dsh/runner.js';
import { agentBusy } from './dsh/sessions.js';
import { sessionModels } from './dsh/models.js';
import { exposeWorkspaces } from './dsh/workspaces.js';
import type { Host } from './dsh/host.js';
import { ProjectWorkspaces } from './projects/workspaces.js';
import { createWorkspaceDirectory } from './dsh/directories.js';
import { ProjectSettings } from './projects/settings.js';
import { FileLibrary } from './storage/files.js';
import { TaskStore } from './storage/tasks.js';
import { BridgeDatabase } from './storage/database.js';
import { TaskEngine } from './services/tasks.js';
import { handler } from './http/api.js';
import { FileTransfer } from './http/files.js';
import { sendCallback } from './http/callback.js';

// Configuration is owned by SQLite; native profile options are not consumed.
export const name = 'terms-bridge';
export const inject = ['profileContext', 'settings', 'webServer', 'agents', 'sessionController', 'permissionPresets', 'workspaceRegistry', 'workspaceController', 'pluginPackages', 'sessionPersistence', 'sessionProjections', 'attachments', 'typert'];
export async function apply(host: Host, _raw?: unknown): Promise<void> {
  const required = [host.webServer?.register, host.agents?.get, host.sessionController?.create, host.sessionController?.resolveAgent,
    host.permissionPresets?.set, host.workspaceRegistry?.list, host.workspaceRegistry?.create, host.sessionPersistence?.stat, host.sessionProjections?.stateOf,
    host.attachments?.saveImage, host.attachments?.saveFileStream, host.attachments?.fileHostPath, host.attachments?.imageHostPath, host.effect];
  if (required.some(value => typeof value !== 'function') || !host.profileContext?.dir || !isAbsolute(host.profileContext.dir) || !host.settings)
    throw new Error('Incompatible dsh public services for terms-bridge');
  sessionModels(host);
  const log = host.logger?.(name), database = new BridgeDatabase(join(host.profileContext.dir, 'data', 'terms-bridge.sqlite'));
  let tasks: TaskEngine | undefined, settings: ProjectSettings | undefined, route: (() => void) | undefined, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true; route?.();
    const updates = settings?.close();
    // Configuration can be waiting for an upload. Abort/drain requests before waiting for it.
    await tasks?.close(); await updates; database.close();
  };
  host.effect(() => close);
  try {
    if (closed) throw new Error('Plugin closed during initialization');
    const initial = database.readSettings().config;
    const store = new TaskStore(database);
    const workspaces = new ProjectWorkspaces(host, database.bindings, createWorkspaceDirectory(host));
    await workspaces.load(initial);
    const projects = workspaces.projects, library = new FileLibrary(database), transfer = new FileTransfer(library);
    tasks = new TaskEngine(store, projects, makeRunner(host, library), {
      files: library, callback: sendCallback, log: text => log?.error(text),
      prepareProject: (id, signal, beforeRelocate) => workspaces.prepare(id, signal, beforeRelocate),
      sessionExists: async id => (await host.sessionPersistence.stat(id)) !== undefined,
      sessionBusy: id => agentBusy(host.agents.get(id)),
    });
    await tasks.recover();
    if (closed) throw new Error('Plugin closed during initialization');
    let prefix = initial.api_prefix;
    const register = (path: string) => host.webServer.register({ kind: 'prefix', path,
      handler: handler(tasks!, path, transfer, async () => {
        if (path !== prefix) throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Task API configuration is changing');
      }),
    });
    settings = new ProjectSettings(database, () => host.settings.writable, async (config, persist) => {
      if (closed) throw new Error('Plugin is stopping');
      // Reject removal before preparing workspaces or touching routing.
      for (const [, task] of store.pending()) if (store.active(task) && !Object.hasOwn(config.projects, task.request.metadata.project_id))
        throw new Error('项目 ' + task.request.metadata.project_id + ' 仍有未完成任务，请等待任务执行和结果回调结束后再移除');
      await tasks!.reconfigure(() => workspaces.configure(config), next => {
        if (closed) throw new Error('Plugin is stopping');
        const replacement = prefix === config.api_prefix ? undefined : register(config.api_prefix);
        try { persist(next); }
        catch (error) { replacement?.(); throw error; }
        if (replacement) { const previous = route; prefix = config.api_prefix; route = replacement; previous?.(); }
      });
    });
    route = register(prefix);
    exposeWorkspaces(host, projects, settings);
    tasks.start();
    log?.info('terms-bridge active: ' + prefix);
  } catch (error) { await close(); throw error; }
}
