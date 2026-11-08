/**
 * Every tool definition declared under server/workforce/tools/ must state its access class explicitly when it only
 * reads data, and read-named tools must never be declared as write. Absent access counts as write (fail closed),
 * so a read tool missing `access: 'read'` would be treated as a write.
 * Run: node --test --experimental-transform-types tests/workforce/tool-access-declared.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadToolDefinitions } from '../../server/workforce/tools/read-handlers.ts';
import { GROUP03_TOOL_IDS } from '../../server/workforce/tools/handlers/group-03.ts';
import { TOOL_ACCESS } from '../../server/workforce/catalogue/tool-access.ts';

const READ_VERBS = new Set(['list', 'get', 'search', 'view', 'lookup', 'check', 'read', 'availability']);

const stubStore = new Proxy({}, { get: () => async () => [] });
const definitions = createReadToolDefinitions(stubStore);

test('every read tool defined under tools/ declares access read', () => {
  assert.ok(definitions.length > 0, 'expected at least one bound read tool definition');
  // The group 03 handlers include writes, so only tools the catalogue or the verb names as reads are checked here.
  const reads = definitions.filter((def) => TOOL_ACCESS[def.id] === 'read' || READ_VERBS.has(def.id.split('.').pop()));
  assert.ok(reads.length > 0, 'expected at least one read tool definition');
  const missing = reads.filter((def) => def.access !== 'read').map((def) => def.id);
  assert.deepEqual(missing, [], `read tools without access 'read': ${missing.join(', ')}`);
});

test('group 03 definitions declare the access the catalogue gives them', () => {
  const mismatched = definitions
    .filter((def) => GROUP03_TOOL_IDS.includes(def.id))
    .filter((def) => def.access !== TOOL_ACCESS[def.id])
    .map((def) => `${def.id}=${String(def.access)} (catalogue ${String(TOOL_ACCESS[def.id])})`);
  assert.deepEqual(mismatched, [], `access differs from the catalogue: ${mismatched.join(', ')}`);
});

test('read-named tools defined under tools/ are not declared as write', () => {
  const misnamed = definitions
    .filter((def) => READ_VERBS.has(def.id.split('.').pop()) && def.access === 'write')
    .map((def) => def.id);
  assert.deepEqual(misnamed, [], `read-named tools declared as write: ${misnamed.join(', ')}`);
});

test('no tool defined under tools/ leaves access undeclared', () => {
  const undeclared = definitions.filter((def) => def.access === undefined).map((def) => def.id);
  assert.deepEqual(undeclared, [], `tools with no access class: ${undeclared.join(', ')}`);
});
