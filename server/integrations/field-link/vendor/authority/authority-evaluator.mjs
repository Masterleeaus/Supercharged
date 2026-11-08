import { assertAuthorityCompanyId, rejectLegacyAuthorityBoundaryDeep } from './company-boundary.mjs';
import { createWorkerIdentity, createAuthorityRequirement, createApprovalState } from './worker-authority.mjs';
import { normalizeVerifiedAutonomySnapshot, computeContractionOnlyAuthority } from './autonomy.mjs';
import { isProtectedAction } from './protected-actions.mjs';
import { buildAuthorityHistoryIntegritySeal, buildAuthorityHistorySnapshotSeal, stableAuthorityHistoryCanonical } from './history-integrity.mjs';

export const AUTHORITY_DECISIONS=Object.freeze([
  'ALLOW','APPROVAL_REQUIRED','EVIDENCE_REQUIRED','ESCALATE','DENY','AUTHORITY_UNAVAILABLE','RECOVERY_REQUIRED'
]);
export const RISK_LEVELS=Object.freeze(['none','low','medium','high','critical']);
const RISK_CAPS=Object.freeze({none:100,low:85,medium:70,high:50,critical:0});
const text=v=>v==null?null:String(v).trim()||null;
const list=v=>Array.isArray(v)?[...new Set(v.map(x=>String(x).trim()).filter(Boolean))].sort():[];

function operationalLimitCheck(limits={},usage={}){
  const reasons=[]; const constraints=[];
  const currency=String(usage?.currency??"").trim().toUpperCase();
  const requireNumber=(field,reason)=>{
    const n=Number(usage?.[field]);
    if(!Number.isFinite(n)||n<0){reasons.push(`${reason}_usage_missing`);return null;}
    return n;
  };
  const requireInteger=(field,reason)=>{
    const n=requireNumber(field,reason);
    if(n!=null&&!Number.isInteger(n)){reasons.push(`${reason}_usage_invalid`);return null;}
    return n;
  };
  if(limits.max_amount!=null){
    constraints.push(`max_amount:${limits.currency}:${limits.max_amount}`);
    const n=requireNumber("amount","amount_limit");
    if(!currency)reasons.push("amount_limit_currency_missing");
    else if(currency!==limits.currency)reasons.push("amount_limit_currency_mismatch");
    if(n!=null&&n>limits.max_amount)reasons.push("amount_limit_exceeded");
  }
  if(limits.max_provider_cost!=null){
    constraints.push(`max_provider_cost:${limits.currency}:${limits.max_provider_cost}`);
    const n=requireNumber("provider_cost","provider_cost_limit");
    if(!currency)reasons.push("provider_cost_limit_currency_missing");
    else if(currency!==limits.currency)reasons.push("provider_cost_limit_currency_mismatch");
    if(n!=null&&n>limits.max_provider_cost)reasons.push("provider_cost_limit_exceeded");
  }
  if(limits.max_messages!=null){
    constraints.push(`max_messages:${limits.max_messages}`);
    const n=requireInteger("messages","message_limit");
    if(n!=null&&n>limits.max_messages)reasons.push("message_limit_exceeded");
  }
  if(limits.max_recipients!=null){
    constraints.push(`max_recipients:${limits.max_recipients}`);
    const n=requireInteger("recipients","recipient_limit");
    if(n!=null&&n>limits.max_recipients)reasons.push("recipient_limit_exceeded");
  }
  return Object.freeze({allowed:reasons.length===0,reasons:Object.freeze(reasons),constraints:Object.freeze(constraints)});
}

function decisionBase({input,company_id,worker,requirement,reason_codes=[],constraints=[],decision,effective=null,approval=null,evidence_refs=[]}){
  return Object.freeze({
    schema_version:'1.0',
    authority_decision_id:String(input.authority_decision_id??'').trim()||`authority:${String(input.operation_id??input.action_id??'unknown')}`,
    company_id,
    ...(text(input.actor_id)?{actor_id:text(input.actor_id)}:{}),
    operation_id:text(input.operation_id),action_id:text(input.action_id),worker_id:worker.worker_id,
    worker_type:worker.worker_type,surface:worker.surface,
    capability:requirement.capability,variant:requirement.variant,workflow:requirement.workflow,context_ref:requirement.context_ref,operation:requirement.operation,effect:requirement.effect,
    protected_action:isProtectedAction(requirement),decision,
    effective_authority_score:effective?.effective_score??0,
    effective_authority_band:effective?.effective_band??'suggest',
    autonomy_snapshot_id:effective?.snapshot_id??null,
    autonomy_owner:'titan-autonomy',
    authority_lease:effective?.authority_lease??null,
    authority_provenance:effective?.authority_provenance??null,
    authority_delegation:effective?.authority_lease?.delegation??null,
    supersedes_authority_decision_id:text(input.supersedes_authority_decision_id),
    delegation_extinction:effective?.authority_lease?.delegation_extinction??null,
    approval,
    evidence_refs:Object.freeze(list(evidence_refs)),
    constraints:Object.freeze([...new Set(constraints)]),
    reason_codes:Object.freeze([...new Set(reason_codes)]),
    limiting_caps:effective?.caps??null,
    identity_confers_authority:false,
    role_confers_authority:false,
    activation_confers_authority:false,
    module_activation_confers_authority:false,
    local_can_raise_authority:false,
    evaluated_at:String(input.now??new Date().toISOString()),
  });
}

export function evaluateWorkerAuthorityDecision(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('authority-evaluation-input-required');
  rejectLegacyAuthorityBoundaryDeep(input,'authority_evaluation');
  const company_id=assertAuthorityCompanyId(input.company_id);
  const worker=createWorkerIdentity({...input.worker,company_id});
  const requirement=createAuthorityRequirement({...input.requirement,company_id});
  const protected_action=isProtectedAction(requirement);
  const permissions=new Set(list(input.permissions));
  const entitlements=new Set(list(input.entitlements));
  const missing_permissions=requirement.required_permissions.filter(x=>!permissions.has(x));
  const missing_entitlements=requirement.required_entitlements.filter(x=>!entitlements.has(x));
  const risk=String(input.risk??'none').trim();
  if(!RISK_LEVELS.includes(risk))throw new Error(`invalid-risk:${risk}`);
  const evidence=input.evidence&&typeof input.evidence==='object'?input.evidence:{};
  const evidence_status=String(evidence.status??(requirement.required_evidence.length?'missing':'not_required')).trim();
  const evidence_refs=list(evidence.refs??requirement.evidence_refs);
  const approval=createApprovalState({...(input.approval??{}),company_id});
  const reason_codes=[];
  const constraints=[];

  if(missing_permissions.length||missing_entitlements.length||input.policy_allows!==true||input.governance_allows!==true){
    if(missing_permissions.length)reason_codes.push('missing_permission');
    if(missing_entitlements.length)reason_codes.push('missing_entitlement');
    if(input.policy_allows!==true)reason_codes.push('policy_not_allowed');
    if(input.governance_allows!==true)reason_codes.push('governance_not_allowed');
    return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});
  }
  if(input.assurance_allows!==true){
    reason_codes.push('assurance_not_satisfied');
    return decisionBase({input,company_id,worker,requirement,decision:'ESCALATE',reason_codes,approval,evidence_refs});
  }
  const limitCheck=operationalLimitCheck(requirement.limits,input.usage);
  constraints.push(...limitCheck.constraints);
  if(!limitCheck.allowed){
    reason_codes.push(...limitCheck.reasons);
    return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs,constraints});
  }
  if(risk==='critical'){
    reason_codes.push('critical_risk');
    return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});
  }
  if(risk==='high'&&protected_action){
    reason_codes.push('high_risk_escalation_required');
    return decisionBase({input,company_id,worker,requirement,decision:'ESCALATE',reason_codes,approval,evidence_refs});
  }
  if(requirement.required_evidence.length&&evidence_status!=='satisfied'){
    reason_codes.push(`evidence_${evidence_status||'missing'}`);
    return decisionBase({input,company_id,worker,requirement,decision:'EVIDENCE_REQUIRED',reason_codes,approval,evidence_refs});
  }
  const approvalRequired=protected_action||Boolean(requirement.approval_policy);
  if(approvalRequired){
    if(['denied','revoked','expired'].includes(approval.status)){
      reason_codes.push(`approval_${approval.status}`);
      return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});
    }
    if(approval.status==='approved'&&approval.approver_id&&approval.approver_id===worker.worker_id){
      reason_codes.push('self_approval_forbidden');
      return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});
    }
    if(approval.status==='approved'){
      if(!approval.approval_id){reason_codes.push('approval_id_missing');return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});}
      if(!approval.approver_id){reason_codes.push('approver_id_missing');return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});}
      const grantedMs=Date.parse(String(approval.granted_at??''));
      const nowMs=Date.parse(String(input.now??new Date().toISOString()));
      if(!Number.isFinite(grantedMs)){reason_codes.push('approval_granted_at_invalid');return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});}
      if(!Number.isFinite(nowMs)||grantedMs>nowMs){reason_codes.push('approval_granted_in_future');return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});}
      if(approval.expires_at){const expiresMs=Date.parse(approval.expires_at);if(Number.isFinite(expiresMs)&&expiresMs<=grantedMs){reason_codes.push('approval_expiry_not_after_grant');return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});}}
    }
    if(approval.status==='approved'&&approval.expires_at){
      const expiresMs=Date.parse(approval.expires_at);
      const nowMs=Date.parse(String(input.now??new Date().toISOString()));
      if(!Number.isFinite(expiresMs)||!Number.isFinite(nowMs)||expiresMs<=nowMs){
        reason_codes.push('approval_expired');
        return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});
      }
    }
    if(approval.status==='approved'){
      const scope=String(approval.approval_scope??'').trim();
      const validScopes=new Set([
        String(input.action_id??'').trim(),
        String(input.operation_id??'').trim(),
        requirement.capability,
        `${requirement.capability}:${requirement.operation}`,
      ].filter(Boolean));
      if(!scope){
        reason_codes.push('approval_scope_missing');
        return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});
      }
      if(!validScopes.has(scope)){
        reason_codes.push('approval_scope_mismatch');
        return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});
      }
    }
    if(approval.status!=='approved'){
      reason_codes.push('approval_required');
      return decisionBase({input,company_id,worker,requirement,decision:'APPROVAL_REQUIRED',reason_codes,approval,evidence_refs});
    }
  }

  if(!input.autonomy_snapshot){
    reason_codes.push('verified_autonomy_snapshot_required');
    return decisionBase({input,company_id,worker,requirement,decision:'AUTHORITY_UNAVAILABLE',reason_codes,approval,evidence_refs});
  }
  const snapshot=normalizeVerifiedAutonomySnapshot(input.autonomy_snapshot);
  if(snapshot.company_id!==company_id)throw new Error('authority-company-mismatch');
  if(snapshot.capability!==requirement.capability)throw new Error('authority-capability-mismatch');
  if(requirement.variant&&snapshot.variant!==requirement.variant){
    reason_codes.push('authority_variant_mismatch');
    return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});
  }
  if(requirement.workflow&&snapshot.workflow!==requirement.workflow){
    reason_codes.push('authority_workflow_mismatch');
    return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});
  }
  if(requirement.context_ref&&snapshot.context_ref!==requirement.context_ref){
    reason_codes.push('authority_context_mismatch');
    return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,approval,evidence_refs});
  }

  const effective=computeContractionOnlyAuthority({
    snapshot, connectivity:input.connectivity??'online', protected_action,
    now:input.now, max_snapshot_age_ms:input.max_snapshot_age_ms,
    previous_effective_score:input.previous_effective_score, previous_snapshot_id:input.previous_snapshot_id,
    policy_cap:100, risk_cap:RISK_CAPS[risk], evidence_cap:evidence_status==='satisfied'||evidence_status==='not_required'?100:0,
    local_safety_cap:input.local_safety_cap,
  });
  reason_codes.push(...effective.reason_codes);
  if(effective.effective_score===0){
    reason_codes.push('effective_authority_zero');
    return decisionBase({input,company_id,worker,requirement,decision:'AUTHORITY_UNAVAILABLE',reason_codes,effective,approval,evidence_refs});
  }

  const predictivePhase=String(input.predictive_phase??'').trim().toUpperCase();
  if(predictivePhase==='PREPARE'&&requirement.effect!=='read'){
    reason_codes.push('predictive_prepare_non_mutating');
    return decisionBase({input,company_id,worker,requirement,decision:'DENY',reason_codes,effective,approval,evidence_refs});
  }
  if(effective.effective_score>=71){
    const hs=snapshot.trusted_auto_handshake;
    if(!hs.platform){reason_codes.push('trusted_auto_platform_handshake_missing');return decisionBase({input,company_id,worker,requirement,decision:'ESCALATE',reason_codes,effective,approval,evidence_refs});}
    if(!hs.user){reason_codes.push('trusted_auto_user_handshake_missing');return decisionBase({input,company_id,worker,requirement,decision:'APPROVAL_REQUIRED',reason_codes,effective,approval,evidence_refs});}
    if(!hs.assurance){reason_codes.push('trusted_auto_assurance_handshake_missing');return decisionBase({input,company_id,worker,requirement,decision:'ESCALATE',reason_codes,effective,approval,evidence_refs});}
  }
  if(effective.effective_score>=86&&predictivePhase==='EXECUTE'&&!snapshot.predictive_ready){
    reason_codes.push('predictive_readiness_missing');
    return decisionBase({input,company_id,worker,requirement,decision:'ESCALATE',reason_codes,effective,approval,evidence_refs});
  }
  if(effective.effective_score<requirement.minimum_autonomy_score){
    reason_codes.push('autonomy_below_required');
    constraints.push('human_or_higher_authority_required');
    return decisionBase({input,company_id,worker,requirement,decision:'ESCALATE',reason_codes,effective,approval,evidence_refs,constraints});
  }
  reason_codes.push('all_authority_gates_satisfied');
  return decisionBase({input,company_id,worker,requirement,decision:'ALLOW',reason_codes,effective,approval,evidence_refs});
}



export function assertAuthorityDecisionSupersessionContinuity(previous,next){
  if(!previous||typeof previous!=='object'||Array.isArray(previous))throw new Error('previous-authority-decision-required');
  if(!next||typeof next!=='object'||Array.isArray(next))throw new Error('next-authority-decision-required');
  rejectLegacyAuthorityBoundaryDeep(previous,'previous_authority_decision');
  rejectLegacyAuthorityBoundaryDeep(next,'next_authority_decision');
  const prevCompany=assertAuthorityCompanyId(previous.company_id);
  const nextCompany=assertAuthorityCompanyId(next.company_id);
  if(prevCompany!==nextCompany)throw new Error('authority-supersession-company-mismatch');
  for(const field of ['worker_id','capability','operation_id','action_id']){
    const a=text(previous[field]); const b=text(next[field]);
    if(a&&b&&a!==b)throw new Error(`authority-supersession-binding-mismatch:${field}`);
  }
  const prevId=text(previous.authority_decision_id); const nextId=text(next.authority_decision_id);
  if(!prevId||!nextId)throw new Error('authority-supersession-decision-id-required');
  const prevMs=Date.parse(String(previous.evaluated_at??'')); const nextMs=Date.parse(String(next.evaluated_at??''));
  if(!Number.isFinite(prevMs)||!Number.isFinite(nextMs))throw new Error('authority-supersession-evaluated-at-invalid');
  if(nextMs<prevMs)throw new Error('authority-supersession-time-rollback');
  if(nextId===prevId){
    const same=
      String(previous.decision??'')===String(next.decision??'')&&
      prevMs===nextMs&&
      String(previous.autonomy_snapshot_id??'')===String(next.autonomy_snapshot_id??'')&&
      String(previous.supersedes_authority_decision_id??'')===String(next.supersedes_authority_decision_id??'')&&
      String(previous.worker_id??'')===String(next.worker_id??'')&&
      String(previous.capability??'')===String(next.capability??'')&&
      String(previous.operation_id??'')===String(next.operation_id??'')&&
      String(previous.action_id??'')===String(next.action_id??'')&&
      String(previous.provenance_seal??previous.provenance?.provenance_seal??'')===String(next.provenance_seal??next.provenance?.provenance_seal??'');
    if(!same)throw new Error('authority-supersession-id-equivocation');
    return Object.freeze({previous,next,superseded:false,continuous:true});
  }
  if(nextMs===prevMs)throw new Error('authority-supersession-same-time-conflict');
  if(next.supersedes_authority_decision_id&&String(next.supersedes_authority_decision_id)!==prevId)throw new Error('authority-supersession-parent-mismatch');
  return Object.freeze({previous,next,superseded:true,continuous:true});
}

export function assertAuthorityDecisionSupersessionGraph(decisions){
  if(!Array.isArray(decisions)||decisions.length===0)throw new Error('authority-supersession-graph-required');
  const byId=new Map();
  for(const decision of decisions){
    if(!decision||typeof decision!=='object'||Array.isArray(decision))throw new Error('authority-supersession-graph-decision-invalid');
    rejectLegacyAuthorityBoundaryDeep(decision,'authority_supersession_graph_decision');
    assertAuthorityCompanyId(decision.company_id);
    const id=text(decision.authority_decision_id);
    if(!id)throw new Error('authority-supersession-decision-id-required');
    if(byId.has(id)){
      const existing=byId.get(id);
      assertAuthorityDecisionSupersessionContinuity(existing,decision);
      continue;
    }
    byId.set(id,decision);
  }
  const childByParent=new Map();
  const roots=[];
  for(const [id,decision] of byId){
    const parent=text(decision.supersedes_authority_decision_id);
    if(!parent){roots.push(id);continue;}
    if(!byId.has(parent))throw new Error('authority-supersession-parent-missing');
    const existing=childByParent.get(parent);
    if(existing&&existing!==id)throw new Error('authority-supersession-fork');
    childByParent.set(parent,id);
  }
  if(roots.length!==1)throw new Error(roots.length===0?'authority-supersession-cycle':'authority-supersession-disconnected-roots');
  const ordered=[]; const seen=new Set();
  let cursor=roots[0];
  while(cursor){
    if(seen.has(cursor))throw new Error('authority-supersession-cycle');
    seen.add(cursor);
    const current=byId.get(cursor); ordered.push(current);
    const childId=childByParent.get(cursor);
    if(childId){
      const child=byId.get(childId);
      assertAuthorityDecisionSupersessionContinuity(current,child);
    }
    cursor=childId??null;
  }
  if(seen.size!==byId.size)throw new Error('authority-supersession-cycle');
  return Object.freeze({
    ordered:Object.freeze(ordered),
    root:ordered[0],
    terminal:ordered[ordered.length-1],
    continuous:true,
    fork_free:true,
    cycle_free:true,
  });
}


export function buildAuthorityDecisionSupersessionHistorySeal(history){
  if(!Array.isArray(history)) throw new Error('authority-supersession-history-required');
  if(history.length===0) return buildAuthorityHistoryIntegritySeal('authority-decision-supersession',[]);
  const graph=assertAuthorityDecisionSupersessionGraph(history);
  return buildAuthorityHistoryIntegritySeal('authority-decision-supersession',graph.ordered);
}

export function assertAuthorityDecisionSupersessionPersistenceContinuity(previousHistory,nextHistory,expectedPreviousSeal=null){
  if(!Array.isArray(previousHistory)||!Array.isArray(nextHistory)) throw new Error('authority-supersession-persistence-history-required');
  if(expectedPreviousSeal!=null&&String(expectedPreviousSeal)!==buildAuthorityDecisionSupersessionHistorySeal(previousHistory)) throw new Error('authority-supersession-history-seal-mismatch');
  if(nextHistory.length<previousHistory.length) throw new Error('authority-supersession-history-truncation-forbidden');
  for(let i=0;i<previousHistory.length;i++){
    if(stableAuthorityHistoryCanonical(previousHistory[i])!==stableAuthorityHistoryCanonical(nextHistory[i])) throw new Error('authority-supersession-history-prefix-equivocation');
  }
  if(previousHistory.length) assertAuthorityDecisionSupersessionGraph(previousHistory);
  if(nextHistory.length) assertAuthorityDecisionSupersessionGraph(nextHistory);
  return true;
}


export function buildAuthorityDecisionSupersessionHistorySnapshotSeal(history,previousSnapshotSeal='root'){
  if(!Array.isArray(history)) throw new Error('authority-supersession-history-required');
  const ordered=history.length?assertAuthorityDecisionSupersessionGraph(history).ordered:[];
  return buildAuthorityHistorySnapshotSeal('authority-decision-supersession',ordered,previousSnapshotSeal);
}

export function assertAuthorityDecisionSupersessionHistorySnapshotChain(snapshots){
  if(!Array.isArray(snapshots)||snapshots.length===0) throw new Error('authority-supersession-snapshot-chain-required');
  let previousSeal='root';
  let previousHistory=[];
  const seen=new Set();
  for(const snapshot of snapshots){
    if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)) throw new Error('authority-supersession-snapshot-required');
    const history=snapshot.history;
    if(!Array.isArray(history)) throw new Error('authority-supersession-history-required');
    const parent=String(snapshot.previous_snapshot_seal??'root').trim()||'root';
    if(parent!==previousSeal) throw new Error('authority-supersession-snapshot-parent-mismatch');
    const expected=buildAuthorityDecisionSupersessionHistorySnapshotSeal(history,parent);
    const seal=String(snapshot.snapshot_seal??'').trim();
    if(seal!==expected) throw new Error('authority-supersession-snapshot-seal-mismatch');
    if(seen.has(seal)) throw new Error('authority-supersession-snapshot-seal-reuse');
    if(previousSeal!=='root') assertAuthorityDecisionSupersessionPersistenceContinuity(previousHistory,history,buildAuthorityDecisionSupersessionHistorySeal(previousHistory));
    else if(history.length) assertAuthorityDecisionSupersessionGraph(history);
    seen.add(seal);
    previousSeal=seal;
    previousHistory=history;
  }
  return true;
}

export function assertAuthorityDecisionAllowsExecution(decision,{company_id,capability,operation_id,action_id,worker_id,now,max_age_ms}={}){
  if(!decision||typeof decision!=='object'||Array.isArray(decision))throw new Error('authority-decision-required');
  rejectLegacyAuthorityBoundaryDeep(decision,'authority_decision');
  const expected=assertAuthorityCompanyId(company_id??decision.company_id);
  const actual=assertAuthorityCompanyId(decision.company_id);
  if(expected!==actual)throw new Error('authority-company-mismatch');
  if(capability){if(!text(decision.capability))throw new Error('authority-capability-binding-required');if(String(decision.capability)!==String(capability))throw new Error('authority-capability-mismatch');}
  if(operation_id){if(!text(decision.operation_id))throw new Error('authority-operation-binding-required');if(String(decision.operation_id)!==String(operation_id))throw new Error('authority-operation-mismatch');}
  if(action_id){if(!text(decision.action_id))throw new Error('authority-action-binding-required');if(String(decision.action_id)!==String(action_id))throw new Error('authority-action-mismatch');}
  if(worker_id){if(!text(decision.worker_id))throw new Error('authority-worker-binding-required');if(String(decision.worker_id)!==String(worker_id))throw new Error('authority-worker-mismatch');}
  if(decision.decision!=='ALLOW')throw new Error(`authority-not-allowed:${decision.decision}`);
  const evaluatedMs=Date.parse(String(decision.evaluated_at??''));
  if(!Number.isFinite(evaluatedMs))throw new Error('authority-evaluated-at-invalid');
  if(now!=null||max_age_ms!=null){
    const nowMs=Date.parse(String(now??new Date().toISOString()));
    if(!Number.isFinite(nowMs))throw new Error('authority-execution-now-invalid');
    if(evaluatedMs>nowMs)throw new Error('authority-evaluated-in-future');
    const maxAge=Number(max_age_ms??900000);
    if(!Number.isFinite(maxAge)||maxAge<0)throw new Error('authority-max-age-invalid');
    if(nowMs-evaluatedMs>maxAge)throw new Error('authority-decision-stale');
  }
  return true;
}
