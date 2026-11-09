import test from 'node:test';import assert from 'node:assert/strict';
import {createVerifiedInboxService} from '../../server/modules/inbox/production-service.ts';
import {fixture} from './inbox-schema-readiness.test.mjs';
const pool={connect:async()=>{throw Error('not used during construction')}};
const approvals={gateAction:async()=>({}),getApproval:async()=>null,markExecuted:async()=>null};
test('verified service rejects missing approval integration',async()=>{
 await assert.rejects(createVerifiedInboxService({pool,schemaProbe:fixture(),approvals:null}),/approval port/);
});
test('verified service derives company-aware transaction runners from the pool',async()=>{
 const service=await createVerifiedInboxService({pool,schemaProbe:fixture(),approvals});
 assert.equal(typeof service.listThreads,'function');
 assert.equal(typeof service.applyApprovalDecision,'function');
});
