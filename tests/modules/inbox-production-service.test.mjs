import test from 'node:test';
import { consentingGate } from './presend-fixture.mjs';import assert from 'node:assert/strict';
import {createVerifiedInboxService} from '../../server/modules/inbox/production-service.ts';
import {fixture} from './inbox-schema-readiness.test.mjs';
const pool={connect:async()=>{throw Error('should not connect until a request')}};
const approvals={gateAction:async()=>({}),getApproval:async()=>null,markExecuted:async()=>null};
const suppression={isSuppressed:()=>false,reasonFor:()=>null,suppress:()=>({ok:true,suppressed:false,softBounces:0}),unsuppress:()=>({ok:true})};
const optOutReply=async()=>{};
const durable={suppression,optOutReply};
// Production uses company-scoped runners derived from the pool; no global runner.
test('incomplete production dependencies are refused before schema queries',async()=>{
 await assert.rejects(createVerifiedInboxService({}),/PostgreSQL pool/);
 await assert.rejects(createVerifiedInboxService({compliance: consentingGate(), pool}),/approval port/);
 await assert.rejects(createVerifiedInboxService({compliance: consentingGate(), pool,approvals:{}}),/approval port/);
 await assert.rejects(createVerifiedInboxService({compliance: consentingGate(), pool,approvals,...durable}),/schema probe/);
 await assert.rejects(createVerifiedInboxService({pool,approvals,...durable,schemaProbe:fixture()}),/compliance gate/);
});
test('unverified schema prevents constructing a durable Inbox service',async()=>{
 await assert.rejects(createVerifiedInboxService({compliance: consentingGate(), pool,approvals,...durable,schemaProbe:{query:async()=>({rows:[]})}}),/database security not ready/);
});
test('verified schema and explicit durable dependencies construct Inbox service',async()=>{
 const s=await createVerifiedInboxService({compliance: consentingGate(), pool,approvals,...durable,schemaProbe:fixture()});
 for(const name of ['recordInbound','getThread','listThreads','listMessages','createDraft','requestSend','applyApprovalDecision'])assert.equal(typeof s[name],'function');
});

test('canonical ApprovalService integration constructs a verified service without a shadow approval engine',async()=>{
 const canonical={gateAction:async()=>({status:'pending',approval:{id:'ap'},decision:'route_to_human',policyId:null}),getApproval:async()=>null,recordExecuted:async()=>{}};
 const s=await createVerifiedInboxService({compliance: consentingGate(), pool,...durable,schemaProbe:fixture(),approvalService:canonical});
 assert.equal(typeof s.applyApprovalDecision,'function');
});
test('ambiguous dual approval integration is rejected',async()=>{
 const canonical={gateAction:async()=>({}),getApproval:async()=>null,recordExecuted:async()=>{}};
 await assert.rejects(createVerifiedInboxService({compliance: consentingGate(), pool,...durable,schemaProbe:fixture(),approvals,approvalService:canonical}),/one approval integration/);
});

test('canonical approval source must implement the complete durable API',async()=>{
 await assert.rejects(createVerifiedInboxService({compliance: consentingGate(), pool,...durable,schemaProbe:fixture(),approvalService:{getApproval:async()=>null}}),/canonical approval service/);
});
