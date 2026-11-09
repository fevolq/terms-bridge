import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, link, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, project, request, successRun, until, listenHttp } from './helpers.mjs';
import { handler } from '../dist/http/api.js';
import { FileLibrary } from '../dist/storage/files.js';
import { prepareTaskFiles } from '../dist/storage/task-files.js';
import { recordSchema } from '../dist/storage/tasks.js';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-files-'));
  const workspace = join(root, 'news'); await mkdir(workspace);
  const f = await fixture({ ...options, overrides: { workspace_path: workspace, request_token: '', ...options.overrides } });
  const s = createServer(handler(f.engine, '/api/terms-bridge', f.transfer));
  await listenHttp(s);
  t.after(async () => { await f.engine.close(); s.closeAllConnections(); await new Promise(r => s.close(r)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${s.address().port}/api/terms-bridge`;
  const upload = (body = 'hello files', name = '说明.txt', id = 'news', headers = {}) => {
    const form = new FormData(); form.append('file', new Blob([body], { type: 'text/plain' }), name);
    return fetch(`${base}/projects/${id}/files`, { method: 'POST', body: form, headers });
  };
  const submit = body => fetch(base + '/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ...f, root, workspace, base, upload, submit };
}

test('project-only upload is reusable by multiple chats; retries get isolated original bytes and survive reload', async t => {
  const observed = [];
  const f = await setup(t, { run: async (record, signal) => {
    const [file] = await prepareTaskFiles(record, signal, f.files);
    observed.push({ path: file.path, session: record.execution.session_id, text: await readFile(file.path, 'utf8') });
    await writeFile(file.path, 'edited by task');
    if (record.execution.attempts === 1) throw new Error('retry');
    return successRun();
  } });
  const response = await f.upload(); assert.equal(response.status, 201);
  const file = await response.json(); assert.match(file.filename, /^\d{10}_[a-zA-Z0-9]{6}\.txt$/); assert.equal(file.size, 11); assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(file.project_id, 'news'); assert.equal('conversation_id' in file, false); assert.equal('chat_id' in file, false); assert.equal('path' in file, false);
  const body = { ...request('CON:task'), files: [{ file_id: file.file_id }] };
  assert.equal((await f.submit(body)).status, 202);
  assert.equal((await f.submit(body)).status, 409);
  assert.equal((await f.submit({ ...body, files: [] })).status, 409);
  const restored = new FileLibrary(f.database); assert.deepEqual(await restored.resolve('news', f.projects.get('news'), body.files), [file]);
  await f.cycle(); f.advance(60000); await f.cycle(); await f.cycle();
  assert.equal(f.record('CON:task').status, 'completed'); recordSchema.parse(f.record('CON:task'));
  assert.equal((await f.submit({ ...body, metadata: { ...body.metadata, chat_id: 'reuse' } })).status, 202);
  await f.cycle(); assert.equal(observed.length, 3);
  assert.ok(observed.every(x => x.text === 'hello files')); assert.equal(new Set(observed.map(x => x.path)).size, 3); assert.equal(new Set(observed.map(x => x.session)).size, 1);
  assert.equal((await f.upload('other', '说明.txt')).status, 201);
  assert.equal((await restored.resolve('news', f.projects.get('news'), body.files))[0].sha256, file.sha256);
});

test('uploads use unique generated filenames on disk and in attempt copies', async t => {
  const f = await setup(t); const seen = new Set();
  for (const original of ['a%20b.PNG', 'a%20b.PNG', '100%.txt', '无扩展名', '图'.repeat(100) + '.PNG', '../bad.txt', 'CON.txt']) {
    const uploaded = await f.upload('original bytes', original); assert.equal(uploaded.status, 201);
    const file = await uploaded.json();
    const extension = original.endsWith('.PNG') ? '.png' : original.endsWith('.txt') ? '.txt' : '';
    assert.match(file.filename.slice(0, 17), /^\d{10}_[a-zA-Z0-9]{6}$/);
    assert.equal(file.filename.slice(17), extension); assert.equal(seen.has(file.filename), false); seen.add(file.filename);
    assert.ok(Math.abs(Number(file.filename.slice(0, 10)) - Math.floor(Date.now() / 1000)) < 5);
    const folder = join(f.workspace, '.terms-bridge', 'files', file.file_id);
    assert.deepEqual(await readdir(folder), [file.filename]);
    assert.deepEqual(f.database.files.get(file.file_id).file, file);
    assert.equal(await readFile(join(folder, file.filename), 'utf8'), 'original bytes');
    const task = request(file.file_id); task.files = [{ file_id: file.file_id }]; await f.engine.accept(task);
    const record = f.record(file.file_id); record.execution.attempt_id = 'attempt';
    const [copy] = await prepareTaskFiles(record, new AbortController().signal, f.files);
    assert.equal(copy.filename, file.filename); assert.ok(copy.path.endsWith(file.filename));
    assert.equal(await readFile(copy.path, 'utf8'), 'original bytes');
  }
});

test('upload auth and ownership; nonexistent/cross-project/duplicate/path references cannot admit a task', async t => {
  const f = await setup(t, { overrides: { request_token: 'private' } });
  assert.equal((await f.upload()).status, 401);
  assert.equal((await f.upload('hello', 'doc.txt', 'absent')).status, 404);
  const response = await f.upload('hello', 'doc.txt', 'news', { Authorization: 'Bearer private' }); assert.equal(response.status, 201);
  const file = await response.json();
  const other = join(f.root, 'other'); await mkdir(other);
  f.projects.set('other', project({ workspace_path: other, request_token: '' }));
  const body = { ...request('task-1', 'other'), files: [{ file_id: file.file_id }] };
  assert.equal((await f.submit(body)).status, 404);
  f.projects.get('news').request_token = '';
  for (const refs of [[{ file_id: '../secret' }], [{ file_id: file.file_id, path: 'secret' }], [{ file_id: file.file_id }, { file_id: file.file_id }], Array.from({ length: 21 }, () => ({ file_id: file.file_id })), null]) {
    assert.equal((await f.submit({ ...request(), files: refs })).status, 400);
  }
  assert.equal((await f.submit({ ...request(), files: [{ file_id: 'file_' + 'a'.repeat(32) }] })).status, 404);
  assert.equal(f.store.list().length, 0);
});

test('multipart validation, exact size boundary, streaming overflow and partial-file cleanup', async t => {
  const f = await setup(t, { transferOptions: { maxFileBytes: 16 } });
  assert.equal((await f.upload('x'.repeat(16))).status, 201);
  const large = await f.upload('x'.repeat(17)); assert.equal(large.status, 413); assert.equal((await large.json()).error.code, 'FILE_TOO_LARGE');
  const url = f.base + '/projects/news/files';
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data' }, body: '' })).status, 400);
  for (const [field, filename] of [['bad', 'ok.txt']]) {
    const body = `--x\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n\r\nx\r\n--x--\r\n`;
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body })).status, 400);
  }
  const form = new FormData(); form.append('file', new Blob(['a']), 'a.txt'); form.append('file', new Blob(['b']), 'b.txt');
  assert.equal((await fetch(url, { method: 'POST', body: form })).status, 400);
  const extra = new FormData(); extra.append('project_id', 'news'); extra.append('file', new Blob(['a']), 'a.txt');
  assert.equal((await fetch(url, { method: 'POST', body: extra })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', body: new FormData() })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body: '--x\r\nContent-Disposition: form-data; name="file"; filename="x"\r\n\r\nbroken' })).status, 400);
  const folders = await readdir(join(f.workspace, '.terms-bridge', 'files'));
  assert.equal(folders.length, 1); assert.ok(folders.every(x => x.startsWith('file_')));
});

test('upload timeout/disconnect releases slots and removes incomplete files', async t => {
  const transferOptions = { timeoutMs: 80 };
  const f = await setup(t, { transferOptions });
  const url = f.base + '/projects/news/files';
  const slow = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' } });
  slow.write('--x\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\nhello');
  const [res] = await once(slow, 'response'); res.resume(); assert.equal(res.statusCode, 408); slow.destroy();
  // Only the stalled request uses a short deadline; later steps verify disconnect cleanup and recovery.
  delete transferOptions.timeoutMs;
  const aborted = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' } });
  aborted.on('error', () => {}); aborted.write('--x\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\nhello');
  await until(async () => (await readdir(join(f.workspace, '.terms-bridge', 'files'))).some(x => x.startsWith('.incoming')));
  aborted.destroy();
  await until(async () => (await readdir(join(f.workspace, '.terms-bridge', 'files'))).length === 0);
  assert.equal((await f.upload()).status, 201);
});

test('changed file bytes are detected before executing attachments', async t => {
  const f = await setup(t);
  const file = await (await f.upload('hello')).json();
  await f.engine.accept({ ...request(), files: [{ file_id: file.file_id }] });
  await writeFile(join(f.workspace, '.terms-bridge', 'files', file.file_id, file.filename), 'other');
  const record = f.record(); record.execution.attempt_id = 'test-attempt';
  await assert.rejects(prepareTaskFiles(record, new AbortController().signal, f.files), /checksum/);
});

test('concurrent uploads are bounded and shutdown drains uploads awaited by configuration changes', async t => {
  const f = await setup(t);
  const url = f.base + '/projects/news/files';
  const connections = [1, 2].map(() => {
    const req = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' } });
    req.on('error', () => {});
    const response = once(req, 'response').then(([res]) => { res.resume(); return res.statusCode; });
    req.write('--x\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\nhello');
    return { req, response };
  });
  await until(async () => {
    try { return (await readdir(join(f.workspace, '.terms-bridge', 'files'))).length === 2; } catch { return false; }
  });
  assert.equal((await f.upload()).status, 429);
  const changed = new Map([['news', { ...f.projects.get('news'), model: 'new-model' }]]);
  let applied = false;
  const reconfigured = f.engine.reconfigure(changed).then(() => { applied = true; }, error => error);
  connections[0].req.end('\r\n--x--\r\n');
  assert.equal(await connections[0].response, 201); assert.equal(applied, false);
  await f.engine.close();
  assert.equal(await connections[1].response, 400);
  connections[1].req.destroy();
  assert.match((await reconfigured).message, /stopping/);
  assert.equal((await readdir(join(f.workspace, '.terms-bridge', 'files'))).length, 1);
});

test('publish result -> callback reference -> authenticated streaming download; immutable bytes and durable references', async t => {
  const bytes = Buffer.from([0, 255, 42, 128, 13, 10]); let callback, source;
  const f = await setup(t, { callback: async record => { callback = JSON.parse(record.callback_body); return null; },
    run: async (record) => {
      source = join(record.project.workspace_path, "结果'图.bin"); await writeFile(source, bytes);
      return { result: '完成。', files: [await f.files.publish(record, source, new AbortController().signal)] };
    } });
  await f.engine.accept(request()); await f.cycle(); await f.cycle();
  await writeFile(source, 'changed working file');
  recordSchema.parse(f.record());
  assert.equal(callback.result, '完成。');
  const published = { file: callback.files[0] };
  const url = `${f.base}/projects/news/files/${published.file.file_id}`;
  f.projects.get('news').request_token = 'download-token';
  assert.equal((await fetch(url)).status, 401);
  const headers = { Authorization: 'Bearer download-token' };
  const response = await fetch(url, { headers }); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-length'), '6');
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''\d{10}_[a-zA-Z0-9]{6}\.bin/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-dsh-file-sha256'), createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const head = await fetch(url, { method: 'HEAD', headers }); assert.equal(head.status, 405); assert.equal(head.headers.get('allow'), 'GET'); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await fetch(url, { headers: { ...headers, Range: 'bytes=0-1' } }); assert.equal(range.status, 200); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes);
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
  const other = join(f.root, 'other'); await mkdir(other); f.projects.set('other', project({ workspace_path: other, request_token: '' }));
  assert.equal((await fetch(url.replace('/news/', '/other/'))).status, 404);
  assert.equal((await fetch(`${f.base}/projects/news/files/file_${'a'.repeat(32)}`, { headers })).status, 404);
  assert.equal((await fetch(`${f.base}/projects/news/files/%2e%2e%2fsecret`, { headers })).status, 400);
  const reopened = await new FileLibrary(f.database).openDownload('news', f.projects.get('news'), published.file.file_id, new AbortController().signal);
  assert.equal(reopened.file.sha256, published.file.sha256); await reopened.handle.close();
  await writeFile(join(f.workspace, '.terms-bridge', 'files', published.file.file_id, published.file.filename), Buffer.alloc(6));
  const corrupt = await fetch(url, { headers }); assert.equal(corrupt.status, 422); assert.equal((await corrupt.json()).error.code, 'FILE_UNAVAILABLE');
});

test('result snapshots reject outside paths, hardlinks and directory links', async t => {
  const f = await setup(t);
  const outside = join(f.root, 'secret.txt'); await writeFile(outside, 'private');
  await f.engine.accept(request()); const record = f.record(); const library = new FileLibrary(f.database);
  const signal = new AbortController().signal;
  for (const path of [outside, '../secret.txt']) await assert.rejects(library.publish(record, path, signal), e => e.code === 'INVALID_FILE_PATH');
  await link(outside, join(f.workspace, 'hardlink.txt'));
  await assert.rejects(library.publish(record, 'hardlink.txt', signal), e => e.code === 'FILE_UNAVAILABLE');
  await symlink(f.root, join(f.workspace, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(library.publish(record, 'outside/secret.txt', signal), e => e.code === 'FILE_UNAVAILABLE');
});

test('download also serves project uploads and handles client disconnect without poisoning later requests', async t => {
  const f = await setup(t);
  const file = await (await f.upload(Buffer.alloc(8 * 1024 * 1024, 42), 'large.bin')).json();
  const url = `${f.base}/projects/news/files/${file.file_id}`;
  const client = httpRequest(url); client.on('error', () => {}); client.end();
  const [response] = await once(client, 'response'); response.on('error', () => {}); client.destroy();
  const next = await fetch(url); assert.equal(next.status, 200); assert.equal(Number(next.headers.get('content-length')), 8 * 1024 * 1024);
  assert.deepEqual(Buffer.from(await next.arrayBuffer()), Buffer.alloc(8 * 1024 * 1024, 42));
});
