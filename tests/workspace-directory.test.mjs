import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { createWorkspaceDirectory } from '../dist/dsh/directories.js';
import { parseConfig } from '../dist/projects/config.js';
import { watchProjectConfig } from '../dist/dsh/settings.js';
import { TaskStore } from '../dist/storage/tasks.js';
import { MemoryTable } from './helpers.mjs';
import { ProjectWorkspaces, resolveProjects, validateProjectWorkspaces } from '../dist/projects/workspaces.js';

const native = { skip: !process.env.DSH_TEST_PACKAGE };
const project = { provider: 'test', model: 'model', callback_url: 'http://localhost/results' };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-directory-'));
  const requireHost = createRequire(process.env.DSH_TEST_PACKAGE);
  const load = name => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)));
  const { Context } = await load('cordis'), ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    const within = relative(tmpdir(), root); assert(within && !within.startsWith('..') && !isAbsolute(within));
    await rm(root, { recursive: true, force: true });
  });
  for (const [name, config] of [
    ['dsh-storage', {}], ['dsh-storage-json', { root: join(root, 'storage') }],
    ['dsh-storage-domain', { backend: 'json' }], ['dsh-session', {}],
    ['dsh-session-persistence-jsonl', { root: join(root, 'sessions') }],
    ['dsh-workspace', {}], ['dsh-typert-registry', {}], ['dsh-api-remote-access', {}],
  ]) { const plugin = await load(name); await ctx.plugin(plugin.default ?? plugin, config).await(); }
  const { PluginPackages } = await load('dsh-app-boot');
  // Resolve host packages through the real profile lookup, even with a linked plugin outside it.
  const name = '@deepseek-ai/dsh-api-workspace-controller', packageDir = dirname(requireHost.resolve(name + '/package.json'));
  const profilesDir = join(root, 'profiles'), profileDir = join(profilesDir, 'web');
  ctx.baseUrl = pathToFileURL(profileDir + '/').href;
  await ctx.plugin(PluginPackages, { resolution: {
    profilesDir, profileDir, localPackageNames: ['@fevolq/terms-bridge'],
    linkedRoots: [{ name: '@fevolq/terms-bridge', realPath: fileURLToPath(new URL('../', import.meta.url)) }],
    entries: [{ name, packageDir, version: '0.2.1-rc.2', declarer: process.env.DSH_TEST_PACKAGE, scope: 'installation' }],
  } }).await();
  const controller = await load('dsh-api-workspace-controller');
  let fiber;
  return { root, ctx, packageDir, async configure(config) {
    await fiber?.dispose();
    fiber = ctx.plugin(controller.default ?? controller, config); await fiber.await();
    const directory = createWorkspaceDirectory(ctx); await directory.load().catch(() => {}); return directory;
  } };
}

test('automatic projects use native directory config without a default registration; saved bindings survive config changes', native, async t => {
  const f = await setup(t), { root, ctx } = f;
  // Same-name default registrations elsewhere cannot influence directory policy.
  for (const name of ['unrelated-a', 'unrelated-b']) {
    const path = join(root, name, 'default-workspace'); await mkdir(path, { recursive: true });
    await ctx.workspaceRegistry.create(path);
  }
  const documents = join(root, 'documents'), directory = await f.configure({ documentsDirectory: documents });
  const config = parseConfig({ projects: { news: project } });
  const planned = validateProjectWorkspaces(config, undefined, directory);
  const expected = join(await realpath(root), 'documents', 'deepseek-harness', 'news');
  assert.equal(planned.get('news').workspace_path, expected);
  await assert.rejects(stat(documents), { code: 'ENOENT' });
  assert.equal(ctx.workspaceRegistry.list().length, 2, 'directory lookup and validation are read-only');
  const projects = await resolveProjects(ctx, config, undefined, directory);
  assert.equal(projects.get('news').workspace_path, expected);
  assert.equal(ctx.workspaceRegistry.list().length, 3);
  await assert.rejects(stat(join(dirname(expected), 'default-workspace')), { code: 'ENOENT' });
  await ctx.workspaceRegistry.delete((await ctx.workspaceRegistry.resolveByPath(expected)).id);

  const changed = await f.configure({ documentsDirectory: join(root, 'other-documents') });
  const reopened = await resolveProjects(ctx, config, projects, changed);
  assert.equal(reopened.get('news').workspace_path, expected);
  assert.equal(ctx.workspaceRegistry.list().length, 2, 'reload must not recreate the deleted project');
  config.projects.added = { ...project };
  const expanded = await resolveProjects(ctx, config, reopened, changed);
  assert.equal(expanded.get('news').workspace_path, expected);
  assert.equal(expanded.get('added').workspace_path, join(await realpath(root), 'other-documents', 'deepseek-harness', 'added'));
  assert.equal(await ctx.workspaceRegistry.resolveByPath(expected), undefined);
});

test('unset documentsDirectory uses the native OS resolver without registering any workspace', native, async t => {
  const f = await setup(t);
  const { defaultWorkspaceDirectory } = await import(pathToFileURL(join(f.packageDir, 'lib/types/default-directory.js')));
  let expected;
  try { expected = dirname(await defaultWorkspaceDirectory(undefined, AbortSignal.timeout(10000))); }
  catch (error) {
    const unavailable = await f.configure({});
    assert.throws(unavailable, /Cannot resolve DSH workspace directory/);
    return;
  }
  const directory = await f.configure({});
  // Windows spelling may differ in case; existing ancestors are normalized by the adapter.
  assert.equal(directory().toLowerCase(), expected.toLowerCase());
  assert.equal(f.ctx.workspaceRegistry.list().length, 0);
});

test('unavailable directory policy blocks only new automatic projects, preserving manual paths and saved bindings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-directory-failure-'));
  t.after(async () => {
    const within = relative(tmpdir(), root); assert(within && !within.startsWith('..') && !isAbsolute(within));
    await rm(root, { recursive: true, force: true });
  });
  const directory = createWorkspaceDirectory({}); await directory.load().catch(() => {});
  const host = { workspaceRegistry: { list: () => [], create: () => assert.fail('Validation must be read-only') } };
  const manual = parseConfig({ projects: { news: { ...project, workspace_path: root } } });
  const automatic = parseConfig({ projects: { news: project } });
  const current = new Map([['news', { workspace_path: await realpath(root) }]]);
  assert.equal(validateProjectWorkspaces(manual, undefined, directory).get('news').workspace_path, await realpath(root));
  assert.equal((await resolveProjects(host, automatic, current, directory)).get('news').workspace_path, await realpath(root));
  assert.throws(() => validateProjectWorkspaces(automatic, undefined, directory), /Incompatible DSH workspace directory services/);
});


test('transient native directory failure retries without reloading, then caches only the successful result', native, async t => {
  const f = await setup(t), realExec = childProcess.execFile;
  let calls = 0, fail = true;
  const documents = join(f.root, 'recovered-documents');
  childProcess.execFile = function(command, args, options, callback) {
    if (['powershell.exe', 'xdg-user-dir', 'osascript'].includes(command)) {
      calls++;
      queueMicrotask(() => callback(fail ? new Error('temporary Documents lookup failure') : null, fail ? '' : documents, ''));
      return {};
    }
    return realExec.call(this, command, args, options, callback);
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = realExec; syncBuiltinESMExports(); });
  const directory = await f.configure({});
  assert.equal(calls, 1);
  fail = false;
  const config = parseConfig({ projects: { news: project } });
  // Retry the lookup from the asynchronous creation flow, before resolving the new path.
  await directory.load();
  assert.equal(calls, 2);
  assert.equal(validateProjectWorkspaces(config, undefined, directory).get('news').workspace_path,
    join(documents, 'deepseek-harness', 'news'));
  await assert.rejects(stat(documents), { code: 'ENOENT' });
  await resolveProjects(f.ctx, config, undefined, directory);
  assert.equal(calls, 2, 'successful resolution is reused');
});

test('adding an automatic project awaits a cold native directory lookup and needs only one settings save', native, async t => {
  const f = await setup(t);
  const documents = join(f.root, 'first-save-documents'); await f.configure({ documentsDirectory: documents });
  const directory = createWorkspaceDirectory(f.ctx);
  const bindings = new MemoryTable(), service = new ProjectWorkspaces(f.ctx, bindings, directory);
  await service.load(parseConfig({}));
  let guard; const fiber = {};
  watchProjectConfig({ fiber, on: (_event, callback) => { guard = callback; return () => {}; } }, service.projects, new TaskStore(new MemoryTable(), new MemoryTable()));
  const config = parseConfig({ projects: { news: project } });
  assert.doesNotThrow(() => guard.call(fiber, config));
  assert.equal(f.ctx.workspaceRegistry.list().length, 0);
  await assert.rejects(stat(documents), { code: 'ENOENT' });
  const configured = await service.configure(config); await service.save(configured);
  const path = join(documents, 'deepseek-harness', 'news');
  assert.equal(configured.get('news').workspace_path, path);
  assert.equal(bindings.get('current').news.workspace_path, path);
  assert.equal(f.ctx.workspaceRegistry.list().length, 1);
});
