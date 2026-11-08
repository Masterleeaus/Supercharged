import crypto from 'node:crypto';

export const ACCEPTED_EVIDENCE_SCHEMA = 'titan.business.accepted-evidence/v1';
export const BUSINESS_REALITY_PROJECTION_SCHEMA = 'titan.business-reality.job/v1';

/**
 * Canonical factual evidence sink for consequential execution.
 *
 * The ExecutionGateway remains the owner of authority, provider execution and
 * independent verification. This ledger owns only accepted factual history
 * and deterministic read projection from that history.
 */
export class AcceptedEvidenceLedger {
  constructor({ now = () => new Date().toISOString() } = {}) {
    this.now = now;
    this.events = [];
    this.ids = new Set();
  }

  append(input) {
    const event = normalizeEvidence(input, this.events.length + 1, this.now());
    if (this.ids.has(event.evidence_id)) {
      throw new Error(`duplicate-evidence-id:${event.evidence_id}`);
    }
    if (event.supersedes_evidence_id) {
      const previous = this.events.find((candidate) => candidate.evidence_id === event.supersedes_evidence_id);
      if (!previous) throw new Error(`superseded-evidence-not-found:${event.supersedes_evidence_id}`);
      if (previous.company_id !== event.company_id || previous.work_id !== event.work_id) {
        throw new Error('superseded-evidence-scope-mismatch');
      }
    }
    this.ids.add(event.evidence_id);
    this.events.push(deepFreeze(event));
    return clone(event);
  }

  list(company_id) {
    if (!company_id) throw new Error('company-id-required');
    return this.events
      .filter((event) => event.company_id === company_id)
      .map(clone);
  }

  projectJob(company_id, job_id) {
    if (!company_id) throw new Error('company-id-required');
    if (!job_id) throw new Error('job-id-required');
    return rebuildJobProjection(this.events, { company_id, job_id });
  }
}

export function rebuildJobProjection(events, { company_id, job_id }) {
  const scoped = events
    .filter((event) => event.company_id === company_id && event.work_id === job_id)
    .slice()
    .sort((a, b) => a.sequence - b.sequence);
  const superseded = new Set(scoped.map((event) => event.supersedes_evidence_id).filter(Boolean));
  const active = scoped.filter((event) => !superseded.has(event.evidence_id));
  const terminal = active.filter((event) => event.final_outcome === 'verified' && event.verification?.verified === true).at(-1);
  const evidence_ids = terminal ? active.map((event) => event.evidence_id) : [];
  const state = terminal ? clone(terminal.observed_result ?? null) : null;
  const projection = {
    schema: BUSINESS_REALITY_PROJECTION_SCHEMA,
    company_id,
    job_id,
    status: terminal ? 'VERIFIED' : 'UNKNOWN',
    state,
    projection_version: 'job-completion/v1',
    provenance: {
      source_of_truth: 'accepted-evidence',
      evidence_ids,
      terminal_evidence_id: terminal?.evidence_id ?? null,
      reconstructed_at: terminal?.recorded_at ?? null,
    },
  };
  return {
    ...projection,
    projection_revision: hash(canonicalJson(projection)),
  };
}

function normalizeEvidence(input, sequence, recorded_at) {
  if (!input || typeof input !== 'object') throw new Error('evidence-object-required');
  for (const field of ['evidence_id', 'company_id']) {
    if (!input[field]) throw new Error(`evidence-${field}-required`);
  }
  if (input.kind === 'simulated' || input.factual === false) {
    throw new Error('simulated-evidence-cannot-enter-factual-ledger');
  }
  if (input.final_outcome === 'verified' && (input.state !== 'VERIFIED' || input.verification?.verified !== true)) {
    throw new Error('verified-evidence-requires-independent-verification');
  }
  return {
    schema: ACCEPTED_EVIDENCE_SCHEMA,
    sequence,
    evidence_id: String(input.evidence_id),
    company_id: String(input.company_id),
    execution_id: input.execution_id ?? null,
    decision_id: input.decision_id ?? null,
    work_id: input.work_id ?? null,
    run_id: input.run_id ?? null,
    agent_id: input.agent_id ?? null,
    capability: input.capability ?? null,
    provider: input.provider ?? null,
    execution_class: input.execution_class ?? null,
    state: input.state ?? null,
    final_outcome: input.final_outcome ?? null,
    request_summary: clone(input.request_summary ?? null),
    external_ref: input.external_ref ?? null,
    observed_result: clone(input.observed_result ?? null),
    verification: clone(input.verification ?? null),
    failure: clone(input.failure ?? null),
    supersedes_evidence_id: input.supersedes_evidence_id ?? null,
    factual: true,
    recorded_at,
  };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

