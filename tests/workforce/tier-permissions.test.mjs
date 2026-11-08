/**
 * Tests for the owner's tier permissions table and its check against the authority ladder.
 * Pure: no network, no database. The ladder is read, never changed.
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/workforce/tier-permissions.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TIER_PERMISSIONS, checkTierMatchesLadder } from '../../server/workforce/runtime/tier-permissions.ts';
import { evaluatePolicy } from '../../server/modules/approvals/policy-evaluator.ts';

const AGENT = { kind: 'agent', verified: true };
const RISKS = ['low', 'medium', 'high', 'critical'];

function policy(tier, risk, extra = {}) {
  return evaluatePolicy({
    tier,
    access: 'write',
    risk,
    action: 'test_action',
    actor: AGENT,
    approvalState: 'none',
    ...extra,
  });
}

test('all four tiers are present, in autonomy order', () => {
  assert.deepEqual(Object.keys(TIER_PERMISSIONS), ['assist', 'suggest', 'auto', 'predictive']);
  for (const tier of Object.keys(TIER_PERMISSIONS)) {
    assert.deepEqual(
      Object.keys(TIER_PERMISSIONS[tier]).sort(),
      ['canDelete', 'canMoveMoney', 'canReadData', 'canRunTools', 'canSend', 'canWrite', 'runsUnattended'],
      `${tier} has every field`,
    );
  }
});

test('assist runs no tools and does nothing unattended', () => {
  assert.deepEqual(TIER_PERMISSIONS.assist, {
    canRunTools: false,
    canReadData: false,
    canWrite: false,
    canSend: false,
    canMoveMoney: false,
    canDelete: false,
    runsUnattended: false,
  });
});

test('suggest reads and watches, but never writes, sends, moves money or deletes', () => {
  const s = TIER_PERMISSIONS.suggest;
  assert.equal(s.canRunTools, true);
  assert.equal(s.canReadData, true);
  assert.equal(s.runsUnattended, true);
  assert.equal(s.canWrite, false);
  assert.equal(s.canSend, false);
  assert.equal(s.canMoveMoney, false);
  assert.equal(s.canDelete, false);
});

test('auto and predictive run unattended and may write, with sensitive actions gated by approval', () => {
  for (const tier of ['auto', 'predictive']) {
    const p = TIER_PERMISSIONS[tier];
    assert.equal(p.canRunTools, true, `${tier} runs tools`);
    assert.equal(p.canReadData, true, `${tier} reads data`);
    assert.equal(p.canWrite, true, `${tier} writes`);
    assert.equal(p.runsUnattended, true, `${tier} runs unattended`);
    // Money, customer sends and deletes are capabilities that always need approval.
    for (const category of ['money', 'customer_send', 'delete']) {
      for (const risk of RISKS) {
        const unapproved = policy(tier, risk, { category });
        assert.equal(unapproved.decision, 'require_approval', `${tier} ${category} at ${risk} needs approval`);
        const approved = policy(tier, risk, { category, approvalState: 'approved' });
        assert.notEqual(approved.decision, 'deny', `${tier} ${category} at ${risk} is not refused once approved`);
      }
    }
  }
});

test('suggest is refused any write, send, money or delete action', () => {
  for (const category of ['none', 'money', 'customer_send', 'delete']) {
    for (const risk of RISKS) {
      const r = policy('suggest', risk, { category, access: 'write' });
      assert.equal(r.decision, 'deny', `suggest ${category} write at ${risk} is denied`);
    }
  }
});

test('checkTierMatchesLadder: the real ladder agrees with the owner table at every tier and risk level', () => {
  const disagreements = checkTierMatchesLadder();
  const detail = disagreements
    .map((d) => `${d.tier}/${d.risk}/${d.access}: owner table implies ${d.expected}, ladder returns ${d.actual} (${d.ladderReason})`)
    .join('; ');
  assert.deepEqual(disagreements, [], `ladder disagrees with owner table: ${detail}`);
});

test('checkTierMatchesLadder reports a disagreement by tier, risk and access', () => {
  // Synthetic table: predictive is said to be unable to write. The real ladder still allows low and medium writes.
  const table = {
    ...TIER_PERMISSIONS,
    predictive: { ...TIER_PERMISSIONS.predictive, canWrite: false },
  };
  const disagreements = checkTierMatchesLadder(table);
  const hit = disagreements.find((d) => d.tier === 'predictive' && d.risk === 'low' && d.access === 'write');
  assert.ok(hit, 'predictive low-risk write is reported');
  assert.equal(hit.expected, 'deny');
  assert.equal(hit.actual, 'allow');
  assert.deepEqual(
    disagreements.filter((d) => d.tier === 'predictive').map((d) => `${d.risk}/${d.access}`).sort(),
    ['critical/write', 'high/write', 'low/write', 'medium/write'],
    'only the changed predictive write cells are reported',
  );
  assert.deepEqual(
    checkTierMatchesLadder(TIER_PERMISSIONS).filter((d) => d.tier === 'assist'),
    [],
    'assist agrees with the ladder',
  );
});
