/**
 * Checklist item (supercharged-fixes-checklist, section 4): every tool ID declared in a role definition should map to a
 * typed handler. This test computes the declared set from the real role catalogue and the bound set from the typed
 * read handlers, then pins the number of declared IDs that have no handler. Any new unmapped ID raises the count and
 * fails the test. The recorded count is a ratchet: when a handler is added, lower UNMAPPED_COUNT_RECORDED in the same change.
 * Run: node --test --experimental-transform-types tests/workforce/tool-handler-map.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Silence console output so the test runner's IPC is not broken by server imports.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const { loadRoleCatalogue } = await import('../../server/workforce/catalogue/loader.ts');
const { createReadToolSpecs } = await import('../../server/workforce/tools/read-handlers.ts');
const { createGroup00ToolDefinitions, GROUP00_NOT_IMPLEMENTED_IDS } = await import(
  '../../server/workforce/tools/handlers/group-00.ts'
);
const { GROUP01_TOOL_IDS, GROUP01_NOT_IMPLEMENTED_IDS } = await import('../../server/workforce/tools/handlers/group-01.ts');
const { GROUP_02_TOOL_IDS, GROUP_02_NOT_IMPLEMENTED_IDS } = await import('../../server/workforce/tools/handlers/group-02.ts');
const { GROUP03_TOOL_IDS, GROUP03_NOT_IMPLEMENTED_IDS } = await import('../../server/workforce/tools/handlers/group-03.ts');

// Recorded on 2026-11-04: 100 distinct declared IDs across 125 role files, 5 bound to a handler, 95 unmapped.
// Counted here: a tool is bound only when it has a real handler. not_implemented tools do not count.
// Arithmetic: 100 declared - 58 bound = 42 unmapped. The 58 bound are 5 read handlers + 13 group 00 (18 ids, 5
// not_implemented) + 12 group 01 (18 ids, 6 not_implemented) + 15 group 02 (20 ids, 5 not_implemented) + 13 group 03
// (18 ids, 5 not_implemented). 5 + 13 + 12 + 15 + 13 = 58.
const UNMAPPED_COUNT_RECORDED = 42;

const ROLES_DIR = fileURLToPath(new URL('../../server/workforce/catalogue/roles', import.meta.url));

const catalogue = await loadRoleCatalogue(ROLES_DIR);
const declared = new Set();
for (const role of catalogue.values()) for (const toolId of role.tools) declared.add(toolId);

// Typed handlers: the read-handler specs plus the registry definitions, which add the group 03 handlers (reads and writes).
// The store is a stub: no calls are made when building specs or definitions.
const stubStore = new Proxy({}, { get: () => async () => [] });
// Group 00 and group 02 ids count as bound only when they have a real handler (not_implemented ids do not count).
const group00Bound = createGroup00ToolDefinitions()
  .map((def) => def.id)
  .filter((id) => !GROUP00_NOT_IMPLEMENTED_IDS.has(id));
const group01Bound = GROUP01_TOOL_IDS.filter((id) => !GROUP01_NOT_IMPLEMENTED_IDS.has(id));
const group02Bound = GROUP_02_TOOL_IDS.filter((id) => !GROUP_02_NOT_IMPLEMENTED_IDS.includes(id));
const group03Bound = GROUP03_TOOL_IDS.filter((id) => !GROUP03_NOT_IMPLEMENTED_IDS.has(id));
const bound = new Set([
  ...createReadToolSpecs(stubStore).map((spec) => spec.id),
  ...group00Bound,
  ...group01Bound,
  ...group02Bound,
  ...group03Bound,
]);

const unmapped = [...declared].filter((toolId) => !bound.has(toolId)).sort();

test('role catalogue loads and declares tool IDs', () => {
  assert.ok(catalogue.size > 0, 'expected at least one role');
  assert.ok(declared.size > 0, 'expected at least one declared tool ID');
});

test('every bound handler ID is declared by at least one role', () => {
  const orphans = [...bound].filter((toolId) => !declared.has(toolId)).sort();
  assert.deepEqual(orphans, [], `handlers bound to undeclared IDs: ${orphans.join(', ')}`);
});

test('count of declared tool IDs with no typed handler matches the recorded number', () => {
  assert.equal(
    unmapped.length,
    UNMAPPED_COUNT_RECORDED,
    `unmapped declared tool IDs: ${unmapped.length} (recorded ${UNMAPPED_COUNT_RECORDED}). ` +
      `Unmapped now: ${unmapped.join(', ')}`,
  );
});
