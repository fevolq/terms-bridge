import { realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { PluginConfig, Project, ResolvedProject } from '../domain/types.js';
import type { Host, Workspace } from '../dsh/host.js';

const pathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
function projectPath(id: string, project: Project, registered: Workspace[]): string {
  let path = project.workspace_path;
  if (path === '~') path = homedir();
  else if (path?.startsWith('~/')) path = join(homedir(), path.slice(2));
  const automatic = !path;
  if (automatic) {
    const defaults = registered.filter(item => basename(item.path).toLowerCase() === 'default-workspace');
    if (defaults.length !== 1) throw new Error(`Project ${id}: cannot uniquely locate dsh default workspace; specify workspace_path`);
    if (id === 'default-workspace') throw new Error('Project ID default-workspace cannot use automatic workspace creation');
    path = join(realpathSync(dirname(defaults[0]!.path)), id);
  }
  if (!isAbsolute(path!)) throw new Error(`Project ${id}: workspace_path must be absolute`);
  try {
    const actual = realpathSync(path!);
    if (!statSync(actual).isDirectory()) throw new Error(`Project ${id}: workspace_path is not a directory`);
    if (automatic && pathKey(actual) !== pathKey(path!)) throw new Error(`Project ${id}: automatic workspace cannot use a symbolic link`);
    return actual;
  } catch (error) {
    if (automatic && (error as NodeJS.ErrnoException).code === 'ENOENT') return path!;
    throw error;
  }
}
/** Validation is read-only so a refused settings save cannot create workspaces. */
export function validateProjectWorkspaces(host: Pick<Host, 'workspaceRegistry'>, config: PluginConfig, current: ReadonlyMap<string, ResolvedProject> = new Map()): Map<string, ResolvedProject> {
  const registry = host.workspaceRegistry.list();
  const result = new Map<string, ResolvedProject>();
  const paths = new Set<string>();
  for (const [id, project] of Object.entries(config.projects)) {
    const path = projectPath(id, project, registry), identity = pathKey(path);
    if (current.has(id) && pathKey(current.get(id)!.workspace_path) !== identity) throw new Error(`项目 ${id} 的工作区路径保存后不可修改`);
    // Names are display labels; only the full resolved path identifies a workspace.
    if (paths.has(identity)) throw new Error(`项目 ${id} 的工作区路径与其他项目重复：${path}`);
    paths.add(identity);
    result.set(id, { ...project, workspace_path: path, workspace_id: '' });
  }
  return result;
}
export async function resolveProjects(host: Pick<Host, 'workspaceRegistry'>, config: PluginConfig, current?: ReadonlyMap<string, ResolvedProject>): Promise<Map<string, ResolvedProject>> {
  const projects = validateProjectWorkspaces(host, config, current);
  for (const [id, project] of projects) {
    if (!config.projects[id]!.workspace_path) await mkdir(project.workspace_path, { recursive: true });
    const workspace = await host.workspaceRegistry.create(project.workspace_path, project.name);
    if (typeof workspace.attachSession !== 'function') throw new Error('dsh Workspace.attachSession is required');
    projects.set(id, { ...project, workspace_path: workspace.path, workspace_id: workspace.id });
  }
  return projects;
}
