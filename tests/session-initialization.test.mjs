import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, request } from './helpers.mjs';
import { makeRunner } from '../dist/dsh/runner.js';
import { recordSchema } from '../dist/storage/tasks.js';
import { mountNativePresets } from './native-presets.mjs';

test('native pre-prompt initialization failures retry with a new session and respect retry exhaustion', {
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
  const { LlmAdapter } = await mount('dsh-llm'); let modelCalls = 0;
  await mountNativePresets(ctx, mount, load, requireHost, root, fibers);
  class Model extends LlmAdapter {
    async *stream() {
      modelCalls++;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'retry succeeded' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'retry succeeded' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const model = ctx.plugin({ name: 'init-retry-model', inject: ['llm'], apply(c) { c.llm.registerAdapter(['test'], new Model()); } });
  fibers.push(model); await model.await(); await mount('dsh-agent-loop', { agents: [] });
  const path = join(root, 'business'); await mkdir(path); const workspace = await ctx.workspaceRegistry.create(path);
  for (const alwaysFail of [false, true]) {
    let attachments = 0;
    const host = { agents: ctx.agents, agentPresets: ctx.agentPresets, permissionPresets: ctx.permissionPresets, workspaceRegistry: { create: async () => ({
      id: workspace.id, path: workspace.path, async attachSession(id) {
        attachments++;
        assert.ok(await ctx.sessionPersistence.stat(id));
        if (alwaysFail || attachments === 1) throw new Error('Workspace registration temporarily unavailable');
        await workspace.attachSession(id);
      },
    }) } };
    const f = await fixture({ run: await makeRunner(host), sessionExists: async id => (await ctx.sessionPersistence.stat(id)) !== undefined,
      overrides: { workspace_path: workspace.path } });
    f.projects.set('news', { ...f.projects.get('news'), workspace_id: workspace.id });
    try {
      await f.engine.accept(request()); await f.cycle();
      const first = f.record();
      assert.equal(first.status, 'retrying'); assert.equal(first.execution.session_created, false);
      assert.equal(first.session_deleted, undefined);
      // Native permission initialization may leave metadata, but no user turn was started.
      assert.equal((await f.engine.query('news', 'task-1')).status, 'retrying');
      await f.engine.recover();
      for (let retry = 0; retry < (alwaysFail ? 3 : 1); retry++) { f.advance(60000); await f.cycle(); }
      const final = f.record(); recordSchema.parse(final);
      assert.equal(final.execution.attempts, alwaysFail ? 4 : 2);
      assert.equal(new Set(final.execution.sessions).size, final.execution.attempts);
      assert.equal((await f.engine.query('news', 'task-1')).status, alwaysFail ? 'failed' : 'completed');
      if (!alwaysFail) {
        assert.equal(final.result, 'retry succeeded'); assert.equal(final.execution.session_created, true);
        assert.ok(await ctx.sessionPersistence.stat(final.execution.session_id));
      }
    } finally { await f.engine.close(); }
  }
  assert.equal(modelCalls, 1);
});
