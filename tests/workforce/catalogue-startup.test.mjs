import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// Same zod fallback as the other catalogue tests: zod is declared in
// package.json but may be missing from this checkout.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const startup = await import('../../server/workforce/catalogue/startup.ts');
const { loadCatalogueAtStartup, getActiveCatalogue } = startup;

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));
const realRoleCount = readdirSync(rolesDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.startsWith('_'))
  .length;

/** Collects log lines instead of printing them. */
function captureLogger() {
  const lines = { log: [], error: [] };
  return {
    lines,
    logger: {
      log: (msg) => lines.log.push(String(msg)),
      error: (msg) => lines.error.push(String(msg)),
    },
  };
}

// Must run first: nothing has loaded the catalogue in this process yet.
test('getActiveCatalogue is undefined before any load', () => {
  assert.equal(getActiveCatalogue(), undefined);
});

test('a valid folder returns ok with the real 125 roles and caches them', async () => {
  assert.equal(realRoleCount, 125, 'the checked-in catalogue should hold 125 roles');
  const { logger, lines } = captureLogger();
  const result = await loadCatalogueAtStartup(rolesDir, logger);

  assert.equal(result.ok, true);
  assert.equal(result.catalogue.size, 125);
  assert.equal(getActiveCatalogue(), result.catalogue);
  assert.equal(getActiveCatalogue().size, 125);
  assert.deepEqual(lines.log, ['[workforce] role catalogue loaded: 125 roles']);
  assert.deepEqual(lines.error, []);
});

test('a folder with an invalid role returns ok false, lists the problem, and clears the cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-startup-'));
  try {
    writeFileSync(join(dir, 'broken-role.ts'), 'export const role = { id: "broken-role" };\n');
    const { logger, lines } = captureLogger();
    const result = await loadCatalogueAtStartup(dir, logger);

    assert.equal(result.ok, false);
    assert.ok(result.problems.length > 0, 'at least one problem should be reported');
    assert.ok(
      result.problems.some((p) => p.path.includes('broken-role.ts')),
      'the problem should name the broken file',
    );
    assert.equal(getActiveCatalogue(), undefined, 'an invalid load must not leave a catalogue active');
    assert.equal(lines.log.length, 0);
    assert.equal(lines.error[0], `[workforce] role catalogue invalid: ${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}`);
    assert.equal(lines.error.length, result.problems.length + 1, 'each problem gets its own line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing folder returns ok false instead of throwing', async () => {
  const missing = join(tmpdir(), `catalogue-startup-missing-${process.pid}-${Date.now()}`);
  const { logger } = captureLogger();
  const result = await loadCatalogueAtStartup(missing, logger);
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.equal(getActiveCatalogue(), undefined);
});
