import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createEditor } from '../client/model.mjs';
import { settingsForm } from '../client/transport.mjs';
import { fixture, request, deferred, until } from './helpers.mjs';
import { taskKey } from '../dist/domain/request.js';
import { recordSchema } from '../dist/storage/tasks.js';

test('UI project removal rejects unfinished tasks before saving and persists after completion and restart', {
  skip: !process.env.DSH_TEST_PACKAGE,
}, async t => {
  const requireHost = createRequire(process.env.DSH_TEST_PACKAGE);
  const load = name => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)));
  const { boot, readProfilePatches, composeEntries } = await load('dsh-app-boot');
  const { Service } = await load('cordis');
  const dir = await mkdtemp(join(tmpdir(), 'bridge-project-removal-'));
  const home = join(dir, 'home');
  await mkdir(home);
  const defaultWorkspace = join(dir, 'default-workspace');
  await mkdir(defaultWorkspace);
  let ctx, editor;
  async function stop() {
    editor?.dispose(); editor = undefined;
    await ctx?.fiber.dispose(); ctx = undefined;
  }
  t.after(async () => {
    await stop();
    const within = relative(tmpdir(), dir);
    assert(within && !within.startsWith('..') && !isAbsolute(within));
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'bridge-removal-test', dsh: { profile: { bundles: [] } } }));
  await writeFile(join(dir, 'cordis.yml'), '[]');
  await writeFile(join(dir, 'bridge.mjs'), `
    export { Config } from '${new URL('../dist/dsh/settings.js', import.meta.url)}';
    import { watchProjectConfig } from '${new URL('../dist/dsh/settings.js', import.meta.url)}';
    import { TaskStore } from '${new URL('../dist/storage/tasks.js', import.meta.url)}';
    import { MemoryTable } from '${new URL('./helpers.mjs', import.meta.url)}';
    export const table = new MemoryTable();
    export function apply(ctx) {
      const workspaceRegistry = { list: () => [{ path: ${JSON.stringify(defaultWorkspace)}, title: 'default-workspace' }] };
      ctx.effect(() => watchProjectConfig({ fiber: ctx.fiber, on: ctx.on.bind(ctx), workspaceRegistry }, new Map(), new TaskStore(table, new MemoryTable())));
    }
  `);
  const entries = [
    { id: 'terms-bridge', name: pathToFileURL(join(dir, 'bridge.mjs')).href, config: { projects: {} } },
    ...['dsh-config-editor', 'dsh-settings'].map(name => ({ id: name, name: pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)).href })),
  ];
  const profile = { dir, home, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: dir, cwd: dir, startedBundles: [], overlays: [], name: 'removal-test' };
  await writeFile(profile.patchPath, JSON.stringify([{ insert: entries }]));
  const descriptor = () => ctx.settings.describe().find(row => row.ns === 'terms-bridge');
  const remoteView = () => ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'terms-bridge');
  async function start() {
    ctx = await boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', profile), async c => {
      class Profile extends Service {
        constructor(c) { super(c, 'profileContext'); Object.assign(this, profile); }
      }
      await c.plugin(Profile).await();
    });
    const form = { getSnapshot: () => ({ status: 'ready', writable: true, revision: remoteView().revision, value: remoteView().value }), subscribe: () => () => {} };
    editor = createEditor(settingsForm({
      configForms: { get: () => form, describe: () => ({ getSnapshot: () => ({ view: { namespaces: [remoteView()] } }), acceptView() {} }) },
      remote: { settings: { mutate: async (ns, ops, revision) => {
        await ctx.settings.mutate(ns, ops, revision);
        return { ok: true, value: remoteView() };
      } } },
    }));
  }
  function add(id) {
    const key = editor.add();
    const fields = { id, name: id, provider: 'mock', model: 'test', agent_preset: 'standard', callback_url: 'http://127.0.0.1:8001/callback',
      request_token: id + '-secret', callback_headers: JSON.stringify({ 'X-API-Key': id + '-callback-secret' }) };
    for (const [name, value] of Object.entries(fields)) editor.project(key, name, value);
  }
  function diskProjects() {
    return composeEntries([readProfilePatches('dsh', profile)]).find(row => row.id === 'terms-bridge').config.projects;
  }

  // Both projects are added through the actual UI save logic, with no preset projects.
  await start();
  add('remove-me'); add('keep-me');
  assert.equal(await editor.save(), true);
  const keep = structuredClone(descriptor().value.projects['keep-me']);
  await stop();
  await start();
  assert.deepEqual(Object.keys(descriptor().value.projects).sort(), ['keep-me', 'remove-me']);

  const { table } = await import(pathToFileURL(join(dir, 'bridge.mjs')));
  const gate = deferred();
  let callbackReady = false;
  const f = await fixture({ table,
    run: async record => {
      if (record.execution.attempts === 1) throw new Error('temporary execution failure');
      await gate.promise;
      return { result: 'done', files: [] };
    },
    callback: async () => callbackReady ? null : 'HTTP 503',
  });
  t.after(async () => { gate.resolve(); await f.engine.close(); });
  const project = f.projects.get('news');
  f.projects.clear(); f.projects.set('remove-me', project);
  await f.engine.accept(request('pending', 'remove-me'));
  const record = () => f.store.get(taskKey('remove-me', 'pending', 'chat-1'));
  const beforeRemoval = await readFile(profile.patchPath, 'utf8');
  let beforeRevision = descriptor().revision;
  async function rejectedBeforeWrite() {
    recordSchema.parse(record());
    assert.equal(await editor.save(), false);
    assert.match(editor.getSnapshot().message, /remove-me.*未完成任务/);
    assert.equal(editor.getSnapshot().dirty, true, 'keep the unsaved removal draft');
    assert.equal(descriptor().revision, beforeRevision);
    assert.equal(await readFile(profile.patchPath, 'utf8'), beforeRemoval);
    assert.deepEqual(Object.keys(diskProjects()).sort(), ['keep-me', 'remove-me']);
    assert.deepEqual(descriptor().value.projects['keep-me'], keep);
    assert.equal(f.engine.available, true);
  }
  editor.remove(editor.getSnapshot().draft.rows.find(row => row.id === 'remove-me').key);
  assert.equal(await readFile(profile.patchPath, 'utf8'), beforeRemoval, 'unsaved removal must not change disk');
  await t.test('queued task prevents persistence', rejectedBeforeWrite);

  // A rejected deletion must still leave a usable profile after restarting dsh.
  await stop(); await start();
  assert.deepEqual(Object.keys(descriptor().value.projects).sort(), ['keep-me', 'remove-me']);
  beforeRevision = descriptor().revision;
  assert.equal(record().status, 'queued');
  editor.remove(editor.getSnapshot().draft.rows.find(row => row.id === 'remove-me').key);

  await f.cycle(); assert.equal(record().status, 'retrying');
  await t.test('execution retry prevents persistence', rejectedBeforeWrite);
  f.advance(60000); f.engine.tick();
  await until(() => record().status === 'running');
  await t.test('running task prevents persistence', rejectedBeforeWrite);
  gate.resolve(); await f.engine.settle();
  assert.equal(record().status, 'completed'); assert.equal(record().delivery.status, 'pending');
  await t.test('pending callback prevents persistence', rejectedBeforeWrite);
  await f.cycle(); assert.equal(record().delivery.status, 'retrying');
  await t.test('callback retry prevents persistence', rejectedBeforeWrite);
  callbackReady = true; f.advance(60000); await f.cycle();
  assert.equal(record().delivery.status, 'delivered');

  assert.equal(await editor.save(), true);
  assert.deepEqual(descriptor().value.projects, { 'keep-me': keep });
  assert.deepEqual(diskProjects(), { 'keep-me': keep });
  assert.doesNotMatch(await readFile(profile.patchPath, 'utf8'), /remove-me/);

  await stop();
  await start();
  assert.deepEqual(descriptor().value.projects, { 'keep-me': keep });
  assert.deepEqual(editor.getSnapshot().draft.rows.map(row => row.id), ['keep-me']);
  editor.remove(editor.getSnapshot().draft.rows[0].key);
  assert.equal(await editor.save(), true);
  assert.deepEqual(descriptor().value.projects, {});
  assert.deepEqual(diskProjects(), {});
  assert.doesNotMatch(await readFile(profile.patchPath, 'utf8'), /remove-me|keep-me/);

  await stop();
  await start();
  assert.deepEqual(descriptor().value.projects, {});
  assert.deepEqual(editor.getSnapshot().draft.rows, []);
  assert.equal(descriptor().value.api_prefix, '/api/terms-bridge');
});
