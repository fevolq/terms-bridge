import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exposeWorkspaces } from '../dist/dsh/workspaces.js';
import { resolveProjects } from '../dist/projects/workspaces.js';
import { parseConfig } from '../dist/projects/config.js';
import { WORKSPACES_REMOTE } from '../dist/shared/workspaces.js';

test('native settings Remote reads applied project paths, not directory names or raw config', { skip: !process.env.DSH_TEST_PACKAGE }, async t => {
  const requireHost = createRequire(process.env.DSH_TEST_PACKAGE);
  const load = name => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)));
  const { Context } = await load('cordis'); const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const dir = await mkdtemp(join(tmpdir(), 'bridge-workspace-display-'));
  for (const [name, config] of [
    ['dsh-storage', {}], ['dsh-storage-json', { root: join(dir, 'storage') }],
    ['dsh-storage-domain', { backend: 'json' }], ['dsh-session', {}],
    ['dsh-session-persistence-jsonl', { root: join(dir, 'sessions') }],
  ]) { const plugin = await load(name); await ctx.plugin(plugin.default ?? plugin, config).await(); }
  const registry = await load('dsh-typert-registry'); await ctx.plugin(registry.default).await();
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: 'no-grant' }) });
  const gateway = await load('dsh-api-gateway'); await ctx.plugin(gateway.default ?? gateway).await();
  const workspace = await load('dsh-workspace'); await ctx.plugin(workspace.default ?? workspace).await();
  for (const name of ['default-workspace', 'other/news', 'manual']) await mkdir(join(dir, name), { recursive: true });
  await ctx.workspaceRegistry.create(join(dir, 'other/news'));
  await ctx.workspaceRegistry.create(join(dir, 'default-workspace'));
  const common = { provider: 'mock', model: 'mock', callback_url: 'http://localhost/results' };
  let config = parseConfig({ projects: { news: common, custom: { ...common, workspace_path: join(dir, 'manual') } } });
  const projects = await resolveProjects(ctx, config);
  const plugin = ctx.plugin({ inject: ['typert', 'workspaceRegistry'], apply(host) { exposeWorkspaces(host, projects, async () => {
    const next = await resolveProjects(host, config, projects);
    projects.clear(); for (const [id, project] of next) projects.set(id, project);
  }); } }); await plugin.await();
  const peer = { id: 'settings-test', ctx: ctx.extend(), principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'none', dispose: async () => {} };
  const request = { namespace: 'termsBridge', method: 'workspaces', args: {}, peer };
  const paths = await ctx.typertGateway.invoke(request);
  assert.deepEqual(paths, { news: projects.get('news').workspace_path, custom: projects.get('custom').workspace_path });
  assert.notEqual(paths.news, join(dir, 'other/news'));
  assert.equal(config.projects.news.workspace_path, undefined);
  const client = new Context(); t.after(() => client.fiber.dispose());
  await client.plugin(registry.default).await();
  client.provide('connection', { interactions: 'none', rpc: {
    open() {}, async call(_base, endpoint, payload) {
      assert.equal(endpoint, 'termsBridge/workspaces');
      return { ok: true, value: await ctx.typertGateway.invoke({ ...request, args: payload.args }) };
    },
  } });
  await client.plugin(await load('dsh-api-gateway/client')).await();
  let readPaths;
  await client.plugin({ inject: ['remote'], async apply(c) {
    await c.remote.$mount(WORKSPACES_REMOTE);
    await c.inject(['remote.termsBridge'], async scope => {
      readPaths = () => scope.remote.termsBridge.workspaces();
      assert.deepEqual(await readPaths(), { ok: true, value: paths });
    }).await();
  } }).await();
  config = parseConfig({ projects: { added: common } });
  assert.deepEqual(await ctx.typertGateway.invoke(request), { added: join(dir, 'added') });
  assert.deepEqual(await readPaths(), { ok: true, value: { added: join(dir, 'added') } });
  await assert.rejects(ctx.typertGateway.invoke({ ...request, peer: { ...peer, principal: { kind: 'guest' } } }), /access denied/);
  await plugin.dispose();
  await assert.rejects(ctx.typertGateway.invoke(request), /withdrawn|unavailable/);
});
