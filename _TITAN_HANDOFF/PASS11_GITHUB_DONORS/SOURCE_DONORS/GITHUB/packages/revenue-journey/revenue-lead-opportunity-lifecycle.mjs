import crypto from 'node:crypto';
import { buildRevenueJourneyCorrelation, bindRevenueJourneyEntity, REVENUE_JOURNEY_CORRELATION_SCHEMA } from './revenue-journey-correlation.mjs';

export const REVENUE_LEAD_OPPORTUNITY_LIFECYCLE_SCHEMA = 'titan.zero.revenue-journey.lead-opportunity-lifecycle.v1';
export const LEAD_STATES = Object.freeze(['captured','qualifying','qualified','nurture','disqualified','handoff_ready','converted','escalated']);
export const OPPORTUNITY_STATES = Object.freeze(['none','proposed','open','qualified','quote_ready','won','lost','cancelled']);
const LEGACY_COMPANY_KEYS = Object.freeze(['tenant_id','tenantId','tenant_company_id','business_id','account_id']);
const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const uniq = (values) => Object.freeze([...new Set(values.filter(Boolean))]);

const LEAD_TRANSITIONS = Object.freeze({
  captured: ['qualifying','nurture','disqualified','escalated'],
  qualifying: ['qualified','nurture','disqualified','escalated'],
  qualified: ['handoff_ready','nurture','disqualified','escalated'],
  handoff_ready: ['converted','nurture','escalated'],
  nurture: ['qualifying','qualified','disqualified','escalated'],
  escalated: ['qualifying','qualified','nurture','disqualified'],
  disqualified: [],
  converted: []
});
const OPPORTUNITY_TRANSITIONS = Object.freeze({
  none: ['proposed'],
  proposed: ['open','cancelled'],
  open: ['qualified','lost','cancelled'],
  qualified: ['quote_ready','lost','cancelled'],
  quote_ready: ['won','lost','cancelled'],
  won: [], lost: [], cancelled: []
});

function rejectLegacyBoundary(input={}) {
  for (const key of LEGACY_COMPANY_KEYS) if (Object.prototype.hasOwnProperty.call(input,key) && input[key] != null) {
    throw new TypeError(`revenue-lifecycle-legacy-company-boundary-forbidden:${key}`);
  }
}
function assertCompany(input={}) {
  rejectLegacyBoundary(input);
  const companyId=clean(input.company_id);
  if (!companyId) throw new TypeError('revenue-lifecycle-company-id-required');
  return companyId;
}
function stableId(parts) { return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0,32); }
function assertTransition(kind, from, to) {
  const map = kind === 'lead' ? LEAD_TRANSITIONS : OPPORTUNITY_TRANSITIONS;
  if (!(from in map)) throw new TypeError(`revenue-lifecycle-${kind}-from-state-invalid:${from}`);
  if (!(to in map)) throw new TypeError(`revenue-lifecycle-${kind}-to-state-invalid:${to}`);
  if (from === to) return 'idempotent_replay';
  if (!map[from].includes(to)) throw new TypeError(`revenue-lifecycle-${kind}-transition-invalid:${from}->${to}`);
  return 'transition_proposed';
}
function normalizeCorrelation(input, companyId) {
  const provided=input.correlation;
  if (provided) {
    if (provided.schema !== REVENUE_JOURNEY_CORRELATION_SCHEMA) throw new TypeError('revenue-lifecycle-valid-correlation-required');
    if (provided.company_id !== companyId) throw new TypeError('revenue-lifecycle-cross-company-correlation');
    return provided;
  }
  return buildRevenueJourneyCorrelation({
    company_id: companyId,
    revenue_journey_id: clean(input.revenue_journey_id),
    correlation_id: clean(input.correlation_id),
    entities: { lead_id: clean(input.lead_id), opportunity_id: clean(input.opportunity_id) },
    provenance: { producer: clean(input.provenance?.producer), source_event_id: clean(input.provenance?.source_event_id), observed_at: clean(input.provenance?.observed_at) }
  });
}

export function buildLeadOpportunityLifecycleTransition(input={}) {
  const companyId=assertCompany(input);
  rejectLegacyBoundary(input.provenance ?? {});
  const kind=clean(input.kind);
  if (!['lead','opportunity'].includes(kind)) throw new TypeError('revenue-lifecycle-kind-invalid');
  const fromState=clean(input.from_state);
  const toState=clean(input.to_state);
  if (!fromState || !toState) throw new TypeError('revenue-lifecycle-from-and-to-required');
  const disposition=assertTransition(kind,fromState,toState);
  const producer=clean(input.provenance?.producer);
  const sourceEventId=clean(input.provenance?.source_event_id);
  const observedAt=clean(input.provenance?.observed_at);
  if (!producer || !sourceEventId || !observedAt) throw new TypeError('revenue-lifecycle-provenance-required');
  const entityId=clean(kind==='lead' ? input.lead_id : input.opportunity_id);
  if (!entityId) throw new TypeError(`revenue-lifecycle-${kind}-id-required`);

  let correlation=normalizeCorrelation(input,companyId);
  const expectedExisting=kind==='lead' ? correlation.entities?.lead_id : correlation.entities?.opportunity_id;
  if (expectedExisting && expectedExisting !== entityId) throw new TypeError(`revenue-lifecycle-${kind}-id-conflict`);
  if (!expectedExisting) correlation=bindRevenueJourneyEntity(correlation,{company_id:companyId,stage:kind,entity_id:entityId,provenance:{producer,source_event_id:sourceEventId,observed_at:observedAt}});

  const evidenceRefs=uniq((input.evidence_refs ?? []).map(clean));
  if (!evidenceRefs.length) throw new TypeError('revenue-lifecycle-evidence-required');
  const eventKey=`revlt:${stableId([companyId, correlation.revenue_journey_id, kind, entityId, fromState, toState, sourceEventId])}`;
  const opportunityBinding = clean(input.opportunity_id);
  const leadBinding = clean(input.lead_id);

  return Object.freeze({
    schema: REVENUE_LEAD_OPPORTUNITY_LIFECYCLE_SCHEMA,
    company_id: companyId,
    revenue_journey_id: correlation.revenue_journey_id,
    lifecycle_event_id: eventKey,
    idempotency_key: eventKey,
    kind,
    entity_ref: Object.freeze({ lead_id: leadBinding, opportunity_id: opportunityBinding }),
    transition: Object.freeze({ from_state: fromState, to_state: toState, disposition }),
    correlation,
    provenance: Object.freeze({ producer, source_event_id: sourceEventId, observed_at: observedAt, evidence_refs: evidenceRefs }),
    sales_semantics: Object.freeze({
      sales_owns_entity_truth: true,
      sales_qualification_states_reused: kind==='lead',
      persistence_request_only: true,
      mutation_performed: false,
      opportunity_creation_performed: false,
      lead_mutation_performed: false
    }),
    governance: Object.freeze({
      company_boundary: 'company_id',
      identity_is_authority: false,
      authority_granted: false,
      execution_permitted: false,
      owns_domain_truth: false,
      may_create_entities: false,
      may_mutate_entities: false,
      replay_safe: true
    })
  });
}

export function assertLifecycleEventReplay(existing, candidate) {
  if (!existing || !candidate) throw new TypeError('revenue-lifecycle-events-required');
  if (existing.company_id !== candidate.company_id) return false;
  if (existing.revenue_journey_id !== candidate.revenue_journey_id) return false;
  if (existing.idempotency_key !== candidate.idempotency_key) return false;
  return JSON.stringify(existing.transition) === JSON.stringify(candidate.transition) &&
    existing.provenance?.source_event_id === candidate.provenance?.source_event_id;
}
