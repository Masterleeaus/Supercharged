// Checklist item: "Separate read, draft, and execute capabilities".
//
// Every tool ID that a role in the catalogue declares must have a capability class (read, draft or execute).
// The class is read from TOOL_ACCESS in server/workforce/catalogue/tool-access.ts, which gives 'read' or 'write'
// for each declared ID. 'read' maps to the read class. 'write' maps to the execute class (fail closed), because
// the map does not separate draft from execute.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { TOOL_ACCESS } = await import('../../server/workforce/catalogue/tool-access.ts');

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));

const READ_VERBS = new Set(['list', 'get', 'search', 'view', 'lookup', 'check', 'read', 'availability', 'status']);

/** Loads every real role file (files starting with "_" are not roles) and collects the declared tool IDs. */
async function declaredToolIds() {
  const files = readdirSync(rolesDir).filter((f) => f.endsWith('.ts') && !f.startsWith('_'));
  const ids = new Map(); // tool id -> Set of role ids
  for (const file of files) {
    const mod = await import(`${rolesDir}${file}`);
    const role = mod.role ?? mod.default;
    assert.ok(role && Array.isArray(role.tools), `${file} must export a role with a tools array`);
    for (const toolId of role.tools) {
      if (!ids.has(toolId)) ids.set(toolId, new Set());
      ids.get(toolId).add(role.id ?? file);
    }
  }
  return ids;
}

/** Derives a capability class from TOOL_ACCESS, or null when the ID has no entry. */
function classOf(toolId) {
  const access = TOOL_ACCESS[toolId];
  if (access === 'read') return 'read';
  if (access === 'write') return 'execute'; // fail closed: a write is treated as an execute
  return null;
}

function isReadNamed(toolId) {
  const verb = toolId.split('.').pop();
  return READ_VERBS.has(verb);
}

test('every declared tool ID has a capability class from TOOL_ACCESS', async () => {
  const declared = await declaredToolIds();
  const unclassified = [];
  let classified = 0;
  for (const toolId of [...declared.keys()].sort()) {
    const cls = classOf(toolId);
    if (cls !== null) classified += 1;
    else unclassified.push(toolId);
  }
  assert.deepEqual(
    unclassified,
    [],
    `${unclassified.length} of ${declared.size} declared tool IDs have no entry in TOOL_ACCESS ` +
      `(${classified} classified). Unclassified: ${unclassified.join(', ')}`,
  );
});

test('TOOL_ACCESS has no entry for a tool that no role declares', async () => {
  const declared = await declaredToolIds();
  const stale = Object.keys(TOOL_ACCESS).filter((toolId) => !declared.has(toolId));
  assert.deepEqual(stale, [], `TOOL_ACCESS entries not declared by any role: ${stale.join(', ')}`);
});

test('every TOOL_ACCESS value is read or write', () => {
  const invalid = Object.entries(TOOL_ACCESS)
    .filter(([, access]) => access !== 'read' && access !== 'write')
    .map(([toolId, access]) => `${toolId}=${String(access)}`);
  assert.deepEqual(invalid, [], `TOOL_ACCESS values other than read or write: ${invalid.join(', ')}`);
});

test('no tool named as a read is classified as an execute', async () => {
  const declared = await declaredToolIds();
  const violations = [];
  for (const toolId of declared.keys()) {
    if (!isReadNamed(toolId)) continue;
    if (classOf(toolId) !== 'read') violations.push(`${toolId} (access=${TOOL_ACCESS[toolId]})`);
  }
  assert.deepEqual(violations, [], `read-named tools not classified as read: ${violations.join('; ')}`);
});

test('every role declares toolAccess that matches TOOL_ACCESS for each of its tools', async () => {
  const files = readdirSync(rolesDir).filter((f) => f.endsWith('.ts') && !f.startsWith('_'));
  const mismatches = [];
  for (const file of files) {
    const mod = await import(`${rolesDir}${file}`);
    const role = mod.role;
    for (const toolId of role.tools) {
      const declared = role.toolAccess?.[toolId];
      const expected = TOOL_ACCESS[toolId];
      if (declared !== expected) mismatches.push(`${role.id}:${toolId} declared=${String(declared)} expected=${String(expected)}`);
    }
  }
  assert.deepEqual(mismatches, [], `toolAccess drift: ${mismatches.slice(0, 20).join('; ')}`);
});

test('every read tool is declared read in every role that uses it', async () => {
  const files = readdirSync(rolesDir).filter((f) => f.endsWith('.ts') && !f.startsWith('_'));
  const readAsWrite = [];
  for (const file of files) {
    const mod = await import(`${rolesDir}${file}`);
    const role = mod.role;
    for (const toolId of role.tools) {
      if (TOOL_ACCESS[toolId] === 'read' && role.toolAccess?.[toolId] !== 'read') readAsWrite.push(`${role.id}:${toolId}`);
    }
  }
  assert.deepEqual(readAsWrite, [], `read tools not declared read: ${readAsWrite.slice(0, 20).join('; ')}`);
});
