import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile, mkdtemp, rm, readdir, mkdir } from 'node:fs/promises';
import { join,relative,isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { BridgeDatabase } from '../dist/storage/database.js';
import { FileLibrary } from '../dist/storage/files.js';
import { TaskStore } from '../dist/storage/tasks.js';
import { TaskEngine } from '../dist/services/tasks.js';
import { active } from '../dist/domain/task.js';
import { parseConfig } from '../dist/projects/config.js';
import { taskKey,conversationKey } from '../dist/domain/request.js';
import { queued,beginExecution,completed,beginDelivery,deliveryFinished, executionFailed } from '../dist/domain/task.js';
import { sqliteFixture } from './sqlite-fixture.mjs';
import { request,conversation,fixture,deferred,until,successRun,temporaryDatabase } from './helpers.mjs';

async function temporary(t,close=()=>{}){const path=await mkdtemp(join(tmpdir(),'bridge-database-'));t.after(async()=>{close();const child=relative(tmpdir(),path);assert(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(path,{recursive:true,force:true});});return path;}

test('fresh SQLite ignores old profile options, storage and existing workspace files',async t=>{
 const fileId='file_'+'a'.repeat(32);
 const f=await sqliteFixture(t,{empty:true,prepare:async f=>{
  const folder=join(f.workspace,'.terms-bridge','files',fileId);await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'metadata.json'),'unrelated old metadata');
  await writeFile(join(f.workspace,'existing.txt'),'keep existing file');
  f.config={get projects(){assert.fail('Profile configuration must not be read');}};
 }});
 const view=f.remote.settings();assert.deepEqual(view.value,parseConfig({}));assert.equal(view.revision,1);assert.equal(f.legacyOpens,0);
 assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM files').get().n,0);
 const added=await f.save([{op:'set',path:['projects','news'],value:{provider:'test',model:'test',workspace_path:f.workspace,callback_url:'http://localhost/result'}}]);
 assert.equal(added.accepted,true,added.error?.message);
 assert.equal(await readFile(join(f.workspace,'existing.txt'),'utf8'),'keep existing file');
 assert.equal(await readFile(join(f.workspace,'.terms-bridge','files',fileId,'metadata.json'),'utf8'),'unrelated old metadata');
 await f.stop();await f.start();assert.equal(f.remote.settings().value.projects.news.model,'test');assert.equal(f.legacyOpens,0);
});

test('SQLite settings survive reload and ignore stale profile options',async t=>{
 const f=await sqliteFixture(t);
 assert.equal((await f.save([{op:'set',path:['projects','news','model'],value:'database-model'}])).accepted,true);
 await f.stop();f.config={projects:'invalid old configuration'};await f.start();
 assert.equal(f.remote.settings().value.projects.news.model,'database-model');assert.equal(f.legacyOpens,0);
});

test('atomic task admission rolls back new mapping when task persistence fails',async t=>{
 const f=await sqliteFixture(t);f.sql.exec("CREATE TRIGGER reject_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'task write rejected'); END");
 assert.equal((await f.submit('retry')).status,503);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM session_mappings').get().n,0);
 f.sql.exec('DROP TRIGGER reject_task');assert.equal((await f.submit('retry')).status,202);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM session_mappings').get().n,1);
 assert.equal((await f.submit('retry')).status,409);
});

test('new upload metadata resides in SQLite; metadata failure does not publish a file',async t=>{
 const f=await sqliteFixture(t);
 const upload=async()=>{const body=new FormData();body.append('file',new Blob(['database bytes']),'input.txt');return fetch(f.origin+'/api/terms-bridge/projects/news/files',{method:'POST',body});};
 const response=await upload();assert.equal(response.status,201);const file=await response.json();assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM files').get().n,1);
 await assert.rejects(stat(join(f.workspace,'.terms-bridge','files',file.file_id,'metadata.json')),{code:'ENOENT'});
 assert.equal(await (await fetch(f.origin+'/api/terms-bridge/projects/news/files/'+file.file_id)).text(),'database bytes');
 f.sql.exec("CREATE TRIGGER reject_file BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT,'file write rejected'); END");
 assert.equal((await upload()).status,503);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM files').get().n,1);
 assert.deepEqual(await readdir(join(f.workspace,'.terms-bridge','files')),[file.file_id]);
 await f.stop();await f.start();assert.equal(await (await fetch(f.origin+'/api/terms-bridge/projects/news/files/'+file.file_id)).text(),'database bytes');
});

test('profile databases are isolated and future database versions fail without resetting data',async t=>{
 const a=await sqliteFixture(t),b=await sqliteFixture(t);
 assert.equal((await a.save([{op:'set',path:['projects','news','model'],value:'only-a'}])).accepted,true);assert.equal(b.remote.settings().value.projects.news.model,'original');
 await a.stop();a.sql.exec('PRAGMA user_version=999');await assert.rejects(a.start(),/newer version/);
 assert.equal(JSON.parse(a.sql.prepare('SELECT config FROM projects').get().config).model,'only-a');
});

test('SQLite restart preserves interrupted execution and callback budgets without allocating new sessions',async t=>{
 const sessions={};const f=await sqliteFixture(t,{prepare:async f=>{
  const project=f.config.projects.news;await f.tables.projects.put('current',{news:{workspace_path:f.workspace}});
  for(const id of ['running','delivering']){
   const input=request(id),mapping={...conversation(),conversation_id:id,workspace_path:f.workspace};sessions[id]=mapping.session_id;
   let task=beginExecution(queued(input,project,[],Date.now(),mapping));
   if(id==='delivering')task=beginDelivery(completed(task,task.execution.attempt_id,{result:'persisted response',files:[]},Date.now()));
   await f.tables.conversations.put(conversationKey('news',id),mapping);await f.tables.tasks.put(taskKey('news',id,'chat-1'),task);
  }
 }});
 const records=()=>Object.fromEntries(f.tasks().map(([,task])=>[task.request.metadata.conversation_id,task]));let tasks=records();
 assert.equal(tasks.running.status,'retrying');assert.equal(tasks.running.execution.attempts,1);assert.equal(tasks.running.execution.last_error,'EXECUTION_INTERRUPTED');
 assert.equal(tasks.delivering.delivery.status,'retrying');assert.equal(tasks.delivering.delivery.attempts,1);assert.equal(tasks.delivering.result,'persisted response');
 await f.stop();await f.start();tasks=records();
 for(const id of Object.keys(sessions))assert.equal(tasks[id].execution.session_id,sessions[id]);
 assert.equal(tasks.running.execution.attempts,1);assert.equal(tasks.delivering.delivery.attempts,1);assert.equal(f.legacyOpens,0);
});

test('a corrupt database is reported without overwriting it or falling back to legacy data',async t=>{
 const dir=await temporary(t),path=join(dir,'corrupt.sqlite');await writeFile(path,'not a sqlite database');
 assert.throws(()=>new BridgeDatabase(path),/database|file/i);assert.equal(await readFile(path,'utf8'),'not a sqlite database');
});


test('indexed pending queries follow execution and callback transitions and conversation scope',async t=>{
 let db;const dir=await temporary(t,()=>db?.close());db=new BridgeDatabase(join(dir,'bridge.sqlite'));
 const project=parseConfig({projects:{news:{provider:'test',model:'test',workspace_path:dir,callback_url:'http://localhost/result'}}}).projects.news;
 const store=new TaskStore(db),now=Date.now(),expected=new Set();
 for(const state of ['queued','running','retrying','failed','pending','callback-retrying','in-flight','delivered','callback-failed']){
  const input=request(state),mapping={...conversation(),conversation_id:state,workspace_path:dir};
  db.mappings.putSync(conversationKey('news',state),mapping);
  const key=taskKey('news',state,'chat-1');let task=queued(input,{...project,max_execution_retries:state==='failed'?0:3},[],now,mapping);
  if(state!=='queued')task=beginExecution(task);
  if(['retrying','failed'].includes(state))task=executionFailed(task,task.execution.attempt_id,'failed',now);
  if(['pending','callback-retrying','in-flight','delivered','callback-failed'].includes(state)){
   task=completed(task,task.execution.attempt_id,{result:'saved result',files:[]},now);
   if(state!=='pending')task=beginDelivery(task);
   if(state==='delivered')task=deliveryFinished(task,null,now);
   if(state==='callback-retrying')task=deliveryFinished(task,'HTTP 503',now);
   if(state==='callback-failed'){task.delivery.attempts=11;task=deliveryFinished(task,'HTTP 503',now);}
  }
  db.tasks.putSync(key,task);if(active(task))expected.add(key);
  assert.equal(store.busy(input.metadata),['queued','running','retrying'].includes(state));
  assert.equal(store.busy({...input.metadata,project_id:'other'}),false);
 }
 assert.deepEqual(new Set(store.pending().map(([key])=>key)),expected);
 const queuedKey=taskKey('news','queued','chat-1');let task=beginExecution(store.get(queuedKey));
 task=deliveryFinished(beginDelivery(completed(task,task.execution.attempt_id,{result:'done',files:[]},now)),null,now);
 db.tasks.putSync(queuedKey,task);expected.delete(queuedKey);
 assert.deepEqual(new Set(store.pending().map(([key])=>key)),expected);
 await store.conversations.mark(request('running').metadata,'deleted');assert.equal(store.busy(request('running').metadata),false);
 expected.delete(taskKey('news','running','chat-1'));assert.deepEqual(new Set(store.pending().map(([key])=>key)),expected);
});

test('idle scheduling, admission checks and settings changes do not load terminal task history',async t=>{
 let db;const dir=await temporary(t,()=>db?.close());db=new BridgeDatabase(join(dir,'bridge.sqlite'));
 const project=parseConfig({projects:{news:{provider:'test',model:'test',workspace_path:dir,callback_url:'http://localhost/result'}}}).projects.news;
 db.transaction(()=>{
  for(let i=0;i<50;i++){
   const input=request('history-'+i),mapping={...conversation(),conversation_id:input.metadata.conversation_id,workspace_path:dir};
   db.mappings.putSync(conversationKey('news',mapping.conversation_id),mapping);
   let task=beginExecution(queued(input,project,[],Date.now(),mapping));
   task=deliveryFinished(beginDelivery(completed(task,task.execution.attempt_id,{result:'a'.repeat(32*1024),files:[]},Date.now())),null,Date.now());
   db.tasks.putSync(taskKey('news',mapping.conversation_id,'chat-1'),task);
  }
 });
 const store=new TaskStore(db),projects=new Map([['news',project]]);
 const unexpected=()=>assert.fail('No execution or callback expected');
 const engine=new TaskEngine(store,projects,unexpected,{files:new FileLibrary(db),callback:unexpected});t.after(()=>engine.close());
 await engine.recover();
 db.tasks.entries=()=>assert.fail('Must not enumerate all task history');
 const queries=[],prepare=db.sql.prepare.bind(db.sql);
 db.sql.prepare=sql=>{if(sql.startsWith('SELECT key,value FROM tasks INDEXED BY tasks_pending WHERE '))queries.push(sql);return prepare(sql);};
 assert.deepEqual(store.pending(),[]);engine.tick();await engine.settle();
 assert.equal(store.busy(request('history-0').metadata),false);await engine.reconfigure(new Map(projects));
 assert.ok(queries.length>0);
 for(const sql of queries){
  const plan=prepare('EXPLAIN QUERY PLAN '+sql).all().map(row=>row.detail).join('\n');
  assert.match(plan,/USING INDEX tasks_pending/);assert.match(plan,/USING INDEX mapping_deleted/);
 }
 assert.equal(store.get(taskKey('news','history-0','chat-1')).result.length,32*1024);
});


test('recovery excludes deleted-session tasks before loading their bodies without rewriting history',async t=>{
 let db;const dir=await temporary(t,()=>db?.close());db=new BridgeDatabase(join(dir,'bridge.sqlite'));
 const project=parseConfig({projects:{news:{provider:'test',model:'test',workspace_path:dir,callback_url:'http://localhost/result'}}}).projects.news;
 db.transaction(()=>{
  for(let i=0;i<50;i++){
   const input=request('deleted-'+i),mapping={...conversation(),created:true,conversation_id:input.metadata.conversation_id,workspace_path:dir};
   db.mappings.putSync(conversationKey('news',mapping.conversation_id),mapping);
   let task=beginExecution(queued(input,project,[],Date.now(),mapping));
   task=completed(task,task.execution.attempt_id,{result:'deleted-history-body-'.repeat(1600),files:[]},Date.now());
   db.tasks.putSync(taskKey('news',mapping.conversation_id,'chat-1'),task);
  }
 });
 const original=db.sql.prepare('SELECT key,value FROM tasks ORDER BY key').all();
 const store=new TaskStore(db),unexpected=()=>assert.fail('Deleted sessions must not execute or deliver');
 let checks=0;const engine=new TaskEngine(store,new Map([['news',project]]),unexpected,{files:new FileLibrary(db),callback:unexpected,sessionExists:async()=>{checks++;return false;}});t.after(()=>engine.close());
 await engine.recover();assert.equal(checks,50);assert.deepEqual(store.pending(),[]);
 assert.deepEqual(db.sql.prepare('SELECT key,value FROM tasks ORDER BY key').all(),original);
 db.tasks.entries=()=>assert.fail('Must not scan task history');
 const parse=JSON.parse;t.mock.method(JSON,'parse',text=>{assert.ok(!text.includes('deleted-history-body-'),'Must not decode deleted task bodies');return parse(text);});
 engine.tick();await engine.settle();await engine.reconfigure(new Map());assert.deepEqual(store.pending(),[]);
 assert.equal(store.busy(request('deleted-0').metadata),false);
 const restored=new TaskStore(db);assert.deepEqual(restored.pending(),[]);
});

test('a deleted running session holds its project slot until execution teardown finishes',async t=>{
 let db;const dir=await temporary(t,()=>db?.close());db=new BridgeDatabase(join(dir,'bridge.sqlite'));
 const release=deferred(),started=[];let deleted;
 const f=await fixture({database:db,overrides:{max_concurrency:1},sessionExists:async id=>id!==deleted,
  run:async(task,_signal,session)=>{await session.ready();const id=task.request.metadata.conversation_id;started.push(id);if(id==='first')await release.promise;return successRun();}});
 t.after(async()=>{release.resolve();await f.engine.close();});
 await f.engine.accept(request('first'));await f.engine.accept(request('second'));f.engine.tick();await until(()=>started.length===1);
 deleted=f.record('first').execution.session_id;
 await assert.rejects(f.engine.query('news','first','chat-1'),error=>error.code==='SESSION_NOT_FOUND');
 assert.deepEqual(f.store.pending().map(([,task])=>task.request.metadata.conversation_id),['second']);
 f.engine.tick();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['first']);
 release.resolve();await f.engine.settle();await f.cycle();assert.deepEqual(started,['first','second']);
});

for (const [source, query] of [
  ['pending tasks', 'SELECT key,value FROM tasks'],
  ['conversation mapping', 'SELECT value FROM session_mappings'],
]) test('scheduler pauses safely when reading ' + source + ' fails', async t => {
  const database = temporaryDatabase();
  const project = parseConfig({ projects: { news: {
    provider: 'test', model: 'test', workspace_path: tmpdir(), callback_url: 'http://localhost/result',
  } } }).projects.news;
  const store = new TaskStore(database), logs = [];
  let executions = 0, callbacks = 0, poll;
  t.mock.method(globalThis, 'setInterval', callback => { poll = callback; return { unref() {} }; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const engine = new TaskEngine(store, new Map([['news', project]]), async () => {
    executions++; return successRun();
  }, {
    files: new FileLibrary(database), callback: async () => { callbacks++; return null; },
    log: message => logs.push(message),
  });
  t.after(() => engine.close());
  await engine.recover(); engine.start();
  await engine.accept(request());
  const key = taskKey('news', 'task-1', 'chat-1'), before = store.get(key);
  const prepare = database.sql.prepare.bind(database.sql);
  let failures = 0;
  t.mock.method(database.sql, 'prepare', sql => {
    if (sql.startsWith(query)) {
      failures++;
      throw Object.assign(new Error('Injected database read failure'), { code: 'SQLITE_IOERR' });
    }
    return prepare(sql);
  });
  assert.doesNotThrow(() => poll(), 'Storage errors must not escape the timer callback');
  assert.equal(failures, 1); assert.equal(engine.available, false);
  assert.equal(logs.length, 1); assert.match(logs[0], /scheduling paused until reload/);
  await engine.settle();
  assert.equal(executions, 0); assert.equal(callbacks, 0); assert.deepEqual(store.get(key), before);
  await assert.rejects(engine.accept(request('another')), error => error.status === 503 && error.code === 'SERVICE_UNAVAILABLE');
  poll(); poll(); engine.tick();
  assert.equal(failures, 1, 'Paused scheduling must not keep querying the failed storage');
  assert.equal(logs.length, 1);
});
