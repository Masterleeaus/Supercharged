import test from 'node:test';import assert from 'node:assert/strict';
import {enabled,fixture,A,B,id} from './inbox-postgres-support.mjs';
import {createSqlDeliveryReceipts} from '../../server/modules/inbox/sql-delivery-receipts.ts';
test('PostgreSQL: arbitrary unknown provider IDs cannot create delivery evidence',{skip:!enabled},async()=>{
 const f=fixture();try{
  const repo=createSqlDeliveryReceipts(f.pool);
  const before=Number((await f.pool.query('SELECT count(*) AS n FROM inbox_delivery_receipts')).rows[0].n);
  assert.equal(await repo.record({companyId:A,provider:'gateway',eventId:id('unknown'),providerId:id('missing'),outcome:'failed',payloadSha256:'f'.repeat(64),providerEventAt:null}),'unmatched');
  const after=Number((await f.pool.query('SELECT count(*) AS n FROM inbox_delivery_receipts')).rows[0].n);
  assert.equal(after,before);
 }finally{await f.close();}
});
