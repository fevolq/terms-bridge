import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsForm } from '../client/transport.mjs';
import { createEditor } from '../client/model.mjs';
import { DEFAULT_CONFIG, DEFAULT_PROJECT } from '../client/fields.mjs';
import { deferred } from './helpers.mjs';

test('configuration refusal reaches the editor without exposing the edited token', async t=>{
 const view={value:DEFAULT_CONFIG,revision:1,writable:true,secrets:[]};
 const form=settingsForm({remote:{termsBridge:{settings:async()=>({ok:true,value:view}),mutate:async()=>({ok:true,value:{accepted:false,error:{code:'CONFIG_REJECTED',message:'validation failed: sensitive-test-token'},view}})}}});t.after(()=>form.dispose());await form.refresh();
 const editor=createEditor(form);t.after(()=>editor.dispose());const key=editor.add();
 for(const [name,value]of Object.entries({...DEFAULT_PROJECT,id:'test',provider:'mock',model:'mock',agent_preset:'standard',callback_url:'http://127.0.0.1:8001',request_token:'sensitive-test-token'}))editor.project(key,name,value);
 assert.equal(await editor.save(),false);assert.match(editor.getSnapshot().message,/validation failed/);assert.doesNotMatch(editor.getSnapshot().message,/sensitive-test-token/);
});

test('accepted Remote write updates the local snapshot before returning; stale reads cannot replace it',async t=>{
 const delayed=deferred();let reads=0;
 const view={value:DEFAULT_CONFIG,revision:3,writable:true,secrets:[]};
 const adapter=settingsForm({remote:{termsBridge:{settings:()=>++reads===1?delayed.promise:Promise.resolve({ok:true,value:view}),mutate:async(_ops,revision)=>{assert.equal(revision,2);return{ok:true,value:{accepted:true,view}}}}}});t.after(()=>adapter.dispose());
 assert.equal(await adapter.mutate([],2),true);assert.equal(adapter.getSnapshot().revision,3);
 delayed.resolve({ok:true,value:{...view,revision:1}});await Promise.resolve();assert.equal(adapter.getSnapshot().revision,3);
});

test('reconnect reloads persisted settings, and lost save responses refresh the current revision',async t=>{
 let reconnect,current={value:DEFAULT_CONFIG,revision:1,writable:true,secrets:[]};
 const form=settingsForm({on:(_,fn)=>{reconnect=fn},remote:{termsBridge:{settings:async()=>({ok:true,value:current}),mutate:async()=>{current={...current,revision:2};throw new Error('connection lost')}}}});t.after(()=>form.dispose());await form.refresh();
 await assert.rejects(form.mutate([],1),/connection lost/);assert.equal(form.getSnapshot().revision,2);
 current={...current,revision:3};reconnect();await form.refresh();assert.equal(form.getSnapshot().revision,3);
});


test('slow polling coalesces reads without discarding the response',async t=>{
 let poll;const reads=[];
 t.mock.method(globalThis,'setInterval',callback=>{poll=callback;return{unref(){}};});
 t.mock.method(globalThis,'clearInterval',()=>{});
 const form=settingsForm({remote:{termsBridge:{settings:()=>{const gate=deferred();reads.push(gate);return gate.promise;}}}});t.after(()=>form.dispose());
 const first=form.refresh();
 for(let i=0;i<6;i++)poll();
 assert.equal(reads.length,1);assert.equal(form.getSnapshot().status,'loading');
 reads[0].resolve({ok:true,value:{value:DEFAULT_CONFIG,revision:1,writable:true,secrets:[]}});await first;
 assert.equal(form.getSnapshot().status,'ready');assert.equal(form.getSnapshot().revision,1);
 poll();const second=form.refresh();poll();assert.equal(reads.length,2);
 reads[1].resolve({ok:true,value:{value:DEFAULT_CONFIG,revision:2,writable:true,secrets:[]}});await second;
 assert.equal(form.getSnapshot().revision,2);
});

test('reconnect accepts a restored revision and ignores late reads from the old connection',async t=>{
 let reconnect,delayed=false,current={value:DEFAULT_CONFIG,revision:7,writable:true,secrets:[]};const old=deferred();
 const form=settingsForm({on:(_,fn)=>{reconnect=fn;},remote:{termsBridge:{settings:()=>delayed?old.promise:Promise.resolve({ok:true,value:current})}}});t.after(()=>form.dispose());
 await form.refresh();assert.equal(form.getSnapshot().revision,7);
 delayed=true;const oldRead=form.refresh();delayed=false;current={...current,revision:2};reconnect();await form.refresh();
 assert.equal(form.getSnapshot().status,'ready');assert.equal(form.getSnapshot().revision,2);assert.equal(form.getSnapshot().writable,true);
 old.resolve({ok:true,value:{...current,revision:99}});await oldRead;
 assert.equal(form.getSnapshot().revision,2);
 current={...current,revision:1};await form.refresh();assert.equal(form.getSnapshot().revision,2,'same-connection revisions cannot go backwards');
});

test('a late save from the old connection cannot overwrite state or unlock a new save',async t=>{
 let reconnect,writes=0,current={value:DEFAULT_CONFIG,revision:7,writable:true,secrets:[]};const old=deferred(),next=deferred();
 const form=settingsForm({on:(_,fn)=>{reconnect=fn;},remote:{termsBridge:{settings:async()=>({ok:true,value:current}),mutate:()=>++writes===1?old.promise:next.promise}}});t.after(()=>form.dispose());
 await form.refresh();const oldSave=form.mutate([],7),rejected=assert.rejects(oldSave,/连接已重置/);
 current={...current,revision:2};reconnect();await form.refresh();const newSave=form.mutate([],2);
 old.resolve({ok:true,value:{accepted:true,view:{...current,revision:8}}});await rejected;
 assert.equal(form.getSnapshot().revision,2);await assert.rejects(form.mutate([],2),/配置保存不可用/);
 next.resolve({ok:true,value:{accepted:true,view:{...current,revision:3}}});assert.equal(await newSave,true);assert.equal(form.getSnapshot().revision,3);
});

for(const revision of [2,7])test('reconnect preserves an unsaved draft as a conflict even when revision='+revision,async t=>{
 let reconnect,current={value:{...DEFAULT_CONFIG,api_prefix:'/original'},revision:7,writable:true,secrets:[]};
 const form=settingsForm({on:(_,fn)=>{reconnect=fn;},remote:{termsBridge:{settings:async()=>({ok:true,value:current}),mutate:()=>assert.fail('A stale draft must not be saved')}}});t.after(()=>form.dispose());
 await form.refresh();const editor=createEditor(form);t.after(()=>editor.dispose());editor.field('api_prefix','/unsaved');
 current={...current,revision,value:{...DEFAULT_CONFIG,api_prefix:'/restored'}};reconnect();await form.refresh();
 assert.equal(editor.getSnapshot().draft.api_prefix,'/unsaved');assert.equal(editor.getSnapshot().conflict,true);assert.equal(await editor.save(),false);
 editor.discard();assert.equal(editor.getSnapshot().draft.api_prefix,'/restored');assert.equal(editor.getSnapshot().revision,revision);assert.equal(editor.getSnapshot().conflict,false);
});
