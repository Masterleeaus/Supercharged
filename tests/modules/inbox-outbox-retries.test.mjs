import test from 'node:test';import assert from 'node:assert/strict';
import {createOutboxDispatcher} from '../../server/modules/inbox/outbox-dispatcher.ts';
const A='11111111-1111-4111-8111-111111111111';
const job=(attempts)=>({id:'job',companyId:A,messageId:'message',channel:'sms',leaseToken:'token',attempts});
test('provider exception schedules retry without recording success',async()=>{
 const calls=[],repo={claim:async()=>[job(1)],loadBody:async()=> 'hello',markSent:async()=>{throw Error('must not mark success')},markRetry:async(...a)=>{calls.push(a);return true}};
 const result=await createOutboxDispatcher(repo,{send:async()=>{throw Error('temporary outage')}}).runOnce(A);
 assert.equal(result.retried,1);assert.equal(calls[0][4],'temporary outage');assert.equal(calls[0][5],false);assert.ok(calls[0][3]>=10);
});
test('fifth failed attempt enters dead-letter state',async()=>{
 const calls=[],repo={claim:async()=>[job(5)],loadBody:async()=> 'hello',markSent:async()=>true,markRetry:async(...a)=>{calls.push(a);return true}};
 const r=await createOutboxDispatcher(repo,{send:async()=>{throw Error('still unavailable')}}).runOnce(A);
 assert.equal(r.dead,1);assert.equal(calls[0][5],true);
});
test('missing provider acknowledgment is not silently marked sent',async()=>{
 const calls=[],repo={claim:async()=>[job(1)],loadBody:async()=> 'hello',markSent:async()=>{throw Error('bad success')},markRetry:async(...a)=>{calls.push(a);return true}};
 await createOutboxDispatcher(repo,{send:async()=>({providerId:''})}).runOnce(A);
 assert.equal(calls.length,1);
});
