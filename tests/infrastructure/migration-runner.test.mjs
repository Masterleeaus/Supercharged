/**
 * Static checks of scripts/run-safe-migration.mjs and the migrations/ directory.
 *
 * Reads files only. It does not import the runner (that would start a migration)
 * and does not connect to any database.
 *
 *   node --test --experimental-transform-types tests/infrastructure/migration-runner.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const runnerSource = readFileSync(new URL('scripts/run-safe-migration.mjs', ROOT), 'utf8');

// Parse the MIGRATIONS array entries: { file: '...', required: true|false }
const entries = [...runnerSource.matchAll(/\{ file: '([^']+)', required: (true|false) \}/g)].map((m) => ({
  file: m[1],
  required: m[2] === 'true',
}));

// Committed migration files that the runner intentionally does not run.
// 0000_damp_spectrum.sql is the base schema, applied by db:push or manually before the runner.
// add_missing_columns.sql (no number prefix) is not registered; owner decision pending.
const NOT_RUN_BY_RUNNER = new Set(['0000_damp_spectrum.sql', 'add_missing_columns.sql']);

test('runner declares entries in the expected order', () => {
  assert.ok(entries.length >= 17, `expected at least 17 entries, found ${entries.length}`);
  const files = entries.map((e) => e.file);
  assert.equal(new Set(files).size, files.length, 'no duplicate entries');
  const idx = (f) => files.indexOf(f);
  assert.ok(idx('0010c_chatbot.sql') < idx('0014_workforce_tool_tables.sql'), '0014 after 0010c');
  assert.ok(idx('0014_workforce_tool_tables.sql') < idx('0015_company_quiet_hours.sql'), '0015 after 0014');
});

test('every REQUIRED runner entry exists as a file in migrations/', () => {
  const missing = entries
    .filter((e) => e.required && !existsSync(new URL('migrations/' + e.file, ROOT)))
    .map((e) => e.file);
  assert.deepEqual(missing, [], `required migration files missing: ${missing.join(', ')}`);
});

test('008 and 009 are REQUIRED runner entries and their files are present', () => {
  for (const file of [
    '008_add_ve_session_id_and_voice_engine_tables.sql',
    '009_fix_ve_session_id_and_all_missing_columns.sql',
  ]) {
    const entry = entries.find((e) => e.file === file);
    assert.ok(entry, `${file} is registered in the runner`);
    assert.equal(entry.required, true, `${file} is REQUIRED`);
    assert.ok(existsSync(new URL('migrations/' + file, ROOT)), `${file} exists in migrations/`);
  }
});

test('runner prints a loud warning that names the optional entries', () => {
  assert.match(runnerSource, /OPTIONAL MIGRATION FILES ARE MISSING/);
  assert.match(runnerSource, /missingOptional\.map\(\(m\) => m\.file\)/);
});

test('runner exits nonzero on a missing required file before connecting to the database', () => {
  const checkIdx = runnerSource.indexOf('missingRequired.length > 0');
  const exitIdx = runnerSource.indexOf('process.exit(1)', checkIdx);
  const poolIdx = runnerSource.indexOf('new Pool(');
  assert.ok(checkIdx > 0, 'missing-required check exists');
  assert.ok(exitIdx > checkIdx, 'exit(1) follows the check');
  assert.ok(exitIdx < poolIdx, 'exit happens before the Pool is created');
});

test('every committed numbered migration is registered, or is a known exclusion', () => {
  const committed = readdirSync(new URL('migrations/', ROOT)).filter((f) => f.endsWith('.sql'));
  const registered = new Set(entries.map((e) => e.file));
  const unexplained = committed.filter((f) => !registered.has(f) && !NOT_RUN_BY_RUNNER.has(f) && !f.startsWith('DRAFT_'));
  assert.deepEqual(unexplained, [], `committed migrations not registered: ${unexplained.join(', ')}`);
});
