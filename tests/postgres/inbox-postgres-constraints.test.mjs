import test from 'node:test';import assert from 'node:assert/strict';
import {A,B,enabled,fixture,id,participant,thread,message} from './inbox-postgres-support.mjs';
test('PostgreSQL: composite foreign keys reject cross-company thread membership',{skip:!enabled},async()=>{
 const f=fixture();try{
  const p=participant(A,id('contact')),t=thread(B,id('thread'));await f.store.insertParticipant(p);await f.store.insertThread(t);
  await assert.rejects(f.store.linkParticipant({companyId:A,threadId:t.id,participantId:p.id}),e=>e.code==='23503');
 }finally{await f.close();}
});
test('PostgreSQL: duplicate provider IDs are constrained per tenant/channel',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(A,id('thread'));await f.store.insertThread(t);const external=id('provider');
  await f.store.insertMessage(message(A,id('message-1'),t.id,external));
  await assert.rejects(f.store.insertMessage(message(A,id('message-2'),t.id,external)),e=>e.code==='23505');
 }finally{await f.close();}
});
