import assert from 'node:assert/strict';
import {
  evaluateWorkerAuthorityDecision,
  prepareGovernedCommandEnvelope,
  assertAuthoritativeExecutionReceipt,
  assertPostActionVerification,
} from '../index.mjs';

const now='2026-09-05T01:00:00Z';
const authority=evaluateWorkerAuthorityDecision({
  authority_decision_id:'auth-eval-1',company_id:'co-1',operation_id:'op-1',action_id:'action-1',now,
  worker:{worker_id:'worker-1'},
  requirement:{capability:'booking.create',operation:'create',effect:'book',required_permissions:['booking.write'],required_entitlements:['booking'],required_evidence:['request'],minimum_autonomy_score:51,approval_policy:'protected'},
  autonomy_snapshot:{company_id:'co-1',decision_id:'autonomy-1',capability:'booking.create',effective_score:65,status:'verified',source:'titan-autonomy',verified_at:'2026-09-05T00:30:00Z',expires_at:'2026-09-06T00:00:00Z'},
  permissions:['booking.write'],entitlements:['booking'],policy_allows:true,governance_allows:true,assurance_allows:true,risk:'medium',
  evidence:{status:'satisfied',refs:['ev-1']},approval:{status:'approved',approval_id:'ap-1',approver_id:'human-1',approval_scope:'action-1',granted_at:'2026-09-05T00:50:00Z'},connectivity:'online'
});
assert.equal(authority.decision,'ALLOW');

assert.throws(()=>prepareGovernedCommandEnvelope({
  company_id:'co-1',actor_id:'worker-1',action_id:'action-1',capability:'booking.create',operation_id:'op-1',idempotency_key:'idem-1',
  authority_decision:{...authority,decision:'DENY'}
}),/authority-not-allowed/);



assert.throws(()=>prepareGovernedCommandEnvelope({
  company_id:'co-1',actor_id:'worker-1',action_id:'other-action',capability:'booking.create',operation_id:'op-1',idempotency_key:'idem-1',
  authority_decision:authority
}),/authority-action-mismatch/);

const command=prepareGovernedCommandEnvelope({
  company_id:'co-1',actor_id:'worker-1',action_id:'action-1',capability:'booking.create',variant:'standard',operation_id:'op-1',idempotency_key:'idem-1',
  authority_decision:authority,approval_refs:['ap-1'],evidence_refs:['ev-1'],trace_id:'trace-1',correlation_id:'corr-1',risk:'medium',
  expected_effect:{kind:'booking_created'},reversibility:'reversible'
});
assert.equal(command.execution_transport,'titan-command-bus');
assert.equal(command.direct_mutation,false);
assert.equal(command.requires_authoritative_receipt,true);
assert.equal(command.authority_decision_ref,'auth-eval-1');
assert.equal(command.idempotency_key,'idem-1');

const receipt={receipt_ref:'receipt-1',company_id:'co-1',action_id:'action-1',capability:'booking.create',operation_id:'op-1',authority_decision_ref:'auth-eval-1',idempotency_key:'idem-1',status:'succeeded',source_provider:'booking-authority',source_revision:'42',authoritative:true};
assert.equal(assertAuthoritativeExecutionReceipt(receipt,{company_id:'co-1',action_id:'action-1',capability:'booking.create',idempotency_key:'idem-1'}),true);
assert.throws(()=>assertAuthoritativeExecutionReceipt({...receipt,company_id:'co-2'},{company_id:'co-1',action_id:'action-1'}),/receipt-company-mismatch/);
assert.throws(()=>assertAuthoritativeExecutionReceipt({...receipt,authoritative:false},{company_id:'co-1',action_id:'action-1'}),/receipt-not-authoritative/);
assert.throws(()=>assertAuthoritativeExecutionReceipt({...receipt,status:'unknown'},{company_id:'co-1',action_id:'action-1'}),/RECOVERY_REQUIRED/);

const verification={verification_id:'verify-1',company_id:'co-1',action_id:'action-1',capability:'booking.create',operation_id:'op-1',receipt_ref:'receipt-1',verification_state:'verified_success',evidence:['ev-2'],authoritative_state_ref:'booking:42',verified_at:now};
assert.equal(assertPostActionVerification(verification,{company_id:'co-1',action_id:'action-1',required:true}),true);
assert.throws(()=>assertPostActionVerification({...verification,company_id:'co-2'},{company_id:'co-1',action_id:'action-1',required:true}),/verification-company-mismatch/);
assert.throws(()=>assertPostActionVerification({...verification,verification_state:'uncertain'},{company_id:'co-1',action_id:'action-1',required:true}),/RECOVERY_REQUIRED/);

const retry=prepareGovernedCommandEnvelope({...command,authority_decision:authority});
assert.equal(retry.operation_id,command.operation_id);
assert.equal(retry.idempotency_key,command.idempotency_key);

console.log('execution boundary PASS');

assert.throws(()=>prepareGovernedCommandEnvelope({...command,risk:'critical',authority_decision:authority}),/critical-mutation-denied/);
assert.throws(()=>prepareGovernedCommandEnvelope({...command,risk:'high',approval_refs:[],authority_decision:authority}),/high-risk-approval-required/);
assert.throws(()=>prepareGovernedCommandEnvelope({...command,risk:'high',evidence_refs:[],authority_decision:authority}),/high-risk-evidence-required/);
const high=prepareGovernedCommandEnvelope({...command,risk:'high',authority_decision:authority});
assert.equal(high.post_action_verification_required,true);
assert.throws(()=>assertAuthoritativeExecutionReceipt({...receipt,receipt_ref:''},{company_id:'co-1'}),/receipt-ref-required/);
assert.throws(()=>assertAuthoritativeExecutionReceipt({...receipt,operation_id:'op-x'},{company_id:'co-1',operation_id:'op-1'}),/receipt-operation-mismatch/);
assert.throws(()=>assertPostActionVerification({...verification,evidence:[]},{company_id:'co-1',action_id:'action-1',risk:'high'}),/verification-evidence-required/);
assert.throws(()=>assertPostActionVerification({...verification,receipt_ref:'receipt-x'},{company_id:'co-1',action_id:'action-1',risk:'high',receipt_ref:'receipt-1'}),/verification-receipt-mismatch/);
