import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeskCentralAccountResolver} from '../../server/infrastructure/central-sso/account-resolver.ts';
const companyId='00000000-0000-4000-8000-000000000001';
const selection=()=>({issuer:'https://issuer.example',subject:'central-user',companyId,
 audience:'supercharged',authority:'central-verified',verifiedAt:new Date().toISOString()});
const row={user_id:'user-123',company_id:companyId,role:'user',revision:2,is_active:true};
function setup(over={}){
 const calls=[];const opts={
  resolveCompanyBinding:async()=>companyId,authoriseCentral:async()=>true,
  queryLink:async(...v)=>{calls.push(v);return [row]},...over
 };
 return {resolve:createDeskCentralAccountResolver(opts),calls};
}
test('Central maps one account-owned Supercharged user',async()=>{
 const x=setup();
 assert.deepEqual(await x.resolve(selection()),{userId:'user-123',companyId,role:'user',revision:2});
 assert.deepEqual(x.calls,[['https://issuer.example','central-user',companyId]]);
});
test('foreign tenant mapping blocks local account query',async()=>{
 let called=false;
 const x=setup({resolveCompanyBinding:async()=> '00000000-0000-4000-8000-000000000099',
 queryLink:async()=>{called=true;return [row]}});
 assert.equal(await x.resolve(selection()),null);
 assert.equal(called,false);
});
test('suspended users, duplicate links and revoked entitlements fail',async()=>{
 for(const opt of [{queryLink:async()=>[{...row,is_active:false}]},
 {queryLink:async()=>[row,row]},{authoriseCentral:async()=>false}]){
  assert.equal(await setup(opt).resolve(selection()),null);
 }
});
test('browser-provided email, forged company and stale identity cannot be authority',async()=>{
 const x=setup();
 assert.equal(await x.resolve({...selection(),email:'spoof@example.org'}),null);
 assert.equal(await x.resolve({...selection(),companyId:'invalid'}),null);
 assert.equal(await x.resolve({...selection(),verifiedAt:'2020-01-01T00:00:00.000Z'}),null);
 assert.equal(x.calls.length,0);
});
test('database errors deny without leaking or trusting stale account',async()=>{
 const x=setup({queryLink:async()=>{throw Error('private database data')}});
 assert.equal(await x.resolve(selection()),null);
});
