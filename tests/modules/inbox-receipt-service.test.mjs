import test from 'node:test';import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';import {createReceiptService} from '../../server/modules/inbox/receipt-service.ts';
const A='11111111-1111-4111-8111-111111111111',secret='1234'.repeat(12),now=1762660800000,ts=String(Math.floor(now/1000));
const rawBody=Buffer.from('{"eventId":"event-1","providerId":"message-1","outcome":"delivered"}');
const signature='sha256='+createHmac('sha256',secret).update(ts).update('.').update(rawBody).digest('hex');
test('valid signature resolves one tenant and writes a delivery fact',async()=>{
 const calls=[],service=createReceiptService({resolve:async id=>{calls.push(['resolve',id]);return{companyId:A,provider:'gateway',secret};}},
 {record:async r=>{calls.push(['record',r]);return 'recorded';}});
 const result=await service.receive({integrationId:'integration-1',timestamp:ts,signature,rawBody,now});
 assert.equal(result,'recorded');assert.equal(calls[1][1].companyId,A);
});
test('bad HMAC cannot write any delivery fact',async()=>{
 let writes=0;const s=createReceiptService({resolve:async()=>({companyId:A,provider:'gateway',secret})},{record:async()=>{writes++;return'recorded'}});
 await assert.rejects(s.receive({integrationId:'integration-1',timestamp:ts,signature:'sha256='+'0'.repeat(64),rawBody,now}),/invalid_provider_signature/);
 assert.equal(writes,0);
});
test('unknown integration never reaches delivery storage',async()=>{
 let writes=0;const s=createReceiptService({resolve:async()=>null},{record:async()=>{writes++;return 'recorded'}});
 await assert.rejects(s.receive({integrationId:'integration-1',timestamp:ts,signature,rawBody,now}),/unknown integration/);assert.equal(writes,0);
});
