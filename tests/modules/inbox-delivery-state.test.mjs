import test from 'node:test';import assert from 'node:assert/strict';
import {mapDeliveryState,validateDeliveryOutcome} from '../../server/modules/inbox/delivery-state.ts';
const A='11111111-1111-4111-8111-111111111111';
test('delivery state maps database timestamps and preserves company id',()=>{
 const now=new Date('2026-11-09T00:00:00Z');
 const row=mapDeliveryState({company_id:A,outbox_id:'outbox',message_id:'message',outcome:'delivered',event_id:'e',provider_event_at:null,updated_at:now});
 assert.equal(row.companyId,A);assert.equal(row.messageId,'message');assert.equal(row.providerEventAt,null);assert.equal(row.updatedAt.getTime(),now.getTime());
});
test('only provider-confirmed terminal outcomes are accepted',()=>{
 for(const status of ['queued','sent','unknown',null])assert.throws(()=>validateDeliveryOutcome(status),/invalid outcome/);
 assert.doesNotThrow(()=>validateDeliveryOutcome('delivered'));assert.doesNotThrow(()=>validateDeliveryOutcome('failed'));
});
test('invalid tenant in a projected row fails closed',()=>assert.throws(()=>mapDeliveryState({company_id:'bad'}),/companyId/));
