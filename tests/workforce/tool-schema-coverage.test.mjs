/**
 * Coverage check for every tool id declared by a role in server/workforce/catalogue/roles/.
 *
 * For each declared tool id the test asserts:
 *   1. an explicit input schema exists on a registered tool definition (ToolDefinition.schema),
 *   2. a risk class is declared (role.toolRisk entry, one of low/medium/high/critical, and the
 *      definition's risk when a definition exists),
 *   3. a per-tool timeout is declared (ToolDefinition.timeoutMs, a positive integer).
 *
 * Tools with no registered definition cannot satisfy (1) or (3). They are reported, not invented:
 * a definition needs a real handler and a company-scoped data source (see tools/READ_TOOLS.md).
 * Run: node --test --experimental-transform-types tests/workforce/tool-schema-coverage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

// zod is listed in package.json but may be missing from node_modules. Route it to the fallback copy when needed.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

// Test files must not write to stdout (the runner uses IPC). Silence console before importing server code.
const silence = () => {};
console.log = silence;
console.info = silence;
console.warn = silence;

const { loadRoleCatalogue } = await import('../../server/workforce/catalogue/loader.ts');
const { createReadToolDefinitions } = await import('../../server/workforce/tools/read-handlers.ts');

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));

// Stub store: definitions are built but never executed by this test.
const stubStore = new Proxy({}, { get: () => async () => [] });

const catalogue = await loadRoleCatalogue(rolesDir);
const definitions = new Map(createReadToolDefinitions(stubStore).map((def) => [def.id, def]));

/** tool id -> [{ roleId, risk }] for every role that declares it. */
const declared = new Map();
for (const role of catalogue.values()) {
  for (const toolId of role.tools) {
    if (!declared.has(toolId)) declared.set(toolId, []);
    declared.get(toolId).push({ roleId: role.id, risk: role.toolRisk[toolId] });
  }
}
const toolIds = [...declared.keys()].sort();

test('the catalogue declares tool ids to check', () => {
  assert.ok(toolIds.length > 0, 'expected at least one declared tool id');
});

test('every declared tool id has an explicit input schema', () => {
  const missing = toolIds.filter((id) => {
    const def = definitions.get(id);
    return def === undefined || typeof def.schema !== 'object' || def.schema === null;
  });
  const unregistered = missing.filter((id) => !definitions.has(id));
  assert.deepEqual(
    missing,
    [],
    `no input schema for ${missing.length} of ${toolIds.length} declared tools ` +
      `(${unregistered.length} have no registered definition): ${missing.join(', ')}`,
  );
});

test('every declared tool id has a risk class in each role that declares it', () => {
  const problems = [];
  for (const id of toolIds) {
    for (const { roleId, risk } of declared.get(id)) {
      if (!RISK_LEVELS.has(risk)) problems.push(`${id} in ${roleId} (${String(risk)})`);
    }
    const def = definitions.get(id);
    if (def !== undefined && !RISK_LEVELS.has(def.risk)) problems.push(`${id} definition (${String(def.risk)})`);
  }
  assert.deepEqual(problems, [], `missing or invalid risk class: ${problems.join(', ')}`);
});

test('every declared tool id has a per-tool timeout', () => {
  const missing = toolIds.filter((id) => {
    const def = definitions.get(id);
    return def === undefined || !Number.isInteger(def.timeoutMs) || def.timeoutMs < 1;
  });
  assert.deepEqual(
    missing,
    [],
    `no per-tool timeout for ${missing.length} of ${toolIds.length} declared tools ` +
      `(only the registry-wide default applies): ${missing.join(', ')}`,
  );
});
