import test from 'node:test';import assert from 'node:assert/strict';
import {createSqlDeliveryStateReader} from '../../server/modules/inbox/sql-delivery-state.ts';
const A='11111111-1111-4111-8111-111111111111';
test('invalid message references cannot reach database connections',async()=>{
 let connects=0;const pool={async connect(){connects++;throw Error('unexpected connect')}};
 const service=createSqlDeliveryStateReader(pool);
 for(const id of ['', ' '.repeat(5), 'a'.repeat(201),null])
  await assert.rejects(service.getByMessage(A,id),/invalid messageId/);
 assert.equal(connects,0);
});
test('tenant-scoped recent results preserve delivery outcome and last event id',async()=>{
 const row={company_id:A,outbox_id:'outbox',message_id:'message',outcome:'failed',
 event_id:'failure-event',provider_event_at:'2026-11-09T11:01:00Z',updated_at:'2026-11-09T11:02:00Z'};
 const pool={async connect(){return{async query(sql){return{rows:sql.includes('FROM public.inbox_delivery_state')?[row]:[]}},release(){}}}};
 const result=await createSqlDeliveryStateReader(pool).listRecent(A,1);
 assert.equal(result[0].outcome,'failed');assert.equal(result[0].eventId,'failure-event');
 assert.equal(result[0].providerEventAt.toISOString(),'2026-11-09T11:01:00.000Z');
});
