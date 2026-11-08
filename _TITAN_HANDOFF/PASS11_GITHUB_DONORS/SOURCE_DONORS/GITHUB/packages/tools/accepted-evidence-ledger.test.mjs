import test from 'node:test';
import assert from 'node:assert/strict';
import { AcceptedEvidenceLedger } from './accepted-evidence-ledger.mjs';
import { ExecutionGateway, EXECUTION_CLASSES } from './execution-gateway.mjs';

const base = {
  execution_id: 'execution-1',
  company_id: 'company-a',
  decision_id: 'decision-1',
  work_id: 'job-1',
  capability: 'job.complete',
  idempotency_key: 'complete-job-1',
  authority: { status: 'approved' },
  risk: { status: 'approved' },
};

test('verified execution is append-only evidence and deterministically rebuilds a job projection', async () => {
  const ledger = new AcceptedEvidenceLedger({ now: () => '2026-01-01T00:00:00.000Z' });
  const gateway = new ExecutionGateway({
    evidenceSink: (evidence) => ledger.append(evidence),
    providers: [{
      id: 'field-service',
      executionClass: EXECUTION_CLASSES.CONNECTED,
      capabilities: ['job.complete'],
      execute: async () => ({ external_ref: 'provider-job-1', result: { status: 'complete' } }),
      verify: async () => ({ verified: true, method: 'canonical-reread' }),
    }],
  });

  const result = await gateway.execute(base);
  const events = ledger.list('company-a');
  const projection = ledger.projectJob('company-a', 'job-1');

  assert.equal(result.state, 'VERIFIED');
  assert.equal(events.length, 6);
  assert.equal(projection.status, 'VERIFIED');
  assert.equal(projection.company_id, 'company-a');
  assert.equal(projection.job_id, 'job-1');
  assert.deepEqual(projection.provenance.evidence_ids, events.map((event) => event.evidence_id));
  assert.equal(projection.provenance.source_of_truth, 'accepted-evidence');
  assert.deepEqual(ledger.projectJob('company-a', 'job-1'), projection);
});

test('provider acknowledgement without verification cannot enter the verified projection', async () => {
  const ledger = new AcceptedEvidenceLedger();
  const gateway = new ExecutionGateway({
    evidenceSink: (evidence) => ledger.append(evidence),
    providers: [{
      id: 'field-service',
      executionClass: EXECUTION_CLASSES.CONNECTED,
      capabilities: ['job.complete'],
      execute: async () => ({ external_ref: 'provider-job-2', result: { status: 'complete' } }),
    }],
  });

  const result = await gateway.execute({ ...base, execution_id: 'execution-2', idempotency_key: 'complete-job-2' });
  const projection = ledger.projectJob('company-a', 'job-1');

  assert.equal(result.state, 'UNCERTAIN');
  assert.equal(projection.status, 'UNKNOWN');
  assert.deepEqual(projection.provenance.evidence_ids, []);
});

test('company scope and supersession are enforced during projection rebuild', () => {
  const ledger = new AcceptedEvidenceLedger();
  ledger.append({
    evidence_id: 'event-a', company_id: 'company-a', work_id: 'job-1', state: 'VERIFIED',
    final_outcome: 'verified', verification: { verified: true, method: 'canonical-reread' }, observed_result: { status: 'complete' },
  });
  ledger.append({
    evidence_id: 'event-b', company_id: 'company-a', work_id: 'job-1', state: 'VERIFIED',
    final_outcome: 'verified', verification: { verified: true, method: 'canonical-reread' }, supersedes_evidence_id: 'event-a', observed_result: { status: 'reopened' },
  });
  ledger.append({
    evidence_id: 'event-other', company_id: 'company-b', work_id: 'job-1', state: 'VERIFIED',
    final_outcome: 'verified', verification: { verified: true, method: 'canonical-reread' }, observed_result: { status: 'complete' },
  });

  const projection = ledger.projectJob('company-a', 'job-1');
  assert.equal(projection.status, 'VERIFIED');
  assert.deepEqual(projection.state, { status: 'reopened' });
  assert.deepEqual(projection.provenance.evidence_ids, ['event-b']);
  assert.deepEqual(ledger.list('company-a').map((event) => event.evidence_id), ['event-a', 'event-b']);
  assert.deepEqual(ledger.list('company-b').map((event) => event.evidence_id), ['event-other']);
});

test('factual history is immutable and simulated evidence is rejected', () => {
  const ledger = new AcceptedEvidenceLedger();
  const stored = ledger.append({ evidence_id: 'event-immutable', company_id: 'company-a', work_id: 'job-1', state: 'REQUESTED' });
  stored.state = 'VERIFIED';
  assert.equal(ledger.list('company-a')[0].state, 'REQUESTED');
  assert.throws(() => ledger.append({ evidence_id: 'event-simulated', company_id: 'company-a', kind: 'simulated' }), /simulated-evidence/);
  assert.throws(() => ledger.append({ evidence_id: 'event-immutable', company_id: 'company-a' }), /duplicate-evidence-id/);
});

test('unverified records cannot assert a verified business outcome', () => {
  const ledger = new AcceptedEvidenceLedger();
  assert.throws(() => ledger.append({
    evidence_id: 'event-unverified', company_id: 'company-a', work_id: 'job-1',
    state: 'VERIFIED', final_outcome: 'verified', observed_result: { status: 'complete' },
  }), /verified-evidence-requires-independent-verification/);
  assert.throws(() => ledger.append({
    evidence_id: 'event-conflicting-state', company_id: 'company-a', work_id: 'job-1',
    state: 'PROVIDER_ACKNOWLEDGED', final_outcome: 'verified', verification: { verified: true },
  }), /verified-evidence-requires-independent-verification/);
  assert.equal(ledger.projectJob('company-a', 'job-1').status, 'UNKNOWN');
});
