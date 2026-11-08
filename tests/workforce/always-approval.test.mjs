import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

// Static check, no network and no database. Every role file is loaded and its declared tool IDs
// are classified by name into the money, customer_send and delete categories. Each classified
// tool must be on ALWAYS_APPROVAL_ACTIONS, and every list entry must be a declared tool.

const rolesDir = new URL('../../server/workforce/catalogue/roles/', import.meta.url);
const modUrl = new URL('../../server/workforce/runtime/always-approval.ts', import.meta.url);
const { ALWAYS_APPROVAL_ACTIONS, isAlwaysApproval } = await import(modUrl.href);
const modTest = await import(modUrl.href);

// Name classifier for the three gated categories. Matches money movement and money decisions,
// customer-facing sends and requests, and deletes or merges.
const GATED =
  /refund|payment|charge|payout|pay\b|purchase_orders|invoice\.send|\.send$|send_customer|request_from_customer|\.request$|delete|merge|remove|purge/;

// Read-only tools that the name classifier matches. Each entry needs a reason.
const READ_ONLY = new Map([
  ['payments.list', 'read-only list of payments; no money movement'],
  ['refund_requests.list', 'read-only list of refund requests; issues no refund'],
  ['purchase_orders.list', 'read-only list of purchase orders; places no order'],
]);

const files = readdirSync(rolesDir)
  .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
  .sort();

const declared = new Set();
for (const file of files) {
  const mod = await import(new URL(file, rolesDir).href);
  for (const tool of mod.role.tools) declared.add(tool);
}

const gatedTools = [...declared].filter((tool) => GATED.test(tool) && !READ_ONLY.has(tool)).sort();

test('the roles folder yields declared tools to check', () => {
  assert.ok(files.length > 0, 'no role files found');
  assert.ok(gatedTools.length > 0, 'the classifier found no gated tools');
});

test('every money, customer_send and delete tool declared by a role is on the always-approval list', () => {
  const missing = gatedTools.filter((tool) => !ALWAYS_APPROVAL_ACTIONS.includes(tool));
  assert.deepEqual(missing, [], `gated tools missing from ALWAYS_APPROVAL_ACTIONS: ${missing.join(', ')}`);
});

test('every money, customer_send and delete tool gives isAlwaysApproval true', () => {
  for (const tool of gatedTools) {
    assert.equal(isAlwaysApproval(tool), true, `${tool} must need approval`);
  }
});

test('every list entry is a declared tool that matches the gated pattern and is not read-only', () => {
  for (const tool of ALWAYS_APPROVAL_ACTIONS) {
    assert.ok(declared.has(tool), `${tool} is on the list but no role declares it`);
    assert.ok(GATED.test(tool), `${tool} is on the list but does not match the gated pattern`);
    assert.ok(!READ_ONLY.has(tool), `${tool} is read-only and must not be on the list`);
  }
});

test('the list is frozen, has no duplicates, and isAlwaysApproval rejects other input', () => {
  assert.ok(Object.isFrozen(ALWAYS_APPROVAL_ACTIONS), 'list must be frozen');
  assert.equal(new Set(ALWAYS_APPROVAL_ACTIONS).size, ALWAYS_APPROVAL_ACTIONS.length, 'list has duplicates');
  assert.equal(isAlwaysApproval('clients.list'), false);
  assert.equal(isAlwaysApproval('payments.list'), false);
  assert.equal(isAlwaysApproval(undefined), false);
  assert.equal(isAlwaysApproval(null), false);
  assert.equal(isAlwaysApproval(42), false);
});

test('each listed tool maps to exactly one category, and the flat list is the category groups joined', () => {
  const { ALWAYS_APPROVAL_BY_CATEGORY, alwaysApprovalCategoryOf } = modTest;
  const flat = [...ALWAYS_APPROVAL_BY_CATEGORY.money, ...ALWAYS_APPROVAL_BY_CATEGORY.customer_send, ...ALWAYS_APPROVAL_BY_CATEGORY.delete];
  assert.deepEqual([...ALWAYS_APPROVAL_ACTIONS].sort(), flat.slice().sort(), 'flat list must equal the joined groups');
  for (const [category, tools] of Object.entries(ALWAYS_APPROVAL_BY_CATEGORY)) {
    for (const tool of tools) assert.equal(alwaysApprovalCategoryOf(tool), category, `${tool} must map to ${category}`);
  }
});

test('alwaysApprovalCategoryOf returns null for unlisted and non-string input', () => {
  const { alwaysApprovalCategoryOf } = modTest;
  assert.equal(alwaysApprovalCategoryOf('clients.list'), null);
  assert.equal(alwaysApprovalCategoryOf('customer_messages.draft'), null);
  assert.equal(alwaysApprovalCategoryOf(undefined), null);
  assert.equal(alwaysApprovalCategoryOf(7), null);
});
