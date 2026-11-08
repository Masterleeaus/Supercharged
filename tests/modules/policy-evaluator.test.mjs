import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy, CATEGORIES } from '../../server/modules/approvals/policy-evaluator.ts';
import { HUMAN_ACTOR, RISK_TIERS } from '../../server/modules/approvals/authority-ladder.ts';

// Pure tests. No database, no Express, no environment reads.

const AGENT = { kind: 'agent', verified: true };
const HUMAN = { kind: 'human', verified: true };

function input(overrides = {}) {
  return {
    tier: 'auto',
    access: 'write',
    risk: 'low',
    action: 'do_thing',
    actor: AGENT,
    category: 'none',
    approvalState: 'none',
    ...overrides,
  };
}

// Hand-written expectations per (tier, category, risk) for a write tool, unapproved and approved.
// Key: tier|category|risk. Values: [unapproved, approved].
const GATED = new Set(['money', 'customer_send', 'delete']);

function expectedWrite(tier, category, risk) {
  if (tier === 'assist' || tier === 'suggest') return ['deny', 'deny'];
  // Agents: low and medium run. A verified human also runs high; critical waits for approval.
  const ladderAllows = tier === HUMAN_ACTOR ? risk !== 'critical' : risk === 'low' || risk === 'medium';
  if (!ladderAllows) return ['require_approval', 'allow'];
  if (GATED.has(category)) return ['require_approval', 'allow'];
  return ['allow', 'allow'];
}

for (const tier of ['assist', 'suggest', 'auto', 'predictive', HUMAN_ACTOR]) {
  for (const category of CATEGORIES) {
    for (const risk of RISK_TIERS) {
      test(`write tool, tier ${tier}, category ${category}, risk ${risk}`, () => {
        const actor = tier === HUMAN_ACTOR ? HUMAN : AGENT;
        const [unapproved, approved] = expectedWrite(tier, category, risk);
        const base = { tier, risk, category, actor, access: 'write' };

        assert.equal(evaluatePolicy(input({ ...base, approvalState: 'none' })).decision, unapproved);
        assert.equal(evaluatePolicy(input({ ...base, approvalState: 'approved' })).decision, approved);
      });
    }
  }
}

test('suggest with read access: every risk tier runs with no approval gate', () => {
  for (const risk of RISK_TIERS) {
    assert.equal(evaluatePolicy(input({ tier: 'suggest', access: 'read', risk })).decision, 'allow', risk);
    assert.equal(evaluatePolicy(input({ tier: 'suggest', access: 'read', risk, approvalState: 'approved' })).decision, 'allow', risk);
  }
});

test('a read tool in a money category still needs approval under auto and suggest', () => {
  for (const tier of ['auto', 'suggest']) {
    assert.equal(evaluatePolicy(input({ tier, access: 'read', category: 'money' })).decision, 'require_approval', tier);
  }
});

test('predictive matches auto for every category and risk', () => {
  for (const category of CATEGORIES) {
    for (const risk of RISK_TIERS) {
      for (const approvalState of ['none', 'approved']) {
        const auto = evaluatePolicy(input({ tier: 'auto', risk, category, approvalState }));
        const predictive = evaluatePolicy(input({ tier: 'predictive', risk, category, approvalState }));
        assert.equal(predictive.decision, auto.decision, `${category} ${risk} ${approvalState}`);
      }
    }
  }
});

test('approved once: approval turns require_approval into allow for that one call only', () => {
  const pending = input({ tier: 'auto', risk: 'high', category: 'money', approvalState: 'none' });
  assert.equal(evaluatePolicy(pending).decision, 'require_approval');
  assert.equal(evaluatePolicy({ ...pending, approvalState: 'approved' }).decision, 'allow');
  // The next action has its own state. Nothing carries over.
  assert.equal(evaluatePolicy({ ...pending, action: 'another_action' }).decision, 'require_approval');
});

test('approval states other than approved do not allow a waiting action', () => {
  for (const approvalState of ['none', 'pending', 'expired']) {
    assert.equal(
      evaluatePolicy(input({ tier: 'auto', risk: 'critical', approvalState })).decision,
      'require_approval',
      approvalState,
    );
  }
});

test('a rejected approval denies, even where the action would otherwise be allowed', () => {
  assert.equal(evaluatePolicy(input({ tier: 'auto', risk: 'low', approvalState: 'rejected' })).decision, 'deny');
  assert.equal(evaluatePolicy(input({ tier: 'auto', risk: 'high', approvalState: 'rejected' })).decision, 'deny');
});

test('unknown values fail closed', () => {
  const cases = [
    ['tier', input({ tier: 'admin' })],
    ['tier', input({ tier: undefined })],
    ['access', input({ access: 'execute' })],
    ['access', input({ access: undefined })],
    ['risk', input({ risk: 'urgent' })],
    ['category', input({ category: 'refund' })],
    ['approvalState', input({ approvalState: 'maybe' })],
    ['approvalState', input({ approvalState: undefined })],
    ['actor', input({ actor: undefined })],
    ['actor kind', input({ actor: { kind: 'robot', verified: true } })],
    ['actor verified', input({ actor: { kind: 'agent', verified: 'yes' } })],
    ['actor unverified', input({ actor: { kind: 'agent', verified: false } })],
    ['action', input({ action: '' })],
    ['companyPolicy shape', input({ companyPolicy: { deniedTools: 'do_thing' } })],
    ['companyPolicy requireApprovalFor', input({ companyPolicy: { requireApprovalFor: [1] } })],
    ['userPermissions shape', input({ userPermissions: 'do_thing' })],
    ['limits shape', input({ limits: { maxAmountCents: '100', usedAmountCents: 0 } })],
    ['money amount', input({ category: 'money', limits: { maxAmountCents: 100, usedAmountCents: 0 } })],
  ];
  for (const [label, value] of cases) {
    assert.equal(evaluatePolicy(value).decision, 'deny', label);
  }
});

test('an agent claiming the human actor is denied; a human on a non-human tier is denied', () => {
  assert.equal(evaluatePolicy(input({ tier: HUMAN_ACTOR, actor: AGENT, approvalState: 'approved' })).decision, 'deny');
  assert.equal(evaluatePolicy(input({ tier: 'auto', actor: HUMAN })).decision, 'deny');
});

test('limit exceeded denies, even with owner approval', () => {
  const limits = { maxAmountCents: 10000, usedAmountCents: 9000 };
  const over = input({ tier: 'auto', category: 'money', limits, amountCents: 2000 });
  assert.equal(evaluatePolicy({ ...over, approvalState: 'none' }).decision, 'deny');
  assert.equal(evaluatePolicy({ ...over, approvalState: 'approved' }).decision, 'deny');
});

test('money within the limit follows the normal money rule; exactly at the limit is within it', () => {
  const limits = { maxAmountCents: 10000, usedAmountCents: 9000 };
  const exact = input({ tier: 'auto', category: 'money', limits, amountCents: 1000 });
  assert.equal(evaluatePolicy({ ...exact, approvalState: 'none' }).decision, 'require_approval');
  assert.equal(evaluatePolicy({ ...exact, approvalState: 'approved' }).decision, 'allow');
});

test('a ladder deny cannot be turned into allow by company policy, permissions, or approval', () => {
  const permissive = {
    companyPolicy: { requireApprovalFor: [], deniedTools: [] },
    userPermissions: ['do_thing'],
  };
  const cases = [
    input({ tier: 'assist', access: 'read', risk: 'low' }),
    input({ tier: 'assist', access: 'write', risk: 'low' }),
    input({ tier: 'suggest', access: 'write', risk: 'low' }),
    input({ tier: 'suggest', access: 'write', risk: 'critical' }),
  ];
  for (const base of cases) {
    for (const approvalState of ['none', 'approved']) {
      const result = evaluatePolicy({ ...base, ...permissive, approvalState });
      assert.equal(result.decision, 'deny', `${base.tier} ${base.access} ${base.risk} ${approvalState}`);
    }
  }
});

test('company deniedTools denies an action the ladder would allow', () => {
  const result = evaluatePolicy(input({ tier: 'auto', risk: 'low', companyPolicy: { deniedTools: ['do_thing'] }, approvalState: 'approved' }));
  assert.equal(result.decision, 'deny');
});

test('company requireApprovalFor turns a ladder allow into require_approval, and approval allows it once', () => {
  const base = input({ tier: 'auto', risk: 'low', companyPolicy: { requireApprovalFor: ['do_thing'] } });
  assert.equal(evaluatePolicy(base).decision, 'require_approval');
  assert.equal(evaluatePolicy({ ...base, approvalState: 'approved' }).decision, 'allow');
});

test('user permissions: a missing action denies; a granted action passes', () => {
  assert.equal(evaluatePolicy(input({ userPermissions: ['other_action'] })).decision, 'deny');
  assert.equal(evaluatePolicy(input({ userPermissions: new Set(['do_thing']) })).decision, 'allow');
});

// Owner rule: money, customer_send and delete need a verified owner approval whatever the tier, and
// whatever category the caller passed. A listed tool with no category is gated by the owner's list.
const OWNER_LISTED = ['refund_requests.create', 'customer_messages.send', 'client_merge_suggestions.create'];
const OWNER_CATEGORY_OF = { 'refund_requests.create': 'money', 'customer_messages.send': 'customer_send', 'client_merge_suggestions.create': 'delete' };

test('owner rule: a listed tool with no category needs approval at every autonomy tier and risk', () => {
  for (const action of OWNER_LISTED) {
    for (const tier of ['auto', 'predictive', HUMAN_ACTOR]) {
      for (const risk of RISK_TIERS) {
        const actor = tier === HUMAN_ACTOR ? HUMAN : AGENT;
        const base = { tier, risk, action, actor, access: 'write', category: 'none' };
        const unapproved = evaluatePolicy(input({ ...base, approvalState: 'none' }));
        assert.notEqual(unapproved.decision, 'allow', `${action} ${tier} ${risk} must not run unapproved`);
        assert.equal(evaluatePolicy(input({ ...base, approvalState: 'approved' })).decision, 'allow', `${action} ${tier} ${risk} approved`);
        assert.equal(evaluatePolicy(input({ ...base, approvalState: 'rejected' })).decision, 'deny', `${action} ${tier} ${risk} rejected`);
      }
    }
  }
});

test('owner rule: a listed tool keeps its own category when the caller passes none', () => {
  for (const action of OWNER_LISTED) {
    const category = OWNER_CATEGORY_OF[action];
    const bare = evaluatePolicy(input({ tier: 'auto', risk: 'low', action, approvalState: 'none' }));
    const named = evaluatePolicy(input({ tier: 'auto', risk: 'low', action, category, approvalState: 'none' }));
    assert.equal(bare.decision, 'require_approval', action);
    assert.equal(named.decision, 'require_approval', action);
  }
});

test('owner rule: a money-listed tool takes the money path even when the caller names another gated category', () => {
  const limits = { maxAmountCents: 1000, usedAmountCents: 0 };
  const over = evaluatePolicy(input({ tier: 'auto', action: 'refund_requests.create', category: 'customer_send', limits, amountCents: 5000, approvalState: 'approved' }));
  assert.equal(over.decision, 'deny', 'the money limit still applies to a money-listed tool');
});

test('owner rule: an unlisted tool with no category is not gated by the owner list', () => {
  assert.equal(evaluatePolicy(input({ tier: 'auto', risk: 'low', action: 'clients.list', approvalState: 'none' })).decision, 'allow');
});

test('owner rule: a listed tool that a suggest or assist agent asks to write is still refused', () => {
  assert.equal(evaluatePolicy(input({ tier: 'suggest', access: 'write', risk: 'low', action: 'messages.send', approvalState: 'approved' })).decision, 'deny');
  assert.equal(evaluatePolicy(input({ tier: 'assist', access: 'write', risk: 'low', action: 'messages.send', approvalState: 'approved' })).decision, 'deny');
});
