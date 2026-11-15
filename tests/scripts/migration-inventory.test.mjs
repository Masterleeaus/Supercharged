import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { listedMigrations, inventoryReport } from '../../scripts/check-migration-inventory.mjs';

const manifest = "const MIGRATIONS = [{ file: 'one.sql', required: true }, { file: 'two.sql', required: false }];";
test('extracts required and optional entries from the real manifest structure', () => {
  assert.deepEqual(listedMigrations(manifest), [{file:'one.sql',required:true},{file:'two.sql',required:false}]);
});
test('fails when the runner manifest structure changes unexpectedly', () => {
  assert.throws(() => listedMigrations('const MIGRATIONS = [];'), /No migration manifest/);
});
test('rejects path traversal and duplicate filenames', () => {
  assert.throws(() => listedMigrations("{ file: '../secret.sql', required: true }"), /Invalid/);
  assert.throws(() => listedMigrations("{ file: 'a.sql', required: true }, { file: 'a.sql', required: true }"), /Duplicate/);
});
test('only missing required entries block migration inventory', () => {
  assert.deepEqual(inventoryReport(manifest, n => n === 'one.sql'), {
    entries: [{file:'one.sql',required:true},{file:'two.sql',required:false}],
    missingRequired: [], missingOptional: ['two.sql'],
  });
  assert.deepEqual(inventoryReport(manifest, () => false).missingRequired, ['one.sql']);
});

// These schema-dependent Central SSO migrations explicitly require operator review
// of deployed tenant columns, role grants and privilege boundaries. Do not silently
// turn them into automatic migrations to make the fresh-database CI job green.
test('operator-only Central SSO migrations are present but never auto-applied', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const runner = readFileSync(new URL('../../scripts/run-safe-migration.mjs', import.meta.url), 'utf8');
  const applied = listedMigrations(runner).map(entry => entry.file);
  for (const file of ['0018_central_sso_company_links.sql', '0019_central_sso_pending_logins.sql']) {
    assert.ok(existsSync(new URL(`../../migrations/${file}`, import.meta.url)), `${file} must remain available for operator-reviewed deployment`);
    assert.ok(!applied.includes(file), `${file} must not run unattended`);
  }
  assert.ok(applied.includes('0017_user_company_memberships.sql'));
  assert.ok(applied.includes('0020_scheduled_booking_mirror.sql'));
});
