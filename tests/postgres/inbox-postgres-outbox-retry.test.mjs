import test from 'node:test';import assert from 'node:assert/strict';
import {enabled,fixture,A,id,thread,message} from './inbox-postgres-support.mjs';
import {createSqlOutbox} from '../../server/modules/inbox/sql-outbox.ts';
test('PostgreSQL: lease token prevents stale retry after another outcome',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(A,id('retry-thread')),m=message(A,id('retry-msg'),t.id,id('retry-provider'));
  await f.store.insertThread(t);await f.store.insertMessage({...m,direction:'outbound',status:'queued',externalId:null,authorKind:'staff'});
  const q=createSqlOutbox(f.pool);await q.enqueueQueued(A,10);
  const job=(await q.claim(A,50,60)).find(x=>x.messageId===m.id);assert.ok(job);
  assert.equal(await q.markRetry(A,job.id,job.leaseToken,10,'temporary',false),true);
  assert.equal(await q.markSent(A,job.id,job.leaseToken,'late-ack'),false);
  assert.equal((await f.pool.query('SELECT status FROM inbox_outbox WHERE id=$1',[job.id])).rows[0].status,'retry');
 }finally{await f.close();}
});
