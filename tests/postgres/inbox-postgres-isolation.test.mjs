import test from 'node:test';
import assert from 'node:assert/strict';
import {A,B,enabled,fixture,id,participant,thread,message} from './inbox-postgres-support.mjs';
test('PostgreSQL: all Inbox CRUD reads and writes are company isolated',{skip:!enabled},async()=>{
 const f=fixture();try{
  const a=thread(A,id('thread-a')),b=thread(B,id('thread-b'));
  await f.store.insertThread(a);await f.store.insertThread(b);
  assert.equal(await f.store.findThread(A,b.id),null);
  assert.equal(await f.store.findThread(B,a.id),null);
  assert.equal(await f.store.updateThread(A,b.id,{status:'closed'}),null);
  assert.ok((await f.store.listThreads(A,{})).every(t=>t.companyId===A));
  assert.ok((await f.store.listThreads(B,{})).every(t=>t.companyId===B));
  const m=message(B,id('message-b'),b.id,id('ext-b'));await f.store.insertMessage(m);
  assert.equal(await f.store.findMessage(A,m.id),null);
  assert.equal(await f.store.findMessageByExternalId(A,'email',m.externalId),null);
  assert.equal(await f.store.updateMessage(A,m.id,{status:'queued'}),null);
  assert.equal((await f.store.findMessage(B,m.id)).status,'received');
 }finally{await f.close();}
});

test('PostgreSQL: changing tenants between pooled requests cannot expose earlier rows',{skip:!enabled},async()=>{
 const f=fixture();try{
  const t=thread(A,id('pooled'));await f.store.insertThread(t);
  const first=await f.store.findThread(A,t.id),other=await f.store.findThread(B,t.id),again=await f.store.findThread(A,t.id);
  assert.equal(first.id,t.id);assert.equal(other,null);assert.equal(again.id,t.id);
 }finally{await f.close();}
});
