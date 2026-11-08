import assert from 'node:assert/strict';
import {
  normalizeAuthorityDecisionProvenance,
  evaluateAuthorityDecisionLease,
  normalizeVerifiedAutonomySnapshot,
  computeContractionOnlyAuthority,
  evaluateWorkerAuthorityDecision,
} from '../index.mjs';

const now = '2026-09-05T03:00:00Z';

const provenance = normalizeAuthorityDecisionProvenance({
  company_id: 'co-1',
  decision_id: 'autonomy-lease-1',
  capability: 'booking.create',
  variant: 'default',
  workflow: 'booking',
  context_ref: 'customer:42',
  source: 'titan-autonomy',
  verified_at: '2026-09-05T02:30:00Z',
  policy_ref: 'policy:booking.create:v4',
  risk_ref: 'risk:r-17',
  assurance_ref: 'assurance:a-12',
  evidence_refs: ['ev-2', 'ev-1', 'ev-1'],
  source_receipt_ref: 'autonomy-receipt:77',
  evaluator_version: 'autonomy-1.8.3',
});
assert.equal(provenance.authority_owner, 'titan-autonomy');
assert.equal(provenance.source, 'titan-autonomy');
assert.equal(provenance.decision_id, 'autonomy-lease-1');
assert.equal(provenance.capability, 'booking.create');
assert.equal(provenance.context_ref, 'customer:42');
assert.deepEqual(provenance.evidence_refs, ['ev-1', 'ev-2']);
assert.equal(provenance.locally_issued, false);
assert.equal(provenance.provenance_confers_authority, false);

const snapshot = normalizeVerifiedAutonomySnapshot({
  company_id: 'co-1',
  decision_id: 'autonomy-lease-1',
  capability: 'booking.create',
  variant: 'default',
  workflow: 'booking',
  context_ref: 'customer:42',
  effective_score: 65,
  status: 'verified',
  source: 'titan-autonomy',
  verified_at: '2026-09-05T02:30:00Z',
  expires_at: '2026-09-05T04:00:00Z',
  policy_ref: 'policy:booking.create:v4',
  risk_ref: 'risk:r-17',
  assurance_ref: 'assurance:a-12',
  evidence_refs: ['ev-1'],
  source_receipt_ref: 'autonomy-receipt:77',
  evaluator_version: 'autonomy-1.8.3',
});
assert.equal(snapshot.provenance.policy_ref, 'policy:booking.create:v4');
assert.equal(snapshot.provenance.source_receipt_ref, 'autonomy-receipt:77');

const freshLease = evaluateAuthorityDecisionLease({
  company_id: 'co-1', snapshot, now, max_fresh_age_ms: 3_600_000,
});
assert.equal(freshLease.state, 'fresh');
assert.equal(freshLease.lease_status, 'active');
assert.equal(freshLease.execution_eligible, true);
assert.equal(freshLease.local_can_raise_authority, false);
assert.equal(freshLease.provenance.decision_id, 'autonomy-lease-1');
assert.equal(freshLease.capability, 'booking.create');
assert.equal(freshLease.provenance.workflow, 'booking');

const staleLease = evaluateAuthorityDecisionLease({
  company_id: 'co-1', snapshot: { ...snapshot, verified_at: '2026-09-04T20:00:00Z', provenance: { ...snapshot.provenance, verified_at: '2026-09-04T20:00:00Z', provenance_seal:null, provenance_seal_algorithm:null } }, now,
  max_fresh_age_ms: 3_600_000,
});
assert.equal(staleLease.state, 'stale');
assert.equal(staleLease.execution_eligible, true);
assert.ok(staleLease.reason_codes.includes('authority_lease_stale'));

const expiredLease = evaluateAuthorityDecisionLease({
  company_id: 'co-1', snapshot: { ...snapshot, expires_at: '2026-09-05T02:59:59Z' }, now,
});
assert.equal(expiredLease.state, 'expired');
assert.equal(expiredLease.execution_eligible, false);
assert.ok(expiredLease.reason_codes.includes('authority_lease_expired'));

const revokedLease = evaluateAuthorityDecisionLease({
  company_id: 'co-1', snapshot: { ...snapshot, status: 'revoked' }, now,
});
assert.equal(revokedLease.state, 'revoked');
assert.equal(revokedLease.execution_eligible, false);

const unknownLease = evaluateAuthorityDecisionLease({ company_id: 'co-1', snapshot: null, now });
assert.equal(unknownLease.state, 'unknown');
assert.equal(unknownLease.execution_eligible, false);
assert.equal(unknownLease.authority_ceiling, 0);

assert.throws(() => evaluateAuthorityDecisionLease({ company_id: 'co-2', snapshot, now }), /authority-company-mismatch/);
assert.throws(() => normalizeAuthorityDecisionProvenance({ ...provenance, tenant_id: 'co-1' }), /legacy-company-boundary/);
assert.throws(() => normalizeAuthorityDecisionProvenance({ ...provenance, source: 'local-worker' }), /authority-provenance-source-invalid/);
assert.throws(() => evaluateAuthorityDecisionLease({
  company_id: 'co-1', snapshot: { ...snapshot, provenance: { ...snapshot.provenance, capability: 'invoice.pay' } }, now,
}), /authority-provenance-binding-mismatch:capability/);
assert.throws(() => evaluateAuthorityDecisionLease({
  company_id: 'co-1', snapshot: { ...snapshot, provenance: { ...snapshot.provenance, decision_id: 'other-decision' } }, now,
}), /authority-provenance-binding-mismatch:decision_id/);
assert.throws(() => evaluateAuthorityDecisionLease({
  company_id: 'co-1', snapshot: { ...snapshot, provenance: { ...snapshot.provenance, context_ref: 'customer:other' } }, now,
}), /authority-provenance-binding-mismatch:context_ref/);

assert.throws(() => evaluateAuthorityDecisionLease({
  company_id: 'co-1', snapshot: { ...snapshot, verified_at: '2026-09-05T05:00:00Z', expires_at: '2026-09-05T06:00:00Z', provenance: { ...snapshot.provenance, verified_at: '2026-09-05T05:00:00Z' } }, now,
}), /authority-lease-verified-at-future/);
assert.throws(() => evaluateAuthorityDecisionLease({
  company_id: 'co-1', snapshot: { ...snapshot, verified_at: '2026-09-05T03:30:00Z', expires_at: '2026-09-05T03:00:00Z', provenance: { ...snapshot.provenance, verified_at: '2026-09-05T03:30:00Z' } }, now: '2026-09-05T02:00:00Z',
}), /authority-lease-window-invalid/);


const contracted = computeContractionOnlyAuthority({
  snapshot: { ...snapshot, verified_at: '2026-09-04T20:00:00Z', provenance: { ...snapshot.provenance, verified_at: '2026-09-04T20:00:00Z', provenance_seal:null, provenance_seal_algorithm:null } },
  now,
  max_snapshot_age_ms: 3_600_000,
  connectivity: 'online',
});
assert.equal(contracted.authority_lease.state, 'stale');
assert.equal(contracted.effective_score, 30);
assert.equal(contracted.authority_provenance.decision_id, 'autonomy-lease-1');
assert.equal(contracted.local_can_raise_authority, false);

const decision = evaluateWorkerAuthorityDecision({
  authority_decision_id: 'eval-lease-1',
  company_id: 'co-1', operation_id: 'op-1', action_id: 'action-1', now,
  worker: { worker_id: 'worker-1' },
  requirement: {
    capability: 'booking.create', operation: 'create', effect: 'read',
    minimum_autonomy_score: 0,
  },
  autonomy_snapshot: snapshot,
  permissions: [], entitlements: [],
  policy_allows: true, governance_allows: true, assurance_allows: true,
  risk: 'none', connectivity: 'online',
  evidence: { status: 'not_required', refs: [] },
  approval: { status: 'not_required' },
});
assert.equal(decision.decision, 'ALLOW');
assert.equal(decision.authority_lease.state, 'fresh');
assert.equal(decision.authority_provenance.source, 'titan-autonomy');
assert.equal(decision.authority_provenance.locally_issued, false);

const { readFile } = await import('node:fs/promises');
const decisionSchema = JSON.parse(await readFile(new URL('../WorkerAuthorityDecision.schema.json', import.meta.url), 'utf8'));
assert.ok(decisionSchema.properties.authority_lease);
assert.ok(decisionSchema.properties.authority_provenance);

console.log('authority decision lifecycle PASS');
