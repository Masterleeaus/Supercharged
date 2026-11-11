import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {parseDeliveryReceipt} from '../../server/modules/inbox/delivery-receipt.ts';
const A='11111111-1111-4111-8111-111111111111',body=Buffer.from(JSON.stringify({eventId:'delivery-1',providerId:'provider-1',outcome:'delivered',occurredAt:'2026-11-09T03:00:00Z',companyId:'a-forged-company'}));
test('callback company is taken only from trusted integration binding',()=>{
 const r=parseDeliveryReceipt(A,'gateway',body);assert.equal(r.companyId,A);assert.equal(r.outcome,'delivered');
 assert.equal(r.payloadSha256,createHash('sha256').update(body).digest('hex'));assert.ok(r.providerEventAt instanceof Date);
});
test('unknown outcomes and missing provider references fail closed',()=>{
 for(const b of [{eventId:'one',providerId:'x',outcome:'queued'},{eventId:'one',outcome:'delivered'},{providerId:'x',outcome:'failed'}])
 assert.throws(()=>parseDeliveryReceipt(A,'gateway',Buffer.from(JSON.stringify(b))),/receipt:/);
});
test('invalid provider namespace and malformed JSON are rejected',()=>{
 assert.throws(()=>parseDeliveryReceipt(A,'Not Safe',body),/invalid provider/);
 assert.throws(()=>parseDeliveryReceipt(A,'gateway',Buffer.from('not json')),/malformed JSON/);
});
