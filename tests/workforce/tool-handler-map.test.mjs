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
const { createGroup04ToolDefinitions, GROUP04_NOT_IMPLEMENTED } = await import('../../server/workforce/tools/handlers/group-04.ts');

// Recorded on 2026-11-04: 100 distinct declared IDs across 125 role files, 5 bound to a handler, 95 unmapped.
// Group 04 (handlers/group-04.ts) binds 19 more: 20 ids, with site_visits.schedule not_implemented. 95 - 19 = 76.
const UNMAPPED_COUNT_RECORDED = 76;

const ROLES_DIR = fileURLToPath(new URL('../../server/workforce/catalogue/roles', import.meta.url));

const catalogue = await loadRoleCatalogue(ROLES_DIR);
const declared = new Set();
for (const role of catalogue.values()) for (const toolId of role.tools) declared.add(toolId);

// Typed handlers bound through the read-handler port. The store is a stub: no calls are made when building specs.
const stubStore = new Proxy({}, { get: () => async () => [] });
// Group 04 counts as bound only for the ids it implements. not_implemented ids do not lower the count.
const group04Bound = createGroup04ToolDefinitions()
  .map((def) => def.id)
  .filter((id) => !GROUP04_NOT_IMPLEMENTED.includes(id));
const bound = new Set([...createReadToolSpecs(stubStore).map((spec) => spec.id), ...group04Bound]);

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
