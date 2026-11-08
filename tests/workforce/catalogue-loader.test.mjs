import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// Same zod fallback as tests/workforce/catalogue.test.mjs: zod is declared in
// package.json but may be missing from this checkout.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const loader = await import('../../server/workforce/catalogue/loader.ts');
const catalogueIndex = await import('../../server/workforce/catalogue/index.ts');
const { role: example } = await import('../../server/workforce/catalogue/roles/_example.ts');

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));
const expectedIds = readdirSync(rolesDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.startsWith('_'))
  .length;

/** Writes a role file into dir as a TypeScript module exporting `role`. */
function writeRole(dir, fileName, role) {
  writeFileSync(join(dir, fileName), `export const role = ${JSON.stringify(role, null, 2)};\n`);
}

test('loads the real roles folder with zero problems', async () => {
  const catalogue = await loader.loadRoleCatalogue(rolesDir);
  assert.equal(catalogue.size, expectedIds, 'every non-underscore role file should load');
  assert.ok(catalogue.size > 0);
  for (const [id, role] of catalogue) {
    assert.equal(role.id, id);
  }
  assert.ok(loader.getRole(catalogue, 'appointment-reminder'), 'known role should be found by id');
  assert.equal(loader.getRole(catalogue, 'no-such-role'), undefined);
});

test('the registry is read-only and each call returns a fresh copy', async () => {
  const first = await loader.loadRoleCatalogue(rolesDir);
  assert.throws(() => first.set('rogue', example), TypeError);
  assert.throws(() => first.delete('appointment-reminder'), TypeError);
  assert.throws(() => first.clear(), TypeError);
  assert.equal(first.has('rogue'), false);

  const role = loader.getRole(first, 'appointment-reminder');
  assert.throws(() => {
    role.name = 'changed';
  }, TypeError);

  const second = await loader.loadRoleCatalogue(rolesDir);
  assert.notEqual(first, second);
  assert.equal(second.size, expectedIds);
  assert.equal(second.get('appointment-reminder').name, 'Appointment Reminder');
});

test('getRole does not mutate the catalogue', async () => {
  const catalogue = await loader.loadRoleCatalogue(rolesDir);
  const before = catalogue.size;
  loader.getRole(catalogue, 'appointment-reminder');
  loader.getRole(catalogue, 'no-such-role');
  assert.equal(catalogue.size, before);
});

test('rejects a fixture set with an unresolved handoffTo target and names the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-loader-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    writeRole(dir, 'good-role.ts', example);
    writeRole(dir, 'bad-handoff.ts', {
      ...example,
      id: 'bad-handoff-role',
      name: 'Bad Handoff Role',
      handoffTo: ['no-such-role'],
    });
    writeRole(dir, '_ignored.ts', { not: 'a role' });

    await assert.rejects(
      loader.loadRoleCatalogue(dir),
      (error) => {
        assert.ok(error instanceof loader.RoleCatalogueError);
        assert.equal(error.problems.length, 1, JSON.stringify(error.problems));
        assert.equal(error.problems[0].path, 'bad-handoff.ts.handoffTo.0');
        assert.match(error.problems[0].message, /no-such-role/);
        assert.match(error.message, /bad-handoff\.ts\.handoffTo\.0/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepts a fixture set whose handoffTo resolves within the folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-loader-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    writeRole(dir, 'a.ts', { ...example, id: 'role-a', name: 'Role A', handoffTo: ['role-b'] });
    writeRole(dir, 'b.ts', { ...example, id: 'role-b', name: 'Role B', handoffTo: [] });
    const catalogue = await loader.loadRoleCatalogue(dir);
    assert.equal(catalogue.size, 2);
    assert.deepEqual(loader.getRole(catalogue, 'role-a').handoffTo, ['role-b']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('index re-exports the loader', () => {
  assert.equal(catalogueIndex.loadRoleCatalogue, loader.loadRoleCatalogue);
  assert.equal(catalogueIndex.getRole, loader.getRole);
});
