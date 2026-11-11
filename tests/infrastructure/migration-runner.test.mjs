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
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const runnerSource = readFileSync(new URL('scripts/run-safe-migration.mjs', ROOT), 'utf8');
const RUNNER_PATH = fileURLToPath(new URL('scripts/run-safe-migration.mjs', ROOT));

// Runs the runner with no database. DATABASE_URL points at a closed port so any connection attempt shows up as ECONNREFUSED.
function runRunner(runnerPath, args = [], env = {}) {
  // (env keys set here override process.env; DATABASE_URL is removed unless given)
  const childEnv = { ...process.env, ...env };
  if (!('DATABASE_URL' in env)) delete childEnv.DATABASE_URL;
  return spawnSync(process.execPath, [runnerPath, ...args], { env: childEnv, encoding: 'utf8', timeout: 20000 });
}

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

test('journal lists the base schema and then exactly the runner entries, in the same order', () => {
  const journal = JSON.parse(readFileSync(new URL('migrations/meta/_journal.json', ROOT), 'utf8'));
  const tags = journal.entries.map((e) => e.tag);
  assert.deepEqual(
    tags,
    ['0000_damp_spectrum', ...entries.map((e) => e.file.replace(/\.sql$/, ''))],
    'journal tags match 0000 plus the runner entries in order',
  );
  assert.deepEqual(
    journal.entries.map((e) => e.idx),
    tags.map((_, i) => i),
    'journal idx values are 0..n-1',
  );
  for (const tag of tags) {
    assert.ok(existsSync(new URL(`migrations/${tag}.sql`, ROOT)), `journal tag ${tag} has a file`);
  }
});

test('dry run prints the exact ordered set of runner entries and makes no database connection', () => {
  const result = runRunner(RUNNER_PATH, ['--dry-run']);
  assert.equal(result.status, 0, `dry run exits 0, stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stdout + result.stderr, /ECONNREFUSED|Applying:/);
  const printed = [...result.stdout.matchAll(/^\s*\d+\. (\S+?)(?: \(optional\))?$/gm)].map((m) => m[1]);
  assert.deepEqual(printed, entries.map((e) => e.file), 'printed order equals the MIGRATIONS array order');
});

test('missing required file exits 1 before any database work, so later migrations are not applied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-runner-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'migrations'));
    const copy = join(dir, 'scripts', 'run-safe-migration.mjs');
    copyFileSync(RUNNER_PATH, copy);
    // Every required entry exists except one in the middle, so earlier files would apply if the runner got that far.
    const missing = '0004_add_missing_tables.sql';
    for (const e of entries.filter((x) => x.required && x.file !== missing)) {
      writeFileSync(join(dir, 'migrations', e.file), '-- empty placeholder\n');
    }
    const result = runRunner(copy, [], { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none' });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, `exits 1, output: ${output}`);
    assert.match(result.stderr, /Required migration files are missing\. Nothing was applied\./);
    assert.match(result.stderr, new RegExp(missing.replace(/\./g, '\\.')));
    assert.doesNotMatch(output, /Applying:|__MIGRATION_RESULT__|ECONNREFUSED/, 'no migration was applied and no connection was tried');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
