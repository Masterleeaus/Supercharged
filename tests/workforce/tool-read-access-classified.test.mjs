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
const { GROUP00_TOOL_IDS } = await import('../../server/workforce/tools/handlers/group-00.ts');
const { createGroup04ToolDefinitions } = await import('../../server/workforce/tools/handlers/group-04.ts');

const GROUP00_IDS = new Set(GROUP00_TOOL_IDS);

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
  const definitions = createReadToolDefinitions(new Proxy({}, { get: () => async () => [] }));
  // Group 00 holds writes too (checked in tools-real-00.test.mjs). Group 04 write tools are checked as write in
  // tools-real-04.test.mjs. Both are excluded here.
  const groupWriteIds = new Set(createGroup04ToolDefinitions().filter((def) => def.access === 'write').map((def) => def.id));
  const readSpecs = definitions.filter((def) => !GROUP00_IDS.has(def.id) && !groupWriteIds.has(def.id));
  assert.ok(readSpecs.length > 0, 'expected bound read tool definitions');
  const notRead = readSpecs.filter((def) => def.access !== 'read').map((def) => `${def.id}=${String(def.access)}`);
  assert.deepEqual(notRead, [], `bound read tools not declared read: ${notRead.join(', ')}`);
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
