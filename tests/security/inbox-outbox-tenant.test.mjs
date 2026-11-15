import test from 'node:test';import assert from 'node:assert/strict';
import {createOutboxDispatcher} from '../../server/modules/inbox/outbox-dispatcher.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
test('worker will not transmit a returned job belonging to another company',async()=>{
 let sent=false;const repo={claim:async()=>[{companyId:B,id:'job',leaseToken:'lease'}],loadDelivery:async()=>({body:'body',recipient:'a@example.com',subject:null}),markSent:async()=>true,markRetry:async()=>true};
 await assert.rejects(createOutboxDispatcher(repo,{send:async()=>{sent=true}}).runOnce(A),/invalid claimed tenant/);
 assert.equal(sent,false);
});
test('invalid user company cannot claim or send',async()=>{
 let claimed=false;const repo={claim:async()=>{claimed=true;return[]},loadDelivery:async()=>null,markSent:async()=>false,markRetry:async()=>false};
 await assert.rejects(createOutboxDispatcher(repo,{send:async()=>({providerId:'ok'})}).runOnce('invalid'),/companyId/);
 assert.equal(claimed,false);
});
