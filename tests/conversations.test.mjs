import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fixture, request, successRun, deferred, until, listenHttp, project } from './helpers.mjs';
import { TaskStore, recordSchema } from '../dist/storage/tasks.js';
import { TaskEngine } from '../dist/services/tasks.js';
import { handler } from '../dist/http/api.js';
import { ApiError, requestSchema, taskKey, validateRequest } from '../dist/domain/request.js';
import { attemptEvents, finalResponse, presentedFiles } from '../dist/dsh/results.js';
import { openSession } from '../dist/dsh/sessions.js';

test('optional IDs are independent; persisted metadata always requires all three IDs', async () => {
  const f = await fixture();
  for (const metadata of [{ project_id: 'news' }, { project_id: 'news', chat_id: 'provided-chat' },
    { project_id: 'news', conversation_id: 'provided-conversation' }, request('both').metadata]) {
    const admitted = await f.engine.accept({ ...request(), metadata });
    const full = admitted.body.metadata;
    assert.equal(admitted.status, 202);
    assert.deepEqual(Object.keys(full).sort(), ['chat_id', 'conversation_id', 'project_id']);
    assert.equal(full.project_id, 'news');
    if (metadata.conversation_id) assert.equal(full.conversation_id, metadata.conversation_id);
    if (metadata.chat_id) assert.equal(full.chat_id, metadata.chat_id);
    assert.match(full.conversation_id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
    assert.match(full.chat_id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
    recordSchema.parse(f.store.get(taskKey(full.project_id, full.conversation_id, full.chat_id)));
  }
  for (const field of ['conversation_id', 'chat_id']) {
    for (const invalid of ['', null, '../outside', 4]) assert.throws(() => validateRequest({ ...request(), metadata: { ...request().metadata, [field]: invalid } }));
    const incomplete = request(); delete incomplete.metadata[field];
    assert.equal(requestSchema.safeParse(incomplete).success, false);
  }
  assert.throws(() => validateRequest({ ...request(), metadata: { project_id: 'news', task_id: 'legacy' } }));
});

test('one conversation admits only one concurrent chat; identical chat IDs remain scoped by project and conversation', async () => {
  const f = await fixture();
  const responses = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => f.engine.accept(request('same', 'news', 'chat-' + i))));
  assert.equal(responses.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(responses.filter(r => r.status === 'rejected' && r.reason.status === 409 && r.reason.code === 'CONVERSATION_BUSY').length, 11);
  await f.engine.accept(request('different', 'news', 'chat-0'));
  f.projects.set('other', { ...project() });
  await f.engine.accept(request('same', 'other', 'chat-0'));
  assert.equal(new Set(f.store.list().map(([, task]) => task.execution.session_id)).size, 3);
});

test('queued, running and retrying chats keep the conversation busy; failure exhaustion releases it', async t => {
  const gate = deferred();
  const f = await fixture({ overrides: { max_execution_retries: 1 }, run: async () => { await gate.promise; throw new Error('model failure'); } });
  t.after(async () => { gate.resolve(); await f.engine.close(); });
  const next = () => f.engine.accept(request('task-1', 'news', 'next'));
  const busy = () => assert.rejects(next(), e => e.code === 'CONVERSATION_BUSY');
  await f.engine.accept(request()); await busy();
  f.engine.tick(); await until(() => f.record().status === 'running'); await busy();
  gate.resolve(); await f.engine.settle(); assert.equal(f.record().status, 'retrying'); await busy();
  const session = f.record().execution.session_id;
  f.advance(60_000); await f.cycle(); assert.equal(f.record().status, 'failed');
  assert.equal((await next()).status, 202);
  assert.equal(f.record('task-1', 'next').execution.session_id, session);
  await assert.rejects(f.engine.accept(request()), e => e.code === 'CHAT_ALREADY_EXISTS');
});

test('callbacks in flight and waiting to retry do not block the next chat; results stay separate', async t => {
  const callbackStarted = deferred(), callbackFinish = deferred();
  const f = await fixture({ run: async task => ({ result: task.request.metadata.chat_id, files: [] }), callback: async () => {
    callbackStarted.resolve(); await callbackFinish.promise; return 'HTTP 503';
  } });
  t.after(async () => { callbackFinish.resolve(); await f.engine.close(); });
  await f.engine.accept(request()); await f.cycle();
  const session = f.record().execution.session_id, body = f.record().callback_body;
  // Even malformed content cannot turn a previously accepted ID into a new task.
  await assert.rejects(f.engine.accept({ metadata: request().metadata, instruction: null }), e => e.code === 'CHAT_ALREADY_EXISTS');
  f.engine.tick(); await callbackStarted.promise;
  await f.engine.accept(request('task-1', 'news', 'chat-2'));
  f.engine.tick(); await until(() => f.record('task-1', 'chat-2').status === 'completed');
  assert.equal(f.record('task-1', 'chat-2').execution.session_id, session);
  assert.equal(f.record().callback_body, body);
  callbackFinish.resolve(); await f.engine.settle(); assert.equal(f.record().delivery.status, 'retrying');
  await f.engine.accept(request('task-1', 'news', 'chat-3'));
  assert.equal((await f.engine.query('news', 'task-1', 'chat-2')).result, 'chat-2');
});

test('restart rebuilds admission from durable tasks and preserves session binding, retry budget and used chat IDs', async () => {
  const f = await fixture({ run: successRun });
  await f.engine.accept(request()); await f.cycle();
  const session = f.record().execution.session_id;
  await f.engine.accept(request('task-1', 'news', 'chat-2'));
  const key = taskKey('news', 'task-1', 'chat-2');
  await f.store.update(key, task => ({ ...task, status: 'running', execution: { ...task.execution, attempts: 1, attempt_id: 'interrupted' } }));
  await f.engine.close();
  const store = new TaskStore(f.table, f.conversationTable);
  const engine = new TaskEngine(store, f.projects, successRun, { files: f.files, callback: async () => null, now: () => Date.now() + 60_000 });
  await engine.recover();
  assert.equal(store.get(key).status, 'retrying');
  assert.equal(store.get(key).execution.attempts, 1);
  await assert.rejects(engine.accept(request()), e => e.code === 'CHAT_ALREADY_EXISTS');
  await assert.rejects(engine.accept(request('task-1', 'news', 'chat-3')), e => e.code === 'CONVERSATION_BUSY');
  assert.equal(store.get(key).execution.session_id, session);
  await engine.close();
});

test('failed task admission leaves a reusable binding, not a permanently busy conversation', async () => {
  const f = await fixture(); f.table.failWrites = true;
  await assert.rejects(f.engine.accept(request()));
  const session = f.store.conversations.get(request().metadata).session_id;
  f.table.failWrites = false;
  await f.engine.accept(request());
  assert.equal(f.record().execution.session_id, session);
  assert.equal(f.store.list().length, 1);
});

test('a conversation cannot be silently rebound to a different project workspace', async () => {
  const f = await fixture({ run: successRun }); await f.engine.accept(request()); await f.cycle(); await f.cycle();
  await f.engine.reconfigure(new Map([['news', { ...f.projects.get('news'), workspace_path: f.projects.get('news').workspace_path + '/different' }]]));
  await assert.rejects(f.engine.accept(request('task-1', 'news', 'next')), e => e.code === 'CONVERSATION_WORKSPACE_CHANGED');
});

test('re-registering the same directory preserves queued tasks, retries, callbacks and conversation recovery', async t => {
  const f = await fixture({ run: async task => {
    if (task.request.metadata.conversation_id === 'retry') throw new Error('Transient execution failure');
    return successRun();
  }, callback: async () => 'HTTP 503' });
  t.after(() => f.engine.close());
  await f.engine.accept(request('finished')); await f.cycle(); await f.cycle();
  const finished = f.record('finished');
  assert.equal(finished.delivery.status, 'retrying');
  await f.engine.accept(request('retry')); await f.cycle();
  assert.equal(f.record('retry').status, 'retrying');
  await f.engine.accept(request('queued'));
  const projects = new Map([['news', { ...f.projects.get('news') }]]);
  await f.engine.reconfigure(projects);
  await f.engine.close();

  const engine = new TaskEngine(f.store, projects, successRun, { files: f.files, callback: async () => null,
    now: () => Date.parse('2026-10-30T00:02:00Z') });
  t.after(() => engine.close());
  await engine.recover();
  await engine.accept(request('finished', 'news', 'next'));
  for (let index = 0; index < 4; index++) { engine.tick(); await engine.settle(); }
  for (const [conversation, chat] of [['queued', 'chat-1'], ['retry', 'chat-1'], ['finished', 'next']]) {
    assert.equal(f.record(conversation, chat).status, 'completed');
  }
  assert.equal(f.record('retry').execution.attempts, 2);
  assert.equal(f.record('queued').execution.attempts, 1);
  assert.equal(f.record('finished', 'next').execution.session_id, finished.execution.session_id);
  assert.equal(f.record('finished').callback_body, finished.callback_body);
  assert.equal(f.record('finished').delivery.status, 'delivered');
  f.store.assertProjects(projects);
});

test('HTTP returns generated metadata and a complete query URL, rejects duplicates and removes the old route', async t => {
  const f = await fixture({ run: successRun, overrides: { request_token: '' } });
  const server = createServer(handler(f.engine, '/bridge', f.transfer)); await listenHttp(server);
  t.after(async () => { await f.engine.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(origin + '/bridge/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const response = await post({ ...request(), metadata: { project_id: 'news' } });
  const { metadata } = await response.json();
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('location'), `/bridge/projects/news/conversations/${metadata.conversation_id}/chats/${metadata.chat_id}`);
  const duplicate = await post({ ...request(), metadata });
  assert.equal(duplicate.status, 409); assert.deepEqual((await duplicate.json()).metadata, metadata);
  await f.cycle();
  const state = await (await fetch(origin + response.headers.get('location'))).json();
  assert.deepEqual(state.metadata, metadata); assert.equal(state.result, 'done');
  assert.equal((await fetch(origin + '/bridge/projects/news/tasks/task-1')).status, 404);
  const next = await post({ ...request(), metadata: { project_id: 'news', conversation_id: metadata.conversation_id } });
  assert.equal(next.status, 202); assert.notEqual((await next.json()).metadata.chat_id, metadata.chat_id);
});

test('results match the submitted message even when a later unrelated turn exists', () => {
  const turn = (number, id) => [
    { type: 'turn/start', data: { turn: number } }, { type: 'user/message', data: { id } },
    { type: 'deliverables/presented', data: { turn: number, files: [{ path: id + '.txt' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: id }] } } },
    { type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } },
  ];
  const events = [...turn(1, 'prior'), ...turn(2, 'target'), ...turn(3, 'later')];
  const selected = attemptEvents(events, 'target');
  assert.equal(finalResponse(selected)[0].text, 'target');
  assert.deepEqual(presentedFiles(selected), ['target.txt']);
  assert.throws(() => attemptEvents(events, 'missing'));
  assert.throws(() => attemptEvents(turn(1, 'unfinished').slice(0, -1), 'unfinished'));
});

test('session acquisition delegates restoration to DSH and reads live activity on each request', async () => {
  const f = await fixture(); await f.engine.accept(request()); const task = f.record();
  let resolved, live;
  const agent = { id: task.execution.session_id, status: 'idle', inbox: { nextTurn: [] } };
  const host = {
    agents: { get: () => live }, sessionPersistence: { stat: async () => ({}) },
    sessionController: { create: () => assert.fail('existing session was recreated'),
      resolveAgent: async id => { resolved = id; live = agent; return { agent }; } },
  };
  const open = created => openSession(host, task, new AbortController().signal, created);
  assert.equal(await open(false), agent); assert.equal(resolved, task.execution.session_id);
  host.sessionController.resolveAgent = () => assert.fail('live Agent should be reused');
  assert.equal(await open(true), agent);
  agent.status = 'running';
  await assert.rejects(open(true), e => e.code === 'CONVERSATION_BUSY');
  agent.status = 'idle'; agent.inbox.nextTurn = [{ id: 'ui-message' }];
  await assert.rejects(open(true), e => e.code === 'CONVERSATION_BUSY');
  host.agents.get = () => undefined; host.sessionPersistence.stat = async () => undefined;
  await assert.rejects(open(true), /no longer exists/);
});

test('creation uses the bound identity and canceled activation cannot send a late task', async () => {
  const f = await fixture(); await f.engine.accept(request()); const task = f.record();
  let created, resolved = 0;
  const agent = { status: 'idle', inbox: { nextTurn: [] } };
  const host = { agents: { get: () => undefined }, sessionPersistence: { stat: async () => undefined },
    sessionController: { create: async options => { created = options; return { sessionId: options.sessionId }; },
      resolveAgent: async () => { resolved++; return { agent }; } } };
  assert.equal(await openSession(host, task, new AbortController().signal, false), agent);
  assert.deepEqual(created, { sessionId: task.execution.session_id, cwd: task.project.workspace_path, agentPreset: task.project.agent_preset });
  host.sessionController.create = async () => ({ sessionId: 'wrong' });
  await assert.rejects(openSession(host, task, new AbortController().signal, false), /different conversation identity/);
  assert.equal(resolved, 1);
  const gate = deferred(), entered = deferred(), controller = new AbortController();
  host.sessionPersistence.stat = async () => ({});
  host.sessionController.resolveAgent = () => { entered.resolve(); return gate.promise; };
  const outcome = assert.rejects(openSession(host, task, controller.signal, true), /aborted/);
  await entered.promise; controller.abort(); await outcome; gate.resolve({ agent });
  host.sessionController.resolveAgent = async () => ({ error: new Error('native activation failed') });
  await assert.rejects(openSession(host, task, new AbortController().signal, true), /native activation failed/);
});

test('native activity rejects new chats and defers accepted chats without consuming attempts or blocking other conversations', async t => {
  const busy = new Set();
  const f = await fixture({ run: successRun, sessionBusy: id => busy.has(id), overrides: { max_concurrency: 1 } });
  t.after(() => f.engine.close());
  await f.engine.accept(request()); await f.cycle();
  const session = f.record().execution.session_id;
  busy.add(session);
  await assert.rejects(f.engine.accept(request('task-1', 'news', 'next')), e => e.status === 409 && e.code === 'CONVERSATION_BUSY');
  assert.equal(f.record('task-1', 'next'), undefined);
  busy.clear(); await f.engine.accept(request('task-1', 'news', 'next')); busy.add(session);
  await f.engine.accept(request('other')); await f.cycle();
  assert.equal(f.record('other').status, 'completed');
  assert.equal(f.record('task-1', 'next').status, 'queued');
  assert.equal(f.record('task-1', 'next').execution.attempts, 0);
  busy.clear(); await f.cycle();
  assert.equal(f.record('task-1', 'next').status, 'completed');
  assert.equal(f.record('task-1', 'next').execution.attempts, 1);
});

test('a native activity race preserves both queued and retrying state until a prompt can be sent', async t => {
  let mode = 'busy';
  const f = await fixture({ run: async () => {
    if (mode === 'busy') throw new ApiError(409, 'CONVERSATION_BUSY', 'busy');
    if (mode === 'failure') throw new Error('model failed');
    return successRun();
  } });
  t.after(() => f.engine.close());
  await f.engine.accept(request()); const queued = f.record(); await f.cycle();
  assert.deepEqual(f.record(), queued);
  mode = 'failure'; await f.cycle(); const retrying = f.record();
  assert.equal(retrying.status, 'retrying'); assert.equal(retrying.execution.attempts, 1);
  f.advance(60_000); mode = 'busy'; await f.cycle(); assert.deepEqual(f.record(), retrying);
  mode = 'success'; await f.cycle();
  assert.equal(f.record().status, 'completed'); assert.equal(f.record().execution.attempts, 2);
});

test('session creation is persisted once per conversation and survives further chats and engine reload', async t => {
  const snapshots = [];
  const run = async (_task, _signal, session) => { snapshots.push(session.created); await session.ready(); return successRun(); };
  const f = await fixture({ run }); t.after(() => f.engine.close());
  await f.engine.accept(request()); await f.cycle();
  const saved = structuredClone([...f.conversationTable.entries()]);
  // Once created, followups and retries must not write the same marker again.
  f.conversationTable.failWrites = true;
  await f.engine.accept(request('task-1', 'news', 'next')); await f.cycle();
  assert.equal(f.record('task-1', 'next').status, 'completed');
  await f.engine.close();
  const g = await fixture({ run, table: f.table, conversationTable: f.conversationTable }); t.after(() => g.engine.close());
  await g.engine.accept(request('task-1', 'news', 'after-reload')); await g.cycle();
  assert.equal(g.record('task-1', 'after-reload').status, 'completed');
  assert.deepEqual([...g.conversationTable.entries()], saved);
  assert.deepEqual(snapshots, [false, true, true]);
  for (const [, record] of g.store.list()) { assert.equal('session_created' in record.execution, false); recordSchema.parse(record); }
});

test('legacy workspace IDs are discarded at storage decoding and are absent from new records', async () => {
  const { domainSpec, recordSchema } = await import('../dist/storage/tasks.js');
  const { conversationSchema } = await import('../dist/storage/conversations.js');
  const f = await fixture({ run: successRun });
  try {
    await f.engine.accept(request());
    const record = f.record(), conversation = f.store.conversations.get(request().metadata);
    assert.equal('workspace_id' in record.project, false);
    assert.equal('workspace_id' in conversation, false);
    assert.deepEqual(recordSchema.parse({ ...record, project: { ...record.project, workspace_id: 'old' } }), record);
    assert.deepEqual(conversationSchema.parse({ ...conversation, workspace_id: 'old' }), conversation);
    assert.deepEqual(domainSpec.tables.projects.valueSchema.parse({ news: { workspace_path: '/saved', workspace_id: 'old' } }), { news: { workspace_path: '/saved' } });
  } finally { await f.engine.close(); }
});
