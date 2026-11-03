import type { Host } from './host.js';
import type { ResolvedProject } from '../domain/types.js';
import { WORKSPACES_REMOTE } from '../shared/workspaces.js';

export function exposeWorkspaces(host: Host, projects: ReadonlyMap<string, ResolvedProject>, refresh: () => Promise<void>): void {
  const service = {
    async workspaces() {
      // A settings save may finish before its configuration has been applied.
      await refresh();
      return Object.fromEntries([...projects].map(([id, project]) => [id, project.workspace_path]));
    },
  };
  const binding = Object.freeze({ service, serviceKey: 'termsBridge', namespace: 'termsBridge' });
  Object.assign(service, { typertRemote: binding });
  host.provide('termsBridge', service);
  host.effect(() => host.typert.register({
    package: WORKSPACES_REMOTE.package, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: WORKSPACES_REMOTE.descriptors,
  }));
}
