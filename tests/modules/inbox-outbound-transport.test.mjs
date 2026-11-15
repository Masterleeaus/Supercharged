import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOutboxDispatcher} from '../../server/modules/inbox/outbox-dispatcher.ts';
import {createInboxOutboundTransport,failureFromAdapterReason} from '../../server/modules/inbox/outbound-transport.ts';
import {createInboxOutboundWorker,inboxOutboundEnabled} from '../../server/modules/inbox/outbound-worker.ts';
import {createEmailOutboundSender,createSmsOutboundSender} from '../../server/modules/inbox/outbound-senders.ts';
import {OutboxSendError} from '../../server/modules/inbox/outbox-types.ts';

const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';

// In-memory outbox that follows the SQL semantics: company scoping, queued-only delivery, lease tokens.
function memoryOutbox(messages){
 const rows=[];let clock=1000,token=0;
 const repo={
  now:()=>clock,
  advance(seconds){clock+=seconds;},
  rows,
  async enqueueQueued(co,limit){
   let n=0;
   for(const m of messages){
    if(n>=limit)break;
    if(m.companyId!==co||m.direction!=='outbound'||m.status!=='queued')continue;
    if(rows.some(r=>r.companyId===co&&r.messageId===m.id))continue;
    rows.push({id:'job-'+m.id,companyId:co,messageId:m.id,channel:m.channel,status:'queued',attempts:0,nextAt:clock,leasedUntil:null,leaseToken:null,providerId:null,lastError:null});
    n++;
   }
   return n;
  },
  async claim(co,limit,lease){
   return rows.filter(r=>r.companyId===co&&((['queued','retry'].includes(r.status)&&r.nextAt<=clock)||(r.status==='leased'&&r.leasedUntil<=clock))).slice(0,limit).map(r=>{
    r.status='leased';r.attempts++;r.leaseToken='lease-'+(++token);r.leasedUntil=clock+lease;return{...r};
   });
  },
  async loadDelivery(co,messageId){
   const m=messages.find(x=>x.id===messageId&&x.companyId===co&&x.direction==='outbound'&&x.status==='queued');
   return m?{body:m.body,recipient:m.recipient??null,subject:m.subject??null}:null;
  },
  async markSent(co,id,leaseToken,providerId){
   const r=rows.find(x=>x.id===id&&x.companyId===co&&x.leaseToken===leaseToken&&x.status==='leased');
   if(!r)return false;r.status='sent';r.providerId=providerId;r.leaseToken=null;r.leasedUntil=null;return true;
  },
  async markRetry(co,id,leaseToken,delay,code,dead){
   const r=rows.find(x=>x.id===id&&x.companyId===co&&x.leaseToken===leaseToken&&x.status==='leased');
   if(!r)return false;r.status=dead?'dead':'retry';r.nextAt=clock+delay;r.lastError=code;r.leaseToken=null;r.leasedUntil=null;return true;
  },
 };
 return repo;
}

// Fake provider gateway. An idempotent provider returns the first providerId for a repeated key and records one delivery.
// plan entries: 'ok' (default), 'fail' (error before accepting), 'ack-lost' (accepts, then errors).
function fakeGateway({idempotent=true,plan=[]}={}){
 const accepted=new Map(),deliveries=[],requests=[];
 let n=0;
 return{
  requests,deliveries,
  async deliver(req){
   requests.push(req);
   const step=plan.shift()??'ok';
   if(step==='fail')throw Error('network down 61400000000');
   let providerId=idempotent?accepted.get(req.idempotencyKey):undefined;
   if(!providerId){
    providerId='prov-'+(++n);
    deliveries.push({key:req.idempotencyKey,to:req.recipient,body:req.body});
    accepted.set(req.idempotencyKey,providerId);
   }
   if(step==='ack-lost')throw Error('timeout after accept');
   return{providerId};
  }
 };
}

function senderOver(gateway,idempotent){
 return{idempotent,send:req=>gateway.deliver(req)};
}

const queuedSms=(over={})=>({id:'m1',companyId:A,direction:'outbound',status:'queued',channel:'sms',body:'Hello',recipient:'+61400000000',subject:null,...over});

function harness({messages,sender,idempotent=true,plan}){
 const gateway=fakeGateway({idempotent,plan});
 const repo=memoryOutbox(messages);
 const transport=createInboxOutboundTransport({sms:sender??senderOver(gateway,idempotent)});
 const worker=createInboxOutboundWorker({repo,transport,listCompanyIds:async()=>[A]});
 return{gateway,repo,worker};
}

test('a queued message is picked up by the worker and sent exactly once',async()=>{
 const{gateway,repo,worker}=harness({messages:[queuedSms()]});
 const first=await worker.tick();
 assert.equal(first.enqueued,1);assert.equal(first.sent,1);
 const second=await worker.tick();
 assert.equal(second.enqueued,0);assert.equal(second.sent,0);
 assert.equal(gateway.deliveries.length,1);
 assert.equal(gateway.requests[0].idempotencyKey,'inbox:'+A+':m1');
 assert.equal(repo.rows[0].status,'sent');
});

test('a failed send is retried and not duplicated',async()=>{
 const{gateway,repo,worker}=harness({messages:[queuedSms()],plan:['fail']});
 const first=await worker.tick();
 assert.equal(first.retried,1);assert.equal(first.sent,0);
 assert.equal(gateway.deliveries.length,0);
 assert.equal(repo.rows[0].status,'retry');
 repo.advance(60);
 const second=await worker.tick();
 assert.equal(second.sent,1);
 assert.equal(gateway.requests.length,2);
 assert.equal(gateway.deliveries.length,1);
 assert.equal(gateway.requests[0].idempotencyKey,gateway.requests[1].idempotencyKey);
});

test('a provider that accepted but lost the acknowledgment is not duplicated on retry',async()=>{
 const{gateway,repo,worker}=harness({messages:[queuedSms()],plan:['ack-lost']});
 assert.equal((await worker.tick()).retried,1);
 repo.advance(60);
 assert.equal((await worker.tick()).sent,1);
 assert.equal(gateway.requests.length,2);
 assert.equal(gateway.deliveries.length,1);
});

test('a non-idempotent sender is dead-lettered after a provider call fails, never retried',async()=>{
 const{gateway,repo,worker}=harness({messages:[queuedSms()],idempotent:false,plan:['ack-lost']});
 const first=await worker.tick();
 assert.equal(first.dead,1);
 assert.equal(repo.rows[0].status,'dead');
 assert.equal(repo.rows[0].lastError,'provider_error');
 repo.advance(100000);
 await worker.tick();
 assert.equal(gateway.requests.length,1);
});

test('a refusal before any provider call is dead-lettered and nothing is sent',async()=>{
 const gateway=fakeGateway();
 const sms=createSmsOutboundSender({idempotent:false,adapter:{send:async()=>({ok:false,reason:'quiet_hours'})}});
 const repo=memoryOutbox([queuedSms()]);
 const worker=createInboxOutboundWorker({repo,transport:createInboxOutboundTransport({sms}),listCompanyIds:async()=>[A]});
 assert.equal((await worker.tick()).dead,1);
 assert.equal(repo.rows[0].lastError,'quiet_hours');
 assert.equal(gateway.requests.length,0);
});

test('an audit refusal before the request is retried later',async()=>{
 const sms=createSmsOutboundSender({idempotent:false,adapter:{send:async()=>({ok:false,reason:'audit_unavailable'})}});
 const repo=memoryOutbox([queuedSms()]);
 const worker=createInboxOutboundWorker({repo,transport:createInboxOutboundTransport({sms}),listCompanyIds:async()=>[A]});
 assert.equal((await worker.tick()).retried,1);
 assert.equal(repo.rows[0].status,'retry');
});

test('a channel with no configured sender never reaches a provider',async()=>{
 const gateway=fakeGateway();
 const repo=memoryOutbox([queuedSms({id:'w1',channel:'whatsapp'})]);
 const worker=createInboxOutboundWorker({repo,transport:createInboxOutboundTransport({sms:senderOver(gateway,true)}),listCompanyIds:async()=>[A]});
 const r=await worker.tick();
 assert.equal(r.retried,1);
 assert.equal(gateway.requests.length,0);
 assert.equal(repo.rows[0].lastError,'provider_not_configured');
});

test('a message without a contact recipient is dead-lettered without a provider call',async()=>{
 const gateway=fakeGateway();
 const repo=memoryOutbox([queuedSms({recipient:null})]);
 const worker=createInboxOutboundWorker({repo,transport:createInboxOutboundTransport({sms:senderOver(gateway,true)}),listCompanyIds:async()=>[A]});
 assert.equal((await worker.tick()).dead,1);
 assert.equal(repo.rows[0].lastError,'recipient_missing');
 assert.equal(gateway.requests.length,0);
});

test('the worker serves only the listed companies',async()=>{
 const gateway=fakeGateway();
 const repo=memoryOutbox([queuedSms(),queuedSms({id:'b1',companyId:B})]);
 const worker=createInboxOutboundWorker({repo,transport:createInboxOutboundTransport({sms:senderOver(gateway,true)}),listCompanyIds:async()=>[A]});
 await worker.tick();
 assert.equal(gateway.deliveries.length,1);
 assert.equal(gateway.deliveries[0].key,'inbox:'+A+':m1');
 assert.equal(repo.rows.filter(r=>r.companyId===B).length,0);
});

test('overlapping ticks are skipped, not run twice',async()=>{
 const gateway=fakeGateway();
 let release;const gate=new Promise(r=>{release=r;});
 const repo=memoryOutbox([queuedSms()]);
 const worker=createInboxOutboundWorker({repo,transport:createInboxOutboundTransport({sms:senderOver(gateway,true)}),listCompanyIds:async()=>{await gate;return[A];}});
 const running=worker.tick();
 const overlapped=await worker.tick();
 assert.equal(overlapped.skipped,true);
 release();
 assert.equal((await running).sent,1);
 assert.equal(gateway.deliveries.length,1);
});

test('the transport refuses unknown channels and bad sender declarations',()=>{
 assert.throws(()=>createInboxOutboundTransport({telegram:{idempotent:true,send:async()=>({providerId:'x'})}}),/unknown channel/);
 assert.throws(()=>createInboxOutboundTransport({sms:{send:async()=>({providerId:'x'})}}),/idempotent/);
});

test('the enable flag needs both comms flags set to exactly true',()=>{
 assert.equal(inboxOutboundEnabled({COMMS_INBOX_ENABLED:'true',COMMS_INBOX_OUTBOUND_ENABLED:'true'}),true);
 assert.equal(inboxOutboundEnabled({COMMS_INBOX_ENABLED:'true',COMMS_INBOX_OUTBOUND_ENABLED:'1'}),false);
 assert.equal(inboxOutboundEnabled({COMMS_INBOX_OUTBOUND_ENABLED:'true'}),false);
 assert.equal(inboxOutboundEnabled({}),false);
});

test('email sender uses a Message-ID derived from the idempotency key and maps refusals to fixed codes',async()=>{
 const seen=[];
 const adapter=async msg=>{seen.push(msg);return{success:true,messageId:undefined};};
 const sender=createEmailOutboundSender({idempotent:false,adapterFor:()=>adapter});
 const key='inbox:'+A+':m1';
 const first=await sender.send({companyId:A,recipient:'a@example.com',subject:'Hi',body:'x',idempotencyKey:key});
 await sender.send({companyId:A,recipient:'a@example.com',subject:'Hi',body:'x',idempotencyKey:key});
 const expected='<'+createHash('sha256').update(key,'utf8').digest('hex')+'@inbox.invalid>';
 assert.equal(seen[0].headers['Message-ID'],expected);
 assert.equal(seen[1].headers['Message-ID'],expected);
 assert.equal(first.providerId,expected);
 const failing=createEmailOutboundSender({idempotent:false,adapterFor:()=>async()=>({success:false,error:'bounce to a@example.com'})});
 await assert.rejects(failing.send({companyId:A,recipient:'a@example.com',subject:null,body:'x',idempotencyKey:key}),err=>{
  assert.ok(err instanceof OutboxSendError);assert.equal(err.code,'email_send_failed');assert.equal(err.retryable,false);
  assert.ok(!err.message.includes('@'));return true;
 });
});

test('adapter reason mapping keeps retries for safe cases only',()=>{
 assert.equal(failureFromAdapterReason('opted_out',true).retryable,false);
 assert.equal(failureFromAdapterReason('audit_unavailable',false).retryable,true);
 assert.equal(failureFromAdapterReason('provider_error',false).retryable,false);
 assert.equal(failureFromAdapterReason('provider_error',true).retryable,true);
});
