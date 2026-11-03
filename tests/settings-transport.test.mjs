import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsForm } from '../client/transport.mjs';
import { createEditor } from '../client/model.mjs';
import { DEFAULT_CONFIG, DEFAULT_PROJECT } from '../client/fields.mjs';

test('native remote refusal reason survives settings form and user tokens are redacted', async () => {
 const form={getSnapshot:()=>({status:'ready',writable:true,revision:1,value:DEFAULT_CONFIG}),subscribe:()=>()=>{}};
 const ctx={configForms:{get:()=>form,describe:()=>({acceptView(){}})},remote:{settings:{mutate:async()=>({ok:false,error:{code:'settings/rejected',message:'validation failed: sensitive-test-token'}}),describe:async()=>({ok:true,value:{namespaces:[]}})}}};
 const editor=createEditor(settingsForm(ctx));const key=editor.add();
 for(const [name,value]of Object.entries({...DEFAULT_PROJECT,id:'test',provider:'mock',model:'mock',agent_preset:'standard',callback_url:'http://127.0.0.1:8001',request_token:'sensitive-test-token'}))editor.project(key,name,value);
 assert.equal(await editor.save(),false);
 assert.match(editor.getSnapshot().message,/validation failed/);
 assert.ok(!editor.getSnapshot().message.includes('sensitive-test-token'));
 assert.equal(editor.getSnapshot().dirty,true);editor.dispose();
});

test('accepted remote write updates the shared settings mirror before returning',async()=>{
 const view={ns:'terms-bridge',revision:3};let accepted;
 const adapter=settingsForm({configForms:{get:()=>({}),describe:()=>({acceptView:v=>{accepted=v}})},remote:{settings:{mutate:async(_ns,_ops,revision)=>{assert.equal(revision,2);return{ok:true,value:view}}}}});
 assert.equal(await adapter.mutate([],2),true);assert.equal(accepted,view);
});
