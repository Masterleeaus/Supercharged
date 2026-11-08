/**
 * Pure tests for the company controls document (parseCompanyControls, defaultControlsDocument,
 * describeControlChanges) in server/modules/approvals/company-policy.ts.
 * No database, no Express, no network.
 * Run: node --test --experimental-transform-types tests/modules/company-controls-policy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCompanyControls,
  defaultControlsDocument,
  describeControlChanges,
  MAX_BUDGET_VALUE,
} from '../../server/modules/approvals/company-policy.ts';

// Silence the module's output. The test runner's IPC breaks on stray stdout.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const CAPS = new Map([
  ['estimator', 'suggest'],
  ['dispatcher', 'auto'],
  ['bookkeeper', 'assist'],
]);

const BUDGETS = {
  maxToolCallsPerRun: 50,
  maxTokensPerRun: 200000,
  maxSpendCentsPerRun: 500,
  maxRunsPerCompanyPerDay: 100,
  maxSpendCentsPerCompanyPerDay: 10000,
};

function validDoc(overrides = {}) {
  return {
    roles: {
      estimator: { enabled: true, tier: 'suggest' },
      dispatcher: { enabled: true, tier: 'assist' },
      bookkeeper: { enabled: false, tier: 'assist' },
    },
    policy: { requireApprovalFor: ['money', 'customer_send', 'delete'], deniedTools: ['payouts.create'] },
    budgets: { ...BUDGETS },
    ...overrides,
  };
}

test('a complete document within every role cap is accepted', () => {
  const result = parseCompanyControls(validDoc(), CAPS);
  assert.equal(result.ok, true);
  assert.equal(result.controls.roles.dispatcher.tier, 'assist');
  assert.deepEqual(result.controls.budgets, BUDGETS);
});

test('a tier above the role cap is refused, including the cap itself being exceeded by one step', () => {
  const doc = validDoc();
  doc.roles.estimator.tier = 'auto';
  const result = parseCompanyControls(doc, CAPS);
  assert.equal(result.ok, false);
  assert.match(result.reason, /roles\.estimator\.tier/);
});

test('a tier equal to the role cap is accepted', () => {
  const doc = validDoc();
  doc.roles.dispatcher.tier = 'auto';
  assert.equal(parseCompanyControls(doc, CAPS).ok, true);
});

test('an unknown tier name is refused', () => {
  const doc = validDoc();
  doc.roles.dispatcher.tier = 'observe_only';
  assert.equal(parseCompanyControls(doc, CAPS).ok, false);
});

test('a role missing from the document is refused, not assumed', () => {
  const doc = validDoc();
  delete doc.roles.bookkeeper;
  const result = parseCompanyControls(doc, CAPS);
  assert.equal(result.ok, false);
  assert.match(result.reason, /roles\.bookkeeper: missing/);
});

test('an unknown role id is refused and the reason does not echo it', () => {
  const doc = validDoc();
  doc.roles['<script>x'] = { enabled: true, tier: 'assist' };
  const result = parseCompanyControls(doc, CAPS);
  assert.equal(result.ok, false);
  assert.equal(result.reason.includes('<script>'), false);
});

test('every owner approval rule must stay in requireApprovalFor', () => {
  for (const rule of ['money', 'customer_send', 'delete']) {
    const doc = validDoc();
    doc.policy.requireApprovalFor = ['money', 'customer_send', 'delete'].filter((r) => r !== rule);
    const result = parseCompanyControls(doc, CAPS);
    assert.equal(result.ok, false, `removing ${rule} must be refused`);
    assert.match(result.reason, new RegExp(`owner rule '${rule}'`));
  }
});

test('the company may add approval rules on top of the owner rules', () => {
  const doc = validDoc();
  doc.policy.requireApprovalFor = ['money', 'customer_send', 'delete', 'invoices.send'];
  assert.equal(parseCompanyControls(doc, CAPS).ok, true);
});

test('a budget that is missing, zero, negative, fractional or above the ceiling is refused', () => {
  const bad = [
    undefined,
    0,
    -1,
    1.5,
    MAX_BUDGET_VALUE + 1,
    '50',
    null,
  ];
  for (const value of bad) {
    const doc = validDoc();
    if (value === undefined) delete doc.budgets.maxTokensPerRun;
    else doc.budgets.maxTokensPerRun = value;
    assert.equal(parseCompanyControls(doc, CAPS).ok, false, `budget value ${String(value)} must be refused`);
  }
});

test('a budget at the ceiling is accepted', () => {
  const doc = validDoc();
  doc.budgets.maxSpendCentsPerRun = MAX_BUDGET_VALUE;
  assert.equal(parseCompanyControls(doc, CAPS).ok, true);
});

test('unknown keys at any level are refused', () => {
  const top = validDoc({ companyId: '22222222-2222-4222-8222-222222222222' });
  assert.equal(parseCompanyControls(top, CAPS).ok, false);

  const inRole = validDoc();
  inRole.roles.estimator.extra = true;
  assert.equal(parseCompanyControls(inRole, CAPS).ok, false);

  const inBudgets = validDoc();
  inBudgets.budgets.maxWhatever = 5;
  assert.equal(parseCompanyControls(inBudgets, CAPS).ok, false);

  const inPolicy = validDoc();
  inPolicy.policy.ownerOverride = true;
  assert.equal(parseCompanyControls(inPolicy, CAPS).ok, false);
});

test('non-object inputs are refused', () => {
  for (const input of [null, undefined, "x", 42, []]) {
    assert.equal(parseCompanyControls(input, CAPS).ok, false);
  }
});

test('the default document disables every role at the lowest tier and sets no budgets', () => {
  const doc = defaultControlsDocument(CAPS);
  assert.deepEqual(Object.keys(doc.roles).sort(), ['bookkeeper', 'dispatcher', 'estimator']);
  for (const role of Object.values(doc.roles)) assert.deepEqual(role, { enabled: false, tier: 'assist' });
  assert.deepEqual(doc.policy.requireApprovalFor, ['money', 'customer_send', 'delete']);
  assert.equal(doc.budgets, null);
});

test('describeControlChanges lists only what changed', () => {
  const before = { ...defaultControlsDocument(CAPS), budgets: null };
  const after = parseCompanyControls(validDoc(), CAPS).controls;
  const changes = describeControlChanges(before, after);
  assert.ok(changes.includes('role estimator: disabled -> enabled'));
  assert.ok(changes.includes('role dispatcher: disabled -> enabled'));
  assert.ok(changes.includes('tool denied: payouts.create'));
  assert.ok(changes.includes('budget maxSpendCentsPerRun: unset -> 500'));
  assert.equal(changes.some((c) => c.includes('bookkeeper')), false);
});

test('describeControlChanges is empty for identical documents', () => {
  const doc = parseCompanyControls(validDoc(), CAPS).controls;
  assert.deepEqual(describeControlChanges(doc, doc), []);
});
