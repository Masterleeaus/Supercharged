import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApprovalView } from '../../server/modules/approvals/approval-view.ts';

// Pure tests. No database, no Express, no environment reads.

const CREATED = new Date('2026-11-03T10:00:00Z');
const EXPIRES = new Date('2026-11-03T11:00:00Z');
const NOW = new Date('2026-11-03T10:30:00Z');

function approval(overrides = {}) {
  return {
    id: 'appr_1',
    requestedBy: 'user_1',
    agentId: 'agent_1',
    action: 'refund_order',
    urgency: 'normal',
    params: { orderId: 'ord_9', amountCents: 2500, note: 'late delivery' },
    status: 'pending',
    decision: null,
    policyId: null,
    decidedBy: null,
    decisionReason: null,
    paramsSha256: 'abc',
    createdAt: CREATED,
    decidedAt: null,
    executedAt: null,
    expiresAt: EXPIRES,
    companyId: 'co_1',
    context: {},
    ...overrides,
  };
}

test('a money action gets the money consequence', () => {
  const view = buildApprovalView(approval({ context: { category: 'money', risk: 'high' } }), { now: NOW });
  assert.equal(view.category, 'money');
  assert.equal(view.consequences, 'Moves money');
});

test('customer_send and delete get their own consequence sentences', () => {
  const send = buildApprovalView(approval({ context: { category: 'customer_send' } }), { now: NOW });
  const del = buildApprovalView(approval({ context: { category: 'delete' } }), { now: NOW });
  assert.equal(send.consequences, 'Sends a message to a customer');
  assert.equal(del.consequences, 'Deletes records');
});

test('a category outside the known set is unknown and the consequence falls back to the action name', () => {
  const view = buildApprovalView(approval({ context: { category: 'wire_everything' } }), { now: NOW });
  assert.equal(view.category, 'unknown');
  assert.equal(view.consequences, 'refund_order');
});

test('a missing roster leaves the agent role unknown and keeps the agent id', () => {
  const view = buildApprovalView(approval(), { now: NOW });
  assert.deepEqual(view.agent, { id: 'agent_1', roleId: 'unknown' });
});

test('a roster supplies the role id for a known agent, and unknown for an agent not on it', () => {
  const roster = [{ id: 'agent_1', roleId: 'billing' }];
  assert.equal(buildApprovalView(approval(), { now: NOW, roster }).agent.roleId, 'billing');
  const other = buildApprovalView(approval({ agentId: 'agent_7' }), { now: NOW, roster });
  assert.deepEqual(other.agent, { id: 'agent_7', roleId: 'unknown' });
});

test('affectedRecords come from context and default to empty', () => {
  const listed = buildApprovalView(approval({ context: { affectedRecords: ['c_1', 'c_2'] } }), { now: NOW });
  assert.deepEqual(listed.affectedRecords, ['c_1', 'c_2']);
  const byRecordIds = buildApprovalView(approval({ context: { recordIds: ['o_3'] } }), { now: NOW });
  assert.deepEqual(byRecordIds.affectedRecords, ['o_3']);
  const none = buildApprovalView(approval({ context: {} }), { now: NOW });
  assert.deepEqual(none.affectedRecords, []);
  const malformed = buildApprovalView(approval({ context: { affectedRecords: 'c_1' } }), { now: NOW });
  assert.deepEqual(malformed.affectedRecords, []);
});

test('redact is applied to parameters when passed, and parameters are exact when it is not', () => {
  const stored = { orderId: 'ord_9', apiKey: 'sk_live_123' };
  const redacted = buildApprovalView(approval({ params: stored }), {
    now: NOW,
    redact: (params) => ({ ...params, apiKey: '[REDACTED]' }),
  });
  assert.deepEqual(redacted.parameters, { orderId: 'ord_9', apiKey: '[REDACTED]' });
  assert.equal(stored.apiKey, 'sk_live_123', 'the stored params are not mutated');

  const exact = buildApprovalView(approval({ params: stored }), { now: NOW });
  assert.deepEqual(exact.parameters, { orderId: 'ord_9', apiKey: 'sk_live_123' });
});

test('ageMs and expiresInMs follow the injected now', () => {
  const view = buildApprovalView(approval(), { now: NOW });
  assert.equal(view.ageMs, 30 * 60_000);
  assert.equal(view.expiresInMs, 30 * 60_000);

  const later = buildApprovalView(approval(), { now: new Date('2026-11-03T10:45:00Z') });
  assert.equal(later.ageMs, 45 * 60_000);
  assert.equal(later.expiresInMs, 15 * 60_000);

  const asNumber = buildApprovalView(approval(), { now: NOW.getTime() });
  assert.equal(asNumber.ageMs, 30 * 60_000);
});

test('missing company, agent and action are reported as unknown, and risk is unknown when absent', () => {
  const view = buildApprovalView(
    approval({ companyId: undefined, agentId: null, action: '', context: {} }),
    { now: NOW },
  );
  assert.equal(view.company, 'unknown');
  assert.deepEqual(view.agent, { id: 'unknown', roleId: 'unknown' });
  assert.equal(view.action, 'unknown');
  assert.equal(view.risk, 'unknown');
  assert.equal(view.consequences, 'unknown');
});

test('risk is read from context only when it is a known tier', () => {
  assert.equal(buildApprovalView(approval({ context: { risk: 'critical' } }), { now: NOW }).risk, 'critical');
  assert.equal(buildApprovalView(approval({ context: { risk: 'extreme' } }), { now: NOW }).risk, 'unknown');
});

test('company comes from companyId and the policy decision is passed through when given', () => {
  const view = buildApprovalView(approval(), {
    now: NOW,
    policy: { decision: 'require_approval', reason: 'money action' },
  });
  assert.equal(view.company, 'co_1');
  assert.deepEqual(view.policy, { decision: 'require_approval', reason: 'money action' });
  assert.equal(buildApprovalView(approval(), { now: NOW }).policy, 'unknown');
});

test('missing or non-object params are reported as unknown', () => {
  const view = buildApprovalView(approval({ params: null }), { now: NOW });
  assert.equal(view.parameters, 'unknown');
});
