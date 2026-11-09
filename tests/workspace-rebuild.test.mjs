import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { MemoryTable, deferred, fixture, listenHttp, project, request, successRun, until } from './helpers.mjs';
import { handler } from '../dist/http/api.js';
import { ProjectWorkspaces, resolveProjects, workspaceBindings } from '../dist/projects/workspaces.js';

async function setup(t, manual = false) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-rebuild-'));
  const path = join(root, 'original', 'news'); await mkdir(path, { recursive: true });
  const configured = { ...project(), workspace_path: manual ? path : undefined };
  const f = await fixture({ overrides: { workspace_path: path }, run: successRun });
  if (manual) f.projects.get('news').configured_path = path;
  const bindings = new MemoryTable(); await bindings.put('current', workspaceBindings(f.projects));
  const registered = new Map([[path, { id: 'workspace-1', path, attachSession: async () => {} }]]);
  let creates = 0, lookups = 0, removed = 0;
  const host = { workspaceRegistry: { list: () => [...registered.values()], create: async path => {
    creates++; if (!registered.has(path)) registered.set(path, { id: 'id-' + creates, path, attachSession: async () => {} });
    return registered.get(path);
  } } };
  const fallback = join(root, 'new-documents', 'deepseek-harness', 'news');
  const directory = () => { lookups++; return join(root, 'new-documents', 'deepseek-harness'); };
  const workspaces = new ProjectWorkspaces(host, bindings, directory, f.projects);
  f.engine.ports.prepareProject = (id, signal, beforeRelocate) => workspaces.prepare(id, signal, beforeRelocate);
  const server = createServer(handler(f.engine, '/bridge', f.transfer)); await listenHttp(server);
  const base = `http://127.0.0.1:${server.address().port}/bridge`;
  const upload = (headers = {}) => {
    const form = new FormData(); form.append('file', new Blob(['input data']), 'input.txt');
    return fetch(base + '/projects/news/files', { method: 'POST', body: form, headers: { Authorization: 'Bearer test-request-token', ...headers } });
  };
  const within = path => { const child = relative(root, path); assert(child && !child.startsWith('..') && !isAbsolute(child)); };
  const removeDirectory = async () => {
    const backup = path + '-retained-' + ++removed; within(path); within(backup); await rename(path, backup);
  };
  t.after(async () => {
    server.closeAllConnections(); await f.engine.close(); await new Promise(resolve => server.close(resolve));
    const child = relative(tmpdir(), root); assert(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(root, { recursive: true, force: true });
  });
  return { ...f, root, path, configured, bindings, host, directory, registered, fallback, upload, base,
    counts: () => ({ creates, lookups }), removeDirectory,
    blockDirectory: async () => { await removeDirectory(); await writeFile(path, 'not a directory'); } };
}

test('startup reads saved bindings without consulting DSH registrations or default directories', async t => {
  const f = await setup(t); await f.blockDirectory();
  const host = { workspaceRegistry: { list: () => assert.fail('Startup must not inspect DSH workspaces'), create: () => assert.fail('Startup must not create workspaces') } };
  const service = new ProjectWorkspaces(host, f.bindings, () => assert.fail('Startup must not resolve defaults'));
  await service.load({ projects: { news: f.configured } });
  assert.equal(service.projects.get('news').workspace_path, f.path);
  assert.equal(await readFile(f.path, 'utf8'), 'not a directory');
});

for (const manual of [false, true]) test('a missing saved directory rebuilds in place only on a task; manual=' + manual, async t => {
  const f = await setup(t, manual); await f.removeDirectory(); f.registered.clear();
  const config = { projects: { news: { ...f.configured, model: 'updated' } } };
  const projects = await resolveProjects(f.host, config, f.projects, () => assert.fail('Reload cannot rebuild'));
  assert.equal(projects.get('news').workspace_path, f.path);
  await assert.rejects(stat(f.path), { code: 'ENOENT' });
  assert.equal(f.counts().creates, 0);
  assert.equal((await f.engine.accept(request('new'))).status, 202);
  assert.equal(f.record('new').project.workspace_path, f.path);
  assert.equal(f.bindings.get('current').news.workspace_path, f.path);
  assert.equal('workspace_id' in f.bindings.get('current').news, false);
  assert.equal((await stat(f.path)).isDirectory(), true);
  assert.deepEqual(f.counts(), { creates: 1, lookups: 0 });
});

for (const missingDirectory of [false, true]) test('HTTP upload restores and registers the saved workspace before task submission; missing directory=' + missingDirectory, async t => {
  const f = await setup(t); f.registered.clear();
  if (missingDirectory) await f.removeDirectory();
  const response = await f.upload(); assert.equal(response.status, 201);
  const file = await response.json();
  assert.ok(f.registered.has(f.path)); assert.equal(f.counts().lookups, 0);
  assert.equal('workspace_id' in f.bindings.get('current').news, false);
  const input = request(); input.files = [{ file_id: file.file_id }];
  assert.equal((await f.engine.accept(input)).status, 202);
  assert.equal(f.record().project.workspace_path, f.path);
  assert.equal(f.record().files[0].file_id, file.file_id);
  const download = await fetch(f.base + '/projects/news/files/' + file.file_id, { headers: { Authorization: 'Bearer test-request-token' } });
  assert.equal(download.status, 200); assert.equal(await download.text(), 'input data');
});

test('rejected requests do not create workspaces, and a later chat restores its original directory', async t => {
  const f = await setup(t); await f.engine.accept(request()); await f.cycle();
  const old = f.record(), callback = old.callback_body; await f.removeDirectory(); f.registered.clear();
  const before = f.counts();
  await assert.rejects(f.engine.accept({ metadata: request().metadata }), e => e.code === 'CHAT_ALREADY_EXISTS');
  await assert.rejects(f.engine.accept({ metadata: request('new').metadata }), e => e.code === 'INVALID_REQUEST');
  assert.equal((await f.upload({ Authorization: 'wrong' })).status, 401);
  const invalid = await fetch(f.base + '/projects/news/files', { method: 'POST', headers: { Authorization: 'Bearer test-request-token', 'Content-Type': 'text/plain' }, body: 'invalid' });
  assert.equal(invalid.status, 415); assert.deepEqual(f.counts(), before);
  await assert.rejects(stat(f.path), { code: 'ENOENT' });
  assert.equal((await f.engine.accept(request('task-1', 'news', 'next'))).status, 202);
  assert.equal(f.record('task-1', 'next').execution.session_id, old.execution.session_id);
  assert.equal(f.record().callback_body, callback); assert.equal(f.counts().lookups, 0);
});

for (const manual of [false, true]) test('only failed restoration falls back and the new binding survives reload and settings edits; manual=' + manual, async t => {
  const f = await setup(t, manual); await f.blockDirectory();
  const response = await f.upload(); assert.equal(response.status, 201);
  const file = await response.json();
  assert.equal(f.projects.get('news').workspace_path, f.fallback);
  assert.equal(f.bindings.get('current').news.workspace_path, f.fallback);
  assert.equal(await readFile(f.path, 'utf8'), 'not a directory');
  assert.deepEqual(f.counts(), { creates: 1, lookups: 1 });
  const config = { projects: { news: { ...f.configured, model: 'updated' } } };
  const projects = await resolveProjects(f.host, config, new Map(Object.entries(f.bindings.get('current'))), () => assert.fail('Saved replacement must not be recalculated'));
  assert.equal(projects.get('news').workspace_path, f.fallback);
  await f.engine.reconfigure(projects);
  const input = request(); input.files = [{ file_id: file.file_id }];
  assert.equal((await f.engine.accept(input)).status, 202);
  assert.equal(f.record().project.workspace_path, f.fallback); assert.equal(f.record().project.model, 'updated');
  assert.equal('configured_path' in f.record().project, false);
  assert.equal(f.counts().lookups, 1);
});

test('native registration errors never fall back or change the saved path', async t => {
  const f = await setup(t); await f.removeDirectory(); f.registered.clear();
  const create = f.host.workspaceRegistry.create;
  f.host.workspaceRegistry.create = async () => { throw new Error('native registration unavailable'); };
  await assert.rejects(f.engine.accept(request()), /native registration unavailable/);
  assert.equal(f.projects.get('news').workspace_path, f.path);
  assert.equal(f.counts().lookups, 0);
  f.host.workspaceRegistry.create = create;
  assert.equal((await f.engine.accept(request())).status, 202);
});

test('old sessions and unfinished tasks cannot relocate, while callbacks remain independent', async t => {
  const f = await setup(t); await f.engine.accept(request()); await f.blockDirectory();
  await assert.rejects(f.engine.accept(request('new')), e => e.code === 'PROJECT_BUSY');
  const busy = await f.upload(); assert.equal(busy.status, 409); assert.equal((await busy.json()).error.code, 'PROJECT_BUSY');
  await f.cycle(); const old = f.record();
  await assert.rejects(f.engine.accept(request('task-1', 'news', 'next')), e => e.code === 'CONVERSATION_WORKSPACE_CHANGED');
  assert.equal(f.counts().lookups, 0);
  assert.equal((await f.engine.accept(request('new'))).status, 202);
  assert.equal(f.record('new').project.workspace_path, f.fallback);
  assert.equal(f.record().project.workspace_path, f.path); assert.equal(f.record().callback_body, old.callback_body);
  await f.cycle(); assert.equal(f.record().delivery.status, 'delivered');
});

test('failed binding persistence is retryable and configuration waits for recovered paths to commit', async t => {
  const f = await setup(t), old = f.bindings.get('current');
  await f.blockDirectory(); f.bindings.failWrites = true;
  await assert.rejects(f.engine.accept(request('new')), /disk unavailable/);
  assert.deepEqual(f.bindings.get('current'), old); assert.equal(f.projects.get('news').workspace_path, f.path);
  assert.equal(f.record('new'), undefined); f.bindings.failWrites = false;
  const gate = deferred(); let saving = false;
  const update = f.bindings.update.bind(f.bindings);
  f.bindings.update = async (...args) => { saving = true; await gate.promise; return update(...args); };
  const admission = f.engine.accept(request('new')); t.after(() => gate.resolve());
  await until(() => saving); let configured = false;
  const change = f.engine.reconfigure(async () => {
    configured = true;
    return resolveProjects(f.host, { projects: { news: { ...f.configured, model: 'changed' } } }, f.projects, f.directory);
  }, next => f.bindings.put('current', workspaceBindings(next)));
  assert.equal(configured, false); gate.resolve(); await admission; await change;
  assert.equal(f.projects.get('news').workspace_path, f.fallback);
  assert.equal(f.projects.get('news').model, 'changed'); assert.equal(f.record('new').project.model, f.configured.model);
  assert.equal(f.bindings.get('current').news.workspace_path, f.fallback);
});

test('an in-progress HTTP upload prevents directory relocation without serializing file streams', async t => {
  const f = await setup(t), gate = deferred();
  const stage = f.files.stage.bind(f.files); let waiting = false, first = true;
  // Pause after workspace preparation but before opening a file: Windows locks open directories.
  f.files.stage = async (...args) => {
    if (first) { first = false; waiting = true; await gate.promise; }
    return stage(...args);
  };
  const req = httpRequest(f.base + '/projects/news/files', { method: 'POST', headers: {
    Authorization: 'Bearer test-request-token', 'Content-Type': 'multipart/form-data; boundary=x' } });
  req.on('error', () => {});
  const response = once(req, 'response').then(([res]) => { res.resume(); return res.statusCode; });
  try {
    req.write('--x\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\nhello');
    await until(() => waiting);
    assert.equal((await f.upload()).status, 201, 'second upload can finish while the first is streaming');
    await f.blockDirectory();
    await assert.rejects(f.engine.accept(request()), e => e.code === 'PROJECT_BUSY');
    assert.equal(f.counts().lookups, 0);
    gate.resolve(); req.end('\r\n--x--\r\n'); assert.equal(await response, 503);
    assert.equal((await f.upload()).status, 201, 'failed upload releases the directory reservation');
    assert.equal(f.projects.get('news').workspace_path, f.fallback);
  } finally { gate.resolve(); req.destroy(); }
});

test('upload cancellation while waiting for workspace recovery leaves the saved directory untouched', async t => {
  const f = await setup(t), gate = deferred(); await f.removeDirectory(); f.registered.clear();
  f.transfer.options.timeoutMs = 30;
  let held = false, pendingSignal;
  const locked = f.store.locked('project:news', async () => { held = true; await gate.promise; });
  const upload = f.engine.upload.bind(f.engine);
  f.engine.upload = (id, receive) => upload(id, prepare => receive(signal => { pendingSignal = signal; return prepare(signal); }));
  try {
    await until(() => held);
    const response = f.upload(); await until(() => pendingSignal?.aborted);
    gate.resolve(); await locked;
    assert.equal((await response).status, 408);
    await assert.rejects(stat(f.path), { code: 'ENOENT' });
    assert.deepEqual(f.counts(), { creates: 0, lookups: 0 });
    f.transfer.options.timeoutMs = 1000;
    assert.equal((await f.upload()).status, 201);
  } finally { gate.resolve(); await locked; }
});

test('startup loads an unusable saved path without touching it, then upload preparation performs recovery', async t => {
  const f = await setup(t); await f.blockDirectory();
  const bindings = f.bindings, service = new ProjectWorkspaces(f.host, bindings, f.directory);
  await service.load({ projects: { news: f.configured } });
  assert.equal(service.projects.get('news').workspace_path, f.path);
  assert.deepEqual(f.counts(), { creates: 0, lookups: 0 });
  assert.equal(await readFile(f.path, 'utf8'), 'not a directory');
  const recovered = await service.prepare('news', f.engine.stop.signal, () => {});
  assert.equal(recovered.workspace_path, f.fallback);
  assert.deepEqual(bindings.get('current').news, { workspace_path: f.fallback });
});

test('startup defers default-directory lookup and registration for an unbound automatic project', async t => {
  const f = await setup(t); f.registered.clear();
  const service = new ProjectWorkspaces(f.host, new MemoryTable(), f.directory);
  await service.load({ projects: { news: f.configured } });
  assert.equal(service.projects.get('news').workspace_path, undefined);
  assert.deepEqual(f.counts(), { creates: 0, lookups: 0 });
  await assert.rejects(stat(f.fallback), { code: 'ENOENT' });
  const prepared = await service.prepare('news', f.engine.stop.signal, () => {});
  assert.equal(prepared.workspace_path, f.fallback);
  assert.deepEqual(f.counts(), { creates: 1, lookups: 1 });
});

test('an existing conversation binding reports an unusable directory without rebinding or repairing its record', async t => {
  const f = await setup(t);
  await f.engine.accept(request()); await f.cycle();
  const conversation = f.store.conversations.get(request().metadata);
  assert.equal(conversation.created, false); assert.equal(f.store.list().length, 1);
  await f.blockDirectory();
  await assert.rejects(f.engine.accept(request('task-1', 'news', 'next')), error => error.code === 'CONVERSATION_WORKSPACE_CHANGED');
  assert.deepEqual(f.store.conversations.get(request().metadata), conversation);
  assert.equal(f.counts().lookups, 0);
});

test('deferred automatic path resolution still rejects another project’s saved directory', async t => {
  const f = await setup(t); f.registered.clear();
  const service = new ProjectWorkspaces(f.host, new MemoryTable(), f.directory);
  await service.load({ projects: { news: f.configured, other: { ...f.configured, workspace_path: f.fallback } } });
  assert.deepEqual(f.counts(), { creates: 0, lookups: 0 });
  await assert.rejects(service.prepare('news', f.engine.stop.signal, () => {}), /belongs to another project/);
  await assert.rejects(stat(f.fallback), { code: 'ENOENT' });
  assert.deepEqual(f.counts(), { creates: 0, lookups: 1 });
});

test('ordinary configuration edits do not persist unresolved manual paths or trigger workspace calls', async t => {
  const f = await setup(t), alias = join(f.root, 'manual-alias');
  await symlink(f.path, alias, 'junction');
  const bindings = new MemoryTable(), service = new ProjectWorkspaces(f.host, bindings, f.directory);
  const config = { projects: { news: { ...f.configured, workspace_path: alias } } };
  await service.load(config);
  config.projects.news.model = 'updated';
  const next = await service.configure(config); await bindings.put('current', workspaceBindings(next));
  service.projects.clear(); for (const [id, project] of next) service.projects.set(id, project);
  assert.equal(service.projects.get('news').workspace_path, undefined);
  assert.equal(service.projects.get('news').configured_path, alias);
  assert.deepEqual(bindings.get('current'), {});
  assert.deepEqual(f.counts(), { creates: 0, lookups: 0 });
  const prepared = await service.prepare('news', f.engine.stop.signal, () => {});
  assert.equal(prepared.workspace_path, f.path);
  assert.equal(bindings.get('current').news.workspace_path, f.path);
  assert.deepEqual(f.counts(), { creates: 1, lookups: 0 });
});

test('startup and existing configuration edits leave conflicting saved paths unchecked until a request', async t => {
  const f = await setup(t), bindings = new MemoryTable();
  await bindings.put('current', { news: { workspace_path: f.path }, other: { workspace_path: f.path } });
  const service = new ProjectWorkspaces(f.host, bindings, f.directory);
  const config = { projects: { news: f.configured, other: { ...f.configured, model: 'other' } } };
  await service.load(config);
  await bindings.put('current', workspaceBindings(await service.configure(config)));
  assert.deepEqual(f.counts(), { creates: 0, lookups: 0 });
  await assert.rejects(service.prepare('news', f.engine.stop.signal, () => {}), /belongs to another project/);
});

for (const [spelling, automatic] of [
  ['absolute', false], ['absolute', true], ['junction', false], ['junction', true],
  ['home-relative', false], ['normalized', false], ['missing', true],
]) test('new projects reject an existing unresolved manual path: ' + spelling + ', automatic=' + automatic, async t => {
  const f = await setup(t);
  let configured = f.path;
  if (spelling === 'junction') {
    configured = join(f.root, 'workspace-alias');
    await symlink(f.path, configured, 'junction');
  } else if (spelling === 'missing') await f.removeDirectory();
  else if (spelling === 'home-relative') configured = '~/' + relative(homedir(), f.path).replaceAll('\\', '/');
  else if (spelling === 'normalized') configured = dirname(f.path) + '/unused/../news';
  const bindings = new MemoryTable();
  const service = new ProjectWorkspaces(f.host, bindings, () => dirname(f.path));
  const config = { projects: { existing: { ...f.configured, workspace_path: configured } } };
  await service.load(config);
  const original = structuredClone([...service.projects]);
  assert.deepEqual(f.counts(), { creates: 0, lookups: 0 });
  config.projects.news = { ...f.configured, workspace_path: automatic ? undefined : f.path };
  await assert.rejects(service.configure(config), /工作区路径.*重复/);
  assert.deepEqual([...service.projects], original);
  assert.deepEqual(bindings.get('current'), {});
  assert.deepEqual(f.counts(), { creates: 0, lookups: 0 });
  const prepared = await service.prepare('existing', f.engine.stop.signal, () => {});
  assert.equal(prepared.workspace_path, f.path);
  assert.equal(bindings.get('current').existing.workspace_path, f.path);
});
