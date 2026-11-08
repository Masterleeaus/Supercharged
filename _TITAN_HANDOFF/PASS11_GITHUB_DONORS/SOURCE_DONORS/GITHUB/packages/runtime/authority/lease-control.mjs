import { assertAuthorityCompanyId, rejectLegacyAuthorityBoundaryDeep } from './company-boundary.mjs';
import { buildAuthorityHistoryIntegritySeal, buildAuthorityHistorySnapshotSeal, stableAuthorityHistoryCanonical } from './history-integrity.mjs';

function text(value){ return value == null ? null : String(value).trim() || null; }
function isoMs(value){ const n=Date.parse(String(value??'')); return Number.isFinite(n)?n:null; }
function score(value){ const n=Number(value); if(!Number.isFinite(n)||n<0||n>100) throw new Error('authority-lease-control-score-invalid'); return Math.floor(n); }

export function normalizeAuthorityLeaseControl(input, binding={}){
  if(input == null) return null;
  if(typeof input !== 'object' || Array.isArray(input)) throw new Error('authority-lease-control-invalid');
  rejectLegacyAuthorityBoundaryDeep(input,'authority_lease_control');
  const company_id=assertAuthorityCompanyId(input.company_id ?? binding.company_id);
  if(binding.company_id && company_id!==assertAuthorityCompanyId(binding.company_id)) throw new Error('authority-lease-control-company-mismatch');
  const decision_id=text(input.decision_id ?? binding.decision_id);
  const expectedDecision=text(binding.decision_id);
  if(expectedDecision && decision_id && decision_id!==expectedDecision) throw new Error('authority-lease-control-decision-mismatch');
  if(expectedDecision && !decision_id) throw new Error('authority-lease-control-decision-required');
  const decision_provenance_seal=text(input.decision_provenance_seal);
  const expectedProvenanceSeal=text(binding.decision_provenance_seal);
  if(expectedProvenanceSeal && !decision_provenance_seal) throw new Error('authority-lease-control-provenance-required');
  if(expectedProvenanceSeal && decision_provenance_seal!==expectedProvenanceSeal) throw new Error('authority-lease-control-provenance-mismatch');
  const status=String(input.status??'active').trim();
  if(!['active','revoked'].includes(status)) throw new Error('authority-lease-control-status-invalid');
  const capability=text(input.capability ?? binding.capability);
  const workflow=text(input.workflow ?? binding.workflow);
  const context_ref=text(input.context_ref ?? binding.context_ref);
  for(const [field,actual] of [['capability',capability],['workflow',workflow],['context_ref',context_ref]]){
    const expected=text(binding[field]);
    if(expected && actual && actual!==expected) throw new Error(`authority-lease-control-scope-widening:${field}`);
  }
  const upstreamCeiling=Number(binding.authority_ceiling ?? 0);
  const max_authority_score=input.max_authority_score==null?upstreamCeiling:score(input.max_authority_score);
  if(max_authority_score>upstreamCeiling) throw new Error('authority-lease-control-authority-increase-forbidden');
  const upstreamExpiry=text(binding.lease_expires_at);
  const expires_at=text(input.expires_at ?? upstreamExpiry);
  if(expires_at && isoMs(expires_at)==null) throw new Error('authority-lease-control-expires-at-invalid');
  if(upstreamExpiry && expires_at && isoMs(expires_at)>isoMs(upstreamExpiry)) throw new Error('authority-lease-control-expiry-extension-forbidden');
  const issued_at=text(input.issued_at);
  if(issued_at&&isoMs(issued_at)==null) throw new Error('authority-lease-control-issued-at-invalid');
  const control_revision=input.control_revision==null?null:Number(input.control_revision);
  if(control_revision!=null&&(!Number.isInteger(control_revision)||control_revision<0)) throw new Error('authority-lease-control-revision-invalid');
  const revoked_at=text(input.revoked_at);
  if(status==='revoked' && !revoked_at) throw new Error('authority-lease-control-revoked-at-required');
  if(revoked_at && isoMs(revoked_at)==null) throw new Error('authority-lease-control-revoked-at-invalid');
  return Object.freeze({
    schema_version:'1.0', company_id, decision_id, decision_provenance_seal, status, capability, workflow, context_ref,
    max_authority_score, expires_at, revoked_at, issued_at, control_revision,
    reason:text(input.reason), control_id:text(input.control_id),
    identity_confers_authority:false, control_can_raise_authority:false,
  });
}

export function assertAuthorityLeaseControlContinuity(previousInput,nextInput,binding={}){
  if(!previousInput||!nextInput) return true;
  const previous=normalizeAuthorityLeaseControl(previousInput,binding);
  const next=normalizeAuthorityLeaseControl(nextInput,binding);
  if(previous.decision_id&&next.decision_id&&previous.decision_id!==next.decision_id) throw new Error('authority-lease-control-decision-mismatch');
  if(previous.decision_provenance_seal&&next.decision_provenance_seal&&previous.decision_provenance_seal!==next.decision_provenance_seal) throw new Error('authority-lease-control-provenance-mismatch');
  if(previous.decision_provenance_seal&&!next.decision_provenance_seal) throw new Error('authority-lease-control-provenance-downgrade');
  if(previous.status==='revoked'&&next.status!=='revoked') throw new Error('authority-lease-control-revival-forbidden');
  if(next.max_authority_score>previous.max_authority_score) throw new Error('authority-lease-control-rollback-authority-increase');
  if(previous.expires_at&&next.expires_at&&isoMs(next.expires_at)>isoMs(previous.expires_at)) throw new Error('authority-lease-control-rollback-expiry-extension');
  if(previous.issued_at&&!next.issued_at) throw new Error('authority-lease-control-issued-at-downgrade');
  if(previous.issued_at&&next.issued_at&&isoMs(next.issued_at)<isoMs(previous.issued_at)) throw new Error('authority-lease-control-time-rollback');
  if(previous.control_revision!=null&&next.control_revision==null) throw new Error('authority-lease-control-revision-downgrade');
  if(previous.control_revision!=null&&next.control_revision!=null&&next.control_revision<previous.control_revision) throw new Error('authority-lease-control-revision-rollback');
  if(previous.status==='revoked'&&previous.revoked_at&&next.revoked_at&&isoMs(next.revoked_at)>isoMs(previous.revoked_at)) throw new Error('authority-lease-control-revocation-delay-forbidden');
  if(previous.control_id&&next.control_id===previous.control_id){
    const same=previous.status===next.status&&previous.max_authority_score===next.max_authority_score&&previous.expires_at===next.expires_at&&previous.revoked_at===next.revoked_at;
    if(!same) throw new Error('authority-lease-control-id-equivocation');
  }
  return true;
}

export function assertAuthorityLeaseControlHistory(history,binding={}){
  if(!Array.isArray(history)||history.length===0) throw new Error('authority-lease-control-history-required');
  const seenIds=new Set();
  let previous=null;
  for(const input of history){
    const current=normalizeAuthorityLeaseControl(input,binding);
    if(current.control_id){
      if(seenIds.has(current.control_id)) throw new Error('authority-lease-control-history-id-reuse');
      seenIds.add(current.control_id);
    }
    if(previous) assertAuthorityLeaseControlContinuity(previous,current,binding);
    previous=current;
  }
  return true;
}

export function buildAuthorityLeaseControlHistorySeal(history,binding={}){
  if(!Array.isArray(history)) throw new Error('authority-lease-control-history-required');
  const normalized=history.map(item=>normalizeAuthorityLeaseControl(item,binding));
  return buildAuthorityHistoryIntegritySeal('authority-lease-control',normalized);
}

export function assertAuthorityLeaseControlPersistenceContinuity(previousHistory,nextHistory,binding={},expectedPreviousSeal=null,currentDecision=null){
  if(!Array.isArray(previousHistory)||!Array.isArray(nextHistory)) throw new Error('authority-lease-control-persistence-history-required');
  if(expectedPreviousSeal!=null&&String(expectedPreviousSeal)!==buildAuthorityLeaseControlHistorySeal(previousHistory,binding)) throw new Error('authority-lease-control-history-seal-mismatch');
  if(nextHistory.length<previousHistory.length) throw new Error('authority-lease-control-history-truncation-forbidden');
  for(let i=0;i<previousHistory.length;i++){
    const previous=normalizeAuthorityLeaseControl(previousHistory[i],binding);
    const next=normalizeAuthorityLeaseControl(nextHistory[i],binding);
    if(stableAuthorityHistoryCanonical(previous)!==stableAuthorityHistoryCanonical(next)) throw new Error('authority-lease-control-history-prefix-equivocation');
  }
  if(previousHistory.length) assertAuthorityLeaseControlHistory(previousHistory,binding);
  if(nextHistory.length) assertAuthorityLeaseControlHistory(nextHistory,binding);
  if(currentDecision){
    for(const control of nextHistory.slice(previousHistory.length)) assertAuthorityLeaseControlAgainstCurrentDecision(control,currentDecision);
  }
  return true;
}



function currentDecisionSnapshotIdentity(currentDecision){
  if(!currentDecision||typeof currentDecision!=='object'||Array.isArray(currentDecision)) throw new Error('authority-current-decision-required');
  return {
    company_id:assertAuthorityCompanyId(currentDecision.company_id),
    authority_decision_id:text(currentDecision.authority_decision_id ?? currentDecision.decision_id),
    decision:text(currentDecision.decision),
    capability:text(currentDecision.capability),
    provenance_seal:text(currentDecision.provenance_seal ?? currentDecision.provenance?.provenance_seal),
    supersedes_authority_decision_id:text(currentDecision.supersedes_authority_decision_id),
  };
}


export function assertAuthorityCurrentDecisionSnapshotContinuity(previousDecision,currentDecision){
  const previous=currentDecisionSnapshotIdentity(previousDecision);
  const current=currentDecisionSnapshotIdentity(currentDecision);
  if(previous.company_id!==current.company_id) throw new Error('authority-current-decision-snapshot-company-mismatch');
  if(previous.authority_decision_id===current.authority_decision_id){
    if(previous.provenance_seal!==current.provenance_seal) throw new Error('authority-current-decision-snapshot-provenance-equivocation');
    if(previous.decision!==current.decision) throw new Error('authority-current-decision-snapshot-outcome-equivocation');
    if(previous.capability!==current.capability) throw new Error('authority-current-decision-snapshot-capability-equivocation');
    return true;
  }
  if(current.supersedes_authority_decision_id!==previous.authority_decision_id) throw new Error('authority-current-decision-snapshot-supersession-required');
  return true;
}

export function buildAuthorityLeaseControlHistorySnapshotSeal(history,binding={},currentDecision,previousSnapshotSeal='root'){
  if(!Array.isArray(history)) throw new Error('authority-lease-control-history-required');
  const normalized=history.map(item=>normalizeAuthorityLeaseControl(item,binding));
  if(currentDecision){
    for(const control of normalized) assertAuthorityLeaseControlAgainstCurrentDecision(control,currentDecision);
  }
  const payload=[{history:normalized,current_decision:currentDecisionSnapshotIdentity(currentDecision)}];
  return buildAuthorityHistorySnapshotSeal('authority-lease-control-live-decision',payload,previousSnapshotSeal);
}

export function assertAuthorityLeaseControlHistorySnapshotChain(snapshots,binding={}){
  if(!Array.isArray(snapshots)||snapshots.length===0) throw new Error('authority-lease-control-snapshot-chain-required');
  let previousSeal='root';
  let previousHistory=[];
  let previousCurrentDecision=null;
  const seen=new Set();
  for(const snapshot of snapshots){
    if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)) throw new Error('authority-lease-control-snapshot-required');
    const history=snapshot.history;
    const currentDecision=snapshot.current_decision;
    if(!Array.isArray(history)) throw new Error('authority-lease-control-history-required');
    const parent=String(snapshot.previous_snapshot_seal??'root').trim()||'root';
    if(parent!==previousSeal) throw new Error('authority-lease-control-snapshot-parent-mismatch');
    const expected=buildAuthorityLeaseControlHistorySnapshotSeal(history,binding,currentDecision,parent);
    const seal=String(snapshot.snapshot_seal??'').trim();
    if(seal!==expected) throw new Error('authority-lease-control-snapshot-seal-mismatch');
    if(seen.has(seal)) throw new Error('authority-lease-control-snapshot-seal-reuse');
    if(previousCurrentDecision) assertAuthorityCurrentDecisionSnapshotContinuity(previousCurrentDecision,currentDecision);
    if(previousSeal!=='root') assertAuthorityLeaseControlPersistenceContinuity(previousHistory,history,binding,buildAuthorityLeaseControlHistorySeal(previousHistory,binding),currentDecision);
    else if(history.length) assertAuthorityLeaseControlHistory(history,binding);
    seen.add(seal);
    previousSeal=seal;
    previousHistory=history;
    previousCurrentDecision=currentDecision;
  }
  return true;
}
export function applyAuthorityLeaseControl(lease, controlInput, now=new Date().toISOString()){
  if(!lease || typeof lease!=='object') throw new Error('authority-lease-required');
  const control=normalizeAuthorityLeaseControl(controlInput,{
    company_id:lease.company_id, decision_id:lease.decision_id, capability:lease.capability, workflow:lease.workflow, context_ref:lease.context_ref,
    authority_ceiling:lease.authority_ceiling, lease_expires_at:lease.lease_expires_at,
  });
  if(!control) return lease;
  if(lease.lease_control) assertAuthorityLeaseControlContinuity(lease.lease_control,control,{
    company_id:lease.company_id, decision_id:lease.decision_id, capability:lease.capability, workflow:lease.workflow, context_ref:lease.context_ref,
    authority_ceiling:lease.authority_ceiling, lease_expires_at:lease.lease_expires_at,
  });
  const nowMs=isoMs(now); if(nowMs==null) throw new Error('authority-lease-control-now-invalid');
  let state=lease.state; const reasons=[...(lease.reason_codes??[])];
  let execution_eligible=Boolean(lease.execution_eligible);
  let authority_ceiling=Math.min(Number(lease.authority_ceiling??0),control.max_authority_score);
  if(control.status==='revoked' && (!control.revoked_at || isoMs(control.revoked_at)<=nowMs)){
    state='revoked'; execution_eligible=false; authority_ceiling=0; reasons.push('authority_lease_control_revoked');
  } else if(control.expires_at && isoMs(control.expires_at)<=nowMs){
    state='expired'; execution_eligible=false; authority_ceiling=0; reasons.push('authority_lease_control_expired');
  } else if(authority_ceiling < Number(lease.authority_ceiling??0)) reasons.push('authority_lease_control_narrowed');
  return Object.freeze({
    ...lease,
    state,
    lease_status:execution_eligible?'active':state,
    lease_expires_at:control.expires_at ?? lease.lease_expires_at,
    execution_eligible,
    authority_ceiling,
    lease_control:control,
    reason_codes:Object.freeze([...new Set(reasons)]),
    local_can_raise_authority:false,
  });
}

export function assertAuthorityLeaseControlAgainstCurrentDecision(controlInput,currentDecision){
  if(!controlInput||typeof controlInput!=='object'||Array.isArray(controlInput)) throw new Error('authority-lease-control-invalid');
  if(!currentDecision||typeof currentDecision!=='object'||Array.isArray(currentDecision)) throw new Error('authority-current-decision-required');
  const company_id=assertAuthorityCompanyId(controlInput.company_id);
  const currentCompany=assertAuthorityCompanyId(currentDecision.company_id);
  if(company_id!==currentCompany) throw new Error('authority-lease-control-current-company-mismatch');
  const decision_id=text(controlInput.decision_id);
  if(!decision_id) throw new Error('authority-lease-control-decision-required');
  const currentId=text(currentDecision.authority_decision_id ?? currentDecision.decision_id);
  if(!currentId) throw new Error('authority-current-decision-id-required');
  const supersedes=text(currentDecision.supersedes_authority_decision_id);
  if(supersedes===decision_id && currentId!==decision_id) throw new Error('authority-lease-control-decision-superseded');
  if(currentId!==decision_id) throw new Error('authority-lease-control-current-decision-mismatch');
  const controlSeal=text(controlInput.decision_provenance_seal);
  const currentSeal=text(currentDecision.provenance_seal ?? currentDecision.provenance?.provenance_seal);
  if(controlSeal && !currentSeal) throw new Error('authority-lease-control-current-provenance-required');
  if(controlSeal && currentSeal!==controlSeal) throw new Error('authority-lease-control-current-provenance-mismatch');
  if(currentDecision.decision && String(currentDecision.decision)!=='ALLOW') throw new Error('authority-lease-control-current-decision-not-allow');
  const controlCapability=text(controlInput.capability);
  const currentCapability=text(currentDecision.capability);
  if(controlCapability&&currentCapability&&controlCapability!==currentCapability) throw new Error('authority-lease-control-current-capability-mismatch');
  return true;
}
