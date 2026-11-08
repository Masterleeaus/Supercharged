import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessCommissioningLifecycle, advanceBusinessCommissioningLifecycle, recordVerifiedCommissioningOutcome } from './business-commissioning-lifecycle.mjs';

const base = { company_id:'co-29', mission_id:'mission-1', discovery_ref:'discovery-1', installation_plan_ref:'plan-1', outcome_criteria_refs:['metric:completion-time'] };
const step = (state, evidence_refs=['evidence-1'], extra={}) => ({ company_id:'co-29', state, evidence_refs, ...extra });

test('commissioning lifecycle requires ordered, evidence-backed stages', () => {
  let lifecycle = createBusinessCommissioningLifecycle(base);
  for (const state of ['DESIGNED','INSTALLED','SHADOW']) lifecycle = advanceBusinessCommissioningLifecycle(lifecycle, step(state));
  lifecycle = advanceBusinessCommissioningLifecycle(lifecycle, step('PROVEN', ['shadow-evidence'], { receipt_refs:['receipt-1'] }));
  lifecycle = advanceBusinessCommissioningLifecycle(lifecycle, step('ACCEPTED', ['acceptance-evidence'], { acceptance_ref:'client-acceptance-1' }));
  lifecycle = advanceBusinessCommissioningLifecycle(lifecycle, step('LIVE', ['live-review-evidence'], { authority_review_ref:'fresh-authority-review-1' }));
  assert.equal(lifecycle.state, 'LIVE'); assert.equal(lifecycle.history.length, 6); assert.equal(lifecycle.automatic_go_live, false); assert.equal(lifecycle.authority_granted, false);
});

test('commissioning blocks skips, missing proof receipts, missing client acceptance, and duplicate outcomes', () => {
  let lifecycle = createBusinessCommissioningLifecycle(base);
  assert.throws(() => advanceBusinessCommissioningLifecycle(lifecycle, step('INSTALLED')), /commissioning-state-transition-invalid/);
  for (const state of ['DESIGNED','INSTALLED','SHADOW']) lifecycle = advanceBusinessCommissioningLifecycle(lifecycle, step(state));
  assert.throws(() => advanceBusinessCommissioningLifecycle(lifecycle, step('PROVEN')), /commissioning-prove-receipt-required/);
  lifecycle = advanceBusinessCommissioningLifecycle(lifecycle, step('PROVEN', ['proof'], { receipt_refs:['receipt-1'] }));
  assert.throws(() => advanceBusinessCommissioningLifecycle(lifecycle, step('ACCEPTED')), /commissioning-client-acceptance-required/);
  lifecycle = advanceBusinessCommissioningLifecycle(lifecycle, step('ACCEPTED', ['acceptance'], { acceptance_ref:'acceptance-1' }));
  lifecycle = advanceBusinessCommissioningLifecycle(lifecycle, step('LIVE', ['live'], { authority_review_ref:'review-1' }));
  const outcome = recordVerifiedCommissioningOutcome(lifecycle, { outcome_id:'outcome-1', evidence_refs:['verified-1'] });
  assert.equal(recordVerifiedCommissioningOutcome(outcome, { outcome_id:'outcome-1', evidence_refs:['verified-1'] }), outcome);
});

test('commissioning fails closed for cross-company, legacy tenant, and unsafe rollback', () => {
  const lifecycle = createBusinessCommissioningLifecycle(base);
  assert.throws(() => advanceBusinessCommissioningLifecycle(lifecycle, { ...step('DESIGNED'), company_id:'co-other' }), /commissioning-company-mismatch/);
  assert.throws(() => createBusinessCommissioningLifecycle({ ...base, tenant_id:'legacy' }), /legacy-company-boundary/);
  assert.throws(() => advanceBusinessCommissioningLifecycle(lifecycle, { ...step('ROLLED_BACK'), rollback_ref:'rollback-1', evidence_refs:[] }), /commissioning-rolled_back-evidence-required/);
  const rolled = advanceBusinessCommissioningLifecycle(lifecycle, { ...step('ROLLED_BACK'), rollback_ref:'rollback-1' });
  assert.equal(rolled.state, 'ROLLED_BACK'); assert.throws(() => advanceBusinessCommissioningLifecycle(rolled, step('DESIGNED')), /commissioning-lifecycle-terminal/);
});

