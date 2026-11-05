import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveConfig } from '../dist/projects/live.js';
import { parseConfig } from '../dist/projects/config.js';
import { fixture, request, deferred, until } from './helpers.mjs';

test('concurrency switches between limited and unlimited without interrupting running tasks', async t => {
  const gates = new Map(['a', 'b', 'c', 'd'].map(id => [id, deferred()])); const started = [];
  const f = await fixture({ overrides: { max_concurrency: 1 }, run: async (record, signal) => {
    const id = record.request.metadata.conversation_id; started.push({ id, signal });
    await gates.get(id).promise; return { result: id, files: [] };
  } });
  t.after(async () => { for (const gate of gates.values()) gate.resolve(); await f.engine.close(); });
  for (const id of ['a', 'b', 'c']) await f.engine.accept(request(id));
  f.engine.tick(); await until(() => started.length === 1);
  const session = f.record('a').execution.session_id;
  const update = limit => f.engine.reconfigure(new Map([['news', { ...f.projects.get('news'), max_concurrency: limit }]]));
  await update(0); f.engine.tick(); await until(() => started.length === 3);
  assert.equal(f.record('a').execution.session_id, session);
  await update(1); await f.engine.accept(request('d')); f.engine.tick();
  assert.equal(started.length, 3); assert.equal(f.record('d').status, 'queued');
  assert.ok(started.every(item => !item.signal.aborted));
  gates.get('a').resolve(); gates.get('b').resolve();
  await until(() => f.record('a').status === 'completed' && f.record('b').status === 'completed');
  f.engine.tick(); assert.equal(started.length, 3);
  gates.get('c').resolve();
  await until(() => { f.engine.tick(); return started.length === 4; });
  assert.deepEqual(started.map(item => item.id), ['a', 'b', 'c', 'd']);
});

test('adding and updating projects keeps active sessions, queued snapshots, callback destinations and retry budgets', async () => {
  const gate = deferred(); const started = []; const deliveries = [];
  const f = await fixture({ overrides: { max_concurrency: 1, callback_headers: { Authorization: 'Bearer original-callback-token' } }, run: async (record, signal) => {
    started.push({ record, signal });
    if (record.request.metadata.conversation_id === 'running') await gate.promise;
    return { result: record.project.model, files: [] };
  }, callback: async record => { deliveries.push(record); return null; } });
  await f.engine.accept(request('running')); await f.engine.accept(request('queued'));
  f.engine.tick(); await until(() => started.length === 1);
  const old = structuredClone(f.projects.get('news'));
  await f.engine.reconfigure(new Map([
    ['news', { ...old, model: 'new-model', permission_mode: 'auto', callback_url: 'https://new.example/results', callback_headers: { Authorization: 'Bearer new-callback-token' }, max_execution_retries: 0 }],
    ['other', { ...old, workspace_id: 'workspace-2', workspace_path: '/other-project' }],
  ]));
  assert.equal(started[0].signal.aborted, false);
  assert.equal(f.record('running').execution.session_id, started[0].record.execution.session_id);
  assert.equal(f.record('running').execution.attempts, 1);
  assert.deepEqual(f.record('queued').project, old);
  await f.engine.accept(request('new')); await f.engine.accept(request('second-project', 'other'));
  assert.equal(f.record('new').project.model, 'new-model');
  assert.equal(f.record('new').project.max_execution_retries, 0);
  assert.equal(f.record('new').project.permission_mode, 'auto');
  assert.equal(f.record('running').project.permission_mode, 'workspace-write');
  gate.resolve(); await f.engine.settle();
  for (let i = 0; i < 5; i++) await f.cycle();
  assert.equal(f.record('running').status, 'completed');
  assert.equal(deliveries.find(r => r.request.metadata.conversation_id === 'running').project.callback_url, old.callback_url);
  assert.equal(deliveries.find(r => r.request.metadata.conversation_id === 'queued').project.model, old.model);
  assert.equal(deliveries.find(r => r.request.metadata.conversation_id === 'new').project.callback_url, 'https://new.example/results');
  assert.equal(deliveries.find(r => r.request.metadata.conversation_id === 'running').project.callback_headers.Authorization, 'Bearer original-callback-token');
  assert.equal(deliveries.find(r => r.request.metadata.conversation_id === 'new').project.callback_headers.Authorization, 'Bearer new-callback-token');
  await f.engine.close();
});

test('invalid removals and route activation failures cannot partially replace the project registry', async () => {
  const f = await fixture(); await f.engine.accept(request());
  const old = structuredClone(f.projects.get('news'));
  await assert.rejects(f.engine.reconfigure(new Map()), /Active tasks/);
  await assert.rejects(f.engine.reconfigure(new Map([['news', { ...old, workspace_id: 'different' }]])), /Active tasks/);
  await assert.rejects(f.engine.reconfigure(new Map([['news', { ...old, model: 'new' }]]), () => { throw new Error('route conflict'); }), /route conflict/);
  assert.deepEqual(f.projects.get('news'), old);
  assert.equal(f.engine.available, true); await f.engine.close();
});

test('live config serializes updates, preserves the last working registry after failure and retries explicit saves', async () => {
  let value = {}; const raw = { projects: { get: () => value } };
  const gate = deferred(); const applied = []; const errors = [];
  let fail = false;
  const template = (await fixture()).projects.get('news');
  const { workspace_id, ...project } = template;
  const live = new LiveConfig(() => ({ projects: value }), parseConfig({}), async config => {
    if (applied.length === 0) await gate.promise;
    if (fail) throw new Error('invalid workspace');
    applied.push(config);
  }, error => errors.push(error));
  value = { first: project };
  const first = live.refresh(); await Promise.resolve();
  value = { first: project, second: { ...project, workspace_path: '/second' } };
  const second = live.refresh(); gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(Object.keys(applied.at(-1).projects), ['first', 'second']);
  fail = true; value = { third: project };
  await assert.rejects(live.refresh()); await assert.rejects(live.refresh());
  assert.equal(errors.length, 1); assert.equal(applied.length, 2);
  fail = false; await live.refresh(true); assert.deepEqual(Object.keys(applied.at(-1).projects), ['third']);
  await live.close(); value = {}; await live.refresh(); assert.equal(applied.length, 3);
});
