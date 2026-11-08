const STATES = Object.freeze(['DISCOVERED','DESIGNED','INSTALLED','SHADOW','PROVEN','ACCEPTED','LIVE','ROLLED_BACK']);
const TERMINAL = new Set(['LIVE','ROLLED_BACK']);
const text = (value, code) => { const v = String(value ?? '').trim(); if (!v) throw new Error(code); return v; };
const arr = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(arr(values).map(v => text(v, 'commissioning-reference-required')))];
const company = value => text(value, 'commissioning-company-id-required');
const clone = value => value == null ? value : (globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

function rejectLegacy(value, path = 'commissioning') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach((item, index) => rejectLegacy(item, `${path}[${index}]`));
  for (const [key, nested] of Object.entries(value)) {
    if (['tenant_id','tenant_company_id','tenant_company','tenant','tenantCompanyId'].includes(key)) throw new Error(`legacy-company-boundary:${path}.${key}`);
    rejectLegacy(nested, `${path}.${key}`);
  }
}

function assertCompany(expected, value, code = 'commissioning-company-mismatch') {
  if (company(expected) !== company(value)) throw new Error(code);
}

function normalizeRefs(value, field) {
  const refs = unique(value);
  if (!refs.length) throw new Error(`${field}-required`);
  return Object.freeze(refs.sort());
}

export function createBusinessCommissioningLifecycle(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('commissioning-input-required');
  rejectLegacy(input);
  const company_id = company(input.company_id);
  const mission_id = text(input.mission_id, 'commissioning-mission-id-required');
  const discovery_ref = text(input.discovery_ref, 'commissioning-discovery-ref-required');
  const installation_plan_ref = text(input.installation_plan_ref, 'commissioning-installation-plan-ref-required');
  const outcome_criteria_refs = normalizeRefs(input.outcome_criteria_refs, 'commissioning-outcome-criteria');
  return Object.freeze({
    schema: 'titan.workforce.business-commissioning-lifecycle/v1', lifecycle_id: text(input.lifecycle_id ?? `commissioning:${company_id}:${mission_id}`, 'commissioning-lifecycle-id-required'),
    company_id, mission_id, discovery_ref, installation_plan_ref, outcome_criteria_refs,
    state: 'DISCOVERED', revision: 0, history: Object.freeze([]), rollback: null,
    automatic_go_live: false, automatic_authority_change: false, authority_granted: false, execution_permitted: false, authority_effect: false,
  });
}

function gateFor(state, input) {
  const evidence_refs = normalizeRefs(input.evidence_refs, `commissioning-${state.toLowerCase()}-evidence`);
  const receipt_refs = unique(input.receipt_refs);
  const authority_review_ref = input.authority_review_ref ? text(input.authority_review_ref, 'commissioning-authority-review-ref-invalid') : null;
  const acceptance_ref = input.acceptance_ref ? text(input.acceptance_ref, 'commissioning-acceptance-ref-invalid') : null;
  if (state === 'PROVEN' && !receipt_refs.length) throw new Error('commissioning-prove-receipt-required');
  if (state === 'ACCEPTED' && !acceptance_ref) throw new Error('commissioning-client-acceptance-required');
  if (state === 'LIVE' && !authority_review_ref) throw new Error('commissioning-live-authority-review-required');
  return Object.freeze({ evidence_refs, receipt_refs: Object.freeze(receipt_refs.sort()), authority_review_ref, acceptance_ref });
}

export function advanceBusinessCommissioningLifecycle(current, input = {}) {
  if (!current || current.schema !== 'titan.workforce.business-commissioning-lifecycle/v1') throw new Error('commissioning-lifecycle-required');
  rejectLegacy(input); assertCompany(current.company_id, input.company_id ?? current.company_id);
  const next = text(input.state, 'commissioning-next-state-required');
  if (!STATES.includes(next)) throw new Error('commissioning-state-invalid');
  if (TERMINAL.has(current.state)) throw new Error('commissioning-lifecycle-terminal');
  const expectedIndex = STATES.indexOf(current.state) + 1;
  if (STATES.indexOf(next) !== expectedIndex && next !== 'ROLLED_BACK') throw new Error('commissioning-state-transition-invalid');
  if (next === 'ROLLED_BACK') {
    const rollback_ref = text(input.rollback_ref, 'commissioning-rollback-ref-required');
    const evidence = gateFor('ROLLED_BACK', { evidence_refs: input.evidence_refs, receipt_refs: input.receipt_refs });
    return Object.freeze({ ...current, state: next, revision: current.revision + 1, rollback: Object.freeze({ rollback_ref, evidence_refs: evidence.evidence_refs }), history: Object.freeze([...current.history, Object.freeze({ from:current.state, to:next, revision:current.revision + 1, rollback_ref })]) });
  }
  const gate = gateFor(next, input);
  const event = Object.freeze({ from: current.state, to: next, revision: current.revision + 1, evidence_refs: gate.evidence_refs, receipt_refs: gate.receipt_refs, authority_review_ref: gate.authority_review_ref, acceptance_ref: gate.acceptance_ref });
  return Object.freeze({ ...current, state:next, revision:current.revision + 1, history:Object.freeze([...current.history, event]) });
}

export function recordVerifiedCommissioningOutcome(current, input = {}) {
  if (!current || current.schema !== 'titan.workforce.business-commissioning-lifecycle/v1') throw new Error('commissioning-lifecycle-required');
  assertCompany(current.company_id, input.company_id ?? current.company_id);
  if (current.state !== 'LIVE') throw new Error('commissioning-live-state-required');
  const outcome_id = text(input.outcome_id, 'commissioning-outcome-id-required');
  const evidence_refs = normalizeRefs(input.evidence_refs, 'commissioning-outcome-evidence');
  const existing = arr(current.verified_outcomes);
  if (existing.some(item => item.outcome_id === outcome_id)) return current;
  const outcome = Object.freeze({ schema:'titan.workforce.verified-commissioning-outcome/v1', company_id:current.company_id, outcome_id, evidence_refs, receipt_refs:Object.freeze(unique(input.receipt_refs).sort()), verified_at:text(input.verified_at ?? new Date().toISOString(), 'commissioning-outcome-verified-at-invalid'), authority_effect:false, grants_authority:false });
  return Object.freeze({ ...current, verified_outcomes:Object.freeze([...existing, outcome]) });
}

export function summarizeBusinessCommissioningLifecycle(lifecycle = {}) {
  return Object.freeze({ lifecycle_id:lifecycle.lifecycle_id, company_id:lifecycle.company_id, state:lifecycle.state, revision:Number(lifecycle.revision || 0), transitions:arr(lifecycle.history).length, verified_outcomes:arr(lifecycle.verified_outcomes).length, automatic_go_live:false, authority_granted:false, execution_permitted:false });
}

