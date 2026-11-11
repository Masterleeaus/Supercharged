import test from 'node:test';
import assert from 'node:assert/strict';
import {enabled,fixture,A,id,thread,message} from './inbox-postgres-support.mjs';
import {createSqlDeliveryReceipts} from '../../server/modules/inbox/sql-delivery-receipts.ts';
import {createSqlDeliveryStateReader} from '../../server/modules/inbox/sql-delivery-state.ts';
const event=(providerId,eventId,outcome,providerEventAt)=>({companyId:A,provider:'gateway',eventId,providerId,outcome,payloadSha256:'a'.repeat(64),providerEventAt});
test('PostgreSQL: delivered state dominates a later provider failure',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(A,id('state-thread')),m=message(A,id('state-msg'),t.id,id('provider-inbound'));
  await f.store.insertThread(t);
  await f.store.insertMessage({...m,direction:'outbound',status:'queued',externalId:null,authorKind:'staff'});
  await f.outbox.enqueueQueued(A,10);
  const job=(await f.outbox.claim(A,50,60)).find(x=>x.messageId===m.id),providerId=id('provider');
  assert.equal(await f.outbox.markSent(A,job.id,job.leaseToken,providerId),true);
  const writer=createSqlDeliveryReceipts(f.pool),reader=createSqlDeliveryStateReader(f.pool);
  const failed=event(providerId,id('fail'), 'failed',new Date('2026-11-09T12:00:00Z'));
  const delivered=event(providerId,id('delivered'),'delivered',new Date('2026-11-09T12:01:00Z'));
  assert.equal(await writer.record(failed),'recorded');
  assert.equal((await reader.getByMessage(A,m.id)).outcome,'failed');
  assert.equal(await writer.record(delivered),'recorded');
  assert.equal((await reader.getByMessage(A,m.id)).outcome,'delivered');
  assert.equal(await writer.record(event(providerId,id('late-fail'),'failed',new Date('2026-11-09T12:02:00Z'))),'recorded');
  assert.equal((await reader.getByMessage(A,m.id)).outcome,'delivered');
  assert.equal((await reader.listRecent(A)).some(x=>x.messageId===m.id),true);
 }finally{await f.close();}
});
test('PostgreSQL: duplicate provider event cannot change projected delivery',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(A,id('dedupe-thread')),m=message(A,id('dedupe-msg'),t.id,id('provider-inbound'));
  await f.store.insertThread(t);
  await f.store.insertMessage({...m,direction:'outbound',status:'queued',externalId:null,authorKind:'staff'});
  await f.outbox.enqueueQueued(A,10);
  const job=(await f.outbox.claim(A,50,60)).find(x=>x.messageId===m.id),providerId=id('provider');
  await f.outbox.markSent(A,job.id,job.leaseToken,providerId);
  const repo=createSqlDeliveryReceipts(f.pool),reader=createSqlDeliveryStateReader(f.pool);
  const receipt=event(providerId,id('event'),'delivered',new Date('2026-11-09T13:00:00Z'));
  assert.equal(await repo.record(receipt),'recorded');
  assert.equal(await repo.record(receipt),'duplicate');
  assert.equal((await reader.getByMessage(A,m.id)).eventId,receipt.eventId);
 }finally{await f.close();}
});
