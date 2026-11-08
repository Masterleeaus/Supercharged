import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy } from '../../server/modules/approvals/policy-evaluator.ts';
import { HUMAN_ACTOR, RISK_TIERS } from '../../server/modules/approvals/authority-ladder.ts';
import { alwaysApprovalCategoryOf, isAlwaysApproval } from '../../server/workforce/runtime/always-approval.ts';

// Pure checks. No database, network or provider calls. Console is silenced so the test runner's IPC is not broken.
for (const method of ['log', 'info', 'warn', 'error']) console[method] = () => {};

// Money-in (receipts, payouts received) and money-out (payments, refunds, purchase orders) must both need a
// verified owner approval at every autonomy tier and every risk tier.
const MONEY_IN = ['payments.record', 'payouts.create', 'transfers.receive', 'refunds.receive'];
const MONEY_OUT = ['purchase_orders.draft', 'purchase_orders.send', 'refunds.issue', 'payouts.send'];
const MONEY_CALLS = [...MONEY_IN, ...MONEY_OUT];

const AGENT = { kind: 'agent', verified: true };
const HUMAN = { kind: 'human', verified: true };
const TIERS = ['assist', 'suggest', 'auto', 'predictive', HUMAN_ACTOR];

function decide(action, tier, risk, approvalState = 'none') {
  return evaluatePolicy({
    tier,
    access: 'write',
    risk,
    action,
    actor: tier === HUMAN_ACTOR ? HUMAN : AGENT,
    category: 'none',
    approvalState,
  }).decision;
}

test('every money-in and money-out tool is categorised as money', () => {
  for (const tool of MONEY_CALLS) {
    assert.equal(alwaysApprovalCategoryOf(tool), 'money', `${tool} must be money`);
    assert.equal(isAlwaysApproval(tool), true, `${tool} must be always-approval`);
  }
});

test('no money-in or money-out tool is allowed without owner approval, at any tier or risk', () => {
  for (const tool of MONEY_CALLS) {
    for (const tier of TIERS) {
      for (const risk of RISK_TIERS) {
        const decision = decide(tool, tier, risk);
        assert.notEqual(decision, 'allow', `${tool} ${tier}/${risk} must not run unapproved`);
      }
    }
  }
});

test('money-in and money-out tools need approval on low-risk auto and human calls, and run once approved', () => {
  for (const tool of MONEY_CALLS) {
    assert.equal(decide(tool, 'auto', 'low'), 'require_approval', `${tool} auto/low`);
    assert.equal(decide(tool, HUMAN_ACTOR, 'low'), 'require_approval', `${tool} human/low`);
    assert.equal(decide(tool, 'auto', 'low', 'approved'), 'allow', `${tool} auto/low approved`);
  }
});

test('read-only money tools stay ungated, so the check is not too broad', () => {
  for (const tool of ['payments.list', 'refund_requests.list', 'purchase_orders.list', 'invoices.list']) {
    assert.equal(alwaysApprovalCategoryOf(tool), null, `${tool} must not be categorised`);
    assert.equal(
      evaluatePolicy({ tier: 'auto', access: 'read', risk: 'low', action: tool, actor: AGENT, category: 'none', approvalState: 'none' }).decision,
      'allow',
      `${tool} read must run`,
    );
  }
});

test('customer sends and record deletes are gated at every tier', () => {
  for (const tool of ['messages.send', 'customer_messages.send', 'records.delete', 'client_merge_suggestions.create']) {
    assert.notEqual(alwaysApprovalCategoryOf(tool), null, `${tool} must be gated`);
    for (const tier of TIERS) {
      for (const risk of RISK_TIERS) {
        assert.notEqual(decide(tool, tier, risk), 'allow', `${tool} ${tier}/${risk} must not run unapproved`);
      }
    }
  }
});
