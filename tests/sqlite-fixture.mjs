import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BridgeDatabase } from '../dist/storage/database.js';
import { apply } from '../dist/index.js';
import { parseConfig } from '../dist/projects/config.js';
import { listenHttp, request } from './helpers.mjs';

export async function sqliteFixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'terms-sqlite-')), workspace = join(dir, 'workspace'); await mkdir(workspace);
  const config = parseConfig(options.config ?? { projects: { news: { provider: 'test', model: 'original', workspace_path: workspace, max_concurrency: 1, callback_url: 'http://localhost/original' } } });
  const f = { dir, workspace, config, routes: new Map(), legacyOpens: 0, registrations: 0 }, disposers = [], workspaces = new Map();
  f.stop = async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); };
  const unexpected = () => assert.fail('This fixture must not execute a model');
  const server = createServer((req, res) => {
    const route = [...f.routes.values()].filter(route => req.url.startsWith(route.path + '/')).sort((a,b) => b.path.length-a.path.length)[0];
    if (route) void route.handler(req,res); else { res.writeHead(404); res.end(); }
  });
  const host = f.host = {
    profileContext: { dir }, settings: { writable: true },
    workspaceRegistry: { list: () => [...workspaces.values()], create: async path => {
      f.registrations++; await f.preparing?.(path);
      if (!workspaces.has(path)) workspaces.set(path, { id: String(workspaces.size+1), path, attachSession: unexpected });
      return workspaces.get(path);
    } },
    storageDomain: { open: async () => { f.legacyOpens++; assert.fail('Legacy storage must not be opened'); } },
    agents: { get: () => ({ status: 'running' }) }, sessionPersistence: { stat: async () => ({}) },
    permissionPresets: { set: unexpected }, sessionProjections: { stateOf: unexpected },
    sessionController: { create: unexpected, resolveAgent: unexpected, agents: { selectionFor: unexpected, selectForNextRequest: unexpected } },
    attachments: { saveImage: unexpected, saveFileStream: unexpected, fileHostPath: unexpected, imageHostPath: unexpected },
    webServer: { register: route => {
      if (route.path === f.conflict || f.routes.has(route.path)) throw new Error('route conflict');
      f.routes.set(route.path, route); return () => f.routes.delete(route.path);
    } },
    typert: { register: () => () => {} }, provide: (_name, service) => { f.remote = service; return () => {}; },
    effect: callback => { disposers.push(callback()); },
  };
  f.start = () => apply(host, f.config);
  t.after(async () => {
    await f.stop(); f.sql?.close(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    const child=relative(tmpdir(),dir);assert(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(dir,{recursive:true,force:true});
  });
  const seed = new BridgeDatabase(join(dir, 'data', 'terms-bridge.sqlite'));
  try {
    seed.writeSettings(config, 1);
    f.tables = { projects: seed.bindings, tasks: seed.tasks, conversations: seed.mappings };
    await options.prepare?.(f);
    if (!options.empty) {
      const initial = structuredClone(f.config);
      for (const project of Object.values(initial.projects)) project.created_at ??= new Date().toISOString();
      seed.writeSettings(initial, 1);
    } else seed.writeSettings(parseConfig({}), 1);
  } finally { seed.close(); }
  await f.start(); await listenHttp(server);
  f.sql = new DatabaseSync(join(dir, 'data', 'terms-bridge.sqlite'));
  f.origin = 'http://127.0.0.1:' + server.address().port;
  f.submit = async (id, prefix='/api/terms-bridge', project='news') => {
    const response=await fetch(f.origin+prefix+'/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request(id,project))});
    return {status:response.status,body:await response.json()};
  };
  f.tasks = () => f.sql.prepare('SELECT key,value FROM tasks').all().map(row => [row.key,JSON.parse(row.value)]);
  f.save = ops => f.remote.mutate(ops,f.remote.settings().revision);
  f.add = async id => { const path=join(dir,id);await mkdir(path,{recursive:true});return f.save([{op:'set',path:['projects',id],value:{provider:'test',model:'added',workspace_path:path,callback_url:'http://localhost/added'}}]); };
  return f;
}
