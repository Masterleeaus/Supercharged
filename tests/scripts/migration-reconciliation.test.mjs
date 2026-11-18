import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Migration reconciliation guard for #318. Read-only: it reads file names and the runner list, never a database.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = path.join(root, 'migrations');
const runnerSource = fs.readFileSync(path.join(root, 'scripts/run-safe-migration.mjs'), 'utf8');

const NUMBERED = /^(\d{4})([a-z])?_.+\.sql$/;

/**
 * Forward-only migrations from 0014 onward that have no .down.sql. Each entry needs a reason. Adding a new entry
 * needs an owner decision (CLAUDE.md: migrations are reversible unless a migration plan is explicit).
 */
const FORWARD_ONLY = new Map([
  [
    '0018a_desk_app_role.sql',
    'Creates the desk_app role that 0023 and 0024 require. Dropping a role other tables depend on is unsafe.',
  ],
  [
    '0025_central_link_nonces.sql',
    'Header says "Forward-only" (single-use nonce store, #192/#196). A down file needs an owner decision.',
  ],
]);

function listMigrations() {
  return fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
}

test('every numbered migration from 0014 onward has a .down.sql or a documented forward-only reason', () => {
  const files = listMigrations().filter((f) => !f.endsWith('.down.sql') && !f.startsWith('DRAFT_'));
  const missing = [];
  for (const file of files) {
    const match = NUMBERED.exec(file);
    if (!match || Number(match[1]) < 14) continue;
    const down = file.replace(/\.sql$/, '.down.sql');
    if (!fs.existsSync(path.join(migrationsDir, down)) && !FORWARD_ONLY.has(file)) missing.push(file);
  }
  assert.deepEqual(missing, [], `migrations without a down file or a documented reason: ${missing.join(', ')}`);
});

test('forward-only exceptions are real files and each has a reason', () => {
  for (const [file, reason] of FORWARD_ONLY) {
    assert.ok(fs.existsSync(path.join(migrationsDir, file)), `${file} exists`);
    assert.ok(reason.length > 20, `${file} has a reason`);
  }
});

test('no DRAFT_ file sits in the active migrations directory; drafts live in migrations/archive', () => {
  const drafts = listMigrations().filter((f) => f.startsWith('DRAFT_'));
  assert.deepEqual(drafts, []);
  const archived = fs.readdirSync(path.join(migrationsDir, 'archive')).filter((f) => f.startsWith('DRAFT_'));
  assert.ok(archived.length > 0, 'archived drafts are kept as provenance');
});

test('every file the safe runner lists exists on disk', () => {
  const listed = [...runnerSource.matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(listed.length >= 20, `runner lists ${listed.length} files`);
  const missing = listed.filter((f) => !fs.existsSync(path.join(migrationsDir, f)));
  assert.deepEqual(missing, [], `runner references missing files: ${missing.join(', ')}`);
});

test('the safe runner never lists a down or DRAFT file', () => {
  const listed = [...runnerSource.matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    listed.filter((f) => f.endsWith('.down.sql') || f.startsWith('DRAFT_')),
    [],
  );
});
