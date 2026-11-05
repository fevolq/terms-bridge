import { ApiError } from './domain/request.js';
import { Config, readConfig, watchProjectConfig } from './dsh/settings.js';
import { makeRunner } from './dsh/runner.js';
import { agentBusy } from './dsh/sessions.js';
import { sessionModels } from './dsh/models.js';
import { exposeWorkspaces } from './dsh/workspaces.js';
import type { Host } from './dsh/host.js';
import { parseConfig } from './projects/config.js';
import { resolveProjects } from './projects/workspaces.js';
import { LiveConfig } from './projects/live.js';
import { FileLibrary } from './storage/files.js';
import { domainSpec, TaskStore } from './storage/tasks.js';
import { TaskEngine } from './services/tasks.js';
import { handler } from './http/api.js';
import { FileTransfer } from './http/files.js';
import { sendCallback } from './http/callback.js';

export { Config };
export const name = 'terms-bridge';
export const inject = ['webServer', 'agents', 'sessionController', 'permissionPresets', 'workspaceRegistry', 'storageDomain', 'sessionPersistence', 'sessionProjections', 'attachments', 'typert'];
export async function apply(host: Host, raw: unknown): Promise<void> {
  const required = [host.webServer?.register, host.agents?.get, host.sessionController?.create, host.sessionController?.resolveAgent,
    host.permissionPresets?.set, host.workspaceRegistry?.list, host.workspaceRegistry?.create, host.sessionPersistence?.stat, host.sessionProjections?.stateOf,
    host.attachments?.saveImage, host.attachments?.saveFileStream, host.attachments?.fileHostPath, host.attachments?.imageHostPath, host.storageDomain?.open, host.effect];
  if (required.some(value => typeof value !== 'function')) throw new Error('Incompatible dsh public services for terms-bridge');
  sessionModels(host);
  const initial = parseConfig(readConfig(raw)), log = host.logger?.(name);
  const domain = await host.storageDomain.open(domainSpec), store = new TaskStore(domain.table('tasks'), domain.table('conversations'));
  const library = new FileLibrary(), transfer = new FileTransfer(library);
  let tasks: TaskEngine | undefined, live: LiveConfig | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let route: (() => void) | undefined, guard: (() => void) | undefined, notice: (() => void) | undefined, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(timer); route?.(); guard?.(); notice?.();
    const updates = live?.close();
    // A config update may await uploads; abort/drain requests before waiting for that update.
    await tasks?.close(); await updates; await domain.close();
  };
  host.effect(() => close);
  try {
    const projects = await resolveProjects(host, initial);
    if (closed) throw new Error('Plugin closed during initialization');
    tasks = new TaskEngine(store, projects, makeRunner(host, library), {
      files: library, callback: sendCallback, log: text => log?.error(text),
      sessionExists: async id => (await host.sessionPersistence.stat(id)) !== undefined,
      sessionBusy: id => agentBusy(host.agents.get(id)),
    });
    await tasks.recover();
    if (closed) throw new Error('Plugin closed during initialization');
    guard = watchProjectConfig(host, projects, store);
    let prefix = initial.api_prefix;
    const register = (path: string) => host.webServer.register({ kind: 'prefix', path,
      handler: handler(tasks!, path, transfer, async method => {
        if (method === 'POST') {
          try { await live?.refresh(true); }
          catch { throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Saved project configuration could not be applied; check terms-bridge logs'); }
        }
        if (path !== prefix) throw new ApiError(404, 'NOT_FOUND', 'Task API prefix has changed');
      }),
    });
    live = new LiveConfig(() => readConfig(raw), initial, async config => {
      const next = await resolveProjects(host, config, projects);
      if (closed) return;
      await tasks!.reconfigure(next, () => {
        if (prefix === config.api_prefix) return;
        const replacement = register(config.api_prefix);
        route?.(); route = replacement; prefix = config.api_prefix;
      });
    }, error => log?.error(`Project configuration update failed: ${error instanceof Error ? error.message : 'unknown error'}`));
    route = register(prefix);
    exposeWorkspaces(host, projects, () => live!.refresh(true));
    notice = host.on?.('settings/document-updated', () => { void live!.refresh(true).catch(() => {}); });
    timer = setInterval(() => { void live!.refresh().catch(() => {}); }, 250);
    timer.unref();
    await live.refresh(); tasks.start();
    log?.info(`terms-bridge active: ${prefix}`);
  } catch (error) { await close(); throw error; }
}
