import test from 'node:test';
import assert from 'node:assert/strict';
import {A,B,enabled,fixture,id,participant,thread,message} from './inbox-postgres-support.mjs';
test('PostgreSQL: participants, threads, links and messages persist across store instances',{skip:!enabled},async()=>{
 const f=fixture();try{
  const p=participant(A,id('p')),t=thread(A,id('t')),m=message(A,id('m'),t.id,id('external'));
  await f.store.insertParticipant(p);await f.store.insertThread(t);await f.store.linkParticipant({companyId:A,threadId:t.id,participantId:p.id});await f.store.insertMessage(m);
  assert.equal((await f.store.findContactParticipant(A,'email',p.address)).id,p.id);
  assert.equal((await f.store.findThread(A,t.id)).id,t.id);
  assert.equal((await f.store.findMessage(A,m.id)).externalId,m.externalId);
  assert.equal((await f.store.findMessageByExternalId(A,'email',m.externalId)).id,m.id);
  assert.equal((await f.store.listThreadParticipants(A,t.id)).length,1);
  assert.equal((await f.store.listMessages(A,t.id)).length,1);
  assert.equal((await f.store.findOpenThreadForParticipant(A,'email',p.id)).id,t.id);
  const updated=await f.store.updateThread(A,t.id,{status:'snoozed',updatedAt:new Date()});assert.equal(updated.status,'snoozed');
  assert.ok((await f.store.listThreads(A,{status:'snoozed'})).some(row=>row.id===t.id));
 }finally{await f.close();}
});
