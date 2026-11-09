import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sqliteFixture } from './sqlite-fixture.mjs';
import { createEditor } from '../client/model.mjs';
import { settingsForm } from '../client/transport.mjs';

test('UI edits SQLite configuration, preserves redacted tokens and unrelated profile data across reload',async t=>{
 const f=await sqliteFixture(t,{prepare:async f=>{f.config.projects.news.request_token='original-secret';await writeFile(join(f.dir,'cordis.patch.yml'),'legacy profile fixture');}});
 const form=settingsForm({remote:{termsBridge:{settings:async()=>({ok:true,value:f.remote.settings()}),mutate:async(...args)=>({ok:true,value:await f.remote.mutate(...args)})}}});t.after(()=>form.dispose());await form.refresh();
 const editor=createEditor(form);editor.setDefaultPreset('standard');t.after(()=>editor.dispose());const row=()=>editor.getSnapshot().draft.rows[0];
 assert.equal(row().tokenSet,true);assert.equal(row().request_token,'');editor.project(row().key,'max_concurrency',4);assert.equal(await editor.save(),true,editor.getSnapshot().message);
 assert.equal(JSON.parse(f.sql.prepare('SELECT config FROM projects WHERE key=?').get('news').config).request_token,'original-secret');
 editor.project(row().key,'request_token','replacement');assert.equal(await editor.save(),true);
 assert.equal(JSON.parse(f.sql.prepare('SELECT config FROM projects WHERE key=?').get('news').config).request_token,'replacement');
 editor.project(row().key,'request_token','');assert.equal(await editor.save(),true);
 assert.equal(JSON.parse(f.sql.prepare('SELECT config FROM projects WHERE key=?').get('news').config).request_token,undefined);
 const before=f.remote.settings();assert.equal((await f.remote.mutate([],before.revision-1)).error.code,'REVISION_CONFLICT');
 f.host.settings.writable=false;assert.equal((await f.save([])).error.code,'READ_ONLY');f.host.settings.writable=true;
 await f.stop();f.config={invalid:'legacy config must never be reread'};await f.start();assert.equal(f.remote.settings().value.projects.news.max_concurrency,4);
 assert.equal(await readFile(join(f.dir,'cordis.patch.yml'),'utf8'),'legacy profile fixture');
});
