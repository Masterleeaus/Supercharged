import { assertAuthorityCompanyId, rejectLegacyAuthorityBoundaryDeep } from './company-boundary.mjs';
import { normalizeAuthorityDelegation, assertAuthorityDelegationContinuity } from './delegation.mjs';

export const INVOCATION_ENVELOPE_SCHEMA = 'titan.agent.invocation/v1';
export const CONTEXT_OWNER_SCHEMA = 'titan.agent.context-owner/v1';
export const HANDOFF_RECEIPT_SCHEMA = 'titan.agent.handoff-receipt/v1';
const text = (value, code) => { const v = String(value ?? '').trim(); if (!v) throw new Error(code); return v; };
const optional = value => value == null || String(value).trim() === '' ? null : String(value).trim();
const iso = (value, code) => { const v = text(value, code); if (!Number.isFinite(Date.parse(v))) throw new Error(code); return v; };
const unique = values => [...new Set((values ?? []).map(value => text(value, 'invocation-list-entry-required')))];
const ceiling = value => { if (!Array.isArray(value)) throw new Error('authority-ceiling-required'); return Object.freeze(unique(value).sort()); };
const assertCompany = (a, b, code) => { if (assertAuthorityCompanyId(a) !== assertAuthorityCompanyId(b)) throw new Error(code); };

export function createInvocationEnvelope(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invocation-envelope-input-required');
  rejectLegacyAuthorityBoundaryDeep(input, 'invocation_envelope');
  const company_id = assertAuthorityCompanyId(input.company_id);
  const invocation_id = text(input.invocation_id, 'invocation-id-required');
  const actor_id = text(input.actor_id, 'invocation-actor-required');
  const context_ref = text(input.context_ref, 'invocation-context-ref-required');
  const correlation_id = text(input.correlation_id, 'invocation-correlation-required');
  const parent_invocation_id = optional(input.parent_invocation_id);
  if (parent_invocation_id === invocation_id) throw new Error('invocation-self-parent');
  return Object.freeze({
    schema: INVOCATION_ENVELOPE_SCHEMA, company_id, invocation_id, actor_id,
    correlation_id, causation_id: optional(input.causation_id), parent_invocation_id,
    context_ref, context_revision: text(input.context_revision, 'invocation-context-revision-required'),
    authority_ceiling: ceiling(input.authority_ceiling),
    issued_at: iso(input.issued_at ?? new Date().toISOString(), 'invocation-issued-at-invalid'),
    authority_effect: false,
  });
}

export function createContextOwnerRecord(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('context-owner-input-required');
  rejectLegacyAuthorityBoundaryDeep(input, 'context_owner');
  return Object.freeze({
    schema: CONTEXT_OWNER_SCHEMA,
    company_id: assertAuthorityCompanyId(input.company_id),
    context_ref: text(input.context_ref, 'context-ref-required'),
    revision: text(input.revision, 'context-revision-required'),
    source_actor: text(input.source_actor, 'context-source-actor-required'),
    provenance_ref: text(input.provenance_ref, 'context-provenance-required'),
    observed_at: iso(input.observed_at ?? new Date().toISOString(), 'context-observed-at-invalid'),
    retained_until: iso(input.retained_until, 'context-retention-invalid'),
    revoked: input.revoked === true, authority_effect: false, projection_only: true,
    canonical_records_remain_source_of_truth: true,
  });
}

export class DurableAgentContextOwner {
  #records = new Map(); #history = [];
  put(input) {
    const record = createContextOwnerRecord(input); const key = `${record.company_id}:${record.context_ref}`;
    const previous = this.#records.get(key);
    if (previous && String(previous.revision) === String(record.revision)) {
      if (JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('context-revision-equivocation');
      return previous;
    }
    this.#records.set(key, record);
    this.#history.push(Object.freeze({ event:'stored', company_id:record.company_id, context_ref:record.context_ref, revision:record.revision, at:record.observed_at }));
    return record;
  }
  revoke(company_id, context_ref, at = new Date().toISOString()) {
    const company = assertAuthorityCompanyId(company_id); const ref = text(context_ref, 'context-ref-required');
    const current = this.#records.get(`${company}:${ref}`); if (!current) throw new Error('context-not-found');
    const revoked = Object.freeze({ ...current, revoked:true, revoked_at:iso(at, 'context-revoked-at-invalid') });
    this.#records.set(`${company}:${ref}`, revoked); this.#history.push(Object.freeze({ event:'revoked', company_id:company, context_ref:ref, revision:current.revision, at:revoked.revoked_at })); return revoked;
  }
  resolve(company_id, context_ref, at = new Date().toISOString()) {
    const company = assertAuthorityCompanyId(company_id); const ref = text(context_ref, 'context-ref-required');
    const record = this.#records.get(`${company}:${ref}`); if (!record) throw new Error('context-not-found');
    if (record.revoked) throw new Error('context-revoked'); if (Date.parse(record.retained_until) < Date.parse(iso(at, 'context-check-at-invalid'))) throw new Error('context-expired'); return record;
  }
  history(company_id) { const company = assertAuthorityCompanyId(company_id); return Object.freeze(this.#history.filter(event => event.company_id === company)); }
}

function assertCeilingDoesNotExpand(parent, child) { const allowed = new Set(parent); for (const item of child) if (!allowed.has(item)) throw new Error('handoff-authority-ceiling-expansion'); }

export function createHandoffReceipt(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('handoff-receipt-input-required');
  rejectLegacyAuthorityBoundaryDeep(input, 'handoff_receipt');
  const source = createInvocationEnvelope(input.from_invocation); const target = createInvocationEnvelope(input.to_invocation);
  assertCompany(source.company_id, target.company_id, 'handoff-company-mismatch');
  if (source.correlation_id !== target.correlation_id) throw new Error('handoff-correlation-mismatch');
  if (target.causation_id !== source.invocation_id) throw new Error('handoff-causation-mismatch');
  if (target.context_ref !== source.context_ref) throw new Error('handoff-context-reference-mismatch');
  assertCeilingDoesNotExpand(source.authority_ceiling, target.authority_ceiling);
  const delegation = normalizeAuthorityDelegation(input.delegation, { company_id:source.company_id, decision_id:target.invocation_id });
  normalizeAuthorityDelegation(input.parent_delegation, { company_id:source.company_id, decision_id:source.invocation_id });
  assertAuthorityDelegationContinuity(input.parent_delegation, delegation, { company_id:source.company_id });
  return Object.freeze({ schema:HANDOFF_RECEIPT_SCHEMA, handoff_id:text(input.handoff_id, 'handoff-id-required'), company_id:source.company_id, from_invocation_id:source.invocation_id, to_invocation_id:target.invocation_id, context_ref:source.context_ref, correlation_id:source.correlation_id, delegation_id:delegation.delegation_id, received_at:iso(input.received_at ?? new Date().toISOString(), 'handoff-received-at-invalid'), authority_ceiling:target.authority_ceiling, authority_effect:false });
}

export class HandoffReceiptInbox {
  #receipts = new Map();
  accept(receipt, owner, at = new Date().toISOString()) {
    if (!receipt || receipt.schema !== HANDOFF_RECEIPT_SCHEMA) throw new Error('handoff-receipt-invalid');
    const existing = this.#receipts.get(receipt.handoff_id); if (existing) return Object.freeze({ receipt:existing, duplicate:true });
    owner.resolve(receipt.company_id, receipt.context_ref, at); this.#receipts.set(receipt.handoff_id, receipt); return Object.freeze({ receipt, duplicate:false });
  }
}

