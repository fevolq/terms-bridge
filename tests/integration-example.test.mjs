import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { prepareOutputDirectory, prepareTaskFiles } from '../dist/storage/task-files.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture, listenHttp } from './helpers.mjs';
import { handler } from '../dist/http/api.js';
import { sendCallback } from '../dist/http/callback.js';
import { validateRequest } from '../dist/domain/request.js';

const exec = promisify(execFile);
const python = process.env.PYTHON ?? 'python';
const pythonAvailable = spawnSync(python, ['--version'], { windowsHide: true }).status === 0;
const example = fileURLToPath(new URL('../examples/project_client.py', import.meta.url));
const taskPath = fileURLToPath(new URL('../examples/task.json', import.meta.url));
const callbackPath = fileURLToPath(new URL('../examples/callback.json', import.meta.url));

test('documented task examples use the current protocol and callback shape', async () => {
  for (const path of [taskPath, fileURLToPath(new URL('../examples/result-file-task.json', import.meta.url))]) validateRequest(JSON.parse(await readFile(path, 'utf8')));
  const callback = JSON.parse(await readFile(callbackPath, 'utf8'));
  assert.equal(typeof callback.result, 'string'); assert.deepEqual(callback.files, []);
  const protocol = await readFile(new URL('../docs/usage.md', import.meta.url), 'utf8');
  const blocks = [...protocol.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(match => JSON.parse(match[1]));
  validateRequest(blocks[0]); assert.equal(typeof blocks[1].result, 'string'); assert.equal(blocks[1].files.length, 1);
});

test('documented Python client and durable callback receiver interoperate with real bridge HTTP', { skip: !pythonAvailable, timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-integration-example-'));
  const database = join(directory, 'results.sqlite3');
  const callback = JSON.parse(await readFile(callbackPath, 'utf8'));
  const children = [];
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
  t.after(async () => { for (const child of children) await stop(child); });
  async function startReceiver() {
    const child = spawn(python, [example, 'serve', '--port', '0', '--db', database], {
      env: { ...process.env, DSH_CALLBACK_HEADERS: JSON.stringify({ Authorization: 'Bearer example-callback-token', 'X-Project': 'news' }) }, windowsHide: true,
    });
    children.push(child);
    const url = await new Promise((resolve, reject) => {
      let output = ''; let errors = '';
      const timer = setTimeout(() => reject(new Error('Receiver did not start: ' + errors)), 10000);
      child.stderr.on('data', data => { errors += data; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); reject(new Error('Receiver exited: ' + code + ' ' + errors)); });
      child.stdout.on('data', data => {
        output += data;
        const match = output.match(/Callback receiver: (http:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    return { child, url };
  }
  let receiver = await startReceiver(); let executions = 0;
  const f = await fixture({
    overrides: { workspace_path: directory, callback_url: receiver.url, request_token: 'example-request-token', callback_headers: { Authorization: 'Bearer example-callback-token', 'X-Project': 'news' } },
    callback: sendCallback,
    run: async (record, signal) => {
      executions++;
      let result = callback.result; const paths = [];
      if (record.files?.length) {
        const files = await prepareTaskFiles(record, signal);
        assert.match(await readFile(files[0].path, 'utf8'), /项目文件接入测试/);
        result = '文件读取完成';
      }
      if (record.request.metadata.task_id === 'files-001') {
        const root = await prepareOutputDirectory(record); await writeFile(join(root, '报告.md'), '# 文件报告\n测试完成。');
        paths.push(join(root, '报告.md')); result = '报告已生成';
      }
      return { result, files: await Promise.all(paths.map(path => f.files.publish(record, path, signal))) };
    },
  });
  t.after(() => f.engine.close());
  const server = createServer(handler(f.engine, '/api/terms-bridge', f.transfer));
  await listenHttp(server);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = { ...process.env, DSH_API_BASE: `http://127.0.0.1:${server.address().port}/api/terms-bridge`, DSH_REQUEST_TOKEN: 'example-request-token', PYTHONIOENCODING: 'utf-8' };
  const client = (...args) => exec(python, [example, ...args], { env, windowsHide: true });
  assert.match((await client('submit', taskPath)).stdout, /HTTP 202/);
  assert.match((await client('submit', taskPath)).stdout, /"duplicate": true/);
  await f.cycle(); await f.cycle();
  const query = (await client('query', 'news', 'task-001')).stdout;
  assert.match(query, /"status": "completed"/); assert.match(query, /"status": "delivered"/);
  assert.equal(executions, 1);

  const post = (body = callback, token = 'example-callback-token') => fetch(receiver.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Protocol-Version': '2', 'X-Project': 'news', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  assert.equal((await post(callback, 'wrong')).status, 401);
  assert.equal((await post({ ...callback, metadata: { ...callback.metadata, project_id: 'another-project' } })).status, 403);
  assert.equal((await post({ ...callback, result: 'different' })).status, 409);
  assert.deepEqual(await Promise.all([post(), post(), post()].map(async response => (await response).status)), [204, 204, 204]);
  await stop(receiver.child); receiver = await startReceiver();
  assert.equal((await post()).status, 204);
  const inspect = await exec(python, ['-c', 'import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); rows=db.execute("SELECT payload_json FROM received_results").fetchall(); print(json.dumps(rows)); db.close()', database], { windowsHide: true });
  const stored = JSON.parse(inspect.stdout);
  assert.equal(stored.length, 1); assert.deepEqual(JSON.parse(stored[0][0]), callback);
  const uploader = fileURLToPath(new URL('../examples/upload_and_submit.py', import.meta.url));
  f.projects.get('news').callback_url = receiver.url;
  const attachment = fileURLToPath(new URL('../examples/attachment.txt', import.meta.url));
  const savedTask = join(directory, 'file-task.json');
  const uploaded = await exec(python, [uploader, 'news', 'python-files', attachment, '--instruction', '阅读附件并总结。', '--out', savedTask], { env, windowsHide: true });
  assert.match(uploaded.stdout, /HTTP 202/);
  await f.cycle(); await f.cycle();
  assert.match((await client('query', 'news', 'python-files')).stdout, /"status": "delivered"/);
  assert.match((await client('submit', savedTask)).stdout, /"duplicate": true/);
  assert.equal(executions, 2);
  const inspectFiles = await exec(python, ['-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute("SELECT payload_json FROM received_results WHERE task_id=?", ("python-files",)).fetchone()[0]); db.close()', database], { env, windowsHide: true });
  assert.deepEqual(JSON.parse(inspectFiles.stdout).result, '文件读取完成');
  const resultTaskPath = fileURLToPath(new URL('../examples/result-file-task.json', import.meta.url));
  assert.match((await client('submit', resultTaskPath)).stdout, /HTTP 202/);
  await f.cycle(); await f.cycle();
  const resultQuery = (await client('query', 'news', 'files-001')).stdout;
  const downloadedTask = JSON.parse(resultQuery.slice(resultQuery.indexOf('{')));
  assert.equal(downloadedTask.delivery.status, 'delivered');
  const resultFile = downloadedTask.files[0];
  const downloader = fileURLToPath(new URL('../examples/download_result.py', import.meta.url));
  const output = join(directory, 'downloaded.md');
  const downloaded = await exec(python, [downloader, 'news', resultFile.file_id, '--out', output, '--sha256', resultFile.sha256], { env, windowsHide: true });
  assert.equal(JSON.parse(downloaded.stdout).sha256, resultFile.sha256);
  assert.equal(await readFile(output, 'utf8'), '# 文件报告\n测试完成。');
  await assert.rejects(exec(python, [downloader, 'news', resultFile.file_id, '--out', output], { env, windowsHide: true }));
  assert.equal(await readFile(output, 'utf8'), '# 文件报告\n测试完成。');
});
