import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { temporaryDatabase, fixture, request, deferred, until } from './helpers.mjs';
import { mountNativePresets } from './native-presets.mjs';
import { mountNativeController } from './native-controller.mjs';
import { makeRunner } from '../dist/dsh/runner.js';
import { agentBusy } from '../dist/dsh/sessions.js';
import { FileLibrary } from '../dist/storage/files.js';

test('native task boundaries isolate UI work, file capture and cancellation', {
  skip: !process.env.DSH_TEST_PACKAGE, timeout: 30000,
}, async t => {
  const requireHost = createRequire(process.env.DSH_TEST_PACKAGE);
  const load = name => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)));
  const { Context } = await load('cordis');
  const ctx = new Context(), fibers = [], fixtures = [], gates = [], calls = [], behavior = new Map();
  const root = await mkdtemp(join(tmpdir(), 'terms-boundaries-'));
  t.after(async () => {
    for (const gate of gates) gate.finish.resolve();
    for (const f of fixtures) await f.engine.close();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    const within = relative(tmpdir(), root); assert(within && !within.startsWith('..') && !isAbsolute(within));
    await rm(root, { recursive: true, force: true });
  });
  async function mount(name, config = {}) {
    const module = await load(name), fiber = ctx.plugin(module.default ?? module, config);
    fibers.push(fiber); await fiber.await(); return module;
  }
  function user(text) { return { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }; }
  function block() {
    const entered = deferred(), finish = deferred();
    const gate = { entered, finish, aborted: false, async wait(signal) {
      entered.resolve(); let onAbort;
      try {
        signal.throwIfAborted();
        await Promise.race([finish.promise, new Promise(resolve => {
          onAbort = () => { gate.aborted = true; resolve(); }; signal.addEventListener('abort', onAbort, { once: true });
        })]);
        signal.throwIfAborted();
      } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
    } };
    gates.push(gate); return gate;
  }
  await mount('dsh-storage'); await mount('dsh-storage-json', { root: join(root, 'storage') });
  await mount('dsh-storage-domain', { backend: 'json' });
  await mount('dsh-session'); await mount('dsh-session-persistence-jsonl', { root: join(root, 'sessions'), compression: 'none' });
  await mount('dsh-session-projection'); await mount('dsh-workspace');
  await mount('dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false });
  await mount('dsh-tools'); await mount('dsh-skill'); await mount('dsh-agent');
  const { LlmAdapter } = await mount('dsh-llm');
  await mountNativePresets(ctx, mount, load, requireHost, root, fibers);
  class Model extends LlmAdapter {
    async listModels() { return ['ui-model', 'later-ui-model'].map(id => ({ provider: 'test', id, name: id })); }
    async *stream(options) {
      const prompt = options.messages.filter(m => m.role === 'user').flatMap(m => m.content)
        .filter(b => b.type === 'text' && b.text.startsWith('boundary:')).at(-1)?.text;
      assert.ok(prompt);
      calls.push({ prompt, history: JSON.stringify(options.messages), model: options.model, tools: options.tools.map(t => t.name) });
      const text = await behavior.get(prompt)?.(options) ?? 'reply:' + prompt;
      if (text === 'CALL_PRESET_PROBE') {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'model-choice-probe', name: 'preset_probe', arguments: '{}' } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const model = ctx.plugin({ name: 'boundary-model', inject: ['llm'], apply(c) { c.llm.registerAdapter(['test'], new Model()); } });
  fibers.push(model); await model.await(); await mount('dsh-agent-loop', { agents: [] });
  await mountNativeController(ctx, mount, load, root, fibers);
  const workspacePath = join(root, 'workspace'); await mkdir(workspacePath);
  const workspace = await ctx.workspaceRegistry.create(workspacePath);
  async function fresh(overrides = {}, Library = FileLibrary) {
    const database = temporaryDatabase(), library = new Library(database);
    const f = await fixture({ database, run: makeRunner(ctx, library), files: library,
      sessionExists: async id => (await ctx.sessionPersistence.stat(id)) !== undefined,
      sessionBusy: id => agentBusy(ctx.agents.get(id)),
      overrides: { workspace_path: workspace.path, agent_preset: 'test-default', model: 'project-model',
        execution_timeout_seconds: 10, max_execution_retries: 0, ...overrides } });
    fixtures.push(f); return f;
  }
  async function submit(f, conversation, chat, prompt) {
    await f.engine.accept({ ...request(conversation, 'news', chat), instruction: prompt });
    await f.cycle(); const record = f.record(conversation, chat);
    assert.equal(record.status, 'completed', record.execution.last_error);
  }
  async function openHistory(f, conversation) {
    const id = f.record(conversation).execution.session_id;
    const result = await ctx.sessionController.resolveAgent(id);
    assert.ok(result.agent); return result.agent;
  }

  await t.test('newly created runtime finishes this task while the next UI turn remains running', async () => {
    const f = await fresh({ execution_timeout_seconds: 1 }), first = block(), next = block();
    behavior.set('boundary:owned:first', options => first.wait(options.signal));
    behavior.set('boundary:owned:ui', options => next.wait(options.signal));
    await f.engine.accept({ ...request('owned'), instruction: 'boundary:owned:first' }); f.engine.tick(); await first.entered.promise;
    const agent = ctx.agents.get(f.record('owned').execution.session_id);
    agent.followup(user('boundary:owned:ui')); first.finish.resolve(); await next.entered.promise;
    await f.engine.settle();
    assert.equal(f.record('owned').status, 'completed'); assert.equal(f.record('owned').execution.attempts, 1);
    assert.equal(agent.status, 'running'); assert.equal(next.aborted, false);
    assert.ok(calls.at(-1).tools.includes('ask_user_question'));
    await assert.rejects(f.engine.accept(request('owned', 'news', 'next')), e => e.code === 'CONVERSATION_BUSY');
    await f.engine.close(); assert.equal(next.aborted, false);
    next.finish.resolve(); await agent.whenIdle();
    assert.equal(ctx.agents.get(agent.id), agent);
    agent.followup(user('boundary:owned:after-close')); await agent.whenIdle();
    assert.equal(calls.at(-1).prompt, 'boundary:owned:after-close');
  });

  await t.test('native pending context is consumed by dsh without blocking the next task', async () => {
    const f = await fresh(); await submit(f, 'context', 'chat-1', 'boundary:context:first');
    const agent = await openHistory(f, 'context');
    agent.inject(user('native context to preserve'));
    assert.equal(agent.status, 'idle'); assert.equal(agent.inbox.hasPending, true);
    await submit(f, 'context', 'next', 'boundary:context:next');
    assert.match(calls.at(-1).history, /native context to preserve/);
    assert.equal(agent.inbox.hasPending, false);
  });

  await t.test('native routing and switch notices agree, preserve UI selections and leave host defaults alone', async () => {
    const f = await fresh(); await submit(f, 'model-selection', 'chat-1', 'boundary:models:first');
    const agent = await openHistory(f, 'model-selection'), saves = [];
    const defaultModel = ctx.agentDefaultModel, save = defaultModel.saveSelection;
    defaultModel.saveSelection = async selection => { saves.push(selection); };
    try {
      const choose = model => ctx.sessionController.selectModel({ sessionId: agent.id, provider: 'test', model });
      await choose('ui-model');
      const start = agent.session.snapshotEvents().length;
      await submit(f, 'model-selection', 'second', 'boundary:models:second');
      const events = agent.session.snapshotEvents().slice(start);
      assert.equal(calls.at(-1).model, 'project-model');
      assert.equal(agent.session.requestHeader().config.model, 'project-model');
      assert.equal(events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'model-selection').length, 0,
        'A pending UI choice must not produce a false model switch in the bridge request');
      assert.deepEqual(saves.map(s => s.model), ['ui-model']);
      assert.equal(ctx.sessionProjections.stateOf(agent.session, 'modelSelection').pending.model, 'ui-model');
      agent.followup(user('boundary:models:ui')); await agent.whenIdle();
      assert.equal(calls.at(-1).model, 'ui-model');
      const beforeSwitch = agent.session.snapshotEvents().length;
      const running = block(); let step = 0;
      behavior.set('boundary:models:third', async options => {
        if (step++ === 0) { await running.wait(options.signal); return 'CALL_PRESET_PROBE'; }
        return 'multi-step result';
      });
      await f.engine.accept({ ...request('model-selection', 'news', 'third'), instruction: 'boundary:models:third' });
      f.engine.tick(); await running.entered.promise;
      await choose('later-ui-model'); agent.followup(user('boundary:models:later-ui'));
      running.finish.resolve(); await f.engine.settle(); await agent.whenIdle();
      assert.equal(f.record('model-selection', 'third').status, 'completed');
      assert.deepEqual(calls.filter(c => c.prompt === 'boundary:models:third').map(c => c.model), ['project-model', 'project-model']);
      assert.equal(calls.at(-1).model, 'later-ui-model');
      const switches = agent.session.snapshotEvents().slice(beforeSwitch)
        .filter(e => e.type === 'user/message' && e.data.source?.kind === 'model-selection')
        .map(e => e.data.content.map(b => b.text).join(''));
      assert.equal(switches.length, 2);
      assert.match(switches[0], /session continues with project-model/);
      assert.match(switches[1], /session continues with later-ui-model/);
      assert.deepEqual(saves.map(s => s.model), ['ui-model', 'later-ui-model']);
      assert.equal(ctx.agentDefaultModel.currentSelection().model, 'host-default');
    } finally { defaultModel.saveSelection = save; }
  });

  await t.test('stopping a queued task preserves maintenance and other queued messages', async () => {
    const f = await fresh(); await submit(f, 'maintenance', 'chat-1', 'boundary:maintenance:first');
    const agent = await openHistory(f, 'maintenance'), maintenanceGate = block();
    const maintenance = agent.runMaintenance(signal => maintenanceGate.wait(signal)); await maintenanceGate.entered.promise;
    await f.engine.accept({ ...request('maintenance', 'news', 'next'), instruction: 'boundary:maintenance:next' }); f.engine.tick();
    await until(() => agent.inbox.nextTurn.length === 1);
    const ui = user('boundary:maintenance:ui'); agent.followup(ui);
    await f.engine.close();
    assert.equal(maintenanceGate.aborted, false);
    assert.deepEqual(agent.inbox.nextTurn.map(message => message.id), [ui.id]);
    maintenanceGate.finish.resolve(); await maintenance; await agent.whenIdle();
    assert.equal(calls.filter(c => c.prompt === 'boundary:maintenance:next').length, 0);
    assert.equal(calls.filter(c => c.prompt === 'boundary:maintenance:ui').length, 1);
    assert.equal(f.record('maintenance', 'next').execution.last_error, 'EXECUTION_INTERRUPTED');
  });

  for (const pending of ['maintenance', 'context', 'discard']) await t.test(`task completion leaves native ${pending} with DSH`, async () => {
    const saving = block();
    class Library extends FileLibrary {
      async publish(task, path, signal) { await saving.wait(signal); return super.publish(task, path, signal); }
    }
    const f = await fresh({}, Library), conversation = 'native-' + pending;
    const prompt = 'boundary:' + conversation;
    behavior.set(prompt, async () => { await writeFile(join(workspacePath, 'recycle.txt'), 'saved'); return '[result](recycle.txt)'; });
    await f.engine.accept({ ...request(conversation), instruction: prompt }); f.engine.tick(); await saving.entered.promise;
    const agent = ctx.agents.get(f.record(conversation).execution.session_id);
    await agent.whenIdle();
    const maintenanceGate = block(), context = user('pending context survives task completion');
    const maintenance = pending === 'maintenance' ? agent.runMaintenance(signal => maintenanceGate.wait(signal)) : undefined;
    if (!maintenance) agent.inject(context);
    saving.finish.resolve(); await f.engine.settle(); await setImmediate();
    assert.equal(f.record(conversation).status, 'completed');
    assert.equal(ctx.agents.get(agent.id), agent); assert.equal(maintenanceGate.aborted, false);
    if (maintenance) { maintenanceGate.finish.resolve(); await maintenance; }
    else if (pending === 'discard') assert.equal(agent.inbox.remove(context.id), true);
    else {
      await submit(f, conversation, 'next', 'boundary:pending-context-next');
      assert.match(calls.at(-1).history, /pending context survives task completion/);
    }
    assert.equal(ctx.agents.get(agent.id), agent);
  });

  for (const cancelCapture of [false, true]) await t.test(`file capture ${cancelCapture ? 'cancellation releases' : 'finishes before'} subsequent UI execution`, async () => {
    const saving = block(), uiRunning = block();
    class Library extends FileLibrary {
      async publish(task, path, signal) { await saving.wait(signal); return super.publish(task, path, signal); }
    }
    const f = await fresh({}, Library), conversation = cancelCapture ? 'cancel-files' : 'files';
    const bridgePrompt = 'boundary:' + conversation + ':bridge', uiPrompt = 'boundary:' + conversation + ':ui';
    behavior.set(bridgePrompt, async () => { await writeFile(join(workspacePath, 'report.txt'), 'FIRST-TURN'); return '[report](report.txt)'; });
    behavior.set(uiPrompt, async options => { await writeFile(join(workspacePath, 'report.txt'), 'SECOND-TURN'); await uiRunning.wait(options.signal); });
    await f.engine.accept({ ...request(conversation), instruction: bridgePrompt }); f.engine.tick(); await saving.entered.promise;
    const agent = ctx.agents.get(f.record(conversation).execution.session_id); agent.followup(user(uiPrompt));
    await setImmediate();
    assert.equal(calls.filter(call => call.prompt === uiPrompt).length, 0);
    assert.equal(f.record(conversation).status, 'running');
    if (cancelCapture) {
      await f.engine.close(); await uiRunning.entered.promise;
      assert.equal(f.record(conversation).execution.last_error, 'EXECUTION_INTERRUPTED');
      assert.equal(f.record(conversation).callback_body, null);
    } else {
      saving.finish.resolve(); await f.engine.settle(); await uiRunning.entered.promise;
      const record = f.record(conversation); assert.equal(record.status, 'completed');
      const saved = await f.files.openDownload('news', record.project, record.output_files[0].file_id, new AbortController().signal);
      try { const bytes = Buffer.alloc(saved.file.size); await saved.handle.read(bytes, 0, bytes.length, 0); assert.equal(bytes.toString(), 'FIRST-TURN'); }
      finally { await saved.handle.close(); }
    }
    assert.equal(agent.status, 'running'); assert.equal(uiRunning.aborted, false);
    uiRunning.finish.resolve(); await agent.whenIdle();
  });
});
