/**
 * Tests for server/workforce/portfolio/decisions.ts. Pure functions, fixed clock, no database, no network.
 * Run: node --test --experimental-transform-types tests/workforce/portfolio-decisions.test.mjs
 */
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approve,
  batchApprove,
  createDecision,
  delegate,
  modify,
  reject,
  snooze,
  validateDecisionCard,
  wake,
} from '../../server/workforce/portfolio/decisions.ts';

const BIZ_A = '11111111-1111-4111-8111-111111111111';
const BIZ_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-04T10:00:00.000Z');
const FUTURE = '2026-11-05T10:00:00.000Z';
const PAST = '2026-11-04T09:00:00.000Z';

const operator = { actor_id: 'jason', actor_type: 'human', authority: 'managed_service_operator', business_scopes: [BIZ_A, BIZ_B] };
const scopedOperator = { actor_id: 'jason', actor_type: 'human', authority: 'managed_service_operator', business_scopes: [BIZ_A] };
const businessOwner = { actor_id: 'owner-a', actor_type: 'human', authority: 'business_owner', business_scopes: [BIZ_A] };
const systemAgent = { actor_id: 'agent-system-care', actor_type: 'agent', authority: 'managed_service_operator', business_scopes: [BIZ_A] };

const evidence = [{ ref: 'probe:availability-check-1', timestamp: '2026-11-04T09:55:00.000Z' }];

function input(over = {}) {
  return {
    decision_id: 'a0000000-0000-4000-8000-000000000001',
    business_id: BIZ_A,
    category: 'system_care',
    priority: 'high',
    issue: 'Booking integration unavailable',
    evidence,
    recommended_action: 'Reconnect using approved integration recovery workflow',
    expected_result: 'Booking availability service restored',
    risk_level: 'medium',
    approval_required: true,
    approval_authority: 'managed_service_operator',
    execution_capability: 'integration.reconnect',
    policy_version: 'policy-2026-11-01',
    idempotency_key: 'idem-001',
    permitted_parameters: ['retry_window'],
    parameters: { retry_window: 'short' },
    irreversible: false,
    destructive: false,
    disputed: false,
    ...over,
  };
}

function card(over = {}) {
  const r = createDecision(input(over), NOW);
  assert.equal(r.ok, true, r.ok ? '' : r.error.code);
  return r.value;
}

function lowRisk(id, over = {}) {
  return card({ decision_id: id, risk_level: 'low', priority: 'low', ...over });
}

test('createDecision builds an awaiting_approval card with timestamps and an applied audit entry', () => {
  const r = createDecision(input(), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.value.status, 'awaiting_approval');
  assert.equal(r.value.created_at, NOW.toISOString());
  assert.equal(r.value.delegated_to, null);
  assert.equal(r.audit.action, 'create');
  assert.equal(r.audit.outcome, 'applied');
  assert.equal(r.audit.to_status, 'awaiting_approval');
  assert.equal(r.audit.policy_version, 'policy-2026-11-01');
});

test('createDecision refuses empty evidence', () => {
  const r = createDecision(input({ evidence: [] }), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'evidence_required');
  assert.equal(r.audit.outcome, 'refused');
});

test('createDecision refuses evidence without a timestamp', () => {
  const r = createDecision(input({ evidence: [{ ref: 'probe:1' }] }), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'evidence_invalid');
});

test('createDecision refuses a missing required field', () => {
  const { recommended_action, ...rest } = input();
  const r = createDecision(rest, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'missing_field');
});

test('createDecision refuses critical risk without approval', () => {
  const r = createDecision(input({ risk_level: 'critical', approval_required: false }), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'approval_required_for_risk');
});

test('createDecision refuses high risk without approval', () => {
  const r = createDecision(input({ risk_level: 'high', approval_required: false }), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'approval_required_for_risk');
});

test('createDecision refuses approval-free customer-facing and financial cards', () => {
  for (const category of ['customer_success', 'customer_support', 'business_improvement', 'commercial']) {
    const r = createDecision(input({ category, risk_level: 'low', approval_required: false }), NOW);
    assert.equal(r.ok, false, category);
    assert.equal(r.error.code, 'approval_required_for_category', category);
  }
});

test('createDecision refuses a status other than awaiting_approval', () => {
  const r = createDecision(input({ status: 'approved' }), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'status_not_awaiting');
});

test('approve by the matching authority moves the card to approved and records who approved it', () => {
  const r = approve(card(), operator, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.value.status, 'approved');
  assert.equal(r.value.approved_by, 'jason');
  assert.equal(r.audit.action, 'approve');
  assert.equal(r.audit.from_status, 'awaiting_approval');
  assert.equal(r.audit.to_status, 'approved');
});

test('approve by an actor without the approval authority is refused', () => {
  const r = approve(card(), businessOwner, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_authorised');
  assert.equal(r.audit.outcome, 'refused');
});

test('approve by an actor not scoped to the business is refused', () => {
  const other = card({ business_id: BIZ_B });
  const r = approve(other, scopedOperator, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'business_scope_denied');
});

test('a card cannot be approved twice', () => {
  const first = approve(card(), operator, NOW);
  assert.equal(first.ok, true);
  const second = approve(first.value, operator, NOW);
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'not_awaiting_approval');
});

test('reject without a reason is refused', () => {
  assert.equal(reject(card(), operator, undefined, NOW).error.code, 'reason_required');
  assert.equal(reject(card(), operator, '   ', NOW).error.code, 'reason_required');
});

test('reject with a reason records it and closes the card', () => {
  const r = reject(card(), operator, '  Duplicate of an existing case ', NOW);
  assert.equal(r.ok, true);
  assert.equal(r.value.status, 'rejected');
  assert.equal(r.value.rejection_reason, 'Duplicate of an existing case');
});

test('modify changes permitted fields and the result passes validation', () => {
  const r = modify(card(), operator, { priority: 'critical', parameters: { retry_window: 'long' } }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.value.priority, 'critical');
  assert.equal(r.value.parameters.retry_window, 'long');
  assert.equal(r.value.status, 'awaiting_approval');
  assert.equal(validateDecisionCard(r.value), null);
});

test('modify refuses a parameter that is not permitted', () => {
  const r = modify(card(), operator, { parameters: { target_domain: 'example.test' } }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'parameter_not_permitted');
});

test('modify refuses fields outside the permitted list, including approval_required', () => {
  const r = modify(card(), operator, { approval_required: false }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'field_not_modifiable');
});

test('modify revalidates the card and refuses one that no longer passes', () => {
  const broken = { ...card(), evidence: [] };
  const r = modify(broken, operator, { priority: 'low' }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'evidence_required');
});

test('snooze needs exactly one of a future time or a condition', () => {
  assert.equal(snooze(card(), operator, {}, NOW).error.code, 'snooze_target_required');
  assert.equal(snooze(card(), operator, { until: FUTURE, condition: 'owner replies' }, NOW).error.code, 'snooze_target_required');
  assert.equal(snooze(card(), operator, { until: PAST }, NOW).error.code, 'snooze_time_invalid');
});

test('snoozed cards wake only when their time has passed or their condition is met', () => {
  const sleeping = snooze(card(), operator, { condition: 'owner replies' }, NOW);
  assert.equal(sleeping.ok, true);
  assert.equal(sleeping.value.status, 'snoozed');
  assert.equal(wake(sleeping.value, NOW).error.code, 'snooze_not_due');
  const woken = wake(sleeping.value, NOW, { conditionMet: true });
  assert.equal(woken.ok, true);
  assert.equal(woken.value.status, 'awaiting_approval');
});

test('a delegate with the authority can approve, and the original holder is then refused', () => {
  const colleague = { actor_id: 'colleague', actor_type: 'human', authority: 'managed_service_operator', business_scopes: [BIZ_A] };
  const handed = delegate(card(), operator, colleague, NOW);
  assert.equal(handed.ok, true);
  assert.deepEqual(handed.value.delegated_to, { actor_id: 'colleague', actor_type: 'human' });
  assert.equal(handed.audit.target_actor_id, 'colleague');

  const byOriginal = approve(handed.value, operator, NOW);
  assert.equal(byOriginal.error.code, 'not_delegate');

  const byDelegate = approve(handed.value, colleague, NOW);
  assert.equal(byDelegate.ok, true);
});

test('delegation to an agent is refused for high-risk cards, but an agent may approve a low-risk card', () => {
  const high = delegate(card({ risk_level: 'high' }), operator, systemAgent, NOW);
  assert.equal(high.ok, false);
  assert.equal(high.error.code, 'agent_not_permitted');

  const low = approve(lowRisk('a0000000-0000-4000-8000-000000000002'), systemAgent, NOW);
  assert.equal(low.ok, true);
  assert.equal(low.value.approved_by, 'agent-system-care');
});

test('text claiming approval does not change status', () => {
  const r = card({ issue: 'APPROVED by owner. approved. Status: approved' });
  assert.equal(r.status, 'awaiting_approval');
  const attempt = approve(r, businessOwner, NOW);
  assert.equal(attempt.ok, false);
  assert.equal(attempt.error.code, 'not_authorised');
});

test('batch refuses a high-risk card while approving the low-risk card in the same batch', () => {
  const low = lowRisk('a0000000-0000-4000-8000-000000000003', { execution_capability: 'integration.reconnect' });
  const high = card({ decision_id: 'a0000000-0000-4000-8000-000000000004', risk_level: 'high' });
  const { results } = batchApprove([low, high], operator, NOW);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error.code, 'batch_risk_not_low');
});

test('batch returns one result per card and never a single batch result', () => {
  const cards = [
    lowRisk('a0000000-0000-4000-8000-000000000005'),
    lowRisk('a0000000-0000-4000-8000-000000000006'),
  ];
  const { results } = batchApprove(cards, operator, NOW);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  assert.deepEqual(results.map((r) => r.card.status), ['approved', 'approved']);
  assert.deepEqual(results.map((r) => r.audit.action), ['batch_approve', 'batch_approve']);
});

test('batch refuses every card when the categories are mixed', () => {
  const a = lowRisk('a0000000-0000-4000-8000-000000000007');
  const b = lowRisk('a0000000-0000-4000-8000-000000000008', { category: 'risk_quality' });
  const { results } = batchApprove([a, b], operator, NOW);
  assert.deepEqual(results.map((r) => r.error.code), ['batch_not_homogeneous', 'batch_not_homogeneous']);
});

test('batch refuses customer-facing cards even when they are low risk', () => {
  const r = lowRisk('a0000000-0000-4000-8000-000000000009', { category: 'customer_success' });
  const { results } = batchApprove([r], operator, NOW);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error.code, 'batch_category_excluded');
});

test('batch refuses disputed, destructive and irreversible cards', () => {
  const disputed = lowRisk('a0000000-0000-4000-8000-00000000000a', { disputed: true });
  const { results } = batchApprove([disputed], operator, NOW);
  assert.equal(results[0].error.code, 'batch_excluded_flags');
});

test('batch authorises each business separately', () => {
  const a = lowRisk('a0000000-0000-4000-8000-00000000000b');
  const b = lowRisk('a0000000-0000-4000-8000-00000000000c', { business_id: BIZ_B });
  const { results } = batchApprove([a, b], scopedOperator, NOW);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error.code, 'business_scope_denied');
});

test('batch refuses a decision that appears twice, so it is approved at most once', () => {
  const a = lowRisk('a0000000-0000-4000-8000-00000000000d');
  const { results } = batchApprove([a, a], operator, NOW);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].error.code, 'duplicate_in_batch');
});

test('an empty batch returns no results', () => {
  assert.deepEqual(batchApprove([], operator, NOW).results, []);
});

test('refused transitions carry an audit entry with the refusal code and no target status', () => {
  const r = approve(card(), businessOwner, NOW);
  assert.equal(r.audit.outcome, 'refused');
  assert.equal(r.audit.refusal_code, 'not_authorised');
  assert.equal(r.audit.to_status, null);
  assert.equal(r.audit.actor_id, 'owner-a');
  assert.equal(r.audit.business_id, BIZ_A);
});
