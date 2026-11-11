import test from 'node:test';import assert from 'node:assert/strict';
import {verifyInboxSchema,INBOX_TABLES} from '../../server/modules/inbox/schema-readiness.ts';
import {fixture} from './inbox-schema-readiness.test.mjs';
const pred="company_id = nullif(current_setting('app.company_id', true), '')::uuid";
const base=tablename=>({tablename,policyname:tablename+'_tenant_boundary',roles:['desk_app'],cmd:'ALL',permissive:'PERMISSIVE',qual:pred,with_check:pred});
test('no tenant policies refuses deployment on all four tables',async()=>{
 const r=await verifyInboxSchema(fixture({policies:[]}));assert.equal(r.ready,false);assert.equal(r.issues.filter(i=>i.includes('tenant policy missing')).length,4);
});
test('a permissive PUBLIC bypass fails readiness',async()=>{
 const p=[...INBOX_TABLES.map(base),{tablename:'inbox_messages',policyname:'bypass',roles:['public'],cmd:'SELECT',permissive:'PERMISSIVE',qual:'true',with_check:null}];
 const r=await verifyInboxSchema(fixture({policies:p}));assert.equal(r.ready,false);assert.ok(r.issues.some(x=>x.includes('bypass')));
});
test('missing write predicate cannot pass',async()=>{
 const p=INBOX_TABLES.map(base);p[0].with_check=null;
 const r=await verifyInboxSchema(fixture({policies:p}));assert.ok(r.issues.some(x=>x.includes('inbox_participants tenant policy')));
});
test('missing update privilege blocks service readiness',async()=>{
 const t=INBOX_TABLES.map(relname=>({relname,relrowsecurity:true,relforcerowsecurity:true,can_select:true,can_insert:true,can_update:relname!=='inbox_messages'}));
 const r=await verifyInboxSchema(fixture({tables:t}));assert.ok(r.issues.some(x=>x.includes('inbox_messages missing desk_app CRUD')));
});
test('additive restrictive rules remain safe',async()=>{
 const p=[...INBOX_TABLES.map(base),{tablename:'inbox_threads',policyname:'restrict_more',roles:['desk_app'],cmd:'ALL',permissive:'RESTRICTIVE',qual:'false',with_check:'false'}];
 assert.equal((await verifyInboxSchema(fixture({policies:p}))).ready,true);
});
