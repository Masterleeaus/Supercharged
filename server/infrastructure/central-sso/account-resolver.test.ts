import {describe,it,expect,vi} from 'vitest';
import {createDeskCentralAccountResolver} from './account-resolver';
const companyId='00000000-0000-4000-8000-000000000001';
const selection=()=>({issuer:'https://issuer.example',subject:'central-user',companyId,
 audience:'supercharged',authority:'central-verified',verifiedAt:new Date().toISOString()});
const row={user_id:'user-123',company_id:companyId,role:'user',revision:2,is_active:true};
function setup(over:Record<string,unknown>={}){
 const queryLink=vi.fn(async()=>[row]);
 const resolve=createDeskCentralAccountResolver({
  resolveCompanyBinding:async()=>companyId,authoriseCentral:async()=>true,queryLink,...over});
 return {resolve,queryLink};
}
describe('Supercharged account-scoped Central SSO resolver',()=>{
 it('allows only one current tenant-owned link',async()=>{
  const x=setup();
  expect(await x.resolve(selection())).toEqual({userId:'user-123',companyId,role:'user',revision:2});
  expect(x.queryLink).toHaveBeenCalledWith('https://issuer.example','central-user',companyId);
 });
 it('rejects a different company before local lookup',async()=>{
  const x=setup({resolveCompanyBinding:async()=> '00000000-0000-4000-8000-000000000099'});
  expect(await x.resolve(selection())).toBeNull();expect(x.queryLink).not.toHaveBeenCalled();
 });
 it('rejects suspended local user, duplicate link, unverified Central entitlement',async()=>{
  for(const over of [{queryLink:async()=>[{...row,is_active:false}]},
   {queryLink:async()=>[row,row]},{authoriseCentral:async()=>false}]){
   expect(await setup(over).resolve(selection())).toBeNull();
  }
 });
 it('rejects browser claims, expired identity, unrelated tenant',async()=>{
  const x=setup();
  expect(await x.resolve({...selection(),email:'spoof@example.com'})).toBeNull();
  expect(await x.resolve({...selection(),verifiedAt:'2020-01-01T00:00:00.000Z'})).toBeNull();
  expect(await x.resolve({...selection(),companyId:'wrong'})).toBeNull();
 });
 it('fails closed when company or DB lookup fails',async()=>{
  const x=setup({queryLink:async()=>{throw Error('db unavailable')}});
  expect(await x.resolve(selection())).toBeNull();
 });
});
