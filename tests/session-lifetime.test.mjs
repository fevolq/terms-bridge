import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fixture, request, successRun, deferred, listenHttp } from './helpers.mjs';
import { handler } from '../dist/http/api.js';
import { recordSchema } from '../dist/storage/tasks.js';
import { UnsettledExecutionError } from '../dist/domain/types.js';
import { taskKey } from '../dist/domain/request.js';

const missingSession = error => error.status === 404 && error.code === 'SESSION_NOT_FOUND';

test('deleted completed session returns HTTP 404, skips callbacks and stays ignored after reload', async t => {
  let exists = true, callbacks = 0;
  const f = await fixture({
    sessionExists: async () => exists,
    run: async (_record, _signal, session) => { await session.ready(); return successRun(); },
    callback: async () => { callbacks++; return null; }, overrides: { request_token: '' },
  });
  const server = createServer(handler(f.engine, '/api/terms-bridge', f.transfer));
  await listenHttp(server);
  t.after(async () => { await f.engine.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await f.engine.accept(request()); await f.cycle();
  assert.equal((await f.engine.query('news', 'task-1', 'chat-1')).result, 'done');
  exists = false;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/terms-bridge/projects/news/conversations/task-1/chats/chat-1`);
  assert.equal(response.status, 404);
  assert.deepEqual((await response.json()).error, { code: 'SESSION_NOT_FOUND', message: '会话不存在' });
  await assert.rejects(f.engine.accept(request()), e => e.code === 'CHAT_ALREADY_EXISTS');
  await assert.rejects(f.engine.accept(request('task-1', 'news', 'next')), missingSession);
  await f.engine.recover(); f.advance(600000); await f.cycle();
  assert.equal(callbacks, 0); assert.equal(f.record().execution.attempts, 1);
  recordSchema.parse(f.record());
});

test('deleting the current failed session prevents a new execution attempt', async () => {
  let exists = true;
  const f = await fixture({ sessionExists: async () => exists,
    run: async (_record, _signal, session) => { await session.ready(); throw new Error('execution failed'); },
  });
  await f.engine.accept(request()); await f.cycle(); assert.equal(f.record().status, 'retrying');
  exists = false; f.advance(60000); await f.cycle();
  assert.equal(f.record().execution.attempts, 1);
  await assert.rejects(f.engine.query('news', 'task-1', 'chat-1'), missingSession);
  await f.engine.close();
});

test('allocated session IDs are not treated as deleted; a deleted running session result is ignored', async t => {
  const entered = deferred(), create = deferred(), created = deferred(), finish = deferred();
  let exists = false, checks = 0, callbacks = 0;
  const f = await fixture({ sessionExists: async () => { checks++; return exists; },
    run: async (_record, _signal, session) => {
      entered.resolve(); await create.promise;
      exists = true; await session.ready(); created.resolve(); await finish.promise;
      return successRun();
    }, callback: async () => { callbacks++; return null; },
  });
  t.after(async () => { create.resolve(); finish.resolve(); await f.engine.close(); });
  await f.engine.accept(request()); assert.equal((await f.engine.query('news', 'task-1', 'chat-1')).status, 'queued');
  f.engine.tick(); await entered.promise;
  assert.equal((await f.engine.query('news', 'task-1', 'chat-1')).status, 'running'); assert.equal(checks, 0);
  create.resolve(); await created.promise; exists = false; finish.resolve(); await f.engine.settle();
  await f.cycle(); assert.equal(callbacks, 0); assert.equal(f.record().result, undefined);
  await assert.rejects(f.engine.query('news', 'task-1', 'chat-1'), missingSession);
});

test('deleting a session during callback delivery does not schedule a retry', async t => {
  const sending = deferred(), finish = deferred(); let exists = true, callbacks = 0;
  const f = await fixture({ sessionExists: async () => exists,
    run: async (_record, _signal, session) => { await session.ready(); return successRun(); },
    callback: async () => { callbacks++; sending.resolve(); await finish.promise; return 'CALLBACK_ERROR'; },
  });
  t.after(async () => { finish.resolve(); await f.engine.close(); });
  await f.engine.accept(request()); await f.cycle(); f.engine.tick(); await sending.promise;
  exists = false; finish.resolve(); await f.engine.settle();
  f.advance(60000); await f.cycle(); assert.equal(callbacks, 1);
  await assert.rejects(f.engine.query('news', 'task-1', 'chat-1'), missingSession);
});

test('failure before session creation still uses the configured execution retry policy', async () => {
  const f = await fixture({ sessionExists: async () => assert.fail('No session has been created'),
    run: async () => { throw new Error('preparation failed'); },
  });
  await f.engine.accept(request()); await f.cycle(); f.advance(60000); await f.cycle();
  assert.equal(f.record().execution.attempts, 2); assert.equal(f.record().status, 'retrying');
  assert.equal(f.store.conversations.get(request().metadata).deleted, false); await f.engine.close();
});

test('a deleted session disposal error is ignored without pausing other tasks', async () => {
  let exists = true;
  const f = await fixture({ sessionExists: async () => exists,
    run: async (_record, _signal, session) => {
      await session.ready(); exists = false; throw new UnsettledExecutionError('Session was deleted');
    },
  });
  await f.engine.accept(request()); await f.cycle();
  assert.equal(f.engine.available, true); assert.equal(f.store.conversations.get(request().metadata).deleted, true);
  assert.equal(f.record().execution.attempts, 1); await f.engine.close();
});

test('one deletion marker stops every chat without rewriting tasks and survives reload', async t => {
  let exists = true;
  const f = await fixture({ sessionExists: async () => exists,
    run: async (_task, _signal, session) => { await session.ready(); return successRun(); },
    callback: async () => assert.fail('A deleted conversation must not deliver callbacks'),
  });
  t.after(() => f.engine.close());
  await f.engine.accept(request()); await f.cycle();
  await f.engine.accept(request('task-1', 'news', 'next'));
  const before = f.store.list();
  f.table.failWrites = true; exists = false;
  await assert.rejects(f.engine.query('news', 'task-1', 'chat-1'), missingSession);
  await assert.rejects(f.engine.query('news', 'task-1', 'next'), missingSession);
  assert.equal(f.store.conversations.get(request().metadata).deleted, true);
  await f.cycle();
  assert.equal(f.engine.available, true);
  assert.deepEqual(f.store.list(), before);
  assert.ok(f.store.list().every(([, task]) => !f.store.active(task)));
  assert.equal(f.store.busy(request().metadata), false);
  await f.engine.reconfigure(new Map());
  await f.engine.close();
  const restored = await fixture({ database: f.database,
    run: async () => assert.fail('A deleted conversation must not execute'),
    callback: async () => assert.fail('A deleted conversation must not deliver callbacks'),
    sessionExists: async () => assert.fail('A known deletion does not require another host lookup'),
  });
  t.after(() => restored.engine.close());
  await restored.cycle();
  await assert.rejects(restored.engine.query('news', 'task-1', 'next'), missingSession);
  await assert.rejects(restored.engine.accept(request()), error => error.code === 'CHAT_ALREADY_EXISTS');
  await assert.rejects(restored.engine.accept(request('task-1', 'news', 'later')), missingSession);
  assert.deepEqual(restored.store.list(), before);
});

test('a delayed task write observes a conversation deleted while it was waiting', async t => {
  const entered = deferred(), resume = deferred();
  const f = await fixture();
  const updateTask = f.table.update.bind(f.table);
  f.table.update = async (key, change) => { entered.resolve(); await resume.promise; return updateTask(key, change); };
  t.after(async () => { resume.resolve(); await f.engine.close(); });
  await f.engine.accept(request()); const before = f.record();
  const update = f.store.update(taskKey('news', 'task-1', 'chat-1'), () => assert.fail('Late transition must be ignored'));
  await entered.promise;
  await f.store.conversations.mark(request().metadata, 'deleted');
  resume.resolve(); await update;
  assert.deepEqual(f.record(), before);
});
