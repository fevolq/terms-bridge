import { FileLibrary } from '../dist/storage/files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { temporaryDatabase, fixture, request } from './helpers.mjs';
import { makeRunner } from '../dist/dsh/runner.js';
import { recordSchema } from '../dist/storage/tasks.js';
import { mountNativePresets } from './native-presets.mjs';
import { mountNativeController } from './native-controller.mjs';

test('native initialization and model failures retry in the same conversation with the prior context', {
  skip: !process.env.DSH_TEST_PACKAGE, timeout: 30000,
}, async t => {
  const requireHost = createRequire(process.env.DSH_TEST_PACKAGE);
  const load = name => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)));
  const { Context } = await load('cordis'); const ctx = new Context(); const fibers = [];
  const root = await mkdtemp(join(tmpdir(), 'terms-init-retry-'));
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    const within = relative(tmpdir(), root);
    assert(within && !within.startsWith('..') && !isAbsolute(within));
    await rm(root, { recursive: true, force: true });
  });
  async function mount(name, config = {}) {
    const module = await load(name); const fiber = ctx.plugin(module.default ?? module, config);
    fibers.push(fiber); await fiber.await(); return module;
  }
  await mount('dsh-storage'); await mount('dsh-storage-json', { root: join(root, 'storage') });
  await mount('dsh-storage-domain', { backend: 'json' });
  await mount('dsh-session'); await mount('dsh-session-persistence-jsonl', { root: join(root, 'sessions'), compression: 'none' });
  await mount('dsh-session-projection'); await mount('dsh-workspace');
  await mount('dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false });
  await mount('dsh-tools'); await mount('dsh-skill'); await mount('dsh-agent');
  const { LlmAdapter } = await mount('dsh-llm'); let modelCalls = 0, failNext = false;
  const modelHistory = [];
  await mountNativePresets(ctx, mount, load, requireHost, root, fibers);
  class Model extends LlmAdapter {
    async *stream(options) {
      modelCalls++;
      modelHistory.push(JSON.stringify(options.messages));
      if (failNext) { failNext = false; throw new Error('Transient model failure'); }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'retry succeeded' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'retry succeeded' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const model = ctx.plugin({ name: 'init-retry-model', inject: ['llm'], apply(c) { c.llm.registerAdapter(['test'], new Model()); } });
  fibers.push(model); await model.await(); await mount('dsh-agent-loop', { agents: [] });
  await mountNativeController(ctx, mount, load, root, fibers);
  const path = join(root, 'business'); await mkdir(path); const workspace = await ctx.workspaceRegistry.create(path);
  for (const alwaysFail of [false, true]) {
    let attachments = 0;
    const host = { agents: ctx.agents, sessionController: ctx.sessionController, sessionPersistence: ctx.sessionPersistence, sessionProjections: ctx.sessionProjections, permissionPresets: ctx.permissionPresets, workspaceRegistry: { list: () => [{
      id: workspace.id, path: workspace.path, async attachSession(id) {
        attachments++;
        assert.ok(await ctx.sessionPersistence.stat(id));
        if (alwaysFail || attachments === 1) throw new Error('Workspace registration temporarily unavailable');
        await workspace.attachSession(id);
      },
    }] } };
    const database = temporaryDatabase(), files = new FileLibrary(database);
    const f = await fixture({ database, files, run: makeRunner(host, files), sessionExists: async id => (await ctx.sessionPersistence.stat(id)) !== undefined,
      overrides: { workspace_path: workspace.path } });
    try {
      await f.engine.accept(request()); await f.cycle();
      const first = f.record();
      assert.equal(first.status, 'retrying'); assert.equal(f.store.conversations.get(request().metadata).created, true);
      assert.equal(f.store.conversations.get(request().metadata).deleted, false);
      assert.ok(ctx.agents.get(first.execution.session_id));
      // Native permission initialization may leave metadata, but no user turn was started.
      assert.equal((await f.engine.query('news', 'task-1', 'chat-1')).status, 'retrying');
      await f.engine.recover();
      for (let retry = 0; retry < (alwaysFail ? 3 : 1); retry++) { f.advance(60000); await f.cycle(); }
      const final = f.record(); recordSchema.parse(final);
      assert.ok(ctx.agents.get(final.execution.session_id));
      assert.equal(final.execution.attempts, alwaysFail ? 4 : 2);
      assert.equal(final.execution.session_id, first.execution.session_id);
      assert.equal((await f.engine.query('news', 'task-1', 'chat-1')).status, alwaysFail ? 'failed' : 'completed');
      if (!alwaysFail) {
        assert.equal(final.result, 'retry succeeded'); assert.equal(f.store.conversations.get(request().metadata).created, true);
        assert.ok(await ctx.sessionPersistence.stat(final.execution.session_id));
      }
    } finally { await f.engine.close(); }
  }
  assert.equal(modelCalls, 1);
  const database = temporaryDatabase(), files = new FileLibrary(database);
  const continued = await fixture({ database, files, run: makeRunner(ctx, files), sessionExists: async id => (await ctx.sessionPersistence.stat(id)) !== undefined,
    overrides: { workspace_path: workspace.path, max_execution_retries: 1 } });
  try {
    await continued.engine.accept({ ...request('multi'), instruction: 'Remember the codeword: apricot.' });
    await continued.cycle(); assert.equal(continued.record('multi').status, 'completed');
    const session = continued.record('multi').execution.session_id;
    failNext = true;
    await continued.engine.accept({ ...request('multi', 'news', 'second'), instruction: 'What was the codeword?' });
    await continued.cycle();
    assert.equal(continued.record('multi', 'second').status, 'retrying');
    continued.advance(60_000); await continued.cycle();
    const result = continued.record('multi', 'second');
    assert.equal(result.status, 'completed'); assert.equal(result.execution.attempts, 2);
    assert.equal(result.execution.session_id, session);
    assert.equal(modelCalls, 4);
    for (const history of modelHistory.slice(-2)) {
      assert.match(history, /Remember the codeword: apricot/);
      assert.match(history, /retry succeeded/);
      assert.match(history, /What was the codeword/);
    }
    assert.deepEqual(JSON.parse(result.callback_body).metadata, request('multi', 'news', 'second').metadata);
  } finally { await continued.engine.close(); }
});
