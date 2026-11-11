import test from 'node:test';import assert from 'node:assert/strict';
import {enabled,fixture,A,B,id,thread,message} from './inbox-postgres-support.mjs';
import {createSqlDeliveryReceipts} from '../../server/modules/inbox/sql-delivery-receipts.ts';
const receipt=(companyId,providerId,eventId)=>({companyId,provider:'gateway',providerId,eventId,outcome:'delivered',payloadSha256:'a'.repeat(64),providerEventAt:null});
test('PostgreSQL: callback evidence is recorded once for an acknowledged outbound job',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(A,id('receipt-t')),m=message(A,id('receipt-m'),t.id,id('receipt-external'));
  await f.store.insertThread(t);await f.store.insertMessage({...m,direction:'outbound',status:'queued',externalId:null,authorKind:'staff'});
  await f.outbox.enqueueQueued(A,10);const job=(await f.outbox.claim(A,50,60)).find(x=>x.messageId===m.id);
  const providerId=id('provider');await f.outbox.markSent(A,job.id,job.leaseToken,providerId);
  const repo=createSqlDeliveryReceipts(f.pool),e=receipt(A,providerId,id('callback'));
  assert.equal(await repo.record(e),'recorded');assert.equal(await repo.record(e),'duplicate');
  assert.equal(await repo.record(receipt(B,providerId,id('foreign'))),'unmatched');
 }finally{await f.close();}
});
