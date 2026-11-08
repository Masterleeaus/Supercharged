/**
 * Checklist item (supercharged-fixes-checklist, Auto/Suggest tiers): every read tool must declare access 'read', so the
 * Suggest tier can read it. Absent or unknown access counts as write (fail closed). This test checks the TOOL_ACCESS
 * catalogue and the bound read tool definitions, and pins the four tools still to be reviewed.
 * Run: node --test --experimental-transform-types tests/workforce/tool-read-access-classified.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence console output so the test runner's IPC is not broken by server imports.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const { TOOL_ACCESS } = await import('../../server/workforce/catalogue/tool-access.ts');
const { createReadToolDefinitions } = await import('../../server/workforce/tools/read-handlers.ts');
const { GROUP01_TOOL_IDS } = await import('../../server/workforce/tools/handlers/group-01.ts');

const READ_VERBS = new Set(['list', 'get', 'search', 'view', 'lookup', 'check', 'read', 'availability', 'status']);

const verbOf = (toolId) => toolId.split('.').pop();

test('every read-named tool in TOOL_ACCESS is classified read', () => {
  const misclassified = Object.entries(TOOL_ACCESS)
    .filter(([toolId, access]) => READ_VERBS.has(verbOf(toolId)) && access !== 'read')
    .map(([toolId, access]) => `${toolId}=${access}`);
  assert.deepEqual(misclassified, [], `read-named tools not classified read: ${misclassified.join(', ')}`);
});

test('every TOOL_ACCESS value is read or write', () => {
  const invalid = Object.entries(TOOL_ACCESS)
    .filter(([, access]) => access !== 'read' && access !== 'write')
    .map(([toolId, access]) => `${toolId}=${String(access)}`);
  assert.deepEqual(invalid, [], `invalid access values: ${invalid.join(', ')}`);
});

test('bound read tool definitions declare access read', () => {
  // Group 01 (handlers/group-01.ts) is excluded: it has writes and side-effect tools, each classified on its own.
  const definitions = createReadToolDefinitions(new Proxy({}, { get: () => async () => [] }))
    .filter((def) => !GROUP01_TOOL_IDS.includes(def.id));
  assert.ok(definitions.length > 0, 'expected bound read tool definitions');
  const notRead = definitions.filter((def) => def.access !== 'read').map((def) => `${def.id}=${String(def.access)}`);
  assert.deepEqual(notRead, [], `bound read tools not declared read: ${notRead.join(', ')}`);
});

test('every group 01 read-named tool is classified read in TOOL_ACCESS', () => {
  const groupReads = GROUP01_TOOL_IDS.filter((id) => READ_VERBS.has(id.split('.').pop()));
  assert.ok(groupReads.length > 0);
  for (const id of groupReads) assert.equal(TOOL_ACCESS[id], 'read', `${id} should be classified read`);
});

test('the four tools still under review are classified', () => {
  const expected = {
    'referral_requests.create': 'write',
    'invoice_disputes.create': 'write',
    'purchase_orders.draft': 'write',
    'refund_requests.list': 'read',
  };
  for (const [toolId, access] of Object.entries(expected)) {
    assert.equal(TOOL_ACCESS[toolId], access, `${toolId} should be classified ${access}`);
  }
});
