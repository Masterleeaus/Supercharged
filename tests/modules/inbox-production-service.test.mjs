import test from 'node:test';import assert from 'node:assert/strict';
import {createVerifiedInboxService} from '../../server/modules/inbox/production-service.ts';
import {fixture} from './inbox-schema-readiness.test.mjs';
const pool={connect:async()=>{throw Error('should not connect until a request')}};
const approvals={gateAction:async()=>({}),getApproval:async()=>null,markExecuted:async()=>null};
// Production uses company-scoped runners derived from the pool; no global runner.
test('incomplete production dependencies are refused before schema queries',async()=>{
 await assert.rejects(createVerifiedInboxService({}),/PostgreSQL pool/);
 await assert.rejects(createVerifiedInboxService({pool}),/approval port/);
 await assert.rejects(createVerifiedInboxService({pool,approvals:{}}),/approval port/);
 await assert.rejects(createVerifiedInboxService({pool,approvals}),/schema probe/);
});
test('unverified schema prevents constructing a durable Inbox service',async()=>{
 await assert.rejects(createVerifiedInboxService({pool,approvals,transactions,schemaProbe:{query:async()=>({rows:[]})}}),/database security not ready/);
});
test('verified schema and explicit durable dependencies construct Inbox service',async()=>{
 const s=await createVerifiedInboxService({pool,approvals,schemaProbe:fixture()});
 for(const name of ['recordInbound','getThread','listThreads','listMessages','createDraft','requestSend','applyApprovalDecision'])assert.equal(typeof s[name],'function');
});
