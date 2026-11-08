import { assertAuthorityCompanyId, rejectLegacyAuthorityBoundaryDeep } from './company-boundary.mjs';
import { assertAuthorityDecisionAllowsExecution, assertAuthorityDecisionSupersessionContinuity } from './authority-evaluator.mjs';
import { buildAuthorityHistoryIntegritySeal, buildAuthorityHistorySnapshotSeal } from './history-integrity.mjs';

const text=(v,code)=>{const s=String(v??'').trim();if(!s)throw new Error(code);return s;};
const opt=v=>v==null||v===''?null:String(v).trim();
const list=v=>Object.freeze(Array.isArray(v)?[...new Set(v.map(x=>String(x).trim()).filter(Boolean))].sort():[]);
const clone=v=>v==null?v:(globalThis.structuredClone?structuredClone(v):JSON.parse(JSON.stringify(v)));
const STRICT_RISKS=new Set(['high','critical']);
const normalizeRisk=v=>{const r=String(v??'none').trim();if(!['none','low','medium','high','critical'].includes(r))throw new Error(`invalid-risk:${r}`);return r;};

const ctxText=v=>v==null||v===''?null:String(v).trim();

const isoMs=v=>{const n=Date.parse(String(v??''));return Number.isFinite(n)?n:null;};
const canonicalReplayPart=v=>encodeURIComponent(String(v??'').trim());
const stableCanonical=v=>{
  if(v==null||typeof v!=='object') return JSON.stringify(v);
  if(Array.isArray(v)) return `[${v.map(stableCanonical).join(',')}]`;
  return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stableCanonical(v[k])}`).join(',')}}`;
};
export function buildExecutionContextBinding(binding){
  if(!binding) return 'none';
  const normalized=assertCurrentExecutionContextBinding(binding,{company_id:binding.company_id});
  return `titan.context.v1|${['company_id','worker_id','account_id','session_id','tab_id','account_revision','context_revision'].map(k=>canonicalReplayPart(normalized[k]??'')).join('|')}`;
}
export function buildGovernedReplayBinding(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('replay-binding-input-required');
  const company_id=assertAuthorityCompanyId(input.company_id);
  const actor_id=text(input.actor_id,'replay-actor-id-required');
  const action_id=text(input.action_id,'replay-action-id-required');
  const capability=text(input.capability,'replay-capability-required');
  const operation_id=text(input.operation_id,'replay-operation-id-required');
  const idempotency_key=text(input.idempotency_key,'replay-idempotency-key-required');
  const authority_decision_ref=text(input.authority_decision_ref,'replay-authority-decision-ref-required');
  const authority_provenance_seal=opt(input.authority_provenance_seal);
  const execution_context_binding=input.execution_context_binding??(input.execution_context?buildExecutionContextBinding(input.execution_context):'none');
  const approval_refs=[...new Set(Array.isArray(input.approval_refs)?input.approval_refs.map(x=>String(x).trim()).filter(Boolean):[])].sort().join(',');
  const evidence_refs=[...new Set(Array.isArray(input.evidence_refs)?input.evidence_refs.map(x=>String(x).trim()).filter(Boolean):[])].sort().join(',');
  const reversibility=String(input.reversibility??'unknown').trim();
  const expected_effect_digest=stableCanonical(input.expected_effect??null);
  const proof_material_binding=input.proof_material_binding??stableCanonical(input.proof_material??null);
  return `titan.replay.v5|${[company_id,actor_id,action_id,capability,operation_id,idempotency_key,authority_decision_ref,authority_provenance_seal??'',execution_context_binding,approval_refs,evidence_refs,reversibility,expected_effect_digest,proof_material_binding].map(canonicalReplayPart).join('|')}`;
}


export function assertCommandProofCurrent(command,currentProof){
  if(!command||typeof command!=='object'||Array.isArray(command))throw new Error('command-envelope-required');
  if(!currentProof||typeof currentProof!=='object'||Array.isArray(currentProof))throw new Error('command-current-proof-required');
  const replay=buildGovernedReplayBinding({
    company_id:command.company_id,
    actor_id:command.actor_id,
    action_id:command.action_id,
    capability:command.capability,
    operation_id:command.operation_id,
    idempotency_key:command.idempotency_key,
    authority_decision_ref:command.authority_decision_ref,
    authority_provenance_seal:command.authority_provenance_seal,
    execution_context_binding:command.execution_context_binding??'none',
    approval_refs:currentProof.approval_refs??[],
    evidence_refs:currentProof.evidence_refs??[],
    reversibility:currentProof.reversibility??'unknown',
    expected_effect:currentProof.expected_effect??null,
    proof_material:currentProof.proof_material??null,
  });
  if(replay!==String(command.replay_binding??''))throw new Error('command-proof-superseded');
  return true;
}

export function assertCurrentExecutionContextBinding(binding,expected={}){
  if(!binding||typeof binding!=='object'||Array.isArray(binding))throw new Error('execution-context-binding-required');
  rejectLegacyAuthorityBoundaryDeep(binding,'execution_context_binding');
  const company_id=assertAuthorityCompanyId(binding.company_id);
  const expectedCompany=assertAuthorityCompanyId(expected.company_id??company_id);
  if(company_id!==expectedCompany)throw new Error('stale-context-company-mismatch');
  const worker_id=ctxText(binding.worker_id??binding.actor_id);
  const account_id=ctxText(binding.account_id);
  const session_id=ctxText(binding.session_id);
  const tab_id=ctxText(binding.tab_id);
  const account_revision=ctxText(binding.account_revision);
  const context_revision=ctxText(binding.context_revision);
  if(expected.worker_id&&worker_id!==String(expected.worker_id))throw new Error('stale-context-worker-mismatch');
  if(expected.account_id&&account_id!==String(expected.account_id))throw new Error('stale-context-account-mismatch');
  if(expected.session_id&&session_id!==String(expected.session_id))throw new Error('stale-context-session-mismatch');
  if(expected.tab_id!=null&&tab_id!==String(expected.tab_id))throw new Error('stale-context-tab-mismatch');
  if(expected.account_revision!=null&&account_revision!==String(expected.account_revision))throw new Error('stale-context-account-revision-mismatch');
  if(expected.context_revision!=null&&context_revision!==String(expected.context_revision))throw new Error('stale-context-revision-mismatch');
  return Object.freeze({
    company_id,worker_id,account_id,session_id,tab_id,account_revision,context_revision,
    identity_confers_authority:false,
    current_context_only:true,
  });
}

export function prepareGovernedCommandEnvelope(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('command-envelope-input-required');
  rejectLegacyAuthorityBoundaryDeep(input,'command_envelope');
  const company_id=assertAuthorityCompanyId(input.company_id);
  const action_id=text(input.action_id,'action-id-required');
  const capability=text(input.capability,'capability-required');
  const operation_id=text(input.operation_id,'operation-id-required');
  const idempotency_key=text(input.idempotency_key,'idempotency-key-required');
  const actor_id=text(input.actor_id,'actor-id-required');
  assertAuthorityDecisionAllowsExecution(input.authority_decision,{company_id,capability,operation_id,action_id,worker_id:actor_id,now:input.now,max_age_ms:input.max_authority_decision_age_ms});
  const execution_context=input.execution_context?assertCurrentExecutionContextBinding(input.execution_context,{company_id,worker_id:actor_id,...(input.expected_execution_context??{})}):null;
  const authority_decision_ref=text(input.authority_decision.authority_decision_id,'authority-decision-ref-required');
  const authority_provenance_seal=opt(input.authority_decision.provenance_seal ?? input.authority_decision.provenance?.provenance_seal);
  const execution_context_binding=execution_context?buildExecutionContextBinding(execution_context):'none';
  const issued_at=opt(input.issued_at??input.now)??new Date().toISOString();
  if(isoMs(issued_at)==null)throw new Error('command-issued-at-invalid');
  const risk=normalizeRisk(input.risk);
  if(risk==='critical')throw new Error('critical-mutation-denied');
  const strict=STRICT_RISKS.has(risk);
  const approval_refs=list(input.approval_refs);
  const evidence_refs=list(input.evidence_refs);
  if(strict&&!approval_refs.length)throw new Error('high-risk-approval-required');
  if(strict&&!evidence_refs.length)throw new Error('high-risk-evidence-required');
  const reversibility=opt(input.reversibility)??'unknown';
  if(strict&&reversibility==='unknown')throw new Error('high-risk-reversibility-required');
  if(strict&&reversibility==='irreversible'&&!opt(input.compensation_capability))throw new Error('high-risk-compensation-required');
  const proof_material_binding=stableCanonical(input.proof_material??null);
  const execution_attempt_id=opt(input.execution_attempt_id);
  const replay_binding=buildGovernedReplayBinding({company_id,actor_id,action_id,capability,operation_id,idempotency_key,authority_decision_ref,authority_provenance_seal,execution_context_binding,approval_refs,evidence_refs,reversibility,expected_effect:input.expected_effect??null,proof_material_binding});
  return Object.freeze({
    schema:'titan.command.request.v1',
    company_id,
    actor_id,
    action_id, capability,
    variant:opt(input.variant),
    operation_id,idempotency_key,issued_at,replay_binding,execution_context_binding,execution_attempt_id,
    authority_decision_ref,
    authority_provenance_seal,
    authority_evaluated_at:opt(input.authority_decision.evaluated_at),
    autonomy_snapshot_ref:opt(input.authority_decision.autonomy_snapshot_id),
    approval_refs,
    evidence_refs,
    proof_material_binding,
    trace_id:opt(input.trace_id),
    correlation_id:opt(input.correlation_id),
    causation_id:opt(input.causation_id),
    risk,
    expected_effect:clone(input.expected_effect??null),
    reversibility,
    compensation_capability:opt(input.compensation_capability),
    execution_transport:'titan-command-bus',
    direct_mutation:false,
    requires_authoritative_receipt:true,
    post_action_verification_required:strict,
    execution_context,
    authority_effect:false,
  });
}


export function assertCommandAuthorityCurrentAt(command,currentAuthorityDecision,at){
  if(!command||typeof command!=='object'||Array.isArray(command))throw new Error('command-envelope-required');
  if(!currentAuthorityDecision||typeof currentAuthorityDecision!=='object'||Array.isArray(currentAuthorityDecision))throw new Error('current-authority-decision-required');
  const atMs=isoMs(at); if(atMs==null)throw new Error('authority-current-at-invalid');
  const currentMs=isoMs(currentAuthorityDecision.evaluated_at); if(currentMs==null)throw new Error('authority-current-evaluated-at-invalid');
  const commandCompany=assertAuthorityCompanyId(command.company_id);
  const currentCompany=assertAuthorityCompanyId(currentAuthorityDecision.company_id);
  if(currentCompany!==commandCompany)throw new Error('command-authority-company-mismatch');
  for(const [field,expected] of [['worker_id',command.actor_id],['capability',command.capability],['operation_id',command.operation_id],['action_id',command.action_id]]){
    const actual=opt(currentAuthorityDecision[field]);
    if(actual&&expected!=null&&actual!==String(expected))throw new Error(`command-authority-binding-mismatch:${field}`);
  }
  if(currentMs>atMs) return true;
  const commandDecision={
    authority_decision_id:command.authority_decision_ref,
    company_id:command.company_id,worker_id:command.actor_id,capability:command.capability,operation_id:command.operation_id,action_id:command.action_id,
    decision:'ALLOW',evaluated_at:command.authority_evaluated_at??command.issued_at,autonomy_snapshot_id:command.autonomy_snapshot_ref,
    provenance_seal:command.authority_provenance_seal,
  };
  assertAuthorityDecisionSupersessionContinuity(commandDecision,currentAuthorityDecision);
  if(String(currentAuthorityDecision.authority_decision_id)!==String(command.authority_decision_ref))throw new Error('command-authority-superseded-before-execution');
  assertAuthorityDecisionAllowsExecution(currentAuthorityDecision,{company_id:command.company_id,capability:command.capability,operation_id:command.operation_id,action_id:command.action_id,worker_id:command.actor_id,now:at,max_age_ms:Number.MAX_SAFE_INTEGER});
  return true;
}

export function assertAuthoritativeExecutionReceipt(receipt,expected={}){
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw new Error('execution-receipt-required');
  rejectLegacyAuthorityBoundaryDeep(receipt,'execution_receipt');
  const company_id=assertAuthorityCompanyId(receipt.company_id);
  const expectedCompany=assertAuthorityCompanyId(expected.company_id??company_id);
  if(company_id!==expectedCompany)throw new Error('receipt-company-mismatch');
  if(receipt.authoritative!==true)throw new Error('receipt-not-authoritative');
  text(receipt.receipt_ref,'receipt-ref-required');
  text(receipt.source_provider,'receipt-source-provider-required');
  text(receipt.source_revision,'receipt-source-revision-required');
  const action_id=text(receipt.action_id,'receipt-action-id-required');
  const capability=text(receipt.capability,'receipt-capability-required');
  const idempotency_key=text(receipt.idempotency_key,'receipt-idempotency-key-required');
  if(expected.action_id&&String(expected.action_id)!==action_id)throw new Error('receipt-action-mismatch');
  if(expected.capability&&String(expected.capability)!==capability)throw new Error('receipt-capability-mismatch');
  if(expected.idempotency_key&&String(expected.idempotency_key)!==idempotency_key)throw new Error('receipt-idempotency-mismatch');
  if(expected.operation_id&&String(receipt.operation_id??'')!==String(expected.operation_id))throw new Error('receipt-operation-mismatch');
  if(expected.authority_decision_ref&&String(receipt.authority_decision_ref??'')!==String(expected.authority_decision_ref))throw new Error('receipt-authority-decision-mismatch');
  if(expected.actor_id&&String(receipt.actor_id??'')!==String(expected.actor_id))throw new Error('receipt-actor-mismatch');
  if(expected.correlation_id&&String(receipt.correlation_id??'')!==String(expected.correlation_id))throw new Error('receipt-correlation-mismatch');
  if(expected.trace_id&&String(receipt.trace_id??'')!==String(expected.trace_id))throw new Error('receipt-trace-mismatch');
  if(expected.execution_attempt_id&&String(receipt.execution_attempt_id??'')!==String(expected.execution_attempt_id))throw new Error('receipt-execution-attempt-mismatch');
  if(expected.execution_context_binding){const b=text(receipt.execution_context_binding,'receipt-execution-context-binding-required');if(b!==String(expected.execution_context_binding))throw new Error('receipt-execution-context-binding-mismatch');}
  if(expected.replay_binding){
    const replay_binding=text(receipt.replay_binding,'receipt-replay-binding-required');
    if(replay_binding!==String(expected.replay_binding))throw new Error('receipt-replay-binding-mismatch');
  }
  if(expected.issued_at){
    const issuedMs=isoMs(expected.issued_at); if(issuedMs==null)throw new Error('receipt-expected-issued-at-invalid');
    const executed_at=text(receipt.executed_at,'receipt-executed-at-required');
    const executedMs=isoMs(executed_at); if(executedMs==null)throw new Error('receipt-executed-at-invalid');
    if(executedMs<issuedMs)throw new Error('receipt-executed-before-command');
    if(expected.now){const nowMs=isoMs(expected.now);if(nowMs==null)throw new Error('receipt-now-invalid');if(executedMs>nowMs)throw new Error('receipt-executed-in-future');}
  }
  const status=String(receipt.status??'').trim();
  if(status==='unknown')throw new Error('RECOVERY_REQUIRED:execution-receipt-unknown');
  if(status!=='succeeded')throw new Error(`execution-receipt-not-successful:${status||'missing'}`);
  return true;
}


export function assertAuthoritativeExecutionReceiptContinuity(previousInput,nextInput){
  if(!previousInput||!nextInput||typeof previousInput!=='object'||typeof nextInput!=='object'||Array.isArray(previousInput)||Array.isArray(nextInput)) throw new Error('execution-receipt-continuity-required');
  assertAuthoritativeExecutionReceipt(previousInput);
  rejectLegacyAuthorityBoundaryDeep(nextInput,'execution_receipt_continuity_next');
  if(nextInput.authoritative!==true) throw new Error('receipt-not-authoritative');
  text(nextInput.receipt_ref,'receipt-ref-required');
  text(nextInput.source_provider,'receipt-source-provider-required');
  text(nextInput.source_revision,'receipt-source-revision-required');
  text(nextInput.action_id,'receipt-action-id-required');
  text(nextInput.capability,'receipt-capability-required');
  text(nextInput.idempotency_key,'receipt-idempotency-key-required');
  if(!String(nextInput.status??'').trim()) throw new Error('execution-receipt-status-required');
  const previousCompany=assertAuthorityCompanyId(previousInput.company_id);
  const nextCompany=assertAuthorityCompanyId(nextInput.company_id);
  if(previousCompany!==nextCompany) throw new Error('execution-receipt-continuity-company-mismatch');
  const fields=['action_id','capability','operation_id','idempotency_key','authority_decision_ref','actor_id','replay_binding','execution_attempt_id','execution_context_binding'];
  for(const field of fields){
    const a=opt(previousInput[field]); const b=opt(nextInput[field]);
    if(a&&!b) throw new Error(`execution-receipt-continuity-binding-downgrade:${field}`);
    if(a&&b&&a!==b) throw new Error(`execution-receipt-continuity-binding-mismatch:${field}`);
  }
  const sameRef=String(previousInput.receipt_ref)===String(nextInput.receipt_ref);
  if(sameRef){
    const canonical=(r)=>stableCanonical({
      company_id:r.company_id,receipt_ref:r.receipt_ref,source_provider:r.source_provider,source_revision:r.source_revision,
      action_id:r.action_id,capability:r.capability,operation_id:r.operation_id,idempotency_key:r.idempotency_key,
      authority_decision_ref:r.authority_decision_ref,actor_id:r.actor_id,replay_binding:r.replay_binding,
      execution_attempt_id:r.execution_attempt_id,execution_context_binding:r.execution_context_binding,executed_at:r.executed_at,status:r.status,
    });
    if(canonical(previousInput)!==canonical(nextInput)) throw new Error('execution-receipt-ref-equivocation');
    return true;
  }
  const sameAttempt=opt(previousInput.execution_attempt_id)&&opt(previousInput.execution_attempt_id)===opt(nextInput.execution_attempt_id)&&opt(previousInput.replay_binding)===opt(nextInput.replay_binding);
  if(sameAttempt){
    if(String(previousInput.source_provider)!==String(nextInput.source_provider)) throw new Error('execution-receipt-attempt-source-substitution');
    if(String(previousInput.status)!==String(nextInput.status)) throw new Error('execution-receipt-attempt-outcome-equivocation');
  }
  return true;
}


export function assertAuthoritativeExecutionReceiptHistory(history){
  if(!Array.isArray(history)||history.length===0) throw new Error('execution-receipt-history-required');
  const seenRefs=new Set();
  let previous=null;
  for(const item of history){
    assertAuthoritativeExecutionReceipt(item);
    const ref=text(item.receipt_ref,'receipt-ref-required');
    if(seenRefs.has(ref)) throw new Error('execution-receipt-history-receipt-ref-reuse');
    seenRefs.add(ref);
    if(previous){
      if((opt(previous.execution_attempt_id)&&!opt(item.execution_attempt_id))||(opt(previous.replay_binding)&&!opt(item.replay_binding))) throw new Error('execution-receipt-history-attempt-binding-downgrade');
      const previousMs=isoMs(previous.executed_at); const currentMs=isoMs(item.executed_at);
      if(previousMs==null||currentMs==null) throw new Error('execution-receipt-history-executed-at-invalid');
      if(currentMs<previousMs) throw new Error('execution-receipt-history-time-rollback');
      const previousSequence=Number(previous.source_sequence); const currentSequence=Number(item.source_sequence);
      const previousHas=previous.source_sequence!=null&&previous.source_sequence!=='';
      const currentHas=item.source_sequence!=null&&item.source_sequence!=='';
      if(previousHas&&!currentHas) throw new Error('execution-receipt-history-source-sequence-missing');
      if(previousHas&&currentHas){
        if(!Number.isInteger(previousSequence)||previousSequence<0||!Number.isInteger(currentSequence)||currentSequence<0) throw new Error('execution-receipt-history-source-sequence-invalid');
        if(currentSequence<previousSequence) throw new Error('execution-receipt-history-source-sequence-rollback');
      }
      assertAuthoritativeExecutionReceiptContinuity(previous,item);
    }
    previous=item;
  }
  return true;
}


export function buildAuthoritativeExecutionReceiptHistorySeal(history){
  return buildAuthorityHistoryIntegritySeal('execution-receipt',history);
}

export function assertAuthoritativeExecutionReceiptPersistenceContinuity(previousHistory,nextHistory,expectedPreviousSeal=null){
  if(!Array.isArray(previousHistory)||!Array.isArray(nextHistory)) throw new Error('execution-receipt-persistence-history-required');
  if(expectedPreviousSeal!=null&&String(expectedPreviousSeal)!==buildAuthoritativeExecutionReceiptHistorySeal(previousHistory)) throw new Error('execution-receipt-history-seal-mismatch');
  if(nextHistory.length<previousHistory.length) throw new Error('execution-receipt-history-truncation-forbidden');
  for(let i=0;i<previousHistory.length;i++){
    if(stableCanonical(previousHistory[i])!==stableCanonical(nextHistory[i])) throw new Error('execution-receipt-history-prefix-equivocation');
  }
  if(previousHistory.length) assertAuthoritativeExecutionReceiptHistory(previousHistory);
  if(nextHistory.length) assertAuthoritativeExecutionReceiptHistory(nextHistory);
  return true;
}

export function assertPostActionVerification(verification,expected={}){
  if(!verification||typeof verification!=='object'||Array.isArray(verification)){
    if(expected.required)throw new Error('RECOVERY_REQUIRED:post-action-verification-required');
    return true;
  }
  rejectLegacyAuthorityBoundaryDeep(verification,'post_action_verification');
  const company_id=assertAuthorityCompanyId(verification.company_id);
  const expectedCompany=assertAuthorityCompanyId(expected.company_id??company_id);
  if(company_id!==expectedCompany)throw new Error('verification-company-mismatch');
  const action_id=text(verification.action_id,'verification-action-id-required');
  if(expected.action_id&&String(expected.action_id)!==action_id)throw new Error('verification-action-mismatch');
  const strict=Boolean(expected.required)||STRICT_RISKS.has(normalizeRisk(expected.risk??'none'));
  const state=String(verification.verification_state??'').trim();
  if(strict){
    text(verification.verification_id,'verification-id-required');
    text(verification.authoritative_state_ref,'verification-authoritative-state-ref-required');
    if(!Array.isArray(verification.evidence)||verification.evidence.filter(Boolean).length===0)throw new Error('verification-evidence-required');
    if(expected.capability&&String(verification.capability??'')!==String(expected.capability))throw new Error('verification-capability-mismatch');
    if(expected.operation_id&&String(verification.operation_id??'')!==String(expected.operation_id))throw new Error('verification-operation-mismatch');
    if(expected.receipt_ref&&String(verification.receipt_ref??'')!==String(expected.receipt_ref))throw new Error('verification-receipt-mismatch');
    if(expected.actor_id&&String(verification.actor_id??'')!==String(expected.actor_id))throw new Error('verification-actor-mismatch');
    if(expected.correlation_id&&String(verification.correlation_id??'')!==String(expected.correlation_id))throw new Error('verification-correlation-mismatch');
    if(expected.trace_id&&String(verification.trace_id??'')!==String(expected.trace_id))throw new Error('verification-trace-mismatch');
    if(expected.execution_attempt_id&&String(verification.execution_attempt_id??'')!==String(expected.execution_attempt_id))throw new Error('verification-execution-attempt-mismatch');
    if(expected.authority_decision_ref&&String(verification.authority_decision_ref??'')!==String(expected.authority_decision_ref))throw new Error('verification-authority-decision-mismatch');
    if(expected.idempotency_key&&String(verification.idempotency_key??'')!==String(expected.idempotency_key))throw new Error('verification-idempotency-mismatch');
    if(expected.execution_context_binding){const b=text(verification.execution_context_binding,'verification-execution-context-binding-required');if(b!==String(expected.execution_context_binding))throw new Error('verification-execution-context-binding-mismatch');}
    if(expected.replay_binding){const replay_binding=text(verification.replay_binding,'verification-replay-binding-required');if(replay_binding!==String(expected.replay_binding))throw new Error('verification-replay-binding-mismatch');}
    if(expected.executed_at){
      const executedMs=isoMs(expected.executed_at); if(executedMs==null)throw new Error('verification-expected-executed-at-invalid');
      const verified_at=text(verification.verified_at,'verification-verified-at-required');
      const verifiedMs=isoMs(verified_at); if(verifiedMs==null)throw new Error('verification-verified-at-invalid');
      if(verifiedMs<executedMs)throw new Error('verification-before-execution');
      if(expected.now){const nowMs=isoMs(expected.now);if(nowMs==null)throw new Error('verification-now-invalid');if(verifiedMs>nowMs)throw new Error('verification-in-future');}
    }
  }
  if(strict&&state!=='verified_success'){
    if(['uncertain','not_required',''].includes(state))throw new Error(`RECOVERY_REQUIRED:post-action-verification-${state||'missing'}`);
    throw new Error(`post-action-verification-failed:${state}`);
  }
  return true;
}


export function assertPostActionVerificationContinuity(previousInput,nextInput){
  if(!previousInput||!nextInput||typeof previousInput!=='object'||typeof nextInput!=='object'||Array.isArray(previousInput)||Array.isArray(nextInput)) throw new Error('post-action-verification-continuity-required');
  assertPostActionVerification(previousInput,{required:true,risk:'high'});
  const previousCompany=assertAuthorityCompanyId(previousInput.company_id);
  const nextCompany=assertAuthorityCompanyId(nextInput.company_id);
  if(previousCompany!==nextCompany) throw new Error('post-action-verification-company-mismatch');
  const fields=['action_id','capability','operation_id','receipt_ref','actor_id','replay_binding','execution_attempt_id','execution_context_binding','authority_decision_ref','idempotency_key'];
  for(const field of fields){const a=opt(previousInput[field]);const b=opt(nextInput[field]);if(a&&!b) throw new Error(`post-action-verification-continuity-binding-downgrade:${field}`);if(a&&b&&a!==b) throw new Error(`post-action-verification-continuity-binding-mismatch:${field}`);}
  const previousMs=isoMs(previousInput.verified_at); const nextMs=isoMs(nextInput.verified_at);
  if(previousMs==null||nextMs==null) throw new Error('post-action-verification-time-invalid');
  if(nextMs<previousMs) throw new Error('post-action-verification-time-rollback');
  const canonical=(v)=>stableCanonical({
    company_id:v.company_id,verification_id:v.verification_id,verification_state:v.verification_state,authoritative_state_ref:v.authoritative_state_ref,
    evidence:Array.isArray(v.evidence)?[...v.evidence]:[],action_id:v.action_id,capability:v.capability,operation_id:v.operation_id,receipt_ref:v.receipt_ref,
    actor_id:v.actor_id,replay_binding:v.replay_binding,execution_attempt_id:v.execution_attempt_id,execution_context_binding:v.execution_context_binding,authority_decision_ref:v.authority_decision_ref,
    idempotency_key:v.idempotency_key,verified_at:v.verified_at,
  });
  if(String(previousInput.verification_id)===String(nextInput.verification_id)&&canonical(previousInput)!==canonical(nextInput)) throw new Error('post-action-verification-id-equivocation');
  const sameAttempt=opt(previousInput.execution_attempt_id)&&opt(previousInput.execution_attempt_id)===opt(nextInput.execution_attempt_id)&&opt(previousInput.replay_binding)===opt(nextInput.replay_binding);
  if(sameAttempt&&String(previousInput.verification_state)!==String(nextInput.verification_state)) throw new Error('post-action-verification-outcome-equivocation');
  assertPostActionVerification(nextInput,{required:true,risk:'high'});
  return true;
}


export function assertPostActionVerificationHistory(history){
  if(!Array.isArray(history)||history.length===0) throw new Error('post-action-verification-history-required');
  const seenIds=new Set();
  let previous=null;
  for(const item of history){
    assertPostActionVerification(item,{required:true,risk:'high'});
    const id=text(item.verification_id,'verification-id-required');
    if(seenIds.has(id)) throw new Error('post-action-verification-history-id-reuse');
    seenIds.add(id);
    if(previous){
      if((opt(previous.execution_attempt_id)&&!opt(item.execution_attempt_id))||(opt(previous.replay_binding)&&!opt(item.replay_binding))) throw new Error('post-action-verification-history-attempt-binding-downgrade');
      assertPostActionVerificationContinuity(previous,item);
    }
    previous=item;
  }
  return true;
}

export function buildPostActionVerificationHistorySeal(history){
  return buildAuthorityHistoryIntegritySeal('post-action-verification',history);
}

export function assertPostActionVerificationPersistenceContinuity(previousHistory,nextHistory,expectedPreviousSeal=null){
  if(!Array.isArray(previousHistory)||!Array.isArray(nextHistory)) throw new Error('post-action-verification-persistence-history-required');
  if(expectedPreviousSeal!=null&&String(expectedPreviousSeal)!==buildPostActionVerificationHistorySeal(previousHistory)) throw new Error('post-action-verification-history-seal-mismatch');
  if(nextHistory.length<previousHistory.length) throw new Error('post-action-verification-history-truncation-forbidden');
  for(let i=0;i<previousHistory.length;i++){
    if(stableCanonical(previousHistory[i])!==stableCanonical(nextHistory[i])) throw new Error('post-action-verification-history-prefix-equivocation');
  }
  if(previousHistory.length) assertPostActionVerificationHistory(previousHistory);
  if(nextHistory.length) assertPostActionVerificationHistory(nextHistory);
  return true;
}


export function assertReceiptVerificationHistoryLink(receiptHistory,verificationHistory){
  if(!Array.isArray(receiptHistory)||!Array.isArray(verificationHistory)) throw new Error('receipt-verification-history-required');
  if(verificationHistory.length) assertPostActionVerificationHistory(verificationHistory);
  const receipts=new Map(receiptHistory.map(receipt=>[text(receipt?.receipt_ref,'receipt-ref-required'),receipt]));
  const bindingFields=['company_id','action_id','capability','operation_id','actor_id','replay_binding','execution_attempt_id','execution_context_binding','authority_decision_ref','idempotency_key'];
  for(const verification of verificationHistory){
    const receipt=receipts.get(text(verification.receipt_ref,'verification-receipt-ref-required'));
    if(!receipt) throw new Error('verification-history-receipt-not-found');
    for(const field of bindingFields){
      if(String(verification[field]??'')!==String(receipt[field]??'')) throw new Error(`verification-history-receipt-binding-mismatch:${field}`);
    }
    if(String(receipt.status)!=='succeeded') throw new Error('verification-history-receipt-not-successful');
    const executedMs=isoMs(receipt.executed_at); const verifiedMs=isoMs(verification.verified_at);
    if(executedMs==null||verifiedMs==null) throw new Error('verification-history-receipt-time-invalid');
    if(verifiedMs<executedMs) throw new Error('verification-history-before-receipt');
  }
  if(receiptHistory.length) assertAuthoritativeExecutionReceiptHistory(receiptHistory);
  return true;
}

export function assertExecutionReceiptForCommand(receipt,command,currentAuthorityDecision=null,currentProof=null){
  if(!command||typeof command!=='object'||Array.isArray(command))throw new Error('command-envelope-required');
  if(currentAuthorityDecision) assertCommandAuthorityCurrentAt(command,currentAuthorityDecision,receipt?.executed_at);
  if(currentProof) assertCommandProofCurrent(command,currentProof);
  return assertAuthoritativeExecutionReceipt(receipt,{
    company_id:command.company_id,action_id:command.action_id,capability:command.capability,
    operation_id:command.operation_id,idempotency_key:command.idempotency_key,authority_decision_ref:command.authority_decision_ref,
    replay_binding:command.replay_binding,execution_context_binding:command.execution_context?command.execution_context_binding:null,correlation_id:command.correlation_id,trace_id:command.trace_id,execution_attempt_id:command.execution_attempt_id,issued_at:command.issued_at,
  });
}

export function assertPostActionVerificationForCommand(verification,command,receipt){
  if(!command||typeof command!=='object'||Array.isArray(command))throw new Error('command-envelope-required');
  const receipt_ref=receipt&&typeof receipt==='object'?receipt.receipt_ref:null;
  return assertPostActionVerification(verification,{
    company_id:command.company_id,action_id:command.action_id,capability:command.capability,operation_id:command.operation_id,
    receipt_ref,replay_binding:command.replay_binding,execution_context_binding:command.execution_context?command.execution_context_binding:null,correlation_id:command.correlation_id,trace_id:command.trace_id,execution_attempt_id:command.execution_attempt_id,authority_decision_ref:command.authority_decision_ref,idempotency_key:command.idempotency_key,executed_at:receipt&&typeof receipt==='object'?receipt.executed_at:null,
    required:Boolean(command.post_action_verification_required),risk:command.risk,
  });
}

export function buildReceiptVerificationHistoryPairSeal(receiptHistory,verificationHistory){
  if(!Array.isArray(receiptHistory)||!Array.isArray(verificationHistory)) throw new Error('receipt-verification-history-pair-required');
  return buildAuthorityHistoryIntegritySeal('receipt-verification-pair',[{
    receipt_history_seal:buildAuthoritativeExecutionReceiptHistorySeal(receiptHistory),
    verification_history_seal:buildPostActionVerificationHistorySeal(verificationHistory),
    receipt_count:receiptHistory.length,
    verification_count:verificationHistory.length,
  }]);
}



export function buildReceiptVerificationHistorySnapshotSeal(receiptHistory,verificationHistory,previousSnapshotSeal='root'){
  if(!Array.isArray(receiptHistory)||!Array.isArray(verificationHistory)) throw new Error('receipt-verification-history-pair-required');
  const payload=[{
    pair_seal:buildReceiptVerificationHistoryPairSeal(receiptHistory,verificationHistory),
    receipt_count:receiptHistory.length,
    verification_count:verificationHistory.length,
  }];
  return buildAuthorityHistorySnapshotSeal('receipt-verification-pair',payload,previousSnapshotSeal);
}

export function assertReceiptVerificationHistorySnapshotChain(snapshots){
  if(!Array.isArray(snapshots)||snapshots.length===0) throw new Error('receipt-verification-snapshot-chain-required');
  let previousSnapshotSeal='root';
  let previousReceiptHistory=[];
  let previousVerificationHistory=[];
  const seen=new Set();
  for(const snapshot of snapshots){
    if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)) throw new Error('receipt-verification-snapshot-required');
    const receiptHistory=snapshot.receipt_history;
    const verificationHistory=snapshot.verification_history;
    if(!Array.isArray(receiptHistory)||!Array.isArray(verificationHistory)) throw new Error('receipt-verification-history-pair-required');
    const parent=String(snapshot.previous_snapshot_seal??'root').trim()||'root';
    if(parent!==previousSnapshotSeal) throw new Error('receipt-verification-snapshot-parent-mismatch');
    const expected=buildReceiptVerificationHistorySnapshotSeal(receiptHistory,verificationHistory,parent);
    const seal=String(snapshot.snapshot_seal??'').trim();
    if(seal!==expected) throw new Error('receipt-verification-snapshot-seal-mismatch');
    if(seen.has(seal)) throw new Error('receipt-verification-snapshot-seal-reuse');
    if(previousSnapshotSeal!=='root'){
      assertReceiptVerificationPersistenceContinuity(
        previousReceiptHistory,receiptHistory,previousVerificationHistory,verificationHistory,
        null,null,buildReceiptVerificationHistoryPairSeal(previousReceiptHistory,previousVerificationHistory),
      );
    } else {
      if(receiptHistory.length) assertAuthoritativeExecutionReceiptHistory(receiptHistory);
      if(verificationHistory.length) assertPostActionVerificationHistory(verificationHistory);
      assertReceiptVerificationHistoryLink(receiptHistory,verificationHistory);
    }
    seen.add(seal);
    previousSnapshotSeal=seal;
    previousReceiptHistory=receiptHistory;
    previousVerificationHistory=verificationHistory;
  }
  return true;
}
export function assertReceiptVerificationPersistenceContinuity(
  previousReceiptHistory,nextReceiptHistory,previousVerificationHistory,nextVerificationHistory,
  expectedPreviousReceiptSeal=null,expectedPreviousVerificationSeal=null,expectedPreviousPairSeal=null,
){
  if(expectedPreviousPairSeal!=null&&String(expectedPreviousPairSeal)!==buildReceiptVerificationHistoryPairSeal(previousReceiptHistory,previousVerificationHistory)) throw new Error('receipt-verification-history-pair-seal-mismatch');
  assertAuthoritativeExecutionReceiptPersistenceContinuity(previousReceiptHistory,nextReceiptHistory,expectedPreviousReceiptSeal);
  assertPostActionVerificationPersistenceContinuity(previousVerificationHistory,nextVerificationHistory,expectedPreviousVerificationSeal);
  assertReceiptVerificationHistoryLink(nextReceiptHistory,nextVerificationHistory);
  const newReceiptRefs=new Set(nextReceiptHistory.slice(previousReceiptHistory.length).map(receipt=>text(receipt.receipt_ref,'receipt-ref-required')));
  for(const verification of nextVerificationHistory.slice(previousVerificationHistory.length)){
    const ref=text(verification.receipt_ref,'verification-receipt-ref-required');
    if(!newReceiptRefs.has(ref)) throw new Error('verification-history-new-verification-not-new-receipt');
  }
  return true;
}
