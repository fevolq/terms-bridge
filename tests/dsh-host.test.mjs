import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { request, deferred, until } from './helpers.mjs';
import { mountNativePresets } from './native-presets.mjs';

const bridge = process.env.BRIDGE_TEST_PACKAGE
  ? await import(pathToFileURL(createRequire(process.env.BRIDGE_TEST_PACKAGE).resolve('@fevolq/terms-bridge')))
  : await import('../dist/index.js');

test('installed dsh core executes task, persists workspace membership, collects final reply and files and delivers HTTP callback', {
  skip: !process.env.DSH_TEST_PACKAGE,
  timeout: 30000,
}, async t => {
  const requireHost = createRequire(process.env.DSH_TEST_PACKAGE);
  async function load(name) { return import(pathToFileURL(requireHost.resolve(`@deepseek-ai/${name}`))); }
  const { Context, Service, resolveConfig } = await load('cordis'); const ctx = new Context(); const fibers = [];
  ctx.logger.exporter({ export(event) { if (event.type === 'error') console.error(event.name, ...event.args); } });
  t.after(async () => { for (const fiber of [...fibers].reverse()) await fiber.dispose(); });
  async function mount(name, config = {}) {
    const m = await load(name); const f = ctx.plugin(m.default ?? m, config); fibers.push(f); await f.await();
    return m;
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-host-')); const workspace = join(dir, 'workspace'); await mkdir(workspace);
  await mount('dsh-storage'); await mount('dsh-storage-json', { root: join(dir, 'storage') });
  await mount('dsh-storage-domain', { backend: 'json' });
  await mount('dsh-typert-registry');
  await mount('dsh-session'); await mount('dsh-session-projection');
  await mount('dsh-session-persistence-jsonl', { root: join(dir, 'sessions'), compression: 'none' });
  await mount('dsh-workspace'); await mount('dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false });
  await mount('dsh-attachment-local', { dshHome: join(dir, 'attachments') });
  await mount('dsh-tools'); await mount('dsh-skill'); await mount('dsh-agent');
  const { LlmAdapter } = await mount('dsh-llm');
  await mountNativePresets(ctx, mount, load, requireHost, dir, fibers);
  await mount('dsh-fs-local', { cwd: workspace });
  await mount('dsh-tool-present');
  const created = []; const policies = new Map(); let reviews = 0;
  ctx.on('agent/created', ({ agent }) => { created.push({ id: agent.id, preset: ctx.agentPresets.composedPreset(agent.ctx), permission: ctx.permissionPresets.current(agent.session) }); });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    created.find(item => item.id === agent.id).permission = ctx.permissionPresets.current(agent.session);
    policies.set(agent.id, { mode: ctx.sandboxPolicy.resolve({ session: agent.session }).mode,
      approval: ctx.sessionProjections.stateOf(agent.session, 'permissions').approval });
    return next();
  });
  await mount('dsh-experimental-auto-review');
  const autoReview = fibers.at(-1);
  const png = await requireHost('sharp')({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
  let calls = 0; let attachmentRead = false; let publishedId;
  let hold; let holding = false; const models = [];
  t.after(() => hold?.resolve());
  class MockModel extends LlmAdapter {
    async *stream(options) {
      if (options.system?.startsWith('REVIEW_POLICY')) {
        reviews++;
        const text = JSON.stringify({ decision: 'allow', risk: 'low' });
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      assert.ok(options.tools.some(tool => tool.name === 'skill'));
      assert.ok(options.tools.some(tool => tool.name === 'preset_probe'));
      assert.ok(!options.tools.some(tool => tool.name === 'ask_user_question'));
      assert.ok(JSON.stringify(options.messages).includes('business-skill'));
      if (JSON.stringify(options.messages).includes('auto-probe') && !options.messages.some(m => m.role === 'tool')) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'probe-call', name: 'preset_probe', arguments: '{}' } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (JSON.stringify(options.messages).includes('auto-probe')) assert.ok(JSON.stringify(options.messages).includes('preset tool executed'));
      calls++;
      if (calls === 1) {
        const sessionId = ctx.workspaceRegistry.list().find(w => w.path === taskPath(workspace)).sessionIds.at(-1);
        const user = ctx.sessions.get(sessionId).deriveMessages().find(m => m.role === 'user');
        const text = user.content.filter(b => b.type === 'text').map(b => b.text).join('');
        assert.match(text, /^请阅读 .+ 和 .+ 之后完成任务。$/);
        const [imagePath, path] = text.slice('请阅读 '.length, -' 之后完成任务。'.length).split(' 和 ');
        assert.deepEqual(await readFile(imagePath), png);
        assert.equal(await readFile(path, 'utf8'), 'native attachment');
        assert.deepEqual(user.content.slice(1).map(b => b.type), ['file', 'image']);
        assert.match(basename(path), /^\d{10}_[a-zA-Z0-9]{6}\.txt$/);
        assert.match(basename(imagePath), /^\d{10}_[a-zA-Z0-9]{6}\.png$/);
        assert.deepEqual(user.content.slice(1).map(b => b.attachment.name), [basename(path), basename(imagePath)]);
        attachmentRead = true;
        await writeFile(join(workspace, '报告.txt'), 'native result file');
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'present-report', name: 'present',
          arguments: JSON.stringify({ files: [{ path: join(workspace, '报告.txt'), description: 'Result file card' }] }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      models.push(options.model);
      assert.ok(['mock-business', 'new-business'].includes(options.model));
      if (hold && !holding) { holding = true; await hold.promise; }
      const text = calls === 2 ? 'real dsh core result' : 'real dsh core result\n[报告](报告.txt)';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const modelFiber = ctx.plugin({ name: 'test-business-model', inject: ['llm'], apply(c) { c.llm.registerAdapter(['test-business'], new MockModel()); } });
  fibers.push(modelFiber); await modelFiber.await();
  await mount('dsh-agent-loop', { agents: [] });
  await mount('dsh-host-webserver', { host: '127.0.0.1', port: 0 });
  const origin = ctx.webServer.getOrigin(); let received; const callbackIds = [];
  const removeCallback = ctx.webServer.register({ kind: 'exact', path: '/test-callback', handler: async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    received = JSON.parse(Buffer.concat(parts).toString()); callbackIds.push(received.metadata.task_id); res.writeHead(204); res.end();
  } });
  t.after(removeCallback);
  const config = { projects: { news: { name: '同名项目', workspace_path: workspace, provider: 'test-business', model: 'mock-business',
    max_concurrency: 1, max_execution_retries: 0, execution_timeout_seconds: 20,
    callback_url: origin + '/test-callback', request_token: 'isolated-host-token' } } };
  const plugin = ctx.plugin(bridge, config); fibers.push(plugin); await plugin.await();
  assert.deepEqual(await ctx.termsBridge.workspaces(), { news: taskPath(workspace) });
  const prefix = origin + '/api/terms-bridge';
  const form = new FormData(); form.append('file', new Blob(['native attachment']), '原始 100%20.TXT');
  const upload = await fetch(prefix + '/projects/news/files', { method: 'POST', headers: { Authorization: 'Bearer isolated-host-token' }, body: form });
  assert.equal(upload.status, 201); const file = await upload.json();
  const imageForm = new FormData(); imageForm.append('file', new Blob([png], { type: 'image/png' }), '原始 100%20.PNG');
  const imageUpload = await fetch(prefix + '/projects/news/files', { method: 'POST', headers: { Authorization: 'Bearer isolated-host-token' }, body: imageForm });
  assert.equal(imageUpload.status, 201); const image = await imageUpload.json();
  const firstTask = { ...request(), files: [{ file_id: file.file_id }, { file_id: image.file_id }] };
  firstTask.instruction = `请阅读 @${image.file_id} 和 @${file.file_id} 之后完成任务。`;
  const response = await fetch(prefix + '/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer isolated-host-token' }, body: JSON.stringify(firstTask) });
  assert.equal(response.status, 202);
  let task;
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 50));
    const result = await fetch(prefix + '/projects/news/tasks/task-1', { headers: { Authorization: 'Bearer isolated-host-token' } });
    task = await result.json();
    if (task.delivery?.status === 'delivered' || task.status === 'failed') break;
  }
  assert.equal(task.status, 'completed', JSON.stringify(task));
  assert.deepEqual(created[0], { id: task.execution.session_id, preset: 'test-default', permission: 'workspace-write' });
  assert.equal((await ctx.sessionPersistence.stat(task.execution.session_id)).header.agentPreset, 'test-default');
  assert.equal(task.delivery.status, 'delivered', JSON.stringify(task));
  assert.equal(attachmentRead, true);
  assert.equal(received.result, 'real dsh core result'); assert.ok(calls >= 2);
  assert.equal(received.files.length, 1);
  publishedId = received.files[0].file_id; assert.ok(publishedId);
  const download = await fetch(prefix + '/projects/news/files/' + publishedId, { headers: { Authorization: 'Bearer isolated-host-token' } });
  assert.equal(download.status, 200); assert.equal(await download.text(), 'native result file');
  const grouped = ctx.workspaceRegistry.list().find(w => w.path === taskPath(workspace));
  assert.ok(grouped.sessionIds.includes(task.execution.session_id));

  // Exercise the same settings mutation API used by the UI, with an isolated
  // profile editor. No user profile or live dsh configuration is modified.
  const { updateVolatile } = await load('cosmokit');
  let saved = config;
  const entry = { id: 'terms-bridge', options: { id: 'terms-bridge' }, fiber: plugin };
  class Editor extends Service {
    constructor(c) { super(c, 'configEditor'); }
    documentPath = join(dir, 'profile'); writable = true;
    entries() { return [entry]; }
    configuration() { return [{ entry, inherited: {}, override: saved }]; }
    async edit(_entry, change) {
      const next = change(saved, {}); const candidate = resolveConfig(plugin.runtime, next);
      for (const field of ['projects', 'api_prefix']) updateVolatile(plugin.config[field], candidate[field]);
      saved = next; entry.options.config = next;
    }
  }
  class Profile extends Service { constructor(c) { super(c, 'profileContext'); } home = dir; }
  for (const service of [Editor, Profile]) { const f = ctx.plugin(service); fibers.push(f); await f.await(); }
  await mount('dsh-settings');
  const set = async (field, value) => {
    const before = ctx.settings.describe().find(v => v.ns === 'terms-bridge');
    await ctx.settings.mutate('terms-bridge', [{ op: 'set', path: [field], value }], before.revision);
  };
  const post = (id, project = 'news', base = prefix) => fetch(base + '/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer isolated-host-token' }, body: JSON.stringify(request(id, project)),
  });
  const query = async (id, project = 'news', base = prefix) => (await fetch(base + `/projects/${project}/tasks/${id}`, { headers: { Authorization: 'Bearer isolated-host-token' } })).json();
  hold = deferred();
  assert.equal((await post('in-flight')).status, 202); await until(() => holding);
  const running = await query('in-flight');
  const defaultWorkspace = join(dir, 'default-workspace'); await mkdir(defaultWorkspace);
  await ctx.workspaceRegistry.create(defaultWorkspace);
  const secondWorkspace = join(dir, 'second');
  const nextProjects = {
    news: { ...config.projects.news, model: 'new-business', max_execution_retries: 3 },
    second: { ...config.projects.news, workspace_path: undefined, request_token: undefined },
  };
  await set('projects', nextProjects);
  assert.equal((await fetch(prefix + '/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request('new-project', 'second')) })).status, 202);
  assert.ok(ctx.workspaceRegistry.list().some(w => w.path.toLowerCase() === secondWorkspace.toLowerCase()));
  const secondRegistered = ctx.workspaceRegistry.list().find(w => w.path.toLowerCase() === secondWorkspace.toLowerCase());
  assert.equal(grouped.title, '同名项目');
  assert.equal(secondRegistered.title, grouped.title);
  assert.notEqual(secondRegistered.id, grouped.id);
  const stillRunning = await query('in-flight');
  assert.equal(stillRunning.status, 'running');
  assert.equal(stillRunning.execution.session_id, running.execution.session_id);
  assert.equal(stillRunning.execution.attempts, 1);
  hold.resolve();
  await until(() => callbackIds.includes('in-flight') && callbackIds.includes('new-project'));
  assert.equal((await post('new-settings')).status, 202);
  await until(() => callbackIds.includes('new-settings')); assert.ok(models.includes('new-business'));
  // An invalid saved workspace does not cancel work or replace the active registry.
  await set('projects', { ...nextProjects, broken: { ...config.projects.news, workspace_path: join(dir, 'missing') } });
  assert.equal((await post('not-admitted')).status, 503);
  assert.equal((await query('in-flight')).status, 'completed');
  await set('projects', nextProjects);
  assert.equal((await post('after-correction')).status, 202);
  await until(() => callbackIds.includes('after-correction'));
  // Removing a project keeps its workspace and files; re-adding reuses its identity.
  const { parseConfig } = await import('../dist/projects/config.js');
  const { validateProjectWorkspaces } = await import('../dist/projects/workspaces.js');
  await until(async () => (await query('after-correction')).delivery?.status === 'delivered');
  await set('projects', { second: nextProjects.second });
  await until(async () => (await query('task-1')).error?.code === 'PROJECT_NOT_FOUND');
  assert.equal(ctx.workspaceRegistry.get(grouped.id), grouped);
  assert.ok(grouped.sessionIds.includes(task.execution.session_id));
  assert.equal(await readFile(join(workspace, '报告.txt'), 'utf8'), 'native result file');
  validateProjectWorkspaces(ctx, parseConfig({ projects: nextProjects }), new Map());
  await set('projects', nextProjects);
  await until(async () => (await query('task-1')).delivery?.status === 'delivered');
  assert.equal(ctx.workspaceRegistry.list().filter(w => w.path === workspace).length, 1);
  assert.equal(ctx.workspaceRegistry.get(grouped.id), grouped);
  // Each mode is applied before user input; the project's saved Agent preset stays pinned.
  const nextPresetConfig = resolveConfig((await load('dsh-agent-preset-registry')).default, { default: 'test-default', selectedDefault: 'test-specific' });
  updateVolatile(ctx.agentPresets.config.selectedDefault, nextPresetConfig.selectedDefault);
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access', 'auto']) {
    await set('projects', { news: { ...config.projects.news, permission_mode: mode, agent_preset: 'test-default' } });
    const id = 'mode-' + mode;
    const response = await fetch(prefix + '/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer isolated-host-token' },
      body: JSON.stringify({ ...request(id), instruction: mode === 'auto' ? 'auto-probe' : 'plain task' }) });
    assert.equal(response.status, 202);
    await until(() => callbackIds.includes(id));
    const state = await query(id);
    assert.deepEqual(created.find(item => item.id === state.execution.session_id), { id: state.execution.session_id,
      preset: 'test-default', permission: mode });
    if (mode === 'read-only') {
      assert.deepEqual(policies.get(state.execution.session_id), { mode: 'read-only', approval: 'ask' });
      assert.equal(ctx.sandboxPolicy.defaultMode, 'danger-full-access', 'Project mode must not change the host default');
    }
  }
  assert.equal(reviews, 1);
  await autoReview.dispose();
  const beforeUnavailable = calls;
  assert.equal((await post('auto-unavailable')).status, 202);
  await until(async () => (await query('auto-unavailable')).status === 'failed');
  assert.equal(calls, beforeUnavailable, 'Unavailable Auto must not fall back to unreviewed execution');
  await plugin.dispose();
  // Restart just this plugin over its durable domain; do not rerun a delivered task.
  const reloaded = ctx.plugin(bridge, saved); fibers.push(reloaded); await reloaded.await();
  const restored = await fetch(prefix + '/projects/news/tasks/task-1', { headers: { Authorization: 'Bearer isolated-host-token' } });
  assert.equal((await restored.json()).delivery.status, 'delivered');
  const restoredDownload = await fetch(prefix + '/projects/news/files/' + publishedId, { headers: { Authorization: 'Bearer isolated-host-token' } });
  assert.equal(restoredDownload.status, 200); assert.equal(await restoredDownload.text(), 'native result file');
  function taskPath(path) { return path; }
});
