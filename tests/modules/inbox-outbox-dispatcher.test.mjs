import test from 'node:test';import assert from 'node:assert/strict';
import {createOutboxDispatcher} from '../../server/modules/inbox/outbox-dispatcher.ts';
const A='11111111-1111-4111-8111-111111111111';
const job={id:'job1',companyId:A,messageId:'m1',channel:'email',status:'leased',attempts:1,leaseToken:'lease1'};
test('provider succeeds only with a concrete acknowledgment and stable idempotency key',async()=>{
 const events=[],repo={claim:async()=>[job],loadBody:async()=> 'Hello',markSent:async(...args)=>{events.push(['sent',...args]);return true},markRetry:async()=>{throw Error('unexpected retry')}};
 const transport={send:async args=>{events.push(['send',args]);return{providerId:'provider-1'}}};
 const result=await createOutboxDispatcher(repo,transport).runOnce(A);
 assert.deepEqual(result,{claimed:1,sent:1,retried:0,dead:0,stale:0});
 assert.equal(events[0][1].idempotencyKey,'inbox:'+A+':m1');
 assert.deepEqual(events[1],['sent',A,'job1','lease1','provider-1']);
});
test('message no longer queued is dead-lettered without external delivery',async()=>{
 let sent=false;const repo={claim:async()=>[job],loadBody:async()=>null,markSent:async()=>true,markRetry:async(...args)=>{assert.equal(args[5],true);return true}};
 const r=await createOutboxDispatcher(repo,{send:async()=>{sent=true}}).runOnce(A);
 assert.equal(sent,false);assert.equal(r.dead,1);
});
test('missing transport cannot construct a dispatcher',()=>assert.throws(()=>createOutboxDispatcher({claim(){},markSent(){},markRetry(){},loadBody(){}},{}),/idempotent provider transport/));
