import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Host } from './host.js';

/** Resolve existing ancestors without creating the Documents/deepseek-harness directory. */
function canonicalDirectory(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(canonicalDirectory(dirname(path)), basename(path));
  }
}
/** Only project creation and request preparation load the native directory. */
export interface WorkspaceDirectory { (): string; load?: () => Promise<string> }

/** DSH 0.2.1 has no public read-only default-directory service. Isolate its private
 * controller config and shipped resolver here; initializeDefault would create a workspace.
 * Controller config is immutable; Cordis remounts dependants when it changes. */
export function createWorkspaceDirectory(host: Pick<Host, 'workspaceController' | 'pluginPackages' | 'baseUrl'>): WorkspaceDirectory {
  let directory: string | undefined, pending: Promise<string> | undefined, failure: Error | undefined;
  const load = (): Promise<string> => {
    if (directory !== undefined) return Promise.resolve(directory);
    return pending ??= (async () => {
      try {
        const config = (host.workspaceController as { config?: { documentsDirectory?: string; documentsLookupTimeoutMs: number } })?.config;
        const pkg = host.pluginPackages?.packageOf('@deepseek-ai/dsh-api-workspace-controller', host.baseUrl ?? import.meta.url);
        if (!config || !Number.isSafeInteger(config.documentsLookupTimeoutMs) || config.documentsLookupTimeoutMs < 1 || !pkg) {
          throw new Error('Incompatible DSH workspace directory services for terms-bridge');
        }
        const { defaultWorkspaceDirectory } = await import(pathToFileURL(join(pkg.dir, 'lib/types/default-directory.js')).href);
        const path = await defaultWorkspaceDirectory(config.documentsDirectory, AbortSignal.timeout(config.documentsLookupTimeoutMs));
        directory = canonicalDirectory(dirname(path)); failure = undefined;
        return directory;
      } catch (cause) {
        failure = new Error(`Cannot resolve DSH workspace directory: ${cause instanceof Error ? cause.message : String(cause)}; check DSH documentsDirectory or specify workspace_path`, { cause });
        throw failure;
      }
    })().finally(() => { pending = undefined; });
  };
  const read: WorkspaceDirectory = Object.assign(() => {
    if (directory !== undefined) return directory;
    throw failure ?? new Error('DSH workspace directory must be loaded before resolving a new path');
  }, { load });
  return read;
}
