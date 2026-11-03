import { FileLibrary } from '../dist/storage/files.js';
import { FileTransfer } from '../dist/http/files.js';
import { TaskStore } from '../dist/storage/tasks.js';
import { TaskEngine } from '../dist/services/tasks.js';
import { parseConfig } from '../dist/projects/config.js';
import { taskKey } from '../dist/domain/request.js';
import { once } from 'node:events';

// Windows can allocate an ephemeral port that fetch refuses under the Fetch bad-port list.
export async function listenHttp(server) {
  const blocked = new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);
  for (;;) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    if (!blocked.has(server.address().port)) return;
    await new Promise(resolve => server.close(resolve));
  }
}

export class MemoryTable {
  records = new Map(); chain = Promise.resolve(); failWrites = false;
  get(key) { return structuredClone(this.records.get(key)); }
  *entries() { yield* structuredClone([...this.records]); }
  async put(key, value) { if (this.failWrites) throw new Error('disk unavailable'); this.records.set(key, structuredClone(value)); }
  update(key, fn) {
    const work = this.chain.catch(() => {}).then(async () => {
      const result = fn(this.get(key)); await this.put(key, result); return structuredClone(result);
    });
    this.chain = work; return work;
  }
}
export function request(id = 'task-1', project = 'news') {
  return { metadata: { project_id: project, task_id: id }, instruction: 'Summarize input.', files: [] };
}
export function project(overrides = {}) {
  const p = parseConfig({ projects: { news: {
    workspace_path: process.cwd(), provider: 'test', model: 'test-model', max_concurrency: 2,
    callback_url: 'http://localhost/callback', request_token: 'test-request-token', ...overrides,
  } } }).projects.news;
  return { ...p, workspace_id: 'workspace-1' };
}
export async function fixture({ run = async () => {}, callback = async () => null, overrides = {}, table = new MemoryTable(), files = new FileLibrary(), sessionExists, transferOptions } = {}) {
  let time = Date.parse('2026-10-30T00:00:00Z');
  const projects = new Map([['news', project(overrides)]]);
  const store = new TaskStore(table);
  const engine = new TaskEngine(store, projects, run, { callback, now: () => time, files, sessionExists });
  await engine.recover();
  return { engine, store, table, projects, files, transfer: new FileTransfer(files, transferOptions), advance: ms => { time += ms; },
    record: (id = 'task-1') => store.get(taskKey('news', id)),
    cycle: async () => { engine.tick(); await engine.settle(); } };
}
export async function successRun() { return { result: 'done', files: [] }; }
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
export async function until(test) {
  for (let i = 0; i < 200; i++) { if (await test()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('condition did not become true');
}
