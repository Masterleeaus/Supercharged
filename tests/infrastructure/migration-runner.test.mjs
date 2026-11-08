/**
 * Migration runner pre-flight and dry-run checks. No database is used.
 * The runner is run as a child process with --dry-run or with a temporary
 * migrations folder, so nothing is applied.
 *
 *   node --test tests/infrastructure/migration-runner.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../../scripts/run-safe-migration.mjs', import.meta.url));
const realMigrations = fileURLToPath(new URL('../../migrations/', import.meta.url));

// Expected order (owner decision O-08: 0010b runs after 0011).
const EXPECTED_ORDER = [
  '0001_add_missing_columns.sql',
  '0002_add_google_sheets_credentials.sql',
  '0003_campaign_contact_retry.sql',
  '0004_add_missing_tables.sql',
  '0005_add_missing_agent_messaging_columns.sql',
  '0006_add_default_campaign_type.sql',
  '0007_add_external_fonoster_phone_id.sql',
  '008_add_ve_session_id_and_voice_engine_tables.sql',
  '009_fix_ve_session_id_and_all_missing_columns.sql',
  '0010_add_yookassa_columns.sql',
  '0010a_inbox.sql',
  '0011_inbox_channels_and_providers.sql',
  '0010b_approvals.sql',
  '0013_approvals_revoked_status.sql',
  '0010c_chatbot.sql',
];

const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'migration-runner-test-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

function makeFolder(name, files) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), 'SELECT 1;\n');
  return dir;
}

function runRunner(extraArgs, env = {}) {
  const baseEnv = { ...process.env, DATABASE_URL: '' };
  delete baseEnv.DATABASE_URL;
  return spawnSync(process.execPath, [runner, ...extraArgs], {
    encoding: 'utf8',
    env: { ...baseEnv, ...env },
  });
}

/** File names printed by the dry run, in printed order. */
function listedFiles(stdout) {
  return [...stdout.matchAll(/^\s+\d+\. (\S+\.sql)/gm)].map((m) => m[1]);
}

test('dry run on the real migrations folder fails: 008 and 009 are missing', () => {
  const r = runRunner(['--dry-run', `--migrations-dir=${realMigrations}`]);
  assert.notEqual(r.status, 0, 'expected nonzero exit');
  assert.match(r.stderr, /Required migration missing: 008_add_ve_session_id_and_voice_engine_tables\.sql/);
  assert.match(r.stderr, /Required migration missing: 009_fix_ve_session_id_and_all_missing_columns\.sql/);
  assert.doesNotMatch(r.stdout, /Would apply/);
});

test('required migration missing: nonzero exit, and no later migration is listed or applied', () => {
  // Everything except 0003, which is required.
  const dir = makeFolder('missing-0003', EXPECTED_ORDER.filter((f) => f !== '0003_campaign_contact_retry.sql'));
  const r = runRunner(['--dry-run', `--migrations-dir=${dir}`]);
  assert.notEqual(r.status, 0, 'expected nonzero exit');
  assert.match(r.stderr, /Required migration missing: 0003_campaign_contact_retry\.sql/);
  assert.doesNotMatch(r.stdout, /Would apply/);
  assert.doesNotMatch(r.stdout, /0004_add_missing_tables/, 'later migration must not be listed');
  assert.doesNotMatch(r.stdout, /\.sql \(\d+ statements\)/, 'no migration may be planned');
});

test('real apply with a required file missing fails before any database work', () => {
  const dir = makeFolder('missing-real-apply', EXPECTED_ORDER.filter((f) => f !== '0001_add_missing_columns.sql'));
  const r = runRunner([`--migrations-dir=${dir}`]);
  assert.notEqual(r.status, 0, 'expected nonzero exit');
  assert.match(r.stderr, /Required migration missing: 0001_add_missing_columns\.sql/);
  assert.doesNotMatch(r.stdout, /Running safe database migration/, 'must not start the database step');
  assert.doesNotMatch(r.stdout, /Applying:/);
});

test('complete folder: dry run exits 0 and lists the files in the O-08 order', () => {
  const dir = makeFolder('complete', EXPECTED_ORDER);
  const r = runRunner(['--dry-run', `--migrations-dir=${dir}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listedFiles(r.stdout), EXPECTED_ORDER);
  const i10b = listedFiles(r.stdout).indexOf('0010b_approvals.sql');
  const i11 = listedFiles(r.stdout).indexOf('0011_inbox_channels_and_providers.sql');
  assert.ok(i11 < i10b, '0011 must come before 0010b (owner decision O-08)');
});

test('dry run never needs DATABASE_URL', () => {
  const dir = makeFolder('no-db-url', EXPECTED_ORDER);
  const r = runRunner(['--dry-run', `--migrations-dir=${dir}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /DATABASE_URL/);
});
