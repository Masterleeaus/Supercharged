import assert from 'node:assert/strict';
import { evaluateWorkerAuthorityDecision } from '../index.mjs';

const now='2026-09-05T01:00:00Z';
const snapshot={
  company_id:'co-1',decision_id:'auth-1',capability:'booking.create',effective_score:65,
  status:'verified',source:'titan-autonomy',verified_at:'2026-09-05T00:30:00Z',expires_at:'2026-09-06T00:00:00Z',
  trusted_auto_handshake:{platform:true,user:true,assurance:true},predictive_ready:false,
};
const base={
  authority_decision_id:'eval-1',company_id:'co-1',operation_id:'op-1',action_id:'action-1',now,
  worker:{worker_id:'worker-1',worker_type:'booking-coordinator',role_id:'role-1',activation_state:'active'},
  requirement:{
    capability:'booking.create',operation:'create',effect:'book',action_class:'external_commitment',
    required_permissions:['booking.write'],required_entitlements:['booking'],required_evidence:['customer_request'],
    minimum_autonomy_score:51,approval_policy:'protected_action',reversibility:'reversible'
  },
  autonomy_snapshot:snapshot,
  permissions:['booking.write'],entitlements:['booking'],policy_allows:true,governance_allows:true,assurance_allows:true,
  risk:'medium',evidence:{status:'satisfied',refs:['ev-1']},
  approval:{status:'approved',approval_id:'ap-1',approver_id:'human-1',approval_scope:'action-1',granted_at:'2026-09-05T00:50:00Z'},
  connectivity:'online',execution_mode:'autonomous'
};

const allowed=evaluateWorkerAuthorityDecision(base);
assert.equal(allowed.decision,'ALLOW');
assert.equal(allowed.identity_confers_authority,false);
assert.equal(allowed.activation_confers_authority,false);
assert.equal(allowed.module_activation_confers_authority,false);
assert.equal(allowed.effective_authority_score,65);

assert.equal(evaluateWorkerAuthorityDecision({...base,autonomy_snapshot:null}).decision,'AUTHORITY_UNAVAILABLE');
assert.equal(evaluateWorkerAuthorityDecision({...base,evidence:{status:'missing',refs:[]}}).decision,'EVIDENCE_REQUIRED');
assert.equal(evaluateWorkerAuthorityDecision({...base,approval:{status:'pending',approval_id:'ap-1'}}).decision,'APPROVAL_REQUIRED');
assert.equal(evaluateWorkerAuthorityDecision({...base,approval:{status:'revoked',approval_id:'ap-1'}}).decision,'DENY');
assert.equal(evaluateWorkerAuthorityDecision({...base,approval:{status:'approved',approval_id:'ap-self',approver_id:'worker-1'}}).decision,'DENY');
assert.equal(evaluateWorkerAuthorityDecision({...base,risk:'critical'}).decision,'DENY');
assert.equal(evaluateWorkerAuthorityDecision({...base,risk:'high'}).decision,'ESCALATE');
assert.equal(evaluateWorkerAuthorityDecision({...base,permissions:[]}).decision,'DENY');
assert.equal(evaluateWorkerAuthorityDecision({...base,entitlements:[]}).decision,'DENY');

const trusted={...snapshot,effective_score:80,trusted_auto_handshake:{platform:true,user:false,assurance:true}};
const trustedDecision=evaluateWorkerAuthorityDecision({...base,risk:'low',autonomy_snapshot:trusted,requirement:{...base.requirement,minimum_autonomy_score:71}});
assert.equal(trustedDecision.decision,'APPROVAL_REQUIRED');
assert.ok(trustedDecision.reason_codes.includes('trusted_auto_user_handshake_missing'));

const predictive={...snapshot,effective_score:90,predictive_ready:true,trusted_auto_handshake:{platform:true,user:true,assurance:true}};
const predictivePrepare=evaluateWorkerAuthorityDecision({
  ...base,risk:'none',autonomy_snapshot:predictive,predictive_phase:'PREPARE',
  requirement:{...base.requirement,minimum_autonomy_score:86}
});
assert.equal(predictivePrepare.decision,'DENY');
assert.ok(predictivePrepare.reason_codes.includes('predictive_prepare_non_mutating'));



const mismatchedVariant=evaluateWorkerAuthorityDecision({
  ...base,
  requirement:{...base.requirement,variant:'priority'},
  autonomy_snapshot:{...snapshot,variant:'standard'},
});
assert.equal(mismatchedVariant.decision,'DENY');
assert.ok(mismatchedVariant.reason_codes.includes('authority_variant_mismatch'));

const mismatchedWorkflow=evaluateWorkerAuthorityDecision({
  ...base,
  requirement:{...base.requirement,workflow:'booking.create.standard'},
  autonomy_snapshot:{...snapshot,workflow:'booking.create.priority'},
});
assert.equal(mismatchedWorkflow.decision,'DENY');
assert.ok(mismatchedWorkflow.reason_codes.includes('authority_workflow_mismatch'));

const mismatchedContext=evaluateWorkerAuthorityDecision({
  ...base,
  requirement:{...base.requirement,context_ref:'job:1'},
  autonomy_snapshot:{...snapshot,context_ref:'job:2'},
});
assert.equal(mismatchedContext.decision,'DENY');
assert.ok(mismatchedContext.reason_codes.includes('authority_context_mismatch'));

const missingApprovalScope=evaluateWorkerAuthorityDecision({
  ...base,
  approval:{status:'approved',approval_id:'ap-unscoped',approver_id:'human-1',granted_at:'2026-09-05T00:10:00Z'},
});
assert.equal(missingApprovalScope.decision,'DENY');
assert.ok(missingApprovalScope.reason_codes.includes('approval_scope_missing'));

const wrongApprovalScope=evaluateWorkerAuthorityDecision({
  ...base,
  approval:{status:'approved',approval_id:'ap-wrong',approver_id:'human-1',approval_scope:'other-action',granted_at:'2026-09-05T00:10:00Z'},
});
assert.equal(wrongApprovalScope.decision,'DENY');
assert.ok(wrongApprovalScope.reason_codes.includes('approval_scope_mismatch'));

const expiredApproval=evaluateWorkerAuthorityDecision({
  ...base,
  approval:{status:'approved',approval_id:'ap-expired',approver_id:'human-1',approval_scope:'action-1',granted_at:'2026-09-05T00:10:00Z',expires_at:'2026-09-05T00:30:00Z'},
});
assert.equal(expiredApproval.decision,'DENY');
assert.ok(expiredApproval.reason_codes.includes('approval_expired'));

const legacyOnly=evaluateWorkerAuthorityDecision({...base,autonomy_snapshot:null,autonomy_level:'predictive'});
assert.equal(legacyOnly.decision,'AUTHORITY_UNAVAILABLE');

assert.throws(()=>evaluateWorkerAuthorityDecision({...base,company_id:'co-2',autonomy_snapshot:snapshot}),/company-mismatch/);
assert.throws(()=>evaluateWorkerAuthorityDecision({...base,tenant_id:'co-1'}),/legacy-company-boundary/);

console.log('authority evaluator PASS');
