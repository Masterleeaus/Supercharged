import test from 'node:test';import assert from 'node:assert/strict';
import {enabled,fixture,A,B,id,thread,message} from './inbox-postgres-support.mjs';
import {createSqlOutbox} from '../../server/modules/inbox/sql-outbox.ts';
test('PostgreSQL: a company cannot claim or update another company outbox lease',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(B,id('b-thread')),m=message(B,id('b-msg'),t.id,id('b-provider'));
  await f.store.insertThread(t);await f.store.insertMessage({...m,direction:'outbound',status:'queued',externalId:null,authorKind:'staff'});
  const q=createSqlOutbox(f.pool);await q.enqueueQueued(B,10);
  assert.equal((await q.claim(A,50,120)).filter(x=>x.messageId===m.id).length,0);
  const job=(await q.claim(B,50,120)).find(x=>x.messageId===m.id);assert.ok(job);
  assert.equal(await q.markSent(A,job.id,job.leaseToken,id('forged-provider')),false);
  assert.equal(await q.markSent(B,job.id,job.leaseToken,id('legitimate-provider')),true);
 }finally{await f.close();}
});
