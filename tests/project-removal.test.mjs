import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteFixture } from './sqlite-fixture.mjs';
import { createEditor } from '../client/model.mjs';
import { settingsForm } from '../client/transport.mjs';
import { beginExecution, completed, beginDelivery, deliveryFinished } from '../dist/domain/task.js';

test('UI removal rejects execution and pending delivery; successful removal survives reload with legacy config present',async t=>{
 const f=await sqliteFixture(t);assert.equal((await f.submit('active')).status,202);
 const form=settingsForm({remote:{termsBridge:{settings:async()=>({ok:true,value:f.remote.settings()}),mutate:async(...args)=>({ok:true,value:await f.remote.mutate(...args)})}}});t.after(()=>form.dispose());await form.refresh();
 const editor=createEditor(form);t.after(()=>editor.dispose());editor.remove(editor.getSnapshot().draft.rows[0].key);
 assert.equal(await editor.save(),false);assert.match(editor.getSnapshot().message,/未完成任务/);assert.ok(f.remote.settings().value.projects.news);
 const [key,task]=f.tasks()[0],running=beginExecution(task);
 let done=completed(running,running.execution.attempt_id,{result:'final',files:[]},Date.now());
 f.sql.prepare('UPDATE tasks SET value=? WHERE key=?').run(JSON.stringify(done),key);
 assert.equal(await editor.save(),false,'Pending callback still prevents removal');
 done=deliveryFinished(beginDelivery(done),null,Date.now());f.sql.prepare('UPDATE tasks SET value=? WHERE key=?').run(JSON.stringify(done),key);
 assert.equal(await editor.save(),true);assert.deepEqual(f.remote.settings().value.projects,{});
 await f.stop();await f.start();assert.deepEqual(f.remote.settings().value.projects,{});assert.equal(f.tasks()[0][1].result,'final');assert.equal(f.legacyOpens,0);
});
