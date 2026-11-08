import test from 'node:test';
import assert from 'node:assert/strict';
import {
  companyPolicySchema,
  parseCompanyPolicy,
  mergeWithOwnerRules,
} from '../../server/modules/approvals/company-policy.ts';

// Pure tests. No database, no Express, no environment reads.

const OWNER = ['money', 'customer_send', 'delete'];

test('a valid company policy parses and keeps its values', () => {
  const result = parseCompanyPolicy({
    requireApprovalFor: ['money', 'invoices.send'],
    deniedTools: ['payouts.create'],
    maxAmountCents: 50000,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.policy, {
    requireApprovalFor: ['money', 'invoices.send'],
    deniedTools: ['payouts.create'],
    maxAmountCents: 50000,
  });
});

test('a policy without maxAmountCents parses', () => {
  const result = parseCompanyPolicy({ requireApprovalFor: [], deniedTools: [] });
  assert.equal(result.ok, true);
  assert.equal('maxAmountCents' in result.policy, false);
});

test('an unknown key is rejected', () => {
  const result = parseCompanyPolicy({ requireApprovalFor: [], deniedTools: [], allowAll: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /failing closed/);
});

test('a non-object input is rejected', () => {
  assert.equal(parseCompanyPolicy(null).ok, false);
  assert.equal(parseCompanyPolicy('money').ok, false);
  assert.equal(companyPolicySchema.safeParse([]).success, false);
});

test('an empty deniedTools entry is refused', () => {
  assert.equal(parseCompanyPolicy({ requireApprovalFor: [], deniedTools: [''] }).ok, false);
  assert.equal(parseCompanyPolicy({ requireApprovalFor: [], deniedTools: ['   '] }).ok, false);
});

test('a deniedTools entry longer than 200 characters is refused', () => {
  const oversize = 'x'.repeat(201);
  const result = parseCompanyPolicy({ requireApprovalFor: [], deniedTools: [oversize] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /longer than 200/);
});

test('a deniedTools entry of exactly 200 characters is accepted', () => {
  const result = parseCompanyPolicy({ requireApprovalFor: [], deniedTools: ['x'.repeat(200)] });
  assert.equal(result.ok, true);
});

test('an oversize requireApprovalFor entry is refused', () => {
  const result = parseCompanyPolicy({ requireApprovalFor: ['x'.repeat(201)], deniedTools: [] });
  assert.equal(result.ok, false);
});

test('maxAmountCents must be a positive integer', () => {
  for (const bad of [0, -1, 1.5, '100', null, Number.NaN]) {
    const result = parseCompanyPolicy({ requireApprovalFor: [], deniedTools: [], maxAmountCents: bad });
    assert.equal(result.ok, false, `maxAmountCents ${String(bad)} should be refused`);
  }
  assert.equal(parseCompanyPolicy({ requireApprovalFor: [], deniedTools: [], maxAmountCents: 1 }).ok, true);
});

test('the owner three are always present after merge', () => {
  const merged = mergeWithOwnerRules({ requireApprovalFor: [], deniedTools: [] });
  assert.equal(merged.ok, true);
  for (const rule of OWNER) assert.ok(merged.requireApprovalFor.includes(rule), `missing ${rule}`);
  assert.deepEqual(merged.requireApprovalFor.slice(0, 3), OWNER);
});

test('a company can add rules but the owner three stay present with no duplicates', () => {
  const merged = mergeWithOwnerRules({
    requireApprovalFor: ['money', 'invoices.send', 'invoices.send', 'delete'],
    deniedTools: ['payouts.create', 'payouts.create'],
  });
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.requireApprovalFor, ['money', 'customer_send', 'delete', 'invoices.send']);
  assert.deepEqual(merged.deniedTools, ['payouts.create']);
  assert.deepEqual(merged.corrections, [
    "restored owner approval rule 'customer_send' that the company policy omitted",
  ]);
});

test('a removal attempt is corrected and listed', () => {
  const merged = mergeWithOwnerRules({ requireApprovalFor: ['invoices.send'], deniedTools: [] });
  assert.equal(merged.ok, true);
  for (const rule of OWNER) assert.ok(merged.requireApprovalFor.includes(rule));
  assert.equal(merged.corrections.length, 3);
  for (const rule of OWNER) {
    assert.ok(merged.corrections.some((line) => line.includes(`'${rule}'`)), `no correction for ${rule}`);
  }
});

test('no corrections are listed when the company already keeps the owner rules', () => {
  const merged = mergeWithOwnerRules({ requireApprovalFor: [...OWNER], deniedTools: [] });
  assert.deepEqual(merged.corrections, []);
});

test('maxAmountCents passes through merge, and is absent when not given', () => {
  assert.equal(mergeWithOwnerRules({ requireApprovalFor: [], deniedTools: [], maxAmountCents: 900 }).maxAmountCents, 900);
  assert.equal('maxAmountCents' in mergeWithOwnerRules({ requireApprovalFor: [], deniedTools: [] }), false);
});

test('an invalid input does not merge', () => {
  const merged = mergeWithOwnerRules({ requireApprovalFor: [], deniedTools: [''] });
  assert.equal(merged.ok, false);
  assert.equal(mergeWithOwnerRules(undefined).ok, false);
});
