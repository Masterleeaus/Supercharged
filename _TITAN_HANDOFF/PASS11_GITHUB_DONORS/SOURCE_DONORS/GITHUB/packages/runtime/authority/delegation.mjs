import { assertAuthorityCompanyId, rejectLegacyAuthorityBoundaryDeep } from './company-boundary.mjs';
import { buildAuthorityHistoryIntegritySeal, buildAuthorityHistorySnapshotSeal } from './history-integrity.mjs';

export const MAX_AUTHORITY_DELEGATION_DEPTH = 8;
export const DELEGATION_EXTINCTION_REASONS = Object.freeze([
  'delegation_expired',
  'delegation_parent_inactive',
  'delegation_child_inactive',
  'delegation_company_mismatch',
  'delegation_capability_mismatch',
  'delegation_workflow_mismatch',
  'delegation_context_mismatch',
  'delegation_depth_exceeded',
  'delegation_ancestor_extinguished',
]);

function text(value){ return value == null ? null : String(value).trim() || null; }
function requiredText(value, code){ const v=text(value); if(!v) throw new Error(code); return v; }
function isoMs(value){ const n=Date.parse(String(value ?? '')); return Number.isFinite(n) ? n : null; }
function sameOrWildcard(parent, child){ return parent == null || parent === '*' || parent === child; }
function stableCanonical(v){ if(v==null||typeof v!=='object') return JSON.stringify(v); if(Array.isArray(v)) return `[${v.map(stableCanonical).join(',')}]`; return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stableCanonical(v[k])}`).join(',')}}`; }

export function normalizeAuthorityDelegation(input, binding={}){
  if(input == null) return null;
  if(typeof input !== 'object' || Array.isArray(input)) throw new Error('authority-delegation-invalid');
  rejectLegacyAuthorityBoundaryDeep(input, 'authority_delegation');
  const company_id=assertAuthorityCompanyId(input.company_id ?? binding.company_id);
  if(binding.company_id && company_id !== assertAuthorityCompanyId(binding.company_id)) throw new Error('authority-delegation-company-mismatch');
  const delegation_id=requiredText(input.delegation_id, 'authority-delegation-id-required');
  const parent_decision_id=requiredText(input.parent_decision_id, 'authority-delegation-parent-decision-id-required');
  const child_decision_id=requiredText(input.child_decision_id ?? binding.decision_id, 'authority-delegation-child-decision-id-required');
  if(parent_decision_id === child_decision_id) throw new Error('authority-delegation-self-reference');
  if(binding.decision_id && child_decision_id !== text(binding.decision_id)) throw new Error('authority-delegation-child-decision-mismatch');
  const delegated_at=requiredText(input.delegated_at, 'authority-delegation-delegated-at-required');
  if(isoMs(delegated_at) == null) throw new Error('authority-delegation-delegated-at-invalid');
  const expires_at=text(input.expires_at);
  if(expires_at && isoMs(expires_at) == null) throw new Error('authority-delegation-expires-at-invalid');
  if(expires_at && isoMs(expires_at) < isoMs(delegated_at)) throw new Error('authority-delegation-window-invalid');
  const depth=Number(input.depth ?? 1);
  if(!Number.isInteger(depth) || depth < 1 || depth > MAX_AUTHORITY_DELEGATION_DEPTH) throw new Error('authority-delegation-depth-invalid');
  const parent_status=String(input.parent_status ?? 'verified').trim();
  if(!['verified','suspended','revoked','expired'].includes(parent_status)) throw new Error('authority-delegation-parent-status-invalid');
  return Object.freeze({
    schema_version:'1.0', company_id, delegation_id, parent_decision_id, child_decision_id,
    parent_delegation_id:text(input.parent_delegation_id), depth,
    delegated_by:text(input.delegated_by), delegated_to:text(input.delegated_to), delegated_at, expires_at,
    capability:text(input.capability), workflow:text(input.workflow), context_ref:text(input.context_ref),
    parent_status,
    extinction_conditions:Object.freeze({
      expires_at,
      require_parent_active:input.require_parent_active !== false,
      company_id,
      capability:text(input.capability), workflow:text(input.workflow), context_ref:text(input.context_ref),
      max_depth:MAX_AUTHORITY_DELEGATION_DEPTH,
    }),
    identity_confers_authority:false,
    delegation_confers_authority:false,
  });
}

export function assertAuthorityDelegationContinuity(previousInput,nextInput,binding={}){
  const previous=normalizeAuthorityDelegation(previousInput,binding);
  const next=normalizeAuthorityDelegation(nextInput,{...binding,company_id:previous.company_id});
  if(next.company_id!==previous.company_id) throw new Error('authority-delegation-chain-company-mismatch');
  if(next.parent_decision_id!==previous.child_decision_id) throw new Error('authority-delegation-chain-parent-decision-mismatch');
  if(next.parent_delegation_id!==previous.delegation_id) throw new Error('authority-delegation-chain-parent-delegation-mismatch');
  if(next.depth!==previous.depth+1) throw new Error('authority-delegation-chain-depth-mismatch');
  if(previous.delegated_to&&next.delegated_by&&previous.delegated_to!==next.delegated_by) throw new Error('authority-delegation-chain-actor-mismatch');
  if(isoMs(next.delegated_at)<isoMs(previous.delegated_at)) throw new Error('authority-delegation-chain-time-rollback');
  if(previous.expires_at&&isoMs(next.delegated_at)>=isoMs(previous.expires_at)) throw new Error('authority-delegation-chain-parent-expired-before-child');
  if(previous.expires_at&&!next.expires_at) throw new Error('authority-delegation-chain-expiry-downgrade');
  if(previous.expires_at&&next.expires_at&&isoMs(next.expires_at)>isoMs(previous.expires_at)) throw new Error('authority-delegation-chain-expiry-extension');
  for(const field of ['capability','workflow','context_ref']){
    const parent=previous[field]; const child=next[field];
    if(parent&&parent!=='*'&&child!==parent) throw new Error(`authority-delegation-chain-scope-mismatch:${field}`);
  }
  return Object.freeze({previous,next,continuous:true,authority_effect:false});
}


export function assertAuthorityDelegationAncestry(chainInput,binding={}){
  if(!Array.isArray(chainInput)||chainInput.length===0) throw new Error('authority-delegation-chain-required');
  const chain=[];
  const delegationIds=new Set();
  const decisionIds=new Set();
  for(let i=0;i<chainInput.length;i++){
    const item=normalizeAuthorityDelegation(chainInput[i],binding);
    if(delegationIds.has(item.delegation_id)) throw new Error('authority-delegation-cycle:delegation-id');
    if(decisionIds.has(item.child_decision_id)) throw new Error('authority-delegation-cycle:decision-id');
    if(i===0 && item.parent_delegation_id) throw new Error('authority-delegation-root-parent-delegation-forbidden');
    if(i>0) assertAuthorityDelegationContinuity(chain[i-1],item,{...binding,company_id:item.company_id});
    delegationIds.add(item.delegation_id);
    decisionIds.add(item.parent_decision_id);
    decisionIds.add(item.child_decision_id);
    chain.push(item);
  }
  return Object.freeze({chain:Object.freeze(chain),continuous:true,cycle_free:true,authority_effect:false});
}


export function buildAuthorityDelegationHistorySeal(history,binding={}){
  if(!Array.isArray(history)) throw new Error('authority-delegation-history-required');
  const normalized=history.length?assertAuthorityDelegationAncestry(history,binding).chain:[];
  return buildAuthorityHistoryIntegritySeal('authority-delegation',normalized);
}

export function assertAuthorityDelegationPersistenceContinuity(previousHistory,nextHistory,binding={},expectedPreviousSeal=null){
  if(!Array.isArray(previousHistory)||!Array.isArray(nextHistory)) throw new Error('authority-delegation-persistence-history-required');
  if(expectedPreviousSeal!=null&&String(expectedPreviousSeal)!==buildAuthorityDelegationHistorySeal(previousHistory,binding)) throw new Error('authority-delegation-history-seal-mismatch');
  if(nextHistory.length<previousHistory.length) throw new Error('authority-delegation-history-truncation-forbidden');
  const previous=previousHistory.length?assertAuthorityDelegationAncestry(previousHistory,binding).chain:[];
  const next=nextHistory.length?assertAuthorityDelegationAncestry(nextHistory,binding).chain:[];
  for(let i=0;i<previous.length;i++){
    if(stableCanonical(previous[i])!==stableCanonical(next[i])) throw new Error('authority-delegation-history-prefix-equivocation');
  }
  return true;
}




function normalizedDecisionStatuses(statuses,history){
  if(statuses==null) return null;
  if(!(statuses instanceof Map)&&typeof statuses!=='object') throw new Error('authority-delegation-decision-statuses-invalid');
  const relevant=new Set();
  for(const item of history??[]){
    const normalized=normalizeAuthorityDelegation(item);
    relevant.add(normalized.parent_decision_id);
    relevant.add(normalized.child_decision_id);
  }
  const allowed=new Set(['verified','suspended','revoked','expired']);
  const out={};
  for(const id of [...relevant].sort()){
    const raw=statuses instanceof Map?statuses.get(id):statuses[id];
    if(raw==null) continue;
    const status=text(raw);
    if(!allowed.has(status)) throw new Error(`authority-delegation-decision-status-invalid:${id}`);
    out[id]=status;
  }
  return out;
}

export function assertAuthorityDelegationDecisionStatusContinuity(previousStatuses,nextStatuses,history){
  if(!Array.isArray(history)) throw new Error('authority-delegation-history-required');
  const previous=normalizedDecisionStatuses(previousStatuses,history)??{};
  const next=normalizedDecisionStatuses(nextStatuses,history)??{};
  const terminal=new Set(['revoked','expired']);
  for(const [id,previousStatus] of Object.entries(previous)){
    const nextStatus=next[id];
    if(!nextStatus) throw new Error(`authority-delegation-decision-status-missing:${id}`);
    if(terminal.has(previousStatus)&&!terminal.has(nextStatus)) throw new Error(`authority-delegation-decision-status-revival:${id}`);
    if(previousStatus==='revoked'&&nextStatus==='expired') continue;
    if(previousStatus==='expired'&&nextStatus==='revoked') continue;
  }
  return true;
}

export function buildAuthorityDelegationHistorySnapshotSeal(history,binding={},previousSnapshotSeal='root',decisionStatuses=null){
  if(!Array.isArray(history)) throw new Error('authority-delegation-history-required');
  const normalized=history.length?assertAuthorityDelegationAncestry(history,binding).chain:[];
  const statuses=normalizedDecisionStatuses(decisionStatuses,history);
  const payload=statuses==null?normalized:[{history:normalized,decision_statuses:statuses}];
  return buildAuthorityHistorySnapshotSeal('authority-delegation',payload,previousSnapshotSeal);
}

export function assertAuthorityDelegationHistorySnapshotChain(snapshots,binding={}){
  if(!Array.isArray(snapshots)||snapshots.length===0) throw new Error('authority-delegation-snapshot-chain-required');
  let previousSeal='root';
  let previousHistory=[];
  let previousDecisionStatuses=null;
  const seen=new Set();
  for(const snapshot of snapshots){
    if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)) throw new Error('authority-delegation-snapshot-required');
    const history=snapshot.history;
    const decisionStatuses=snapshot.decision_statuses??null;
    if(!Array.isArray(history)) throw new Error('authority-delegation-history-required');
    const parent=String(snapshot.previous_snapshot_seal??'root').trim()||'root';
    if(parent!==previousSeal) throw new Error('authority-delegation-snapshot-parent-mismatch');
    const expected=buildAuthorityDelegationHistorySnapshotSeal(history,binding,parent,decisionStatuses);
    const seal=String(snapshot.snapshot_seal??'').trim();
    if(seal!==expected) throw new Error('authority-delegation-snapshot-seal-mismatch');
    if(seen.has(seal)) throw new Error('authority-delegation-snapshot-seal-reuse');
    if(previousSeal!=='root'){
      assertAuthorityDelegationPersistenceContinuity(previousHistory,history,binding,buildAuthorityDelegationHistorySeal(previousHistory,binding));
      if(previousDecisionStatuses!=null||decisionStatuses!=null) assertAuthorityDelegationDecisionStatusContinuity(previousDecisionStatuses??{},decisionStatuses??{},history);
    } else if(history.length) assertAuthorityDelegationAncestry(history,binding);
    seen.add(seal);
    previousSeal=seal;
    previousHistory=history;
    previousDecisionStatuses=decisionStatuses;
  }
  return true;
}
export function evaluateDelegationChainExtinction(chainInput,binding={},now=new Date().toISOString()){
  const ancestry=assertAuthorityDelegationAncestry(chainInput,binding);
  const reason_codes=[];
  let ancestorExtinguished=false;
  const evaluated=ancestry.chain.map((delegation,index)=>{
    const result=evaluateDelegationExtinction(delegation,binding,now);
    const reasons=[...result.reason_codes];
    if(ancestorExtinguished) reasons.push('delegation_ancestor_extinguished');
    if(reasons.length) ancestorExtinguished=true;
    reason_codes.push(...reasons);
    return Object.freeze({index,delegation:result.delegation,active:reasons.length===0,extinguished:reasons.length>0,reason_codes:Object.freeze([...new Set(reasons)])});
  });
  return Object.freeze({
    active:reason_codes.length===0,
    extinguished:reason_codes.length>0,
    reason_codes:Object.freeze([...new Set(reason_codes)]),
    chain:Object.freeze(evaluated),
    authority_effect:false,
  });
}

export function evaluateDelegationExtinction(delegation, binding={}, now=new Date().toISOString()){
  if(delegation == null) return Object.freeze({active:true, extinguished:false, reason_codes:Object.freeze([]), delegation:null});
  const normalized=normalizeAuthorityDelegation(delegation,binding);
  const nowMs=isoMs(now);
  if(nowMs == null) throw new Error('authority-delegation-now-invalid');
  const reasons=[];
  if(normalized.expires_at && isoMs(normalized.expires_at) <= nowMs) reasons.push('delegation_expired');
  const statuses=binding?.decision_statuses;
  const observedParentStatus=statuses instanceof Map
    ? statuses.get(normalized.parent_decision_id)
    : (statuses&&typeof statuses==='object'?statuses[normalized.parent_decision_id]:null);
  const observedChildStatus=statuses instanceof Map
    ? statuses.get(normalized.child_decision_id)
    : (statuses&&typeof statuses==='object'?statuses[normalized.child_decision_id]:null);
  const effectiveParentStatus=text(observedParentStatus)??normalized.parent_status;
  const effectiveChildStatus=text(observedChildStatus);
  if(normalized.extinction_conditions.require_parent_active && effectiveParentStatus !== 'verified') reasons.push('delegation_parent_inactive');
  if(effectiveChildStatus && effectiveChildStatus !== 'verified') reasons.push('delegation_child_inactive');
  if(binding.company_id && normalized.company_id !== text(binding.company_id)) reasons.push('delegation_company_mismatch');
  if(binding.capability && !sameOrWildcard(normalized.capability, text(binding.capability))) reasons.push('delegation_capability_mismatch');
  if(binding.workflow && !sameOrWildcard(normalized.workflow, text(binding.workflow))) reasons.push('delegation_workflow_mismatch');
  if(binding.context_ref && !sameOrWildcard(normalized.context_ref, text(binding.context_ref))) reasons.push('delegation_context_mismatch');
  if(normalized.depth > MAX_AUTHORITY_DELEGATION_DEPTH) reasons.push('delegation_depth_exceeded');
  return Object.freeze({
    active:reasons.length === 0,
    extinguished:reasons.length > 0,
    reason_codes:Object.freeze(reasons),
    observed_parent_status:effectiveParentStatus,
    observed_child_status:effectiveChildStatus,
    delegation:normalized,
  });
}
