import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {WORKFLOWS,lookupWorkflow} from '../../server/integrations/titan-workforce/catalog.mjs';
import {validatePreviewRequest,validateContext,WorkforceAdapterError} from '../../server/integrations/titan-workforce/validation.mjs';
import {previewWorkforceAction} from '../../server/integrations/titan-workforce/proposal.mjs';
import {previewWorkforceBatch} from '../../server/integrations/titan-workforce/batch.mjs';
import {registerWorkforcePreviewRoutes} from '../../server/integrations/titan-workforce/route.mjs';
import {registerPlugin} from '../../plugins/titan-workforce-bridge/index.mjs';
const name='titan-workforce-bridge';
const input={workflow:'booking',resource_reference:'br_42',client_request_reference:'req_1'};
const ctx={trusted:true,company_id:'company_ABC',desk_actor_id:'actor_1'};
function ports(overrides={}){
  return {resolveIdentity:async()=>ctx,resolveResource:async({context,kind,reference})=>
    ({verified:true,company_id:context.company_id,kind,reference}),
  authorize:async({context})=>({allowed:true,company_id:context.company_id}),...overrides};
}
function fakeApp(){
 const routes=new Map();return {routes,post:(path,...fns)=>routes.set(path,fns)};
}
function response(){let status=200;return {set(){return this},status(v){status=v;return this},json(v){return {status,body:v}}}}
function rejectCode(code){return e=>e instanceof WorkforceAdapterError&&e.code===code;}
test('all ten original starter roles are mapped to one authoritative owner',()=>{
 assert.equal(Object.keys(WORKFLOWS).length,10);
 for(const [key,s] of Object.entries(WORKFLOWS)){
  assert.equal(lookupWorkflow(key),s);assert.ok(['field','desk'].includes(s.owner));
  assert.equal(s.review,'human');
 }
});
test('no unknown role',()=>assert.equal(lookupWorkflow('money-transfer'),null));
test('valid request has only workflow, resource reference, request reference',()=>{
 assert.deepEqual(Object.keys(validatePreviewRequest(input)).sort(),Object.keys(input).sort());
});
for(const bad of [{...input,company_id:'other'},{...input,amount:'200'},
 {...input,resource_kind:'invoice'},{...input,workflow:'execute_script'},
 {...input,resource_reference:'../../etc/passwd'},
 {...input,client_request_reference:'x'.repeat(130)},
 {},null,[]]){
 test('rejects invalid or injected client request '+JSON.stringify(bad)?.slice(0,70),()=>{
  assert.throws(()=>validatePreviewRequest(bad),WorkforceAdapterError);
 });
}
test('requires trusted authenticated identity',()=>assert.throws(()=>validateContext({...ctx,trusted:false}),rejectCode('authenticated_company_context_required')));
test('requires company ID in trusted context',()=>assert.throws(()=>validateContext({trusted:true,desk_actor_id:'a'}),WorkforceAdapterError));
test('rejects missing authorisation ports',async()=>{
 await assert.rejects(previewWorkforceAction(input,{},{}),rejectCode('workforce_ports_unavailable'));
});
test('builds review-only plan from server-verified context',async()=>{
 const p=await previewWorkforceAction(input,{}, {ports:ports()});
 assert.equal(p.company_id,ctx.company_id);assert.equal(p.owner,'field');
 assert.equal(p.execution,'not_executed');assert.equal(p.human_review_required,true);
 assert.equal(p.resource.kind,'booking_request');
 assert.match(p.event_id,/^[a-f0-9]{64}$/);assert.match(p.payload_hash,/^[a-f0-9]{64}$/);
});
test('blocks first-owner fallback and untrusted caller identity',async()=>{
 await assert.rejects(previewWorkforceAction(input,{company_id:'injected'},
 {ports:ports({resolveIdentity:async()=>({company_id:'company_ABC',desk_actor_id:'actor_1'})})}),
 rejectCode('authenticated_company_context_required'));
});
test('rejects mismatched company boundary from resource resolver',async()=>{
 await assert.rejects(previewWorkforceAction(input,{}, {ports:ports({resolveResource:async()=>
 ({verified:true,company_id:'other',kind:'booking_request',reference:'br_42'})})}),
 rejectCode('resource_authority_unverified'));
});
test('rejects wrong resource type',async()=>{
 await assert.rejects(previewWorkforceAction(input,{}, {ports:ports({resolveResource:async()=>
 ({verified:true,company_id:ctx.company_id,kind:'invoice',reference:'br_42'})})}),
 rejectCode('resource_authority_unverified'));
});
test('rejects wrong resource ID',async()=>{
 await assert.rejects(previewWorkforceAction(input,{}, {ports:ports({resolveResource:async()=>
 ({verified:true,company_id:ctx.company_id,kind:'booking_request',reference:'br_999'})})}),
 rejectCode('resource_authority_unverified'));
});
test('rejects an authorisation response for another company',async()=>{
 await assert.rejects(previewWorkforceAction(input,{}, {ports:ports({authorize:async()=>
 ({allowed:true,company_id:'other'})})}),rejectCode('workforce_action_not_authorized'));
});
test('rejects denied authority',async()=>{
 await assert.rejects(previewWorkforceAction(input,{}, {ports:ports({authorize:async()=>
 ({allowed:false,company_id:ctx.company_id})})}),rejectCode('workforce_action_not_authorized'));
});
test('stable event identity across identical requests; different payloads yield different hash',async()=>{
 const a=await previewWorkforceAction(input,{}, {ports:ports()});
 const b=await previewWorkforceAction({...input}, {},{ports:ports()});
 const c=await previewWorkforceAction({...input,resource_reference:'br_43'}, {},{ports:ports()});
 assert.equal(a.event_id,b.event_id);assert.equal(a.payload_hash,b.payload_hash);
 assert.equal(a.event_id,c.event_id);assert.notEqual(a.payload_hash,c.payload_hash);
});
test('event identity separates companies and actors',async()=>{
 const a=await previewWorkforceAction(input,{}, {ports:ports()});
 const b=await previewWorkforceAction(input,{}, {ports:ports({resolveIdentity:async()=>
 ({...ctx,company_id:'company_X'})})});
 assert.notEqual(a.event_id,b.event_id);
});
test('no runtime, delivery, mutation or storage method is called',async()=>{
 let calls=0;const p=ports();p.execute=()=>{calls++};p.send=()=>{calls++};p.write=()=>{calls++};
 await previewWorkforceAction(input,{}, {ports:p}); assert.equal(calls,0);
});
test('batch supports independent successes and failures',async()=>{
 const r=await previewWorkforceBatch([input,{...input,workflow:'bad'}],{},{ports:ports()});
 assert.equal(r.count,2);assert.equal(r.results[0].ok,true);
 assert.deepEqual(r.results[1],{ok:false,error:'preview_unknown_workflow'});
});
test('batch is bounded',async()=>{
 await assert.rejects(previewWorkforceBatch(Array(11).fill(input),{},{ports:ports()}),rejectCode('workforce_batch_invalid'));
});
test('batch rejects empty lists',async()=>{
 await assert.rejects(previewWorkforceBatch([],{},{ports:ports()}),rejectCode('workforce_batch_invalid'));
});
test('route is not registered when default-disabled',()=>{
 const a=fakeApp();assert.equal(registerWorkforcePreviewRoutes(a,{mode:undefined}).registered,false);
 assert.equal(a.routes.size,0);
});
test('route not registered without host admin authentication',()=>{
 const a=fakeApp();assert.equal(registerWorkforcePreviewRoutes(a,{mode:'shadow'}).registered,false);
 assert.equal(a.routes.size,0);
});
test('shadow route registers only two admin-guarded preview paths',()=>{
 const a=fakeApp(),admin=()=>{};
 const r=registerWorkforcePreviewRoutes(a,{mode:'shadow',adminAuthMiddleware:admin});
 assert.equal(r.registered,true);assert.equal(a.routes.size,2);
 for(const fns of a.routes.values())assert.equal(fns[0],admin);
});
test('HTTP preview fails closed if no DB-agent-owned ports',async()=>{
 const app=fakeApp(),admin=()=>{};
 registerWorkforcePreviewRoutes(app,{mode:'shadow',adminAuthMiddleware:admin});
 const handler=app.routes.get('/api/titan-workforce/v1/previews')[1];
 const res=response();const result=await handler({rawBody:Buffer.from(JSON.stringify(input)),body:input},res);
 assert.equal(result.status,503);assert.deepEqual(result.body,{error:'workforce_ports_unavailable'});
});
test('HTTP preview returns result with verified injected ports',async()=>{
 const app=fakeApp(),admin=()=>{};
 registerWorkforcePreviewRoutes(app,{mode:'shadow',adminAuthMiddleware:admin,ports:ports()});
 const handler=app.routes.get('/api/titan-workforce/v1/previews')[1];
 const result=await handler({rawBody:Buffer.from(JSON.stringify(input)),body:input},response());
 assert.equal(result.status,202);assert.equal(result.body.execution,'not_executed');
});
test('oversized HTTP body is blocked before port access',async()=>{
 const app=fakeApp();registerWorkforcePreviewRoutes(app,{mode:'shadow',adminAuthMiddleware:()=>{},ports:ports()});
 const handler=app.routes.get('/api/titan-workforce/v1/previews')[1];
 const result=await handler({rawBody:Buffer.alloc(2049),body:input},response());
 assert.equal(result.status,413);
});
test('plugin manifests do not declare migrations and register function exists',()=>{
 const file=resolve(dirname(fileURLToPath(import.meta.url)),'../../plugins/titan-workforce-bridge/plugin.json');
 const p=JSON.parse(readFileSync(file));assert.equal(p.entryPoint,'index.mjs');
 assert.equal(p.registerFunction,'registerPlugin');assert.equal(p.database,undefined);
 assert.equal(typeof registerPlugin,'function');
});
