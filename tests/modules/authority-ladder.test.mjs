import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LADDER,
  RISK_TIERS,
  AUTONOMY_LEVELS,
  HUMAN_ACTOR,
  evaluateAuthority,
} from '../../server/modules/approvals/authority-ladder.ts';
import {
  MIN_APPROVAL_SECRET_LENGTH,
  assertApprovalSecret,
  hashAction,
  signApprovalDecision,
  verifyApprovalDecision,
} from '../../server/modules/approvals/approval-signing.ts';

// Pure tests. No database, no Express, no environment reads.

const SECRET = 'q7Lr2XvN9bKs4TzW1mHc8PyE6dJf3GaU0oIt5RlB'; // 40 chars, not a placeholder
const OTHER_SECRET = 'Zx4Vb8Nm2Qw6Er0Ty3Ui7Op1As5Df9Gh2Jk4Lz';

// Expected outcome for each (autonomy, tier) cell, written out by hand so the
// test does not just echo the table back. Key: autonomy|tier.
const EXPECTED = {
  'assist|low': 'deny',
  'assist|medium': 'deny',
  'assist|high': 'deny',
  'assist|critical': 'deny',
  'suggest|low': 'deny',
  'suggest|medium': 'deny',
  'suggest|high': 'deny',
  'suggest|critical': 'deny',
  'auto|low': 'allow',
  'auto|medium': 'allow',
  'auto|high': 'approval',
  'auto|critical': 'approval',
  'predictive|low': 'allow',
  'predictive|medium': 'allow',
  'predictive|high': 'approval',
  'predictive|critical': 'approval',
};

test('ladder table has exactly one row per autonomy level and tier', () => {
  assert.equal(LADDER.length, AUTONOMY_LEVELS.length * RISK_TIERS.length);
  const keys = new Set(LADDER.map((row) => `${row.autonomy}|${row.tier}`));
  assert.equal(keys.size, LADDER.length, 'duplicate ladder rows');
  for (const level of AUTONOMY_LEVELS) {
    for (const tier of RISK_TIERS) {
      assert.ok(keys.has(`${level}|${tier}`), `missing row ${level}|${tier}`);
    }
  }
});

test('every ladder row has a non-empty reason', () => {
  for (const row of LADDER) {
    assert.ok(row.reason.length > 0, `${row.autonomy}|${row.tier} has no reason`);
  }
});

for (const level of AUTONOMY_LEVELS) {
  for (const tier of RISK_TIERS) {
    const key = `${level}|${tier}`;
    test(`ladder row ${key} decides as expected`, () => {
      const cell = EXPECTED[key];
      assert.ok(cell, `no expectation written for ${key}`);

      const unapproved = evaluateAuthority({ tier, autonomy: level, humanApproved: false });
      const approved = evaluateAuthority({ tier, autonomy: level, humanApproved: true });

      if (cell === 'allow') {
        assert.equal(unapproved.decision, 'allow');
        assert.equal(approved.decision, 'allow');
      } else if (cell === 'approval') {
        assert.equal(unapproved.decision, 'require_approval');
        assert.equal(approved.decision, 'allow');
      } else if (cell === 'deny') {
        assert.equal(unapproved.decision, 'deny');
        assert.equal(approved.decision, 'deny', 'approval must not override a deny cell');
      }

      for (const result of [unapproved, approved]) {
        assert.ok(result.reason.length > 0);
        assert.equal(result.tier, tier);
        assert.equal(result.autonomy, level);
      }
    });
  }
}

test('unknown risk tier fails closed for every autonomy level', () => {
  for (const level of AUTONOMY_LEVELS) {
    for (const tier of ['urgent', 'LOW', '', undefined, null, 3, { tier: 'low' }]) {
      const result = evaluateAuthority({ tier, autonomy: level, humanApproved: true, actorIsHuman: true });
      assert.equal(result.decision, 'deny', `tier ${String(tier)} under ${level}`);
      assert.equal(result.tier, null);
    }
  }
});

test('unknown autonomy level fails closed', () => {
  for (const autonomy of ['admin', 'OBSERVE_ONLY', '', undefined, null, 1]) {
    const result = evaluateAuthority({ tier: 'low', autonomy, humanApproved: true, actorIsHuman: true });
    assert.equal(result.decision, 'deny', `autonomy ${String(autonomy)}`);
    assert.equal(result.autonomy, null);
  }
});

test('non-boolean approval flags do not count as approval', () => {
  for (const humanApproved of ['true', 1, 'yes', {}, [], null, undefined]) {
    const result = evaluateAuthority({ tier: 'high', autonomy: 'auto', humanApproved });
    assert.equal(result.decision, 'require_approval', `humanApproved ${JSON.stringify(humanApproved)}`);
  }
});

test('the human actor is an actor, not a tier: a verified human runs low to high and waits for approval at critical', () => {
  for (const tier of ['low', 'medium', 'high']) {
    assert.equal(evaluateAuthority({ tier, autonomy: HUMAN_ACTOR, actorIsHuman: true }).decision, 'allow', tier);
  }
  const waiting = evaluateAuthority({ tier: 'critical', autonomy: HUMAN_ACTOR, actorIsHuman: true });
  assert.equal(waiting.decision, 'require_approval');
  assert.equal(evaluateAuthority({ tier: 'critical', autonomy: HUMAN_ACTOR, actorIsHuman: true, humanApproved: true }).decision, 'allow');
  assert.equal(waiting.autonomy, HUMAN_ACTOR);
});

test('an agent cannot claim the human actor at any tier', () => {
  for (const tier of RISK_TIERS) {
    const result = evaluateAuthority({ tier, autonomy: HUMAN_ACTOR, actorIsHuman: false, humanApproved: true });
    assert.equal(result.decision, 'deny', tier);
    assert.equal(result.autonomy, null);
  }
});

test('no critical action runs without owner approval, for any autonomy tier or actor', () => {
  for (const autonomy of [...AUTONOMY_LEVELS, HUMAN_ACTOR]) {
    for (const actorIsHuman of [false, true]) {
      const result = evaluateAuthority({ tier: 'critical', autonomy, actorIsHuman, humanApproved: false });
      assert.notEqual(result.decision, 'allow', `${autonomy} actorIsHuman=${actorIsHuman}`);
    }
  }
});

test('suggest + read at every risk tier is allowed without approval', () => {
  for (const tier of RISK_TIERS) {
    const result = evaluateAuthority({ tier, autonomy: 'suggest', access: 'read', humanApproved: false });
    assert.equal(result.decision, 'allow', tier);
    assert.equal(result.autonomy, 'suggest');
    assert.equal(evaluateAuthority({ tier, autonomy: 'suggest', access: 'read', humanApproved: true }).decision, 'allow', tier);
  }
});

test('suggest + write is denied at every risk tier, even with approval', () => {
  for (const tier of RISK_TIERS) {
    for (const access of ['write', undefined]) {
      assert.equal(evaluateAuthority({ tier, autonomy: 'suggest', access, humanApproved: false }).decision, 'deny', `${tier} access ${String(access)}`);
      assert.equal(evaluateAuthority({ tier, autonomy: 'suggest', access, humanApproved: true }).decision, 'deny', `${tier} approved access ${String(access)}`);
    }
  }
});

test('assist + read is denied at every risk tier', () => {
  for (const tier of RISK_TIERS) {
    assert.equal(evaluateAuthority({ tier, autonomy: 'assist', access: 'read', humanApproved: true }).decision, 'deny', tier);
  }
});

test('an unknown or malformed access value is denied for every autonomy tier and risk tier', () => {
  for (const autonomy of [...AUTONOMY_LEVELS, HUMAN_ACTOR]) {
    for (const tier of RISK_TIERS) {
      for (const access of ['execute', 'READ', '', 'Write', null, 1, {}]) {
        const actorIsHuman = autonomy === HUMAN_ACTOR;
        const result = evaluateAuthority({ tier, autonomy, access, humanApproved: true, actorIsHuman });
        assert.equal(result.decision, 'deny', `${autonomy}|${tier} access ${JSON.stringify(access)}`);
      }
    }
  }
});

test('access does not change auto or predictive: a read tool runs under the same cells as before', () => {
  for (const autonomy of ['auto', 'predictive']) {
    assert.equal(evaluateAuthority({ tier: 'low', autonomy, access: 'read' }).decision, 'allow', autonomy);
    assert.equal(evaluateAuthority({ tier: 'high', autonomy, access: 'read' }).decision, 'require_approval', autonomy);
  }
});

test('evaluateAuthority never throws on missing input', () => {
  assert.equal(evaluateAuthority({}).decision, 'deny');
  assert.equal(evaluateAuthority({ tier: null, autonomy: null }).decision, 'deny');
});

test('signing round-trip verifies with the same fields and secret', () => {
  const fields = fieldsFixture();
  const signature = signApprovalDecision(fields, SECRET);
  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.equal(verifyApprovalDecision(fields, signature, SECRET), true);
});

test('a Date and its ISO string sign the same timestamp', () => {
  const when = new Date('2026-11-02T10:00:00.000Z');
  const asDate = signApprovalDecision({ ...fieldsFixture(), decidedAt: when }, SECRET);
  const asString = signApprovalDecision({ ...fieldsFixture(), decidedAt: '2026-11-02T10:00:00Z' }, SECRET);
  assert.equal(asDate, asString);
});

test('tampered decision fails verification', () => {
  const fields = fieldsFixture();
  const signature = signApprovalDecision(fields, SECRET);
  const tampered = [
    { ...fields, approvalId: 'approval-2' },
    { ...fields, actionHash: hashAction('issue_refund', { amount: 9999 }) },
    { ...fields, deciderId: 'dashboard:someone-else' },
    { ...fields, decidedAt: '2026-11-02T10:00:01Z' },
  ];
  for (const candidate of tampered) {
    assert.equal(verifyApprovalDecision(candidate, signature, SECRET), false);
  }
});

test('wrong secret fails verification', () => {
  const fields = fieldsFixture();
  const signature = signApprovalDecision(fields, SECRET);
  assert.equal(verifyApprovalDecision(fields, signature, OTHER_SECRET), false);
});

test('malformed signatures fail verification without throwing', () => {
  const fields = fieldsFixture();
  const signature = signApprovalDecision(fields, SECRET);
  for (const bad of ['', 'abc', signature.toUpperCase(), signature.slice(0, 62), `${signature}00`, 'zz'.repeat(32), null, undefined, 42]) {
    assert.equal(verifyApprovalDecision(fields, bad, SECRET), false, `signature ${String(bad)}`);
  }
});

test('malformed decision fields are refused', () => {
  const fields = fieldsFixture();
  assert.throws(() => signApprovalDecision({ ...fields, approvalId: '' }, SECRET), TypeError);
  assert.throws(() => signApprovalDecision({ ...fields, actionHash: 'not-a-hash' }, SECRET), TypeError);
  assert.throws(() => signApprovalDecision({ ...fields, decidedAt: 'not a date' }, SECRET), TypeError);
  assert.equal(verifyApprovalDecision({ ...fields, deciderId: '' }, signApprovalDecision(fields, SECRET), SECRET), false);
});

test('hashAction ignores object key order and changes with parameters', () => {
  const a = hashAction('issue_refund', { amount: 40, customer: { id: 'c1', tier: 'gold' } });
  const b = hashAction('issue_refund', { customer: { tier: 'gold', id: 'c1' }, amount: 40 });
  assert.equal(a, b);
  assert.notEqual(a, hashAction('issue_refund', { amount: 41, customer: { id: 'c1', tier: 'gold' } }));
  assert.notEqual(a, hashAction('send_refund', { amount: 40, customer: { id: 'c1', tier: 'gold' } }));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('hashAction refuses values that have no stable JSON form', () => {
  assert.throws(() => hashAction('x', { n: Number.NaN }), TypeError);
  assert.throws(() => hashAction('x', { list: [undefined] }), TypeError);
  assert.throws(() => hashAction('x', { fn: () => 1 }), TypeError);
  assert.throws(() => hashAction('', {}), TypeError);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => hashAction('x', cyclic), TypeError);
});

test('secret of exactly the minimum length is accepted', () => {
  assert.equal(MIN_APPROVAL_SECRET_LENGTH, 32);
  const secret = SECRET.slice(0, 32);
  assert.equal(assertApprovalSecret(secret), secret);
});

test('short secret is refused for signing and verification', () => {
  const short = SECRET.slice(0, 31);
  const fields = fieldsFixture();
  assert.throws(() => signApprovalDecision(fields, short), /at least 32 characters/);
  assert.throws(() => verifyApprovalDecision(fields, 'a'.repeat(64), short), /at least 32 characters/);
});

test('placeholder secrets are refused, including the engine fallbacks', () => {
  const placeholders = [
    'interaction-policy-eval-secret-2026', // exact fixture secret from the engine repository
    'change-me-change-me-change-me-change-me', // padded to length, matches the pattern
    'your-secret-key-goes-here-1234567890', // matches the your-secret pattern
    'THIS-IS-AN-EXAMPLE-SECRET-VALUE-0001', // matches the example pattern
  ];
  const fields = fieldsFixture();
  for (const placeholder of placeholders) {
    assert.ok(placeholder.length >= MIN_APPROVAL_SECRET_LENGTH, `${placeholder} should pass the length check`);
    assert.throws(() => signApprovalDecision(fields, placeholder), /placeholder/);
    assert.throws(() => verifyApprovalDecision(fields, 'a'.repeat(64), placeholder), /placeholder/);
  }
});

test('low-entropy secrets are refused', () => {
  assert.throws(() => assertApprovalSecret('a'.repeat(40)), /distinct characters/);
  assert.throws(() => assertApprovalSecret('ab'.repeat(20)), /distinct characters/);
});

test('non-string secrets are refused', () => {
  for (const bad of [undefined, null, 12345, Buffer.from(SECRET)]) {
    assert.throws(() => assertApprovalSecret(bad), /must be a string/);
  }
});

test('refusal errors never include the secret', () => {
  const placeholder = 'interaction-policy-eval-secret-2026';
  try {
    signApprovalDecision(fieldsFixture(), placeholder);
    assert.fail('expected refusal');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(placeholder), false);
  }
  const short = 'short-secret';
  try {
    assertApprovalSecret(short);
    assert.fail('expected refusal');
  } catch (error) {
    assert.equal(error.message.includes(short), false);
  }
});

function fieldsFixture() {
  return {
    approvalId: 'approval-1',
    actionHash: hashAction('issue_refund', { amount: 40 }),
    deciderId: 'dashboard:user-42',
    decidedAt: '2026-11-02T10:00:00Z',
  };
}
