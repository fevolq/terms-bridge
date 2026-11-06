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
import { domainSpec } from '../dist/storage/tasks.js';
import { conversationKey } from '../dist/domain/request.js';
import { conversation } from './helpers.mjs';

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
    baseUrl: ctx.baseUrl, workspaceController: ctx.workspaceController, pluginPackages: ctx.pluginPackages,
    workspaceRegistry: { list: () => ctx.workspaceRegistry.list(), create: async (...args) => {
      creations.push(args[0]); return ctx.workspaceRegistry.create(...args);
    } },
    storageDomain: ctx.storageDomain, sessionPersistence: ctx.sessionPersistence,
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
  config = parseConfig({ projects: { news: project } });
  const paths = await remote.workspaces();
  assert.equal(creations.length, 1, 'first configuration creates its workspace');
  const first = await ctx.workspaceRegistry.resolveByPath(paths.news);
  await ctx.workspaceRegistry.delete(first.id);
  assert.deepEqual(await remote.workspaces(), paths); await missing(paths.news);
  config.projects.news.model = 'model-b';
  assert.deepEqual(await remote.workspaces(), paths); await missing(paths.news);
  assert.equal(creations.length, 1, 'reading and editing a project must not recreate the workspace');
  await stop();

  const saved = await ctx.storageDomain.open(domainSpec);
  assert.equal([...saved.table('tasks').entries()].length, 0);
  assert.equal([...saved.table('conversations').entries()].length, 0);
  assert.deepEqual(saved.table('projects').get('current'), { news: { workspace_path: paths.news } });
  await saved.close();
  // Existing automatic paths no longer depend on a default workspace registration.
  await ctx.workspaceRegistry.delete(defaultWorkspace.id);
  await start();
  assert.deepEqual(await remote.workspaces(), paths); await missing(paths.news);
  assert.equal(creations.length, 1, 'reload must remember initialized projects even without task history');
  await missing(defaultWorkspace.path);

  config.projects.added = { ...config.projects.news };
  const expanded = await remote.workspaces();
  assert.equal(creations.length, 2); await missing(paths.news);
  assert.ok(await ctx.workspaceRegistry.resolveByPath(expanded.added));
  delete config.projects.news;
  assert.deepEqual(await remote.workspaces(), { added: expanded.added });
  await stop(); await start();
  config.projects.news = { ...config.projects.added };
  assert.deepEqual(await remote.workspaces(), expanded);
  assert.equal(creations.length, 3, 'adding the removed project again is a new configuration');
  const replacement = await ctx.workspaceRegistry.resolveByPath(paths.news);
  assert.notEqual(replacement.id, first.id);

  // Startup does not infer workspace paths from historical conversations.
  await stop();
  const legacyPath = join(dir, 'old-documents', 'deepseek-harness', 'legacy'); await mkdir(legacyPath, { recursive: true });
  const legacy = { ...conversation(), project_id: 'legacy', workspace_path: legacyPath, workspace_id: 'removed-registration' };
  const retiredPath = join(dir, 'retired'); await mkdir(retiredPath);
  const retired = { ...conversation(), project_id: 'legacy', conversation_id: 'retired-conversation',
    workspace_path: retiredPath, workspace_id: 'retired-registration' };
  const legacyDomain = await ctx.storageDomain.open({ ...domainSpec,
    tables: { tasks: domainSpec.tables.tasks, conversations: domainSpec.tables.conversations } });
  await legacyDomain.table('conversations').put(conversationKey(retired.project_id, retired.conversation_id), retired);
  await legacyDomain.table('conversations').put(conversationKey(legacy.project_id, legacy.conversation_id), legacy);
  await legacyDomain.close();
  config = parseConfig({ projects: { legacy: project } });
  await start();
  assert.deepEqual(await remote.workspaces(), { legacy: undefined });
  assert.equal(creations.length, 3); await missing(legacyPath);

  // Saving an empty configuration is distinct from never having saved the new binding record.
  config = parseConfig({}); await remote.workspaces();
  await stop(); await start();
  const newPath = join(dir, 'readded'); await mkdir(newPath);
  config = parseConfig({ projects: { legacy: { ...project, workspace_path: newPath } } });
  assert.deepEqual(await remote.workspaces(), { legacy: newPath });
  assert.equal(creations.length, 4);
});
