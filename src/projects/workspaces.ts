import { realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { homedir } from 'node:os';
import type { PluginConfig, Project, ProjectState, ResolvedProject, Table, WorkspaceBinding } from '../domain/types.js';
import type { Host } from '../dsh/host.js';
import type { WorkspaceDirectory } from '../dsh/directories.js';
import { pathIdentity, restoreWorkspaceDirectory } from '../storage/paths.js';

function expandedPath(path: string): string {
  if (path === '~') return homedir();
  return normalize(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
}
/** Compare saved bindings and unresolved manual settings only at creation/request time. */
function workspacePathIdentity(project: ProjectState | WorkspaceBinding): string | undefined {
  if (project.workspace_path) return pathIdentity(project.workspace_path);
  if (!project.configured_path) return undefined;
  const path = expandedPath(project.configured_path);
  try { return pathIdentity(realpathSync(path)); }
  catch { return pathIdentity(path); } // A missing directory still reserves its configured path.
}
function projectPath(id: string, project: Project, directory?: WorkspaceDirectory): string {
  const automatic = !project.workspace_path;
  if (automatic && !directory) throw new Error(`Project ${id}: DSH workspace directory is unavailable; specify workspace_path`);
  if (automatic && id === 'default-workspace') throw new Error('Project ID default-workspace cannot use automatic workspace creation');
  const path = project.workspace_path ? expandedPath(project.workspace_path) : join(directory!(), id);
  if (!isAbsolute(path)) throw new Error(`Project ${id}: workspace_path must be absolute`);
  try {
    const actual = realpathSync(path);
    if (!statSync(actual).isDirectory()) throw new Error(`Project ${id}: workspace_path is not a directory`);
    if (automatic && pathIdentity(actual) !== pathIdentity(path)) throw new Error(`Project ${id}: automatic workspace cannot use a symbolic link`);
    return actual;
  } catch (error) {
    if (automatic && (error as NodeJS.ErrnoException).code === 'ENOENT') return path;
    throw error;
  }
}
/** Existing projects keep their binding; only additions resolve and validate paths. */
export function validateProjectWorkspaces(config: PluginConfig, current: ReadonlyMap<string, ProjectState | WorkspaceBinding> = new Map(), directory?: WorkspaceDirectory): Map<string, ProjectState> {
  const result = new Map<string, ProjectState>();
  let paths: Set<string> | undefined;
  for (const [id, project] of Object.entries(config.projects)) {
    const previous = current.get(id);
    if (previous) {
      result.set(id, { ...project, workspace_path: previous.workspace_path, configured_path: previous.configured_path });
      continue;
    }
    paths ??= new Set([...current].filter(([key]) => Object.hasOwn(config.projects, key))
      .flatMap(([, value]) => {
        const identity = workspacePathIdentity(value);
        return identity ? [identity] : [];
      }));
    const path = projectPath(id, project, directory);
    if (paths.has(pathIdentity(path))) throw new Error('项目 ' + id + ' 的工作区路径与其他项目重复：' + path);
    paths.add(pathIdentity(path));
    result.set(id, { ...project, workspace_path: path, configured_path: project.workspace_path });
  }
  return result;
}
/** Settings additions initialize workspaces; edits preserve existing bindings. */
export async function resolveProjects(host: Pick<Host, 'workspaceRegistry'>, config: PluginConfig, current: ReadonlyMap<string, ProjectState | WorkspaceBinding> = new Map(), directory?: WorkspaceDirectory): Promise<Map<string, ProjectState>> {
  if (Object.entries(config.projects).some(([id, project]) => !project.workspace_path && !current.has(id))) await directory?.load?.();
  const projects = validateProjectWorkspaces(config, current, directory);
  for (const [id, project] of projects) {
    if (current.has(id)) continue;
    const path = project.workspace_path!;
    if (!config.projects[id]!.workspace_path) await mkdir(path, { recursive: true });
    const workspace = await host.workspaceRegistry.create(path, project.name);
    projects.set(id, { ...project, workspace_path: workspace.path });
  }
  return projects;
}
export async function saveProjectWorkspaces(table: Table<Record<string, WorkspaceBinding>>, projects: ReadonlyMap<string, ProjectState | WorkspaceBinding>): Promise<void> {
  const bindings = Object.fromEntries([...projects].filter(([, value]) => value.workspace_path).map(([id, { workspace_path, configured_path }]) =>
    [id, { workspace_path: workspace_path!, ...(configured_path ? { configured_path } : {}) }]));
  if (JSON.stringify(table.get('current')) !== JSON.stringify(bindings)) await table.put('current', bindings);
}

/** Owns path selection, DSH registration and binding persistence, not task policy. */
export class ProjectWorkspaces {
  constructor(private host: Pick<Host, 'workspaceRegistry'>, private bindings: Table<Record<string, WorkspaceBinding>>, private directory: WorkspaceDirectory, readonly projects = new Map<string, ProjectState>()) {}
  async load(config: PluginConfig): Promise<void> {
    const saved = this.bindings.get('current');
    if (!saved) await this.bindings.put('current', {});
    for (const [id, project] of Object.entries(config.projects)) {
      this.projects.set(id, { ...project, workspace_path: saved?.[id]?.workspace_path,
        configured_path: saved?.[id]?.configured_path ?? project.workspace_path });
    }
  }
  configure(config: PluginConfig): Promise<Map<string, ProjectState>> { return resolveProjects(this.host, config, this.projects, this.directory); }
  save(projects: ReadonlyMap<string, ProjectState>): Promise<void> { return saveProjectWorkspaces(this.bindings, projects); }
  /** Called under the project's admission lock, only for uploads and submissions. */
  async prepare(id: string, signal: AbortSignal, beforeRelocate: () => void): Promise<ResolvedProject> {
    signal.throwIfAborted();
    const project = this.projects.get(id)!;
    let path = project.workspace_path;
    if (!path) {
      if (project.configured_path) {
        path = expandedPath(project.configured_path);
        if (!isAbsolute(path)) throw new Error('workspace_path must be absolute');
        try { path = realpathSync(path); } catch { /* Restoration below reports filesystem failures. */ }
      } else { await this.directory.load?.(); path = projectPath(id, project, this.directory); }
    }
    const checkPath = (path: string) => {
      const identity = pathIdentity(path);
      if ([...this.projects].some(([other, value]) => other !== id && workspacePathIdentity(value) === identity)) {
        throw new Error('Workspace directory belongs to another project');
      }
    };
    checkPath(path);
    try { await restoreWorkspaceDirectory(path); }
    catch (cause) {
      signal.throwIfAborted(); beforeRelocate();
      await this.directory.load?.();
      const replacement = projectPath(id, { ...project, workspace_path: undefined }, this.directory);
      if (pathIdentity(replacement) === pathIdentity(path)) throw cause;
      path = replacement;
      checkPath(path);
      signal.throwIfAborted(); await restoreWorkspaceDirectory(path);
    }
    signal.throwIfAborted();
    const workspace = await this.host.workspaceRegistry.create(path, project.name);
    if (pathIdentity(workspace.path) !== pathIdentity(path)) throw new Error('Workspace directory changed during recovery');
    const replacement = { ...project, workspace_path: workspace.path };
    const binding: WorkspaceBinding = { workspace_path: workspace.path, ...(project.configured_path ? { configured_path: project.configured_path } : {}) };
    if (JSON.stringify(this.bindings.get('current')?.[id]) !== JSON.stringify(binding)) {
      await this.bindings.update('current', current => ({ ...current, [id]: binding }));
    }
    this.projects.set(id, replacement);
    return replacement;
  }
}
