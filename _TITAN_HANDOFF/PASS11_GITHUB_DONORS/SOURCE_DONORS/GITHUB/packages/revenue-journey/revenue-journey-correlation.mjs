import crypto from 'node:crypto';

export const REVENUE_JOURNEY_CORRELATION_SCHEMA = 'titan.zero.revenue-journey.correlation.v1';
export const REVENUE_JOURNEY_STAGES = Object.freeze([
  'lead','opportunity','quote','booking','job','invoice','payment','repeat','referral'
]);
const LEGACY_COMPANY_KEYS = Object.freeze(['tenant_id','tenantId','tenant_company_id','business_id','account_id']);
const ENTITY_FIELDS = Object.freeze({
  lead: 'lead_id',
  opportunity: 'opportunity_id',
  quote: 'quote_id',
  booking: 'booking_id',
  job: 'job_id',
  invoice: 'invoice_id',
  payment: 'payment_id',
  repeat: 'repeat_id',
  referral: 'referral_id'
});

const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

function assertCompany(input = {}) {
  for (const key of LEGACY_COMPANY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] != null) {
      throw new TypeError(`revenue-journey-legacy-company-boundary-forbidden:${key}`);
    }
  }
  const companyId = clean(input.company_id);
  if (!companyId) throw new TypeError('revenue-journey-company-id-required');
  return companyId;
}

function deterministicJourneyId(companyId, anchor) {
  const digest = crypto.createHash('sha256').update(`${companyId}\n${anchor}`).digest('hex').slice(0, 24);
  return `revj:${companyId}:${digest}`;
}

function collectEntities(input = {}, companyId) {
  const source = input.entities && typeof input.entities === 'object' ? input.entities : input;
  const entities = {};
  for (const [stage, field] of Object.entries(ENTITY_FIELDS)) {
    const value = clean(source[field]);
    if (value) entities[field] = value;
    const stageCompany = clean(source[`${stage}_company_id`]);
    if (stageCompany && stageCompany !== companyId) {
      throw new TypeError(`revenue-journey-cross-company-entity:${stage}`);
    }
  }
  return entities;
}

function resolveJourneyId(input, companyId, entities) {
  const explicit = clean(input.revenue_journey_id);
  if (explicit) return { id: explicit, source: 'explicit_revenue_journey_id' };

  const compatibilityJourney = clean(input.journey_id);
  if (compatibilityJourney) {
    if (input.journey_id_semantics !== 'revenue_lifecycle_compatible') {
      throw new TypeError('revenue-journey-generic-journey-id-requires-explicit-compatibility');
    }
    return {
      id: deterministicJourneyId(companyId, `compat:${compatibilityJourney}`),
      source: 'compatible_generic_journey_id'
    };
  }

  const correlationId = clean(input.correlation_id);
  if (correlationId) {
    return { id: deterministicJourneyId(companyId, `corr:${correlationId}`), source: 'correlation_id' };
  }

  const anchorField = Object.values(ENTITY_FIELDS).find((field) => entities[field]);
  if (!anchorField) throw new TypeError('revenue-journey-correlation-anchor-required');
  return {
    id: deterministicJourneyId(companyId, `${anchorField}:${entities[anchorField]}`),
    source: anchorField
  };
}

export function buildRevenueJourneyCorrelation(input = {}) {
  const companyId = assertCompany(input);
  const entities = collectEntities(input, companyId);
  const { id, source } = resolveJourneyId(input, companyId, entities);
  const correlationId = clean(input.correlation_id);
  const provenance = input.provenance && typeof input.provenance === 'object' ? input.provenance : {};
  const producer = clean(provenance.producer);
  if (!producer) throw new TypeError('revenue-journey-provenance-producer-required');

  return Object.freeze({
    schema: REVENUE_JOURNEY_CORRELATION_SCHEMA,
    company_id: companyId,
    revenue_journey_id: id,
    revenue_journey_id_source: source,
    correlation_id: correlationId,
    entities: Object.freeze({ ...entities }),
    provenance: Object.freeze({
      producer,
      source_event_id: clean(provenance.source_event_id),
      observed_at: clean(provenance.observed_at)
    }),
    governance: Object.freeze({
      company_boundary: 'company_id',
      owns_domain_truth: false,
      identity_is_authority: false,
      authority_granted: false,
      execution_permitted: false,
      may_create_entities: false,
      may_mutate_entities: false,
      generic_journey_id_is_not_implicitly_revenue_journey_id: true
    })
  });
}

export function bindRevenueJourneyEntity(correlation, input = {}) {
  if (!correlation || correlation.schema !== REVENUE_JOURNEY_CORRELATION_SCHEMA) {
    throw new TypeError('revenue-journey-valid-correlation-required');
  }
  const companyId = assertCompany(input);
  if (companyId !== correlation.company_id) throw new TypeError('revenue-journey-cross-company-bind');
  const stage = clean(input.stage);
  if (!REVENUE_JOURNEY_STAGES.includes(stage)) throw new TypeError(`revenue-journey-stage-invalid:${stage}`);
  const field = ENTITY_FIELDS[stage];
  const entityId = clean(input.entity_id ?? input[field]);
  if (!entityId) throw new TypeError(`revenue-journey-${field}-required`);
  const existing = correlation.entities?.[field];
  if (existing && existing !== entityId) throw new TypeError(`revenue-journey-${field}-conflict`);

  const next = buildRevenueJourneyCorrelation({
    company_id: companyId,
    revenue_journey_id: correlation.revenue_journey_id,
    correlation_id: clean(input.correlation_id) ?? correlation.correlation_id,
    entities: { ...correlation.entities, [field]: entityId },
    provenance: {
      producer: clean(input.provenance?.producer) ?? correlation.provenance?.producer,
      source_event_id: clean(input.provenance?.source_event_id),
      observed_at: clean(input.provenance?.observed_at)
    }
  });
  return next;
}

export function assertRevenueJourneyContinuity(correlations = []) {
  if (!Array.isArray(correlations) || correlations.length === 0) {
    throw new TypeError('revenue-journey-correlations-required');
  }
  const first = correlations[0];
  if (!first || first.schema !== REVENUE_JOURNEY_CORRELATION_SCHEMA) {
    throw new TypeError('revenue-journey-valid-correlation-required');
  }
  for (const item of correlations) {
    if (!item || item.schema !== REVENUE_JOURNEY_CORRELATION_SCHEMA) return false;
    if (item.company_id !== first.company_id) return false;
    if (item.revenue_journey_id !== first.revenue_journey_id) return false;
  }
  return true;
}
