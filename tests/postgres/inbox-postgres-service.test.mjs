import test from 'node:test';import assert from 'node:assert/strict';
import {A,B,enabled,fixture,id} from './inbox-postgres-support.mjs';
import {createVerifiedInboxService} from '../../server/modules/inbox/production-service.ts';
import {createHash} from 'node:crypto';
test('PostgreSQL: verified service stores and deduplicates inbound messages atomically',{skip:!enabled},async()=>{
 const f=fixture();try{
  const approval={gateAction:async()=>{throw Error('outbound disabled')},getApproval:async()=>null,markExecuted:async()=>null};
  const transactions={runInTransaction:async()=>{throw Error('outbound disabled')}};
  const service=await createVerifiedInboxService({pool:f.pool,schemaProbe:f.pool,approvals:approval,transactions});
  const external=id('inbound'),address='contact-'+id('a')+'@example.test';
  const first=await service.recordInbound(A,{channel:'email',address,body:'Hello Inbox',externalId:external});
  const second=await service.recordInbound(A,{channel:'email',address,body:'Hello Inbox',externalId:external});
  assert.equal(first.duplicate,false);assert.equal(second.duplicate,true);
  assert.equal(first.message.id,second.message.id);
  assert.equal((await service.listMessages(A,first.thread.id)).length,1);
  assert.equal((await f.store.findMessage(B,first.message.id)),null);
 }finally{await f.close();}
});
