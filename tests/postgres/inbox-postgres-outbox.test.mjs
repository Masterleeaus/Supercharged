import test from 'node:test';import assert from 'node:assert/strict';
import {enabled,fixture,A,id,thread,message} from './inbox-postgres-support.mjs';
import {createSqlOutbox} from '../../server/modules/inbox/sql-outbox.ts';
test('PostgreSQL: queue enrollment is idempotent and lease claim is conditional',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(A,id('outbox-thread')),m=message(A,id('outbox-message'),t.id,id('outbox-provider'));
  await f.store.insertThread(t);await f.store.insertMessage({...m,direction:'outbound',status:'queued',externalId:null,authorKind:'staff'});
  const q=createSqlOutbox(f.pool);
  assert.equal(await q.enqueueQueued(A,10),1);assert.equal(await q.enqueueQueued(A,10),0);
  const jobs=await q.claim(A,10,60);assert.equal(jobs.filter(x=>x.messageId===m.id).length,1);
  const job=jobs.find(x=>x.messageId===m.id);assert.equal(job.status,'leased');
  assert.equal(await q.markSent(A,job.id,job.leaseToken,id('provider-ack')),true);
  assert.equal(await q.markSent(A,job.id,job.leaseToken,id('duplicate-ack')),false);
 }finally{await f.close();}
});
