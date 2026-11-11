import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMarketingSchema} from '../../server/modules/marketing/schema-readiness.ts';
const predicate="company_id = nullif(current_setting('app.company_id', true),'')::uuid";
const tables=['landing_pages','content_items'];
function fixture(extra=[]){
 return {async query(sql){
  if(sql.startsWith('SELECT rolname'))return {rows:[{rolname:'desk_app',rolsuper:false,rolbypassrls:false}]};
  if(sql.includes('FROM pg_class c JOIN'))return {rows:tables.map(relname=>({relname,relrowsecurity:true,relforcerowsecurity:true,can_select:true,can_insert:true,can_update:true}))};
  if(sql.includes('FROM pg_policies'))return {rows:[...tables.map(tablename=>({tablename,policyname:tablename+'_tenant_boundary',roles:['desk_app'],cmd:'ALL',permissive:'PERMISSIVE',qual:predicate,with_check:predicate})),...extra]};
  throw Error('unknown SQL');
 }};
}
test('readiness accepts a complete single-policy schema',async()=>assert.equal((await verifyMarketingSchema(fixture())).ready,true));
test('a permissive PUBLIC policy on either table fails readiness',async()=>{
 const result=await verifyMarketingSchema(fixture([{tablename:'content_items',policyname:'public_read',roles:['public'],cmd:'SELECT',permissive:'PERMISSIVE',qual:'true'}]));
 assert.equal(result.ready,false);assert.ok(result.issues.some(x=>x.includes('public_read')));
});
test('a bypass policy for desk_app fails readiness',async()=>{
 const result=await verifyMarketingSchema(fixture([{tablename:'landing_pages',policyname:'manager_override',roles:['desk_app'],cmd:'ALL',permissive:'PERMISSIVE',qual:'true'}]));
 assert.equal(result.ready,false);
});
