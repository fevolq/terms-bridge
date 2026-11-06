import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request, successRun, deferred, until, project } from './helpers.mjs';
import { TaskEngine } from '../dist/services/tasks.js';
import { taskKey } from '../dist/domain/request.js';
import { LIMITS } from '../dist/shared/rules.js';
const CALLBACK_RETRY_MS = LIMITS.callbackInterval;
import { UnsettledExecutionError } from '../dist/domain/types.js';
import { recordSchema } from '../dist/storage/tasks.js';

test('concurrent duplicate admission creates one durable task; conflicts cannot overwrite', async () => {
  const f = await fixture();
  const responses = await Promise.allSettled(Array.from({ length: 12 }, () => f.engine.accept(request())));
  assert.equal(responses.filter(r => r.status === 'fulfilled' && r.value.status === 202).length, 1);
  assert.equal(responses.filter(r => r.status === 'rejected' && r.reason.code === 'CHAT_ALREADY_EXISTS').length, 11);
  assert.equal(f.store.list().length, 1);
  const changed = request(); changed.instruction = 'different';
  await assert.rejects(f.engine.accept(changed), e => e.code === 'CHAT_ALREADY_EXISTS');
  assert.equal(f.record().request.instruction, 'Summarize input.');
});

test('default execution retries create four unique attempts; restart and duplicate requests do not reset exhaustion', async () => {
  const sessions = [], attempts = [];
  const f = await fixture({ run: async r => { sessions.push(r.execution.session_id); attempts.push(r.execution.attempt_id); throw new Error('model failed'); } });
  await f.engine.accept(request());
  for (let i = 0; i < 4; i++) { await f.cycle(); f.advance(60_000); }
  assert.equal(f.record().status, 'failed');
  assert.equal(new Set(sessions).size, 1);
  assert.equal(new Set(attempts).size, 4);
  assert.equal(f.record().execution.attempts, 4);
  await assert.rejects(f.engine.accept(request()), e => e.code === 'CHAT_ALREADY_EXISTS'); await f.cycle();
  const restarted = new TaskEngine(f.store, f.projects, async () => assert.fail('exhausted task ran'), { files: f.files, callback: async () => null });
  await restarted.recover(); restarted.tick(); await restarted.settle();
  assert.equal(f.record().execution.attempts, 4);
});

test('zero retries runs exactly once', async () => {
  const f = await fixture({ overrides: { max_execution_retries: 0 } });
  await f.engine.accept(request()); await f.cycle(); f.advance(60_000); await f.cycle();
  assert.equal(f.record().status, 'failed'); assert.equal(f.record().execution.attempts, 1);
});

test('queued chats and retries keep their due order across recovery', async t => {
  const calls = [];
  const f = await fixture({ overrides: { max_concurrency: 1 }, run: async task => {
    const id = task.request.metadata.conversation_id; calls.push(id);
    if (id === 'retry' && task.execution.attempts === 1) throw new Error('Retry once');
    return successRun();
  } });
  t.after(() => f.engine.close());
  await f.engine.accept(request('retry')); await f.cycle();
  f.advance(59_999); await f.cycle();
  assert.deepEqual(calls, ['retry']);
  await f.engine.accept(request('earlier'));
  f.advance(2); await f.engine.accept(request('later'));
  await f.engine.recover();
  for (let i = 0; i < 3; i++) await f.cycle();
  assert.deepEqual(calls, ['retry', 'earlier', 'retry', 'later']);
  for (const id of ['retry', 'earlier', 'later']) assert.equal(f.record(id).status, 'completed');
});

test('callback makes eleven total attempts, at least one minute apart, without re-executing business', async () => {
  let runs = 0; const bodies = [];
  const f = await fixture({ run: async (...args) => { runs++; return successRun(...args); }, callback: async r => { bodies.push(r.callback_body); return 'HTTP 503'; } });
  await f.engine.accept(request()); await f.cycle();
  for (let i = 1; i <= 11; i++) {
    await f.cycle(); assert.equal(f.record().delivery.attempts, i);
    f.advance(CALLBACK_RETRY_MS - 1); await f.cycle(); assert.equal(f.record().delivery.attempts, i);
    f.advance(1);
  }
  await f.cycle(); assert.equal(bodies.length, 11); assert.equal(new Set(bodies).size, 1);
  assert.equal(runs, 1); assert.equal(f.record().status, 'completed');
  assert.equal(f.record().delivery.status, 'failed'); assert.equal(f.record().delivery.next_retry_at, null);
  assert.deepEqual((await f.engine.query('news', 'task-1', 'chat-1')).result, 'done');
  recordSchema.parse(f.record());
});

test('project concurrency stays occupied until execution and teardown finish', async () => {
  const gate = deferred(); let running = 0; let peak = 0; let started = 0;
  const f = await fixture({ run: async (...args) => {
    started++; running++; peak = Math.max(peak, running); await successRun(...args); await gate.promise; running--; return successRun(...args);
  } });
  await Promise.all(['a', 'b', 'c'].map(id => f.engine.accept(request(id))));
  f.engine.tick(); await until(() => started === 2); f.engine.tick(); assert.equal(started, 2);
  gate.resolve(); await f.engine.settle(); await f.cycle(); assert.equal(started, 3); assert.equal(peak, 2);
});

test('zero or omitted concurrency starts every ready task without waiting for a slot', async t => {
  for (const limit of [0, undefined]) {
    const gate = deferred(); const started = [];
    const f = await fixture({ overrides: { max_concurrency: limit }, run: async record => {
      started.push(record.request.metadata.conversation_id); await gate.promise; return successRun();
    } });
    t.after(async () => { gate.resolve(); await f.engine.close(); });
    for (const id of ['a', 'b', 'c', 'd']) await f.engine.accept(request(id));
    f.engine.tick(); await until(() => started.length === 4);
    assert.equal(f.projects.get('news').max_concurrency, 0);
    assert.deepEqual(started, ['a', 'b', 'c', 'd']);
    for (const id of started) assert.equal(f.record(id).status, 'running');
    gate.resolve(); await f.engine.settle();
    recordSchema.parse(f.record('a'));
  }
});

test('positive concurrency queues excess tasks in submission order as slots become free', async t => {
  const ids = ['z', 'a', 'y', 'b']; const gates = new Map(ids.map(id => [id, deferred()]));
  const started = []; let running = 0, peak = 0;
  const f = await fixture({ overrides: { max_concurrency: 2 }, run: async record => {
    const id = record.request.metadata.conversation_id;
    started.push(id); running++; peak = Math.max(peak, running);
    await gates.get(id).promise; running--; return successRun();
  } });
  t.after(async () => { for (const gate of gates.values()) gate.resolve(); await f.engine.close(); });
  for (const id of ids) { await f.engine.accept(request(id)); f.advance(1); }
  f.engine.tick(); await until(() => started.length === 2);
  assert.deepEqual(started, ['z', 'a']);
  assert.equal(f.record('y').status, 'queued'); assert.equal(f.record('b').status, 'queued');
  gates.get('a').resolve();
  await until(() => { f.engine.tick(); return started.length === 3; });
  assert.deepEqual(started, ['z', 'a', 'y']); assert.equal(f.record('b').status, 'queued');
  gates.get('z').resolve();
  await until(() => { f.engine.tick(); return started.length === 4; });
  assert.deepEqual(started, ids); assert.equal(peak, 2);
});

test('failed durable admission never acknowledges success', async () => {
  const f = await fixture(); f.table.failWrites = true;
  await assert.rejects(f.engine.accept(request())); assert.equal(f.store.list().length, 0);
});

test('persisted interrupted final attempts fail without receiving extra retry budget', async () => {
  const f = await fixture({ overrides: { max_execution_retries: 0 } }); await f.engine.accept(request());
  await f.store.update(taskKey('news', 'task-1', 'chat-1'), r => ({ ...r, status: 'running', execution: {
    ...r.execution, attempts: 1, attempt_id: 'old',
  } }));
  await f.engine.recover(); assert.equal(f.record().status, 'failed');
  const g = await fixture({ run: successRun }); await g.engine.accept(request()); await g.cycle();
  await g.store.update(taskKey('news', 'task-1', 'chat-1'), r => ({ ...r, delivery: { ...r.delivery, attempts: 11, in_flight: true } }));
  await g.engine.recover(); assert.equal(g.record().delivery.status, 'failed'); assert.equal(g.record().status, 'completed');
});

test('two projects route their own model, workspace and callbacks', async () => {
  const seen = []; const callbacks = [];
  const f = await fixture({ run: async (r, ...args) => { seen.push(r.project); return successRun(r, ...args); }, callback: async r => { callbacks.push(r.project.callback_url); return null; } });
  f.projects.set('other', { ...project({ model: 'other-model', callback_url: 'http://localhost/other' }) });
  await f.engine.accept(request()); await f.engine.accept(request('task-1', 'other')); await f.cycle(); await f.cycle();
  assert.deepEqual(seen.map(p => p.model).sort(), ['other-model', 'test-model']);
  assert.deepEqual(callbacks.sort(), ['http://localhost/callback', 'http://localhost/other']);
});
