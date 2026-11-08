import { assertAuthorityCompanyId, rejectLegacyAuthorityBoundaryDeep } from './company-boundary.mjs';
import { normalizeAuthorityDecisionProvenance, evaluateAuthorityDecisionLease } from './authority-lease.mjs';
import { normalizeAuthorityDelegation } from './delegation.mjs';

export const AUTONOMY_BANDS = Object.freeze([
  Object.freeze({id:'suggest',min:0,max:15}),
  Object.freeze({id:'assist',min:16,max:30}),
  Object.freeze({id:'semi_auto',min:31,max:50}),
  Object.freeze({id:'auto',min:51,max:70}),
  Object.freeze({id:'trusted_auto',min:71,max:85}),
  Object.freeze({id:'predictive',min:86,max:100}),
]);

function score(value, name='authority-score') {
  const n=Number(value);
  if(!Number.isFinite(n)||n<0||n>100) throw new Error(`${name}-invalid`);
  return Math.floor(n);
}
function text(value){return value==null?null:String(value).trim()||null;}
function isoMs(value){const n=Date.parse(String(value??''));return Number.isFinite(n)?n:null;}
function cap(value,fallback=100){return value==null?fallback:score(value,'authority-cap');}

export function bandForScore(value){
  const n=score(value);
  return AUTONOMY_BANDS.find(b=>n>=b.min&&n<=b.max)?.id ?? 'suggest';
}

export function normalizeVerifiedAutonomySnapshot(input){
  if(!input||typeof input!=='object'||Array.isArray(input)) throw new Error('autonomy-snapshot-required');
  rejectLegacyAuthorityBoundaryDeep(input,'autonomy_snapshot');
  const company_id=assertAuthorityCompanyId(input.company_id);
  const source=String(input.source??'').trim();
  if(source!=='titan-autonomy') throw new Error('autonomy-source-invalid');
  const status=String(input.status??'verified').trim();
  if(!['verified','suspended','revoked','expired'].includes(status)) throw new Error('autonomy-status-invalid');
  const effective_score=score(input.effective_score,'effective-authority-score');
  const decision_id=String(input.decision_id??'').trim();
  const capability=String(input.capability??'').trim();
  if(!decision_id) throw new Error('autonomy-decision-id-required');
  if(!capability) throw new Error('autonomy-capability-required');
  const verified_at=text(input.verified_at);
  if(!verified_at||isoMs(verified_at)==null) throw new Error('autonomy-verified-at-invalid');
  const expires_at=text(input.expires_at);
  if(expires_at&&isoMs(expires_at)==null) throw new Error('autonomy-expires-at-invalid');
  const hs=input.trusted_auto_handshake&&typeof input.trusted_auto_handshake==='object'?input.trusted_auto_handshake:{};
  const provenance=normalizeAuthorityDecisionProvenance({
    company_id, decision_id, capability, variant:text(input.variant), workflow:text(input.workflow), context_ref:text(input.context_ref), source:'titan-autonomy', verified_at,
    decision_version:input.decision_version, evaluator_version:input.evaluator_version,
    policy_ref:input.policy_ref, risk_ref:input.risk_ref, assurance_ref:input.assurance_ref,
    source_receipt_ref:input.source_receipt_ref, signature_ref:input.signature_ref, evidence_refs:input.evidence_refs,
  });
  const delegation=normalizeAuthorityDelegation(input.delegation,{company_id,decision_id,capability,workflow:text(input.workflow),context_ref:text(input.context_ref)});
  return Object.freeze({
    schema_version:'1.0', company_id, decision_id, capability,
    variant:text(input.variant), workflow:text(input.workflow), context_ref:text(input.context_ref),
    effective_score, effective_band:bandForScore(effective_score),
    source:'titan-autonomy', authority_owner:'titan-autonomy', status,
    verified_at, expires_at, provenance, delegation,
    trusted_auto_handshake:Object.freeze({platform:Boolean(hs.platform),user:Boolean(hs.user),assurance:Boolean(hs.assurance)}),
    predictive_ready:Boolean(input.predictive_ready),
    grants_authority_locally:false,
  });
}

export function computeContractionOnlyAuthority(input){
  if(!input||typeof input!=='object') throw new Error('authority-contraction-input-required');
  const snapshot=normalizeVerifiedAutonomySnapshot(input.snapshot);
  const nowMs=isoMs(input.now??new Date().toISOString());
  if(nowMs==null) throw new Error('authority-now-invalid');
  const lease=evaluateAuthorityDecisionLease({
    company_id:snapshot.company_id, snapshot, now:input.now??new Date().toISOString(),
    max_fresh_age_ms:input.max_snapshot_age_ms??86_400_000,
  });
  const reasons=[...lease.reason_codes];
  let connectivityCap=100;
  const connectivity=String(input.connectivity??'online').trim();
  if(connectivity==='degraded'){connectivityCap=70;reasons.push('degraded_connectivity_cap');}
  else if(connectivity==='offline'){
    connectivityCap=input.protected_action?30:50;
    reasons.push(input.protected_action?'offline_protected_cap':'offline_local_cap');
  } else if(connectivity!=='online') throw new Error('connectivity-state-invalid');

  let statusCap=lease.execution_eligible?100:0;
  if(snapshot.status!=='verified') reasons.push(`authority_${snapshot.status}`);
  if(lease.state==='expired') reasons.push('authority_snapshot_expired');

  let freshnessCap=lease.state==='stale'?30:(lease.execution_eligible?100:0);
  if(lease.state==='stale') reasons.push('stale_authority_snapshot');

  const caps=Object.freeze({
    external_verified:snapshot.effective_score,
    connectivity:connectivityCap,
    status:statusCap,
    freshness:freshnessCap,
    policy:cap(input.policy_cap), risk:cap(input.risk_cap), evidence:cap(input.evidence_cap), local_safety:cap(input.local_safety_cap),
  });
  const effective_score=Math.min(...Object.values(caps));
  const previous=Number(input.previous_effective_score);
  const previousSnapshotId=text(input.previous_snapshot_id);
  const previousVerifiedAt=text(input.previous_verified_at);
  const currentVerifiedMs=isoMs(snapshot.verified_at);
  if(previousVerifiedAt){
    const previousVerifiedMs=isoMs(previousVerifiedAt);
    if(previousVerifiedMs==null) throw new Error('previous-authority-verified-at-invalid');
    if(currentVerifiedMs<previousVerifiedMs) throw new Error('authority-snapshot-rollback-forbidden');
    if(currentVerifiedMs===previousVerifiedMs&&previousSnapshotId&&previousSnapshotId!==snapshot.decision_id){
      throw new Error('authority-snapshot-lineage-conflict');
    }
  }
  const sameSnapshot=previousSnapshotId&&previousSnapshotId===snapshot.decision_id;
  if(sameSnapshot&&Number.isFinite(previous)&&effective_score>previous){
    throw new Error('local-authority-increase-forbidden');
  }
  return Object.freeze({
    schema_version:'1.0', company_id:snapshot.company_id, snapshot_id:snapshot.decision_id,
    external_verified_score:snapshot.effective_score,
    authority_lease:lease, authority_provenance:lease.provenance,
    effective_score, effective_band:bandForScore(effective_score), caps,
    reason_codes:Object.freeze([...new Set(reasons)]),
    contracted:effective_score<snapshot.effective_score,
    local_can_raise_authority:false,
  });
}
