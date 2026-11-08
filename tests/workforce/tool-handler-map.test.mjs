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
const { GROUP01_TOOL_IDS } = await import('../../server/workforce/tools/handlers/group-01.ts');

// Recorded on 2026-11-04: 100 distinct declared IDs across 125 role files, 5 bound to a handler, 95 unmapped.
// 2026-11-08: group 00 binds 13 real IDs (the other 5 are not_implemented and do not count) and group 01 binds 18.
// 95 - 13 - 18 = 64 unmapped, so 36 declared IDs are bound (5 read + 13 group 00 + 18 group 01).
const UNMAPPED_COUNT_RECORDED = 64;


const ROLES_DIR = fileURLToPath(new URL('../../server/workforce/catalogue/roles', import.meta.url));

const catalogue = await loadRoleCatalogue(ROLES_DIR);
const declared = new Set();
for (const role of catalogue.values()) for (const toolId of role.tools) declared.add(toolId);

// Typed handlers bound through the read-handler port. The store is a stub: no calls are made when building specs.
const stubStore = new Proxy({}, { get: () => async () => [] });
// Group 00 ids count as bound only when they have a real handler (not_implemented ids do not count).
const group00Bound = createGroup00ToolDefinitions()
  .map((def) => def.id)
  .filter((id) => !GROUP00_NOT_IMPLEMENTED_IDS.has(id));
const bound = new Set([
  ...createReadToolSpecs(stubStore).map((spec) => spec.id),
  ...group00Bound,
  ...GROUP01_TOOL_IDS,
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
