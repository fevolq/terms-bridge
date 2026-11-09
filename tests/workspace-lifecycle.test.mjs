import { DatabaseSync } from 'node:sqlite';
import { projectOperations } from './config-ops.mjs';
import test from 'node:test';
import { mountNativeWorkspaces } from './native-workspaces.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { apply } from '../dist/index.js';
import { parseConfig } from '../dist/projects/config.js';

test('native project bindings prevent recreation on settings reads, edits and plugin reloads without any tasks', {
  skip: !process.env.DSH_TEST_PACKAGE,
}, async t => {
  const requireHost = createRequire(process.env.DSH_TEST_PACKAGE);
  const load = name => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)));
  const { Context } = await load('cordis'); const ctx = new Context();
  const dir = await mkdtemp(join(tmpdir(), 'bridge-workspace-lifecycle-'));
  let disposers = [], remote;
  async function stop() { for (const dispose of disposers.splice(0).reverse()) await dispose(); }
  t.after(async () => {
    await stop(); await ctx.fiber.dispose();
    const within = relative(tmpdir(), dir);
    assert(within && !within.startsWith('..') && !isAbsolute(within));
    await rm(dir, { recursive: true, force: true });
  });
  for (const [name, config] of [
    ['dsh-storage', {}], ['dsh-storage-json', { root: join(dir, 'storage') }],
    ['dsh-storage-domain', { backend: 'json' }], ['dsh-session', {}],
    ['dsh-session-persistence-jsonl', { root: join(dir, 'sessions') }], ['dsh-workspace', {}],
  ]) { const plugin = await load(name); await ctx.plugin(plugin.default ?? plugin, config).await(); }
  await mountNativeWorkspaces(ctx, load, requireHost, dir);
  await mkdir(join(dir, 'default-workspace'));
  const defaultWorkspace = await ctx.workspaceRegistry.create(join(dir, 'default-workspace'));
  const project = { provider: 'mock', model: 'model-a', callback_url: 'http://localhost/results' };
  let config = parseConfig({});
  const unexpected = () => assert.fail('Configuration operations must not run a conversation');
  const creations = [];
  const host = {
    profileContext: { dir }, settings: { writable: true },
    baseUrl: ctx.baseUrl, workspaceController: ctx.workspaceController, pluginPackages: ctx.pluginPackages,
    workspaceRegistry: { list: () => ctx.workspaceRegistry.list(), create: async (...args) => {
      creations.push(args[0]); return ctx.workspaceRegistry.create(...args);
    } },
    sessionPersistence: ctx.sessionPersistence,
    agents: { get: () => undefined }, permissionPresets: { set: unexpected },
    sessionController: { create: unexpected, resolveAgent: unexpected,
      agents: { selectionFor: unexpected, selectForNextRequest: unexpected } },
    sessionProjections: { stateOf: unexpected },
    attachments: { saveImage: unexpected, saveFileStream: unexpected, fileHostPath: unexpected, imageHostPath: unexpected },
    webServer: { register: () => () => {} }, typert: { register: () => () => {} },
    provide: (name, service) => { assert.equal(name, 'termsBridge'); remote = service; return () => {}; },
    effect: callback => { disposers.push(callback()); },
  };
  const start = () => apply(host, { api_prefix: { get: () => config.api_prefix }, projects: { get: () => config.projects } });
  const missing = async path => assert.equal(await ctx.workspaceRegistry.resolveByPath(path), undefined);

  await start();
  const save = async projects => {
    const view=remote.settings(), result=await remote.mutate(projectOperations(view.value.projects,projects),view.revision);
    assert.equal(result.accepted,true,result.error?.message);
  };
  await save({news:project});const paths=await remote.workspaces();
  assert.equal(creations.length,1);
  const first=await ctx.workspaceRegistry.resolveByPath(paths.news);await ctx.workspaceRegistry.delete(first.id);
  assert.deepEqual(await remote.workspaces(),paths);await missing(paths.news);
  await save({news:{...project,model:'model-b'}});await missing(paths.news);assert.equal(creations.length,1);
  await stop();
  const db=new DatabaseSync(join(dir,'data','terms-bridge.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_mappings').get().n,0);
  assert.equal(JSON.parse(db.prepare('SELECT binding FROM projects WHERE key=?').get('news').binding).workspace_path,paths.news);db.close();
  await ctx.workspaceRegistry.delete(defaultWorkspace.id);
  config=parseConfig({projects:{stale:project}});await start();
  assert.deepEqual(await remote.workspaces(),paths);await missing(paths.news);assert.equal(creations.length,1);
  await save({news:project,added:project});const expanded=await remote.workspaces();assert.equal(creations.length,2);await missing(paths.news);
  assert.ok(await ctx.workspaceRegistry.resolveByPath(expanded.added));
  await save({});await stop();await start();assert.deepEqual(await remote.workspaces(),{});
  const newPath=join(dir,'readded');await mkdir(newPath);await save({news:{...project,workspace_path:newPath}});
  assert.equal((await remote.workspaces()).news,newPath);assert.equal(creations.length,3);
});
