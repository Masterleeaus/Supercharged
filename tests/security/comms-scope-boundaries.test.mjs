import test from 'node:test';
import assert from 'node:assert/strict';
import { commsRoute } from '../../server/modules/desk-modes/comms-router.ts';
const noop = () => {};
const COMPANY_A = '11111111-1111-4111-8111-111111111111';
function response() { return { statusCode:200, status(code){this.statusCode=code;return this;}, json(body){this.body=body;} }; }
test('authenticated company is taken from the injected scope only',async()=>{
  const calls=[];
  const route=commsRoute(()=>({companyId:COMPANY_A,actor:{kind:'human',id:'u1'}}),async(scope,req)=>{calls.push(scope);return {tenant:scope.companyId,requested:req.query.companyId};});
  const res=response();
  await route({params:{companyId:'22222222-2222-4222-8222-222222222222'},query:{companyId:'22222222-2222-4222-8222-222222222222'},body:{companyId:'22222222-2222-4222-8222-222222222222'}},res,noop);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.tenant,COMPANY_A);
  assert.equal(calls[0].actor.id,'u1');
});
test('a missing identity never invokes an effectful service',async()=>{
  let writes=0;
  for (const resolver of [()=>null,()=>({companyId:COMPANY_A,actor:null}),()=>({companyId:'bad',actor:{kind:'human',id:'u'}})]) {
    const res=response();
    await commsRoute(resolver,async()=>{writes++;return {};})({params:{},query:{},body:{}},res,noop);
    assert.equal(res.statusCode,401);
  }
  assert.equal(writes,0);
});

test('a valid second company scope is permitted but is never replaced by request inputs',async()=>{
 const COMPANY_B='22222222-2222-4222-8222-222222222222';
 const res=response();
 await commsRoute(()=>({companyId:COMPANY_B,actor:{kind:'human',id:'u9'}}),async(scope)=>({company:scope.companyId}))({params:{companyId:COMPANY_A},query:{companyId:COMPANY_A}},res,noop);
 assert.equal(res.statusCode,200);
 assert.equal(res.body.company,COMPANY_B);
});
