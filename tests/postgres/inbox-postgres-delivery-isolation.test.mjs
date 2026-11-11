import test from 'node:test';import assert from 'node:assert/strict';
import {enabled,fixture,A,B,id,thread,message} from './inbox-postgres-support.mjs';
import {createSqlDeliveryReceipts} from '../../server/modules/inbox/sql-delivery-receipts.ts';
import {createSqlDeliveryStateReader} from '../../server/modules/inbox/sql-delivery-state.ts';
test('PostgreSQL: delivery projections are invisible outside their company',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(B,id('other-thread')),m=message(B,id('other-msg'),t.id,id('source'));
  await f.store.insertThread(t);
  await f.store.insertMessage({...m,direction:'outbound',status:'queued',externalId:null,authorKind:'staff'});
  await f.outbox.enqueueQueued(B,10);
  const job=(await f.outbox.claim(B,50,60)).find(x=>x.messageId===m.id),pid=id('provider');
  await f.outbox.markSent(B,job.id,job.leaseToken,pid);
  const receipts=createSqlDeliveryReceipts(f.pool);
  assert.equal(await receipts.record({companyId:B,provider:'gateway',providerId:pid,eventId:id('event'),outcome:'delivered',payloadSha256:'a'.repeat(64),providerEventAt:null}),'recorded');
  const reader=createSqlDeliveryStateReader(f.pool);
  assert.equal(await reader.getByMessage(A,m.id),null);
  assert.equal((await reader.getByMessage(B,m.id)).outcome,'delivered');
  assert.equal((await reader.listRecent(A)).some(x=>x.messageId===m.id),false);
 }finally{await f.close();}
});
test('PostgreSQL: composite foreign key denies forged cross-tenant projection',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(B,id('fk-thread')),m=message(B,id('fk-msg'),t.id,id('provider'));
  await f.store.insertThread(t);
  await f.store.insertMessage({...m,direction:'outbound',status:'queued',externalId:null,authorKind:'staff'});
  await f.outbox.enqueueQueued(B,10);
  const job=(await f.outbox.claim(B,50,60)).find(x=>x.messageId===m.id);
  await assert.rejects(f.pool.query(`INSERT INTO inbox_delivery_state(company_id,outbox_id,outcome,event_id)
     VALUES($1,$2,'failed','forged')`,[A,job.id]),err=>err.code==='23503');
 }finally{await f.close();}
});
