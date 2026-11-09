import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteFixture } from './sqlite-fixture.mjs';
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
    ['other', { ...old, workspace_path: '/other-project' }],
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
  await assert.rejects(f.engine.reconfigure(new Map([['news', { ...old, workspace_path: old.workspace_path + '/different' }]])), /Active tasks/);
  await assert.rejects(f.engine.reconfigure(new Map([['news', { ...old, model: 'new' }]]), () => { throw new Error('route conflict'); }), /route conflict/);
  assert.deepEqual(f.projects.get('news'), old);
  assert.equal(f.engine.available, true); await f.engine.close();
});

test('configuration saves serialize and reject a stale second writer without losing changes', async t => {
 const f=await sqliteFixture(t), revision=f.remote.settings().revision;
 const [first,second]=await Promise.all([
  f.remote.mutate([{op:'set',path:['projects','news','model'],value:'first'}],revision),
  f.remote.mutate([{op:'set',path:['projects','news','model'],value:'second'}],revision),
 ]);
 assert.equal(first.accepted,true);assert.equal(second.accepted,false);assert.equal(second.error.code,'REVISION_CONFLICT');
 assert.equal(f.remote.settings().value.projects.news.model,'first');
 assert.equal((await f.save([{op:'set',path:['projects','news','model'],value:'second'}])).accepted,true);
 assert.equal(f.remote.settings().value.projects.news.model,'second');
});

test('pending configuration persistence leaves running tasks intact and rejects new admissions until it settles', async t => {
  const taskGate = deferred(), saveGate = deferred(); let started, saving = false;
  const f = await fixture({ run: async (task, signal) => { started = { task, signal }; await taskGate.promise; return { result: 'finished', files: [] }; } });
  t.after(async () => { taskGate.resolve(); saveGate.resolve(); await f.engine.close(); });
  await f.engine.accept(request('running')); f.engine.tick(); await until(() => started);
  const original = structuredClone(f.projects.get('news'));
  const update = f.engine.reconfigure(new Map([['news', { ...original, model: 'updated' }]]), async () => {
    saving = true; await saveGate.promise; throw new Error('binding persistence failed');
  });
  const rejected = assert.rejects(update, /binding persistence failed/);
  await until(() => saving);
  await assert.rejects(f.engine.accept(request('during-save')), error => error.code === 'SERVICE_UNAVAILABLE');
  assert.equal(started.signal.aborted, false);
  taskGate.resolve(); await f.engine.settle();
  assert.equal(f.record('running').status, 'completed');
  assert.deepEqual(f.record('running').project, original);
  saveGate.resolve(); await rejected;
  assert.equal(f.engine.available, true);
  assert.deepEqual(f.projects.get('news'), original);
  await f.engine.accept(request('after-failure'));
  assert.deepEqual(f.record('after-failure').project, original);
});
