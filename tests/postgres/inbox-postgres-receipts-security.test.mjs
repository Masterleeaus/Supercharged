import test from 'node:test';import assert from 'node:assert/strict';
import {enabled,fixture,A,B,id} from './inbox-postgres-support.mjs';
import {createSqlDeliveryReceipts} from '../../server/modules/inbox/sql-delivery-receipts.ts';
test('PostgreSQL: arbitrary unknown provider IDs cannot create delivery evidence',{skip:!enabled},async()=>{
 const f=fixture();try{
  const repo=createSqlDeliveryReceipts(f.pool);
  const eventId=id('unknown'),providerId=id('missing');
  const count=async()=>Number((await f.pool.query(
   'SELECT count(*) AS n FROM inbox_delivery_receipts WHERE company_id=$1 AND provider=$2 AND event_id=$3',
   [A,'gateway',eventId])).rows[0].n);
  assert.equal(await count(),0);
  assert.equal(await repo.record({companyId:A,provider:'gateway',eventId,providerId,outcome:'failed',payloadSha256:'f'.repeat(64),providerEventAt:null}),'unmatched');
  assert.equal(await count(),0);
 }finally{await f.close();}
});
