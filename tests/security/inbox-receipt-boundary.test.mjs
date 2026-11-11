import test from 'node:test';import assert from 'node:assert/strict';
import {createReceiptService} from '../../server/modules/inbox/receipt-service.ts';
test('malformed integration IDs are rejected before resolving secrets',async()=>{
 let resolved=0;const s=createReceiptService({resolve:async()=>{resolved++;return null;}},{record:async()=>{throw Error('unexpected record')}});
 for(const id of ['','x','../private',''.padEnd(129,'a')])await assert.rejects(s.receive({integrationId:id,rawBody:Buffer.from('{}')}),/invalid integration id/);
 assert.equal(resolved,0);
});
test('an unconfigured service cannot be created without a trusted resolver and persistent storage',()=>{
 assert.throws(()=>createReceiptService(null,{record:async()=>{}}),/trusted integration resolver/);
 assert.throws(()=>createReceiptService({resolve:async()=>null},null),/durable repository/);
});
