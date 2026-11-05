import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, request, deferred, until } from './helpers.mjs';
import { mountNativePresets } from './native-presets.mjs';
import { mountNativeController } from './native-controller.mjs';
import { makeRunner } from '../dist/dsh/runner.js';
import { agentBusy } from '../dist/dsh/sessions.js';

test('native followups retain the original preset and reuse an idle history runtime without disposing it', {
  skip: !process.env.DSH_TEST_PACKAGE, timeout: 30000,
}, async t => {
  const requireHost = createRequire(process.env.DSH_TEST_PACKAGE);
  const load = name => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)));
  const { Context } = await load('cordis');
  const ctx = new Context(), fibers = [], gates = [];
  const root = await mkdtemp(join(tmpdir(), 'terms-session-reuse-'));
  let f, hold;
  t.after(async () => {
    for (const gate of gates) gate.finish.resolve();
    await f?.engine.close();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    const within = relative(tmpdir(), root);
    assert(within && !within.startsWith('..') && !isAbsolute(within));
    await rm(root, { recursive: true, force: true });
  });
  async function mount(name, config = {}) {
    const module = await load(name), fiber = ctx.plugin(module.default ?? module, config);
    fibers.push(fiber); await fiber.await(); return module;
  }
  await mount('dsh-storage'); await mount('dsh-storage-json', { root: join(root, 'storage') });
  await mount('dsh-storage-domain', { backend: 'json' });
  await mount('dsh-session'); await mount('dsh-session-persistence-jsonl', { root: join(root, 'sessions'), compression: 'none' });
  await mount('dsh-session-projection'); await mount('dsh-workspace');
  await mount('dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false });
  await mount('dsh-tools'); await mount('dsh-skill');
  await mount('dsh-agent');
  const { LlmAdapter } = await mount('dsh-llm');
  await mountNativePresets(ctx, mount, load, requireHost, root, fibers);
  const creations = [], calls = [];
  ctx.on('agent/created', ({ agent }) => creations.push({
    mounted: ctx.agentPresets.composedPreset(agent.ctx), recorded: ctx.sessionProjections.stateOf(agent.session, 'agentPreset'),
  }));
  class Model extends LlmAdapter {
    async listModels() { return [{ provider: 'test', id: 'ui-model', name: 'UI model' }]; }
    async *stream(options) {
      calls.push({ model: options.model, history: JSON.stringify(options.messages), tools: options.tools.map(tool => tool.name) });
      if (hold) {
        const gate = hold; hold = undefined; gate.entered.resolve();
        let canceled;
        try {
          await Promise.race([gate.finish.promise, new Promise(resolve => {
            canceled = resolve; options.signal.addEventListener('abort', canceled, { once: true });
          })]);
          options.signal.throwIfAborted();
        } finally { options.signal.removeEventListener('abort', canceled); }
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'reply:' + options.model } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const model = ctx.plugin({ name: 'session-reuse-model', inject: ['llm'], apply(c) { c.llm.registerAdapter(['test'], new Model()); } });
  fibers.push(model); await model.await(); await mount('dsh-agent-loop', { agents: [] });
  let controller = await mountNativeController(ctx, mount, load, root, fibers);
  async function restartController() {
    await controller.dispose();
    await mount('dsh-api-session-controller', { nativeOpen: false }); controller = fibers.at(-1);
  }
  const workspacePath = join(root, 'workspace'); await mkdir(workspacePath);
  const workspace = await ctx.workspaceRegistry.create(workspacePath);
  const run = makeRunner(ctx);
  f = await fixture({ run, sessionExists: async id => (await ctx.sessionPersistence.stat(id)) !== undefined,
    sessionBusy: id => agentBusy(ctx.agents.get(id)),
    overrides: { workspace_path: workspace.path, agent_preset: 'test-default', model: 'first-model' } });
  f.projects.set('news', { ...f.projects.get('news'), workspace_id: workspace.id });
  const configure = patch => f.engine.reconfigure(new Map([['news', { ...f.projects.get('news'), ...patch }]]));
  async function submit(conversation, chat) {
    await f.engine.accept(request(conversation, 'news', chat)); await f.cycle();
    const record = f.record(conversation, chat); assert.equal(record.status, 'completed', record.execution.last_error); return record;
  }
  const first = await submit('original', 'first');
  const sessionId = first.execution.session_id;
  // A host controller restart restores the durable preset through its native resolver.
  await restartController(); assert.equal(ctx.agents.get(sessionId), undefined);
  await configure({ agent_preset: 'test-specific', model: 'second-model' });
  const second = await submit('original', 'second');
  assert.equal(second.execution.session_id, sessionId);
  assert.deepEqual(creations.at(-1), { mounted: 'test-default', recorded: 'test-default' });
  assert.match(calls.at(-1).history, /reply:first-model/);
  assert.equal(calls.at(-1).model, 'second-model');
  await submit('new-conversation', 'first');
  assert.deepEqual(creations.at(-1), { mounted: 'test-specific', recorded: 'test-specific' });
  // Even an unavailable new project preset must not prevent resuming the existing one.
  await configure({ agent_preset: 'missing-preset', model: 'third-model' });
  await restartController();
  await submit('original', 'third');
  assert.deepEqual(creations.at(-1), { mounted: 'test-default', recorded: 'test-default' });

  // Opening history and selecting a model both use the same controller as Web.
  await restartController();
  const { agent } = await ctx.sessionController.resolveAgent(sessionId);
  const selectUiModel = () => ctx.sessionController.selectModel({ sessionId, provider: 'test', model: 'ui-model' });
  await selectUiModel();
  assert.equal(agent.status, 'idle'); assert.ok(agent.ctx.tools.get('ask_user_question', agent));
  const count = creations.length;
  await submit('original', 'history-open');
  assert.equal(creations.length, count); assert.equal(ctx.agents.get(sessionId), agent);
  assert.equal(calls.at(-1).model, 'third-model');
  assert.ok(calls.at(-1).tools.includes('preset_probe')); assert.ok(!calls.at(-1).tools.includes('ask_user_question'));
  assert.match(calls.at(-1).history, /reply:first-model/);
  assert.equal(ctx.agentPresets.composedPreset(agent.ctx), 'test-default');
  assert.equal(ctx.sessionProjections.stateOf(agent.session, 'agentPreset'), 'test-default');
  assert.ok(agent.ctx.tools.get('ask_user_question', agent));

  function blockNext() {
    const gate = { entered: deferred(), finish: deferred() }; gates.push(gate); hold = gate; return gate;
  }
  function fromUi(id) { agent.followup({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: id }] }); }
  const busy = blockNext(); fromUi('ui-running'); await busy.entered.promise;
  assert.equal(agent.status, 'running'); assert.equal(calls.at(-1).model, 'ui-model');
  assert.ok(calls.at(-1).tools.includes('ask_user_question'));
  await assert.rejects(f.engine.accept(request('original', 'news', 'after-ui')), e => e.status === 409 && e.code === 'CONVERSATION_BUSY');
  assert.equal(f.record('original', 'after-ui'), undefined);
  busy.finish.resolve(); await agent.whenIdle();
  await submit('original', 'after-ui'); assert.equal(ctx.agents.get(sessionId), agent);

  // A queued UI turn must not delay the bridge result or inherit its temporary policy.
  await selectUiModel();
  const bridgeGate = blockNext();
  await f.engine.accept(request('original', 'news', 'with-next-ui')); f.engine.tick(); await bridgeGate.entered.promise;
  const uiGate = blockNext(); fromUi('ui-after-task'); bridgeGate.finish.resolve(); await uiGate.entered.promise;
  await until(() => f.record('original', 'with-next-ui').status === 'completed');
  assert.equal(agent.status, 'running'); assert.equal(calls.at(-1).model, 'ui-model');
  assert.ok(calls.at(-1).tools.includes('ask_user_question'));
  assert.equal(f.record('original', 'with-next-ui').result, 'reply:third-model');
  uiGate.finish.resolve(); await agent.whenIdle(); await f.engine.settle();

  // Aborting a borrowed task settles its turn but leaves the history runtime usable.
  await selectUiModel();
  await f.engine.accept(request('original', 'news', 'cancel-test'));
  const task = f.record('original', 'cancel-test'); task.execution.attempt_id = 'cancel-attempt';
  const abort = new AbortController(), cancelGate = blockNext();
  const outcome = assert.rejects(run(task, abort.signal, { created: true, ready: async () => {} }));
  await cancelGate.entered.promise; abort.abort(); await outcome;
  assert.equal(ctx.agents.get(sessionId), agent); assert.equal(agent.status, 'idle');
  assert.ok(agent.ctx.tools.get('ask_user_question', agent));
  fromUi('ui-after-cancel'); await agent.whenIdle();
  assert.equal(calls.at(-1).model, 'ui-model'); assert.ok(calls.at(-1).tools.includes('ask_user_question'));
});
