import test from 'node:test';
import assert from 'node:assert/strict';
import {enabled,createFixture} from './marketing-postgres-support.mjs';
import {verifyMarketingSchema,requireMarketingSchema} from '../../server/modules/marketing/schema-readiness.ts';
test('PostgreSQL: deployment readiness matches actual row-level privileges and policies',{skip:!enabled},async()=>{
 const fixture=createFixture();
 try {
  const state=await verifyMarketingSchema(fixture.pool);
  assert.deepEqual(state,{ready:true,issues:[]});
  await requireMarketingSchema(fixture.pool);
 } finally {await fixture.close();}
});
