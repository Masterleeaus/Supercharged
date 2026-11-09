import test from 'node:test';import assert from 'node:assert/strict';
import {enabled,fixture} from './inbox-postgres-support.mjs';
import {verifyInboxSchema,requireInboxSchema,INBOX_TABLES} from '../../server/modules/inbox/schema-readiness.ts';
test('PostgreSQL: all four Inbox tables pass real deployment readiness',{skip:!enabled},async()=>{
 const f=fixture();try{assert.deepEqual(await verifyInboxSchema(f.pool),{ready:true,issues:[]});await requireInboxSchema(f.pool);}finally{await f.close();}
});
test('PostgreSQL: every Inbox RLS policy uses an ALL read/write tenant predicate',{skip:!enabled},async()=>{
 const f=fixture();try{
  const rows=(await f.pool.query("SELECT tablename,roles,cmd,permissive,qual,with_check FROM pg_policies WHERE tablename=ANY($1::text[])",[INBOX_TABLES])).rows;
  assert.equal(rows.length,4);
  const {tenantPredicate}=await import('../../server/modules/marketing/policy-inspection.ts');
  for(const r of rows){assert.equal(r.cmd,'ALL');assert.equal(r.permissive,'PERMISSIVE');assert.equal(tenantPredicate(r.qual),true);assert.equal(tenantPredicate(r.with_check),true);}
 }finally{await f.close();}
});
