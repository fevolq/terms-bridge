import type { ProjectSettings } from '../projects/settings.js';
import type { Host } from './host.js';
import type { ProjectState } from '../domain/types.js';
import { WORKSPACES_REMOTE } from '../shared/workspaces.js';

export function exposeWorkspaces(host: Host, projects: ReadonlyMap<string, ProjectState>, settings: ProjectSettings): void {
  const service = {
    settings: () => settings.view(),
    mutate: (ops: unknown, revision: unknown) => settings.mutate(ops, revision),
    workspaces() {
      return Object.fromEntries([...projects].map(([id, project]) => [id, project.workspace_path ?? project.configured_path]));
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
