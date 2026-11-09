import test from 'node:test';import assert from 'node:assert/strict';
import {verifyInboxSchema,requireInboxSchema,INBOX_TABLES} from '../../server/modules/inbox/schema-readiness.ts';
const predicate="company_id = nullif(current_setting('app.company_id', true), '')::uuid";
export function fixture(overrides={}){
 const table=relname=>({relname,relrowsecurity:true,relforcerowsecurity:true,can_select:true,can_insert:true,can_update:true});
 const policy=tablename=>({tablename,policyname:tablename+'_tenant_boundary',roles:['desk_app'],cmd:'ALL',permissive:'PERMISSIVE',qual:predicate,with_check:predicate});
 const role={rolname:'desk_app',rolsuper:false,rolbypassrls:false};
 return {async query(sql,values){
  if(sql.startsWith('SELECT rolname'))return {rows:overrides.roles??[role]};
  if(sql.includes('FROM pg_class c JOIN')){assert.deepEqual([...values[0]],INBOX_TABLES);return {rows:overrides.tables??INBOX_TABLES.map(table)};}
  if(sql.includes('FROM pg_policies'))return {rows:overrides.policies??INBOX_TABLES.map(policy)};
  throw Error('unexpected SQL '+sql);
 }};
}
test('complete enforced Inbox RLS passes',async()=>{assert.deepEqual(await verifyInboxSchema(fixture()),{ready:true,issues:[]});await requireInboxSchema(fixture());});
test('missing database inspector fails closed',async()=>await assert.rejects(requireInboxSchema(undefined),/schema probe/));
test('missing restricted role is reported without querying nonexistent role permissions',async()=>{const r=await verifyInboxSchema(fixture({roles:[]}));assert.ok(r.issues.some(x=>x.includes('desk_app role missing')));});
test('restricted role cannot be superuser or BYPASSRLS',async()=>{
 for(const property of ['rolsuper','rolbypassrls']){
  const r=await verifyInboxSchema(fixture({roles:[{rolsuper:false,rolbypassrls:false,[property]:true}]}));
  assert.equal(r.ready,false);assert.ok(r.issues.some(x=>x.includes('cannot')));
 }
});
test('all four missing tables fail closed',async()=>{const r=await verifyInboxSchema(fixture({tables:[]}));assert.equal(r.issues.filter(x=>x.endsWith('missing')).length,4);});
test('disabled FORCE RLS is detected on every table',async()=>{
 const r=await verifyInboxSchema(fixture({tables:INBOX_TABLES.map(relname=>({relname,relrowsecurity:true,relforcerowsecurity:false,can_select:true,can_insert:true,can_update:true}))}));
 assert.equal(r.issues.filter(x=>x.includes('FORCE RLS')).length,4);
});
