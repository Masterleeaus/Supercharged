import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePolicy,
  PREDICTIVE_PERMISSIONS,
  predictivePermissionFor,
  CATEGORIES,
} from '../../server/modules/approvals/policy-evaluator.ts';
import { RISK_TIERS } from '../../server/modules/approvals/authority-ladder.ts';

// Pure tests. No database, no Express, no environment reads.

const AGENT = { kind: 'agent', verified: true };
const APPROVAL_STATES = ['none', 'pending', 'approved', 'rejected', 'expired'];

function input(overrides = {}) {
  return {
    tier: 'predictive',
    access: 'write',
    risk: 'low',
    action: 'do_thing',
    actor: AGENT,
    category: 'none',
    approvalState: 'none',
    ...overrides,
  };
}

// Representative input for each permission, at low risk unless the permission says otherwise.
const REPRESENTATIVE = {
  read: { access: 'read', risk: 'low', category: 'none' },
  prepare: { access: 'write', risk: 'low', category: 'none' },
  // draft and schedule arrive as the same low or medium write with no category (see the constant's comment).
  draft: { access: 'write', risk: 'medium', category: 'none' },
  schedule: { access: 'write', risk: 'low', category: 'none' },
  send: { access: 'write', risk: 'low', category: 'customer_send' },
  money: { access: 'write', risk: 'low', category: 'money' },
  delete: { access: 'write', risk: 'low', category: 'delete' },
  write_high_risk: { access: 'write', risk: 'high', category: 'none' },
};

test('PREDICTIVE_PERMISSIONS lists the exact allowed and approval-required sets', () => {
  assert.deepEqual([...PREDICTIVE_PERMISSIONS.allowed], ['read', 'prepare', 'draft', 'schedule']);
  assert.deepEqual([...PREDICTIVE_PERMISSIONS.approvalRequired], ['send', 'money', 'delete', 'write_high_risk']);
});

test('no permission appears in both lists', () => {
  for (const p of PREDICTIVE_PERMISSIONS.allowed) {
    assert.equal(PREDICTIVE_PERMISSIONS.approvalRequired.includes(p), false, p);
  }
});

for (const permission of PREDICTIVE_PERMISSIONS.allowed) {
  test(`predictive permission ${permission} is allowed without approval`, () => {
    const r = evaluatePolicy(input(REPRESENTATIVE[permission]));
    assert.equal(r.decision, 'allow', r.reason);
  });
}

for (const permission of PREDICTIVE_PERMISSIONS.approvalRequired) {
  test(`predictive permission ${permission} needs owner approval`, () => {
    const base = REPRESENTATIVE[permission];
    const unapproved = evaluatePolicy(input({ ...base, approvalState: 'none' }));
    assert.equal(unapproved.decision, 'require_approval', unapproved.reason);
    for (const state of ['pending', 'expired']) {
      assert.equal(evaluatePolicy(input({ ...base, approvalState: state })).decision, 'require_approval', state);
    }
    const approved = evaluatePolicy(input({ ...base, approvalState: 'approved' }));
    assert.equal(approved.decision, 'allow', approved.reason);
    assert.equal(evaluatePolicy(input({ ...base, approvalState: 'rejected' })).decision, 'deny');
  });
}

test('predictive money approval still respects the money limit', () => {
  const base = { ...REPRESENTATIVE.money, limits: { maxAmountCents: 100, usedAmountCents: 0 }, amountCents: 500 };
  assert.equal(evaluatePolicy(input({ ...base, approvalState: 'approved' })).decision, 'deny');
});

test('predictivePermissionFor classifies by category first, then access, then risk', () => {
  assert.equal(predictivePermissionFor('money', 'read', 'low'), 'money');
  assert.equal(predictivePermissionFor('customer_send', 'write', 'low'), 'send');
  assert.equal(predictivePermissionFor('delete', 'write', 'medium'), 'delete');
  assert.equal(predictivePermissionFor('none', 'read', 'critical'), 'read');
  assert.equal(predictivePermissionFor('none', 'write', 'high'), 'write_high_risk');
  assert.equal(predictivePermissionFor('none', 'write', 'critical'), 'write_high_risk');
  assert.equal(predictivePermissionFor('none', 'write', 'low'), 'prepare');
  assert.equal(predictivePermissionFor('none', 'write', 'medium'), 'prepare');
});

// Predictive's risk cells are the same as auto's. For every input, the decision must match auto.
test('predictive decision matches auto decision for every input', () => {
  for (const access of ['read', 'write']) {
    for (const risk of RISK_TIERS) {
      for (const category of CATEGORIES) {
        for (const approvalState of APPROVAL_STATES) {
          const common = { access, risk, category, approvalState };
          const auto = evaluatePolicy(input({ ...common, tier: 'auto' })).decision;
          const predictive = evaluatePolicy(input({ ...common, tier: 'predictive' })).decision;
          assert.equal(predictive, auto, JSON.stringify(common));
        }
      }
    }
  }
});

// Auto behaviour, written out by hand. Auto has no predictive rule, so these must not move.
function expectedAuto({ access, risk, category, approvalState }) {
  if (approvalState === 'rejected') return 'deny';
  if (approvalState === 'approved') return 'allow';
  const ladderAllows = risk === 'low' || risk === 'medium';
  const gated = category === 'money' || category === 'customer_send' || category === 'delete';
  void access; // Auto uses the same cells for read and write.
  return ladderAllows && !gated ? 'allow' : 'require_approval';
}

test('auto results are unchanged across the full input grid', () => {
  for (const access of ['read', 'write']) {
    for (const risk of RISK_TIERS) {
      for (const category of CATEGORIES) {
        for (const approvalState of APPROVAL_STATES) {
          const common = { access, risk, category, approvalState };
          const r = evaluatePolicy(input({ ...common, tier: 'auto' }));
          assert.equal(r.decision, expectedAuto(common), JSON.stringify(common) + ' ' + r.reason);
        }
      }
    }
  }
});

test('auto write at high risk with no category still needs approval, not predictive wording', () => {
  const r = evaluatePolicy(input({ tier: 'auto', risk: 'high', access: 'write', category: 'none' }));
  assert.equal(r.decision, 'require_approval');
  assert.equal(r.reason, 'high-risk action needs a verified owner approval');
});
