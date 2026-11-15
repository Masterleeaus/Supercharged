import test from 'node:test';import assert from 'node:assert/strict';
import {createVerifiedInboxService} from '../../server/modules/inbox/production-service.ts';
import {fixture} from './inbox-schema-readiness.test.mjs';
const pool={connect:async()=>{throw Error('not used during construction')}};
const approvals={gateAction:async()=>({}),getApproval:async()=>null,markExecuted:async()=>null};
test('verified service rejects missing approval integration',async()=>{
 await assert.rejects(createVerifiedInboxService({pool,schemaProbe:fixture(),approvals:null}),/approval port/);
});
const suppression={isSuppressed:()=>false,reasonFor:()=>null,suppress:()=>({ok:true,suppressed:false,softBounces:0}),unsuppress:()=>({ok:true})};
const optOutReply=async()=>{};
test('verified service refuses to build without a suppression list or opt-out reply sender',async()=>{
 await assert.rejects(createVerifiedInboxService({pool,schemaProbe:fixture(),approvals,optOutReply}),/suppression list required/);
 await assert.rejects(createVerifiedInboxService({pool,schemaProbe:fixture(),approvals,suppression}),/opt-out reply sender required/);
});
test('verified service derives company-aware transaction runners from the pool',async()=>{
 const service=await createVerifiedInboxService({pool,schemaProbe:fixture(),approvals,suppression,optOutReply});
 assert.equal(typeof service.listThreads,'function');
 assert.equal(typeof service.applyApprovalDecision,'function');
});

test('canonical approval source is validated before running database schema inspection',async()=>{
 const incomplete={gateAction:async()=>({})};
 await assert.rejects(createVerifiedInboxService({pool,schemaProbe:fixture(),approvalService:incomplete}),/canonical approval service/);
});
