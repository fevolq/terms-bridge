import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replaceFiles, makeRunner } from '../dist/dsh/runner.js';
import { UnsettledExecutionError } from '../dist/domain/types.js';
import { finalResponse, presentedFiles, referencedPaths } from '../dist/dsh/results.js';
import { fixture, request, deferred, until, fileTestAgent, fileTestSessions } from './helpers.mjs';
import { recordSchema } from '../dist/storage/tasks.js';
import { FileLibrary } from '../dist/storage/files.js';

const assistant = content => ({ type: 'assistant/message', data: { message: { role: 'assistant', content } } });
const end = kind => ({ type: 'turn/end', data: { reason: { kind } } });
const personId = 'file_9751f0e64617464da9982a381269698b';
const clothesId = 'file_2b67ffb86bb548a884ac61e7a1484551';
const inputs = [{ file_id: clothesId, path: 'inputs/clothes.webp' }, { file_id: personId, path: 'inputs/person.png' }];

test('file ID references resolve by ID rather than array order, including repeated references', () => {
  assert.equal(replaceFiles(`给 @${personId} 中的人物穿上 @${clothesId} 中的衣服`, inputs),
    '给 inputs/person.png 中的人物穿上 inputs/clothes.webp 中的衣服');
  assert.equal(replaceFiles(`比较 @${personId} 和 @${personId} 。`, inputs), '比较 inputs/person.png 和 inputs/person.png 。');
});

test('file ID references respect token boundaries and preserve other text', () => {
  assert.equal(replaceFiles(`@${personId}\n\t@${clothesId}`, inputs), 'inputs/person.png\n\tinputs/clothes.webp');
  const unchanged = ` @文件 @a.png x@${personId} @${personId}0 @${personId}_extra @file_${'0'.repeat(32)} `;
  assert.equal(replaceFiles(unchanged, inputs), unchanged);
  assert.equal(replaceFiles(` @${personId} `, []), ` @${personId} `);
  assert.equal(replaceFiles('plain prompt', inputs), 'plain prompt');
});

test('file paths are inserted literally without recursive replacement', () => {
  const path = `C:\\input $&\\ @${clothesId} \\person.png`;
  assert.equal(replaceFiles(` @${personId} `, [{ file_id: personId, path }, ...inputs.slice(0, 1)]), ` ${path} `);
});

test('final assistant blocks exclude earlier steps and tool responses; failures are not completion', () => {
  const final = [{ type: 'reasoning', text: 'private' }, { type: 'text', text: '  原文\n' }, { type: 'text', text: '\n**结论**  ' }];
  const events = [{ type: 'turn/start', data: {} }, assistant([{ type: 'text', text: '中间消息' }, { type: 'tool-call' }]),
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '工具结果' }] } } }, assistant(final), end('completed')];
  assert.deepEqual(finalResponse(events), final);
  for (const kind of ['error', 'canceled', 'max-tokens', 'aborted']) assert.throws(() => finalResponse([...events.slice(0, -1), end(kind)]));
  assert.throws(() => finalResponse(events.slice(0, -1)));
  assert.throws(() => finalResponse([...events, { type: 'turn/start', data: {} }]));
  assert.throws(() => finalResponse([assistant([{ type: 'tool-call' }]), end('completed')]));
});

test('collects existing final links in appearance order, skips missing/remote/outside/symlink paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-refs-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'work'); await mkdir(workspace);
  for (const name of ['a.png', '中文 b.txt', 'file(1).md']) await writeFile(join(workspace, name), 'data');
  await writeFile(join(root, 'secret.txt'), 'secret');
  await symlink(root, join(workspace, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const text = `![图片](a.png) [中文](<中文 b.txt>) [嵌套](file(1).md) \`a.png\` [uri](${pathToFileURL(join(workspace, 'a.png'))}) [缺失](none) [外部](../secret.txt) [网络](https://example.com/a.png) [链接](outside/secret.txt)`;
  const paths = await referencedPaths(text, workspace);
  assert.deepEqual(paths, ['a.png', '中文 b.txt', 'file(1).md', 'a.png', 'a.png'].map(name => join(workspace, name)));
});

test('present cards come only from the latest completed turn, never ordinary tool output', () => {
  const start = turn => ({ type: 'turn/start', data: { turn } });
  const card = (turn, ...paths) => ({ type: 'deliverables/presented', data: { turn, files: paths.map(path => ({ path })) } });
  const finish = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } });
  const events = [start(1), card(1, 'old.png'), finish(1), start(2),
    { type: 'tool/result', data: { turn: 2, files: [{ path: 'intermediate.png' }], message: { content: [{ type: 'text', text: 'Created intermediate.png' }] } } },
    card(1, 'wrong-turn.png'), card(2, 'result.png'), card(2, 'report.txt'),
    assistant([{ type: 'text', text: '已呈现文件。' }]), finish(2)];
  assert.deepEqual(presentedFiles(events), ['result.png', 'report.txt']);
  assert.deepEqual(presentedFiles(events.slice(0, -1)), []);
  assert.deepEqual(presentedFiles([...events, start(3)]), []);
  assert.deepEqual(presentedFiles([...events.slice(0, -1), finish(2, 'error')]), []);
});

test('file-card-only replies reach callbacks and downloads without collecting intermediate files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-present-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'work'); await mkdir(workspace);
  const card = join(workspace, '卡片`100%.txt'), outside = join(root, 'private.txt');
  await writeFile(card, 'final card contents'); await writeFile(outside, 'outside');
  await writeFile(join(workspace, 'intermediate.txt'), 'tool intermediate');
  const result = '结果已作为文件卡片呈现。';
  const events = [{ type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '[intermediate](intermediate.txt)' }] } } },
    { type: 'deliverables/presented', data: { turn: 1, files: [card, card, outside, join(workspace, 'missing.txt')].map(path => ({ path })) } },
    assistant([{ type: 'text', text: result }]), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
  const host = {
    sessionPersistence: { stat: async () => undefined },
    permissionPresets: { set() {} },
    workspaceRegistry: { list: () => [{ id: 'workspace-1', path: workspace, attachSession: async () => {} }] },
    ...fileTestSessions(options => fileTestAgent({ id: options.sessionId, followup(message) { events.splice(1, 0, { type: 'user/message', data: message }); }, cancel() {}, whenIdle: async () => {},
      session: { snapshotEvents: () => events } })),
  };
  const library = new FileLibrary(); let callback;
  const f = await fixture({ run: makeRunner(host, library), files: library, overrides: { workspace_path: workspace },
    callback: async task => { callback = JSON.parse(task.callback_body); return null; } });
  t.after(() => f.engine.close());
  await f.engine.accept(request()); await f.cycle(); await f.cycle();
  const query = await f.engine.query('news', 'task-1', 'chat-1');
  assert.equal(query.status, 'completed'); assert.equal(query.delivery.status, 'delivered');
  assert.equal(query.result, result); assert.equal(query.files.length, 1);
  assert.deepEqual(callback, { metadata: request().metadata, result, files: query.files });
  const saved = await library.openDownload('news', f.projects.get('news'), query.files[0].file_id, new AbortController().signal);
  try {
    const bytes = Buffer.alloc(saved.file.size); await saved.handle.read(bytes, 0, bytes.length, 0);
    assert.equal(bytes.toString(), 'final card contents');
  } finally { await saved.handle.close(); }
});

test('runner returns untouched final text and deduplicates files; no injected business prompt or result tools', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-runner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'work'); await mkdir(workspace);
  const native = join(root, 'native.png'); await writeFile(native, 'native attachment bytes');
  const attachment = { type: 'image', attachment: { attachmentId: 'native', name: 'photo.png' } };
  await writeFile(join(workspace, 'out.txt'), 'result');
  const f = await fixture({ overrides: { workspace_path: workspace } }); await f.engine.accept(request());
  const record = f.record(); record.execution.attempt_id = 'attempt'; record.execution.session_id = 'session';
  let message;
  const result = ' 原文\n[out](out.txt)\n`out.txt` ';
  const host = {
    sessionPersistence: { stat: async () => undefined },
    permissionPresets: { set() {} },
    attachments: { imageHostPath: () => native },
    workspaceRegistry: { list: () => [{ id: 'workspace-1', path: workspace, attachSession: async () => {} }] },
    ...fileTestSessions(() => fileTestAgent({
      id: 'session', followup: m => { message = m; }, whenIdle: async () => {}, cancel() {},
      session: { snapshotEvents: () => [{ type: 'turn/start', data: {} }, { type: 'user/message', data: message }, assistant([{ type: 'text', text: '中间' }]),
        { type: 'deliverables/presented', data: { files: [{ path: join(workspace, 'out.txt') }] } },
        assistant([{ type: 'reasoning', text: '内部' }, { type: 'text', text: result }, attachment, attachment]), end('completed')] },
    })),
  };
  const library = new FileLibrary();
  const run = makeRunner(host, library);
  const actual = await run(record, new AbortController().signal, { created: false, ready: async () => {} });
  assert.equal(actual.result, result); assert.match(actual.files[0].filename, /^\d{10}_[a-zA-Z0-9]{6}\.txt$/); assert.match(actual.files[1].filename, /^\d{10}_[a-zA-Z0-9]{6}\.png$/);
  const saved = await library.openDownload('news', record.project, actual.files[1].file_id, new AbortController().signal);
  const buffer = Buffer.alloc(saved.file.size); await saved.handle.read(buffer, 0, buffer.length, 0); await saved.handle.close();
  assert.equal(buffer.toString(), 'native attachment bytes');
  assert.deepEqual(message.content, [{ type: 'text', text: record.request.instruction }]);
  assert.ok(host.agents.get('session'));
});

test('empty final text is valid; callback and query share the same fixed result', async () => {
  const f = await fixture({ run: async () => ({ result: '', files: [] }) }); await f.engine.accept(request()); await f.cycle();
  assert.equal(f.record().status, 'completed'); recordSchema.parse(f.record());
  assert.deepEqual(JSON.parse(f.record().callback_body), { metadata: request().metadata, result: '', files: [] });
  assert.equal((await f.engine.query('news', 'task-1', 'chat-1')).result, ''); assert.deepEqual((await f.engine.query('news', 'task-1', 'chat-1')).files, []);
});

test('shutdown discards late returned results; cleanup failure pauses scheduler', async () => {
  const gate = deferred(); const f = await fixture({ run: async () => { await gate.promise; return { result: 'late', files: [] }; } });
  await f.engine.accept(request()); f.engine.tick(); await until(() => f.record().status === 'running');
  const closing = f.engine.close(); gate.resolve(); await closing;
  assert.notEqual(f.record().status, 'completed'); assert.equal(f.record().callback_body, null);
  const g = await fixture({ run: async () => { throw new UnsettledExecutionError('cannot drain'); } });
  await g.engine.accept(request()); await g.cycle(); g.advance(120000); await g.cycle();
  assert.equal(g.engine.available, false); assert.equal(g.record().execution.attempts, 1);
});

test('concurrent tasks retain published result bytes after a later overwrite', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'bridge-snapshot-race-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const aSaved = deferred();
  const host = {
    sessionPersistence: { stat: async () => undefined },
    permissionPresets: { set() {} },
    workspaceRegistry: { list: () => [{ id: 'workspace-1', path: workspace, attachSession: async () => {} }] },
    ...fileTestSessions(options => {
      let task, input;
      return fileTestAgent({
        id: options.sessionId, followup: message => { input = message; task = message.content[0].text; }, cancel() {},
        async whenIdle() {
          if (task === 'B') await aSaved.promise;
          await writeFile(join(workspace, 'report.txt'), task);
        },
        session: { snapshotEvents: () => [{ type: 'turn/start', data: {} }, { type: 'user/message', data: input }, assistant([{ type: 'text', text: `${task}: [report](report.txt)` }]), end('completed')] },
      });
    }),
  };
  class Library extends FileLibrary {
    async publish(task, path, signal) {
      const file = await super.publish(task, path, signal);
      if (task.request.instruction === 'A') aSaved.resolve();
      return file;
    }
  }
  const library = new Library();
  const f = await fixture({ run: await makeRunner(host, library), files: library, overrides: { workspace_path: workspace, max_concurrency: 2 } });
  t.after(() => f.engine.close());
  for (const task of ['A', 'B']) await f.engine.accept({ ...request(task), instruction: task });
  await f.cycle(); await f.cycle(); await f.cycle();
  for (const task of ['A', 'B']) {
    const record = f.record(task); assert.equal(record.status, 'completed'); assert.equal(record.delivery.status, 'delivered');
    const callback = JSON.parse(record.callback_body);
    assert.equal(callback.result, `${task}: [report](report.txt)`);
    const saved = await library.openDownload('news', record.project, callback.files[0].file_id, new AbortController().signal);
    const buffer = Buffer.alloc(saved.file.size); await saved.handle.read(buffer, 0, buffer.length, 0); await saved.handle.close();
    assert.equal(buffer.toString(), task);
  }
});

test('literal paths are not URL-decoded and linked files are not recursively inspected', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'bridge-literal-path-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  for (const name of ['a%20b.md', 'a b.md', '100%.txt', 'nested.txt']) await writeFile(join(workspace, name), '[nested](nested.txt)');
  assert.deepEqual(await referencedPaths('`a%20b.md` `100%.txt`', workspace), [join(workspace, 'a%20b.md'), join(workspace, '100%.txt')]);
  assert.deepEqual(await referencedPaths('[encoded](a%20b.md)', workspace), [join(workspace, 'a b.md')]);
});
