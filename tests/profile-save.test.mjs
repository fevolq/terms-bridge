import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEditor } from '../client/model.mjs';
import { settingsForm } from '../client/transport.mjs';

test('real profile editor permits repeated names, blocks repeated paths and preserves unrelated settings', {skip:!process.env.DSH_TEST_PACKAGE}, async t=>{
 const requireHost=createRequire(process.env.DSH_TEST_PACKAGE);
 const load=name=>import(pathToFileURL(requireHost.resolve('@deepseek-ai/'+name)));
 const {boot,readProfilePatches}=await load('dsh-app-boot');const {Service}=await load('cordis');
 const dir=await mkdtemp(join(tmpdir(),'bridge-profile-save-'));const home=join(dir,'home');await mkdir(home);
 const defaultWorkspace=join(dir,'default-workspace'), taken=join(dir,'taken'), fresh=join(dir,'fresh'), sameDirectory=join(dir,'other','taken');
 for(const path of [defaultWorkspace,taken,fresh,sameDirectory])await mkdir(path,{recursive:true});
 await writeFile(join(dir,'package.json'),JSON.stringify({name:'bridge-profile-test',dsh:{profile:{bundles:[]}}}));
 await writeFile(join(dir,'cordis.yml'),'[]');
 await writeFile(join(dir,'bridge.mjs'),`
 export { Config } from '${new URL('../dist/dsh/settings.js',import.meta.url)}';
 import { watchProjectConfig } from '${new URL('../dist/dsh/settings.js',import.meta.url)}';
 import { TaskStore } from '${new URL('../dist/storage/tasks.js',import.meta.url)}';
 import { MemoryTable } from '${new URL('./helpers.mjs',import.meta.url)}';
 export const bindings = new Map();
 export function apply(ctx){
   const workspaceRegistry={list:()=>${JSON.stringify([{id:'default',path:defaultWorkspace,title:'default-workspace'},{id:'taken',path:taken,title:'占用名称'}])}};
   ctx.effect(()=>watchProjectConfig({fiber:ctx.fiber,on:ctx.on.bind(ctx),workspaceRegistry},bindings,new TaskStore(new MemoryTable(), new MemoryTable())));
 }`);
 await writeFile(join(dir,'other.mjs'),`import Schema from '${pathToFileURL(requireHost.resolve('@deepseek-ai/schemastery'))}';export const Config=Schema.object({enabled:Schema.boolean().default(false).volatile()});export function apply(){}`);
 const patches=[{insert:[{id:'terms-bridge',name:pathToFileURL(join(dir,'bridge.mjs')).href},{id:'other-plugin',name:pathToFileURL(join(dir,'other.mjs')).href},...['dsh-config-editor','dsh-settings'].map(name=>({id:name,name:pathToFileURL(requireHost.resolve('@deepseek-ai/'+name)).href}))]}];
 const profile={dir,home,patchPath:join(dir,'cordis.patch.yml'),installAnchor:dir,cwd:dir,startedBundles:[],overlays:[],name:'test'};
 await writeFile(profile.patchPath,JSON.stringify(patches));
 const ctx=await boot('dsh',join(dir,'cordis.yml'),readProfilePatches('dsh',profile),async c=>{class Profile extends Service {constructor(c){super(c,'profileContext');Object.assign(this,profile)}}await c.plugin(Profile).await()});
 t.after(()=>ctx.fiber.dispose());
 const before=ctx.settings.describe().find(x=>x.ns==='terms-bridge');
 const projects={'gen-image':{name:'生图',provider:'mock',model:'test',max_concurrency:3,callback_url:'http://127.0.0.1:8001',callback_headers:{'X-API-Key':'test-key','X-Project':'gen-image'},max_execution_retries:3,retry_interval_seconds:60,execution_timeout_seconds:1800,callback_timeout_seconds:10}};
 await ctx.settings.mutate('terms-bridge',[{op:'set',path:['projects'],value:projects},{op:'set',path:['api_prefix'],value:'/api/terms-bridge'}],before.revision);
 const after=ctx.settings.describe().find(x=>x.ns==='terms-bridge');
 assert.equal(after.value.projects['gen-image'].model,'test');
 assert.match(await readFile(profile.patchPath,'utf8'),/gen-image/);
 assert.equal(after.value.projects['gen-image'].workspace_path,undefined);
 assert.equal(after.value.projects['gen-image'].request_token,undefined);
 const {bindings}=await import(pathToFileURL(join(dir,'bridge.mjs')));
 const boundPath=join(dir,'gen-image');await mkdir(boundPath);
 bindings.set('gen-image',{workspace_path:boundPath});
 const saved=await readFile(profile.patchPath,'utf8');
 await assert.rejects(ctx.settings.mutate('terms-bridge',[{op:'set',path:['projects','gen-image','workspace_path'],value:fresh}],after.revision),/工作区路径保存后不可修改/);
 assert.equal(await readFile(profile.patchPath,'utf8'),saved);
 const extra={...projects['gen-image'],name:'新增',workspace_path:fresh};
 const duplicate={...projects,added:{...extra,workspace_path:boundPath+'/../gen-image'}};
 await assert.rejects(ctx.settings.mutate('terms-bridge',[{op:'set',path:['projects'],value:duplicate}],after.revision),/工作区路径.*重复/);
 assert.equal(await readFile(profile.patchPath,'utf8'),saved);
 assert.equal(ctx.settings.describe().find(x=>x.ns==='terms-bridge').value.projects.added,undefined);
 const revision=ctx.settings.describe().find(x=>x.ns==='terms-bridge').revision;
 await ctx.settings.mutate('terms-bridge',[{op:'set',path:['projects'],value:{...projects,
   added:{...extra,name:'生图',workspace_path:taken},
   same_title:{...extra,name:'占用名称',workspace_path:fresh},
   same_directory:{...extra,name:'生图',workspace_path:sameDirectory},
 }}],revision);
 const accepted=ctx.settings.describe().find(x=>x.ns==='terms-bridge').value.projects;
 assert.equal(accepted.added.workspace_path,taken);
 assert.equal(accepted.added.name,accepted['gen-image'].name);
 assert.equal(accepted.same_title.name,'占用名称');
 assert.equal(accepted.same_directory.workspace_path,sameDirectory);
 assert.match(await readFile(profile.patchPath,'utf8'),/same_title/);
 const other=ctx.settings.describe().find(x=>x.ns==='other-plugin');
 await ctx.settings.mutate('other-plugin',[{op:'set',path:['enabled'],value:true}],other.revision);
 assert.equal(ctx.settings.describe().find(x=>x.ns==='other-plugin').value.enabled,true);

 // Exercise the real host's secret redaction and persistence through the actual editor/transport.
 const descriptor=()=>ctx.settings.describe().find(x=>x.ns==='terms-bridge');
 const remoteView=()=>ctx.settings.describe({redactSecrets:true}).find(x=>x.ns==='terms-bridge');
 await ctx.settings.mutate('terms-bridge',[{op:'set',path:['projects','gen-image','request_token'],value:'original-secret'}],descriptor().revision);
 const form={getSnapshot:()=>({status:'ready',writable:true,revision:remoteView().revision,value:remoteView().value}),subscribe:()=>()=>{}};
 const editor=createEditor(settingsForm({
   configForms:{get:()=>form,describe:()=>({getSnapshot:()=>({view:{namespaces:[remoteView()]}}),acceptView(){}})},
   remote:{settings:{mutate:async(ns,ops,revision)=>{await ctx.settings.mutate(ns,ops,revision);return{ok:true,value:remoteView()};}}},
 }));
 editor.setDefaultPreset('standard');
 t.after(()=>editor.dispose());
 const row=()=>editor.getSnapshot().draft.rows.find(x=>x.id==='gen-image');
 assert.equal(row().tokenSet,true);assert.equal(row().request_token,'');
 editor.project(row().key,'max_concurrency',4);
 assert.equal(await editor.save(),true);
 assert.equal(descriptor().value.projects['gen-image'].request_token,'original-secret');
 assert.equal(descriptor().value.projects['gen-image'].max_concurrency,4);
 editor.project(row().key,'max_concurrency','');
 assert.equal(await editor.save(),true);
 assert.equal(descriptor().value.projects['gen-image'].max_concurrency,0);
 const key=editor.add();
 for(const [name,value] of Object.entries({id:'another',name:'另一个项目',provider:'mock',model:'test',callback_url:'http://127.0.0.1:8001'}))editor.project(key,name,value);
 assert.equal(await editor.save(),true);
 assert.equal(descriptor().value.projects['gen-image'].request_token,'original-secret');
 editor.project(row().key,'request_token','replacement-secret');
 assert.equal(await editor.save(),true);
 assert.equal(descriptor().value.projects['gen-image'].request_token,'replacement-secret');
 assert.equal(row().request_token,'');assert.equal(row().tokenSet,true);
 editor.project(row().key,'request_token','');
 assert.equal(await editor.save(),true);
 assert.equal(descriptor().value.projects['gen-image'].request_token,undefined);assert.equal(row().tokenSet,false);
});
