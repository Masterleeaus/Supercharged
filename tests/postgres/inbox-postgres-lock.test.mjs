import test from 'node:test';import assert from 'node:assert/strict';
import {A,enabled,fixture,id,participant,thread,message} from './inbox-postgres-support.mjs';
test('PostgreSQL: advisory-locked nested writes reuse one pool connection',{skip:!enabled},async()=>{
 const f=fixture();try{
  const p=participant(A,id('contact')),t=thread(A,id('thread'));
  await f.store.lockInboundKey(A,'email',p.address,async()=>{
   await f.store.insertParticipant(p);await f.store.insertThread(t);
   await f.store.linkParticipant({companyId:A,threadId:t.id,participantId:p.id});
   assert.equal((await f.store.findThread(A,t.id)).id,t.id);
  });
  assert.equal((await f.store.findContactParticipant(A,'email',p.address)).id,p.id);
 }finally{await f.close();}
});
test('PostgreSQL: lock rolls back all nested writes on error',{skip:!enabled},async()=>{
 const f=fixture();try{const p=participant(A,id('rollback'));
  await assert.rejects(f.store.lockInboundKey(A,'email',p.address,async()=>{await f.store.insertParticipant(p);throw Error('abort')}),/abort/);
  assert.equal(await f.store.findContactParticipant(A,'email',p.address),null);
 }finally{await f.close();}
});
