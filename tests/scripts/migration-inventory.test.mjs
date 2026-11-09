import test from 'node:test';
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
