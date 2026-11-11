import test from 'node:test';
import assert from 'node:assert/strict';
import {enabled,createFixture} from './marketing-postgres-support.mjs';
import {inspectMarketingPolicies} from '../../server/modules/marketing/policy-inspection.ts';
test('PostgreSQL: actual policy metadata passes strict policy inspection',{skip:!enabled},async()=>{
 const f=createFixture();try{
  const rows=(await f.pool.query("SELECT tablename,policyname,roles,cmd,permissive,qual,with_check FROM pg_policies WHERE tablename = ANY($1::text[])",[['landing_pages','content_items']])).rows;
  for(const table of ['landing_pages','content_items']) assert.deepEqual(inspectMarketingPolicies(table,rows),[]);
 }finally{await f.close();}
});
