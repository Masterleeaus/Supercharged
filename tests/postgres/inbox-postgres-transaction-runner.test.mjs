import test from 'node:test';import assert from 'node:assert/strict';
import {A,B,enabled,fixture,id,thread,message} from './inbox-postgres-support.mjs';
import {inboxTransactionsFor} from '../../server/modules/inbox/sql-transaction-runner.ts';
test('PostgreSQL: runner commits message changes under its own company context',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(A,id('approval-thread')),m=message(A,id('approval-msg'),t.id,id('approval-external'));
  await f.store.insertThread(t);await f.store.insertMessage(m);
  const run=inboxTransactionsFor(f.pool);
  const updated=await run(A).runInTransaction(tx=>tx.updateMessage(A,m.id,{status:'queued',queuedAt:new Date()}));
  assert.equal(updated.status,'queued');
  assert.equal((await f.store.findMessage(A,m.id)).status,'queued');
  assert.equal(await f.store.findMessage(B,m.id),null);
 }finally{await f.close();}
});
test('PostgreSQL: cross-company write attempt rolls back the previous operation',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(A,id('rollback-thread')),m=message(A,id('rollback-msg'),t.id,id('rollback-external'));
  await f.store.insertThread(t);await f.store.insertMessage(m);
  const run=inboxTransactionsFor(f.pool);
  await assert.rejects(run(A).runInTransaction(async tx=>{
    await tx.updateMessage(A,m.id,{status:'queued'});
    await tx.updateMessage(B,m.id,{status:'queued'});
  }),/different company/);
  assert.equal((await f.store.findMessage(A,m.id)).status,'received');
 }finally{await f.close();}
});
