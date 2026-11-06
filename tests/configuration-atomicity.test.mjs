import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { apply } from '../dist/index.js';
import { parseConfig } from '../dist/projects/config.js';
import { MemoryTable, deferred, listenHttp, request, until } from './helpers.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-config-atomicity-'));
  const tables = { projects: new MemoryTable(), tasks: new MemoryTable(), conversations: new MemoryTable() };
  const initial = parseConfig({ projects: { news: { provider: 'test', model: 'original', workspace_path: dir,
    max_concurrency: 1, callback_url: 'http://localhost/original' } } });
  const f = { config: structuredClone(initial), initial, tables, routes: new Map(), dir };
  const disposers = [], workspaces = new Map();
  f.stop = async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); };
  const unexpected = () => assert.fail('These tests must not send a model request');
  const server = createServer((req, res) => {
    const route = [...f.routes.values()].find(route => req.url.startsWith(route.path + '/'));
    if (route) void route.handler(req, res);
    else { res.writeHead(404); res.end(); }
  });
  t.after(async () => {
    await f.stop();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const child = relative(tmpdir(), dir); assert(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(dir, { recursive: true, force: true });
  });
  const host = {
    workspaceRegistry: { list: () => [...workspaces.values()], create: async path => {
      if (!workspaces.has(path)) workspaces.set(path, { id: String(workspaces.size + 1), path, attachSession: unexpected });
      return workspaces.get(path);
    } },
    storageDomain: { open: async () => ({ table: name => tables[name], close: async () => {} }) },
    // Keep accepted tasks queued so their captured project can be inspected.
    agents: { get: () => ({ status: 'running' }) }, sessionPersistence: { stat: async () => ({}) },
    permissionPresets: { set: unexpected }, sessionProjections: { stateOf: unexpected },
    sessionController: { create: unexpected, resolveAgent: unexpected,
      agents: { selectionFor: unexpected, selectForNextRequest: unexpected } },
    attachments: { saveImage: unexpected, saveFileStream: unexpected, fileHostPath: unexpected, imageHostPath: unexpected },
    webServer: { register: route => {
      if (route.path === f.conflict) throw new Error('route conflict');
      assert.equal(f.routes.has(route.path), false);
      f.routes.set(route.path, route); return () => f.routes.delete(route.path);
    } },
    typert: { register: () => () => {} },
    provide: (_name, service) => { f.remote = service; return () => {}; },
    effect: callback => { disposers.push(callback()); },
  };
  await apply(host, { api_prefix: { get: () => f.config.api_prefix }, projects: { get: () => f.config.projects } });
  await listenHttp(server);
  f.submit = async (id, prefix = initial.api_prefix, project = 'news') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${prefix}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request(id, project)),
    });
    await response.json(); return response.status;
  };
  f.projectOf = id => [...tables.tasks.entries()].find(([, task]) => task.request.metadata.conversation_id === id)?.[1].project;
  f.changed = () => parseConfig({ api_prefix: '/changed', projects: {
    news: { ...initial.projects.news, model: 'updated', max_concurrency: 5, callback_url: 'http://localhost/updated' },
    extra: { ...initial.projects.news, workspace_path: tmpdir() },
  } });
  return f;
}

for (const changeRoute of [false, true]) test('failed binding writes preserve runtime configuration through revert and retry; route changes=' + changeRoute, async t => {
  const f = await setup(t);
  assert.equal(await f.submit('before'), 202);
  const saved = f.tables.projects.get('current');
  const original = f.projectOf('before');
  const changed = f.changed;
  f.changed = () => { const config = changed(); if (!changeRoute) config.api_prefix = f.initial.api_prefix; return config; };
  f.config = f.changed(); f.tables.projects.failWrites = true;
  await assert.rejects(f.remote.workspaces(), /disk unavailable/);
  assert.deepEqual([...f.routes.keys()], [f.initial.api_prefix]);
  assert.deepEqual(f.tables.projects.get('current'), saved);
  await assert.rejects(f.remote.workspaces(), /disk unavailable/);

  f.tables.projects.failWrites = false; f.config = structuredClone(f.initial);
  assert.deepEqual(await f.remote.workspaces(), { news: original.workspace_path });
  assert.equal(await f.submit('after-revert'), 202);
  assert.deepEqual(f.projectOf('after-revert'), original);
  assert.equal(await f.submit('removed-project', f.initial.api_prefix, 'extra'), 404);

  f.config = f.changed(); await f.remote.workspaces();
  assert.deepEqual([...f.routes.keys()], [f.config.api_prefix]);
  assert.equal(await f.submit('after-retry', f.config.api_prefix), 202);
  assert.equal(f.projectOf('after-retry').model, 'updated');
  assert.equal(f.projectOf('after-retry').max_concurrency, 5);
  assert.equal(f.projectOf('after-retry').callback_url, 'http://localhost/updated');
  assert.deepEqual(f.projectOf('before'), original);
  assert.deepEqual(f.projectOf('after-revert'), original);
  assert.ok(f.tables.projects.get('current').extra);
});

test('route conflicts reject a configuration before persisting its workspace bindings', async t => {
  const f = await setup(t), saved = f.tables.projects.get('current');
  f.config = f.changed(); f.conflict = f.config.api_prefix;
  await assert.rejects(f.remote.workspaces(), /route conflict/);
  assert.deepEqual(f.tables.projects.get('current'), saved);
  assert.deepEqual([...f.routes.keys()], [f.initial.api_prefix]);
  f.config = structuredClone(f.initial);
  assert.deepEqual(await f.remote.workspaces(), { news: f.dir });
  assert.equal(await f.submit('after-conflict'), 202);
  assert.equal(f.projectOf('after-conflict').model, 'original');
});

test('requests wait for binding persistence and see only the committed project configuration', async t => {
  const f = await setup(t), gate = deferred(); let saving = false;
  const put = f.tables.projects.put.bind(f.tables.projects);
  f.tables.projects.put = async (...args) => { saving = true; await gate.promise; await put(...args); };
  f.config = f.changed();
  const update = f.remote.workspaces();
  t.after(() => gate.resolve());
  await until(() => saving);
  const pending = f.submit('during-save', '/changed');
  assert.equal(f.tables.tasks.records.size, 0);
  gate.resolve(); await update;
  assert.equal(await pending, 202);
  assert.equal(f.projectOf('during-save').model, 'updated');
});


test('shutdown during binding persistence drains the update and leaves no candidate route registered', async t => {
  const f = await setup(t), gate = deferred(); let saving = false;
  const put = f.tables.projects.put.bind(f.tables.projects);
  f.tables.projects.put = async (...args) => { saving = true; await gate.promise; await put(...args); };
  f.config = f.changed();
  const update = f.remote.workspaces();
  try {
    await until(() => saving);
    const stopping = f.stop();
    gate.resolve(); await Promise.all([update, stopping]);
    assert.equal(f.routes.size, 0);
    assert.equal(f.tables.tasks.records.size, 0);
  } finally { gate.resolve(); }
});
