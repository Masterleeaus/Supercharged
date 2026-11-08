import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {previewLeadTransition,registerLeadPreviewRoute} from '../../server/integrations/titan-workforce/lead-review.mjs';
import {registerPlugin} from '../../plugins/titan-workforce-bridge/index.mjs';
import {WorkforceAdapterError} from '../../server/integrations/titan-workforce/validation.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const input={lead_reference:'lead_1',to_state:'qualifying',client_event_reference:'evt_5'};
const ctx={trusted:true,company_id:'company_A',desk_actor_id:'actor_5'};
let calls=[];
const ports=(override={})=>({
  resolveIdentity:async()=>{calls.push('identity');return ctx},
  resolveResource:async({context,kind,reference})=>{
    calls.push('resource');return {verified:true,company_id:context.company_id,kind,reference,state:'captured'}},
  authorize:async()=>{calls.push('authorize');return {allowed:true,company_id:ctx.company_id}},
  ...override
});
const opts={ports:ports(),observedAt:'2026-11-02T00:00:00.000Z'};
const response=()=>{let status=200;return {set(){return this},status(x){status=x;return this},json(body){return {status,body}}}};
const app=()=>{const routes=new Map();return {routes,post:(path,...fns)=>routes.set(path,fns)}};

for(const [name,data] of Object.entries({
  'caller company injection':{...input,company_id:'company_B'},
  'arbitrary side effect':{...input,send_sms:true},
  'unknown transition':{...input,to_state:'issue-refund'},
  'path traversal':{...input,lead_reference:'../../etc/passwd'},
  'missing source event':{...input,client_event_reference:''},
  'missing target':{...input,to_state:undefined}
})){
  test(`invalid lead preview rejects ${name}`,async()=>{
    await assert.rejects(previewLeadTransition(data,{},opts),WorkforceAdapterError);
  });
}
test('Original GitHub revenue transition creates review-only proposal',async()=>{
  calls=[];
  const r=await previewLeadTransition(input,{},opts);
  assert.deepEqual(calls,['identity','resource','authorize']);
  assert.equal(r.company_id,'company_A');
  assert.equal(r.transition.schema,'titan.zero.revenue-journey.lead-opportunity-lifecycle.v1');
  assert.equal(r.transition.transition.to_state,'qualifying');
  assert.equal(r.transition.transition.from_state,'captured');
  assert.equal(r.transition.governance.execution_permitted,false);
  assert.equal(r.transition.governance.may_mutate_entities,false);
  assert.equal(r.human_review_required,true);assert.equal(r.delivery,'not_sent');
});
test('same event stable across repeated previews',async()=>{
  const a=await previewLeadTransition(input,{},opts);const b=await previewLeadTransition(input,{},opts);
  assert.equal(a.event_id,b.event_id);assert.equal(a.transition.idempotency_key,b.transition.idempotency_key);
});
test('different target state yields different event identity',async()=>{
  const a=await previewLeadTransition(input,{},opts);
  const b=await previewLeadTransition({...input,to_state:'nurture'}, {},opts);
  assert.notEqual(a.event_id,b.event_id);
});
test('separate company yields separate event id',async()=>{
  const a=await previewLeadTransition(input,{},opts);
  const newctx={...ctx,company_id:'company_B'};
  const b=await previewLeadTransition(input,{}, {ports:ports({resolveIdentity:async()=>newctx,
    authorize:async()=>({allowed:true,company_id:newctx.company_id})}),observedAt:opts.observedAt});
  assert.notEqual(a.event_id,b.event_id);
});
test('cross-company resource rejected before authorization',async()=>{
  calls=[];
  await assert.rejects(previewLeadTransition(input,{}, {ports:ports({resolveResource:async()=>({verified:true,kind:'lead',company_id:'company_B',reference:'lead_1',state:'captured'})})}),e=>e.code==='lead_resource_not_verified');
  assert.deepEqual(calls,['identity']);
});
test('untrusted identity rejected',async()=>{
  await assert.rejects(previewLeadTransition(input,{}, {ports:ports({resolveIdentity:async()=>({...ctx,trusted:false})})}),e=>e.code==='authenticated_company_context_required');
});
test('authorization denied',async()=>{
  await assert.rejects(previewLeadTransition(input,{}, {ports:ports({authorize:async()=>({allowed:false,company_id:'company_A'})})}),e=>e.code==='lead_transition_not_authorized');
});
test('illegal lead state transition rejected',async()=>{
  await assert.rejects(previewLeadTransition({...input,to_state:'converted'}, {}, opts),e=>e.code==='lead_transition_not_allowed');
});
test('cannot register endpoint without trusted ports or auth',()=>{
  const a=app();assert.equal(registerLeadPreviewRoute(a,{mode:'shadow'}).registered,false);
  assert.equal(a.routes.size,0);
});
test('native route uses admin auth and rawBody gate',async()=>{
  const a=app();let allowed=false;
  const auth=(req,res,next)=>{allowed=true;next?.()};
  const registration=registerLeadPreviewRoute(a,{mode:'shadow',adminAuthMiddleware:auth,ports:ports()});
  assert.equal(registration.registered,true);
  const [middleware,handler]=a.routes.get(registration.path);
  assert.equal(middleware,auth);
  const tooLarge=await handler({rawBody:Buffer.alloc(2049),body:input},response());
  assert.equal(tooLarge.status,413);
  const ok=await handler({rawBody:Buffer.from(JSON.stringify(input)),body:input},response());
  assert.equal(ok.status,202);assert.equal(ok.body.execution,'not_executed');
});
test('plugin registers no routes while disabled',()=>{
  const a=app();const prior=process.env.TITAN_WORKFORCE_ADAPTER_MODE;
  delete process.env.TITAN_WORKFORCE_ADAPTER_MODE;
  try {const result=registerPlugin(a,{adminAuthMiddleware:()=>{},titanWorkforcePorts:ports()});assert.equal(result.registered,false);assert.equal(a.routes.size,0)}
  finally {if(prior===undefined)delete process.env.TITAN_WORKFORCE_ADAPTER_MODE;else process.env.TITAN_WORKFORCE_ADAPTER_MODE=prior}
});
test('original GitHub bytes preserved on disk (metadata check)',()=>{
  const data=readFileSync(resolve(here,'../../server/integrations/titan-revenue/revenue-lead-opportunity-lifecycle.mjs'));
  const sha=createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${data.length}\0`),data])).digest('hex');
  assert.equal(sha,'cacb4805c31abe72b79adccf6bc5231fe71580dc');
});
