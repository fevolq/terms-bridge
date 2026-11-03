import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fixture, request, successRun, deferred, listenHttp } from './helpers.mjs';
import { handler } from '../dist/http/api.js';
import { recordSchema } from '../dist/storage/tasks.js';
import { UnsettledExecutionError } from '../dist/domain/types.js';

const missingSession = error => error.status === 404 && error.code === 'SESSION_NOT_FOUND';

test('deleted completed session returns HTTP 404, skips callbacks and stays ignored after reload', async t => {
  let exists = true, callbacks = 0;
  const f = await fixture({
    sessionExists: async () => exists,
    run: async (_record, _signal, created) => { await created(); return successRun(); },
    callback: async () => { callbacks++; return null; }, overrides: { request_token: '' },
  });
  const server = createServer(handler(f.engine, '/api/terms-bridge', f.transfer));
  await listenHttp(server);
  t.after(async () => { await f.engine.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await f.engine.accept(request()); await f.cycle();
  assert.equal((await f.engine.query('news', 'task-1')).result, 'done');
  exists = false;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/terms-bridge/projects/news/tasks/task-1`);
  assert.equal(response.status, 404);
  assert.deepEqual((await response.json()).error, { code: 'SESSION_NOT_FOUND', message: '会话不存在' });
  await assert.rejects(f.engine.accept(request()), missingSession);
  await f.engine.recover(); f.advance(600000); await f.cycle();
  assert.equal(callbacks, 0); assert.equal(f.record().execution.attempts, 1);
  recordSchema.parse(f.record());
});

test('deleting the current failed session prevents a new execution attempt', async () => {
  let exists = true;
  const f = await fixture({ sessionExists: async () => exists,
    run: async (_record, _signal, created) => { await created(); throw new Error('execution failed'); },
  });
  await f.engine.accept(request()); await f.cycle(); assert.equal(f.record().status, 'retrying');
  exists = false; f.advance(60000); await f.cycle();
  assert.equal(f.record().execution.attempts, 1);
  await assert.rejects(f.engine.query('news', 'task-1'), missingSession);
  await f.engine.close();
});

test('allocated session IDs are not treated as deleted; a deleted running session result is ignored', async t => {
  const entered = deferred(), create = deferred(), created = deferred(), finish = deferred();
  let exists = false, checks = 0, callbacks = 0;
  const f = await fixture({ sessionExists: async () => { checks++; return exists; },
    run: async (_record, _signal, sessionCreated) => {
      entered.resolve(); await create.promise;
      exists = true; await sessionCreated(); created.resolve(); await finish.promise;
      return successRun();
    }, callback: async () => { callbacks++; return null; },
  });
  t.after(async () => { create.resolve(); finish.resolve(); await f.engine.close(); });
  await f.engine.accept(request()); assert.equal((await f.engine.query('news', 'task-1')).status, 'queued');
  f.engine.tick(); await entered.promise;
  assert.equal((await f.engine.query('news', 'task-1')).status, 'running'); assert.equal(checks, 0);
  create.resolve(); await created.promise; exists = false; finish.resolve(); await f.engine.settle();
  await f.cycle(); assert.equal(callbacks, 0); assert.equal(f.record().result, undefined);
  await assert.rejects(f.engine.query('news', 'task-1'), missingSession);
});

test('deleting a session during callback delivery does not schedule a retry', async t => {
  const sending = deferred(), finish = deferred(); let exists = true, callbacks = 0;
  const f = await fixture({ sessionExists: async () => exists,
    run: async (_record, _signal, created) => { await created(); return successRun(); },
    callback: async () => { callbacks++; sending.resolve(); await finish.promise; return 'CALLBACK_ERROR'; },
  });
  t.after(async () => { finish.resolve(); await f.engine.close(); });
  await f.engine.accept(request()); await f.cycle(); f.engine.tick(); await sending.promise;
  exists = false; finish.resolve(); await f.engine.settle();
  f.advance(60000); await f.cycle(); assert.equal(callbacks, 1);
  await assert.rejects(f.engine.query('news', 'task-1'), missingSession);
});

test('failure before session creation still uses the configured execution retry policy', async () => {
  const f = await fixture({ sessionExists: async () => assert.fail('No session has been created'),
    run: async () => { throw new Error('preparation failed'); },
  });
  await f.engine.accept(request()); await f.cycle(); f.advance(60000); await f.cycle();
  assert.equal(f.record().execution.attempts, 2); assert.equal(f.record().status, 'retrying');
  assert.equal(f.record().session_deleted, undefined); await f.engine.close();
});

test('a deleted session disposal error is ignored without pausing other tasks', async () => {
  let exists = true;
  const f = await fixture({ sessionExists: async () => exists,
    run: async (_record, _signal, created) => {
      await created(); exists = false; throw new UnsettledExecutionError('Session was deleted');
    },
  });
  await f.engine.accept(request()); await f.cycle();
  assert.equal(f.engine.available, true); assert.equal(f.record().session_deleted, true);
  assert.equal(f.record().execution.attempts, 1); await f.engine.close();
});
