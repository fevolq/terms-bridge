import { FileLibrary } from '../dist/storage/files.js';
import { FileTransfer } from '../dist/http/files.js';
import { TaskStore } from '../dist/storage/tasks.js';
import { TaskEngine } from '../dist/services/tasks.js';
import { parseConfig } from '../dist/projects/config.js';
import { taskKey } from '../dist/domain/request.js';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

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
      if (!this.records.has(key)) throw new Error(`missing record: ${key}`);
      const result = fn(this.get(key)); await this.put(key, result); return structuredClone(result);
    });
    this.chain = work; return work;
  }
}
export function request(id = 'task-1', project = 'news', chat = 'chat-1') {
  return { metadata: { project_id: project, conversation_id: id, chat_id: chat }, instruction: 'Summarize input.', files: [] };
}
export function conversation() {
  return { project_id: 'news', conversation_id: 'task-1', session_id: randomUUID(), workspace_path: process.cwd(), created: false, deleted: false };
}
export function project(overrides = {}) {
  const p = parseConfig({ projects: { news: {
    workspace_path: process.cwd(), provider: 'test', model: 'test-model', max_concurrency: 2,
    callback_url: 'http://localhost/callback', request_token: 'test-request-token', ...overrides,
  } } }).projects.news;
  return p;
}
export async function fixture({ run = async () => {}, callback = async () => null, overrides = {}, table = new MemoryTable(), conversationTable = new MemoryTable(), files = new FileLibrary(), sessionExists, sessionBusy, transferOptions } = {}) {
  let time = Date.parse('2026-10-30T00:00:00Z');
  const projects = new Map([['news', project(overrides)]]);
  const store = new TaskStore(table, conversationTable);
  const engine = new TaskEngine(store, projects, run, { callback, now: () => time, files, sessionExists, sessionBusy });
  await engine.recover();
  return { engine, store, table, conversationTable, projects, files, transfer: new FileTransfer(files, transferOptions), advance: ms => { time += ms; },
    record: (id = 'task-1', chat = 'chat-1') => store.get(taskKey('news', id, chat)),
    cycle: async () => { engine.tick(); await engine.settle(); } };
}
export async function successRun() { return { result: 'done', files: [] }; }
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
export async function until(test) {
  for (let i = 0; i < 200; i++) { if (await test()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('condition did not become true');
}

// Minimal native event order for file-adapter tests; real driver boundaries are tested separately.
export function fileTestAgent(implementation) {
  const listeners = new Map(); let activity = Promise.resolve();
  const emit = (name, ...args) => { for (const listener of listeners.get(name) ?? []) listener(...args); };
  const agent = { ...implementation, status: 'idle', inbox: { nextTurn: [], hasPending: false, remove: () => false },
    ctx: { tools: { get() {} }, on(name, listener) {
      const group = listeners.get(name) ?? new Set(); listeners.set(name, group); group.add(listener);
      return () => group.delete(listener);
    } },
    followup(message) {
      implementation.followup(message); agent.status = 'running';
      emit('agent/inbox/claimed', { agent, message, turn: 1 });
      activity = Promise.resolve().then(() => implementation.whenIdle()).then(() => {
        emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
        agent.status = 'idle';
      });
    }, whenIdle: () => activity,
  };
  return agent;
}

export function fileTestSessions(create) {
  const agents = new Map();
  return {
    agents: { get: id => agents.get(id) },
    sessionProjections: { stateOf: () => ({ pending: null }) },
    sessionController: {
      async create(options) { agents.set(options.sessionId, await create(options)); return { sessionId: options.sessionId }; },
      async resolveAgent(id) { return { agent: agents.get(id) }; },
      agents: { selectionFor: () => ({ current: { provider: 'test', model: 'test-model' } }), selectForNextRequest() {} },
    },
  };
}
