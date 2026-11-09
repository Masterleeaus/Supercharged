/**
 * Every tool definition declared under server/workforce/tools/ must state its access class explicitly when it only
 * reads data, and read-named tools must never be declared as write. Absent access counts as write (fail closed),
 * so a read tool missing `access: 'read'` would be treated as a write.
 * Run: node --test --experimental-transform-types tests/workforce/tool-access-declared.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadToolDefinitions } from '../../server/workforce/tools/read-handlers.ts';
import { GROUP00_TOOL_IDS } from '../../server/workforce/tools/handlers/group-00.ts';
import { GROUP01_TOOL_IDS } from '../../server/workforce/tools/handlers/group-01.ts';

const READ_VERBS = new Set(['list', 'get', 'search', 'view', 'lookup', 'check', 'read', 'availability']);

const stubStore = new Proxy({}, { get: () => async () => [] });
const definitions = createReadToolDefinitions(stubStore);
// Groups 00 and 01 hold writes as well as reads. Each member declares access explicitly, checked below.
const GROUP_IDS = new Set([...GROUP00_TOOL_IDS, ...GROUP01_TOOL_IDS]);
const readDefinitions = definitions.filter((def) => !GROUP_IDS.has(def.id));

test('every read tool defined under tools/ declares access read', () => {
  assert.ok(readDefinitions.length > 0, 'expected at least one bound read tool definition');
  const missing = readDefinitions.filter((def) => def.access !== 'read').map((def) => def.id);
  assert.deepEqual(missing, [], `read tools without access 'read': ${missing.join(', ')}`);
});

test('every group 00 definition declares access read or write explicitly', () => {
  const group = definitions.filter((def) => new Set(GROUP00_TOOL_IDS).has(def.id));
  assert.equal(group.length, GROUP00_TOOL_IDS.length);
  const undeclared = group.filter((def) => def.access !== 'read' && def.access !== 'write').map((def) => def.id);
  assert.deepEqual(undeclared, [], `group 00 tools without explicit access: ${undeclared.join(', ')}`);
});

test('every group 01 handler declares access explicitly', () => {
  const groupDefs = definitions.filter((def) => new Set(GROUP01_TOOL_IDS).has(def.id));
  assert.equal(groupDefs.length, GROUP01_TOOL_IDS.length);
  const undeclared = groupDefs.filter((def) => def.access !== 'read' && def.access !== 'write').map((def) => def.id);
  assert.deepEqual(undeclared, [], `group 01 tools without access: ${undeclared.join(', ')}`);
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
