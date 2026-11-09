import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sqliteFixture } from './sqlite-fixture.mjs';
import { deferred, until } from './helpers.mjs';

for (const changeRoute of [false,true]) test('SQLite commit failure preserves runtime, bindings and routes; route changes='+changeRoute,async t=>{
 const f=await sqliteFixture(t);assert.equal((await f.submit('before')).status,202);
 const before=f.remote.settings();
 f.sql.exec("CREATE TRIGGER refuse_config BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
 const ops=[{op:'set',path:['projects','news','model'],value:'updated'}];
 if(changeRoute)ops.push({op:'set',path:['api_prefix'],value:'/changed'});
 let saved=await f.save(ops);assert.equal(saved.accepted,false);assert.match(saved.error.message,/injected/);
 assert.equal(f.remote.settings().revision,before.revision);assert.equal(f.remote.settings().value.projects.news.model,'original');
 assert.deepEqual([...f.routes.keys()],['/api/terms-bridge']);
 assert.equal((await f.submit('after-failed')).status,202);assert.equal(f.tasks().at(-1)[1].project.model,'original');
 f.sql.exec('DROP TRIGGER refuse_config');saved=await f.save(ops);assert.equal(saved.accepted,true);
 assert.equal((await f.submit('after-saved',changeRoute?'/changed':undefined)).status,202);
 assert.equal(f.tasks().at(-1)[1].project.model,'updated');assert.equal(f.tasks()[0][1].project.model,'original');
});

test('route conflicts reject settings before changing revision or bindings',async t=>{
 const f=await sqliteFixture(t),before=f.remote.settings();f.conflict='/conflict';
 const result=await f.save([{op:'set',path:['api_prefix'],value:'/conflict'}]);
 assert.equal(result.accepted,false);assert.match(result.error.message,/route conflict/);
 assert.equal(f.remote.settings().revision,before.revision);assert.deepEqual([...f.routes.keys()],['/api/terms-bridge']);
});

test('preparing configuration fences task admissions; commit publishes the complete new snapshot',async t=>{
 const f=await sqliteFixture(t),gate=deferred();let preparing=false;
 const path=join(f.dir,'added');await mkdir(path);
 f.preparing=async()=>{preparing=true;await gate.promise};
 const saving=f.save([{op:'set',path:['projects','news','model'],value:'updated'},{op:'set',path:['projects','added'],value:{provider:'test',model:'test',workspace_path:path,callback_url:'http://localhost/results'}}]);
 try{await until(()=>preparing);assert.equal((await f.submit('during')).status,503);assert.equal(f.remote.settings().value.projects.news.model,'original');}
 finally{gate.resolve();}
 assert.equal((await saving).accepted,true);assert.equal((await f.submit('after')).status,202);assert.equal(f.tasks().at(-1)[1].project.model,'updated');
});

test('shutdown while preparing settings drains the change without committing or leaving routes',async t=>{
 const f=await sqliteFixture(t),gate=deferred();let preparing=false;
 f.preparing=async()=>{preparing=true;await gate.promise};
 const saving=f.add('added');await until(()=>preparing);const stopping=f.stop();gate.resolve();
 assert.equal((await saving).accepted,false);await stopping;assert.equal(f.routes.size,0);
 assert.equal(f.sql.prepare('SELECT revision FROM settings').get().revision,1);
});

test('binding failure rolls back project fields and revision in the same SQLite transaction',async t=>{
 const f=await sqliteFixture(t);await f.submit('before');const before=f.remote.settings();
 f.sql.exec("CREATE TRIGGER refuse_binding BEFORE UPDATE OF binding ON projects BEGIN SELECT RAISE(ABORT,'binding write rejected'); END");
 const rejected=await f.save([{op:'set',path:['projects','news','model'],value:'must-not-save'}]);
 assert.equal(rejected.accepted,false);assert.equal(f.remote.settings().revision,before.revision);assert.equal(f.remote.settings().value.projects.news.model,'original');
 f.sql.exec('DROP TRIGGER refuse_binding');assert.equal((await f.submit('after')).status,202);assert.equal(f.tasks().at(-1)[1].project.model,'original');
});
