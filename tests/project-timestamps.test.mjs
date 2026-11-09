import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteFixture } from './sqlite-fixture.mjs';

test('migration fills missing creation times once; edits and restart keep timestamps without changing legacy config',async t=>{
 const f=await sqliteFixture(t),created=f.remote.settings().value.projects.news.created_at;
 assert.ok(Number.isFinite(Date.parse(created)));assert.equal(f.config.projects.news.created_at,undefined);
 assert.equal((await f.save([{op:'set',path:['projects','news','model'],value:'changed'}])).accepted,true);
 assert.equal(f.remote.settings().value.projects.news.created_at,created);
 assert.equal((await f.add('added')).accepted,true);const added=f.remote.settings().value.projects.added.created_at;assert.ok(Number.isFinite(Date.parse(added)));
 await f.stop();await f.start();assert.equal(f.remote.settings().value.projects.news.created_at,created);assert.equal(f.remote.settings().value.projects.added.created_at,added);
 assert.equal(f.config.projects.news.model,'original');assert.equal(f.legacyOpens,0);
});
