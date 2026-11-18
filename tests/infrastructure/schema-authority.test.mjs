// Issue #253: the Central migration chain is the only authority for shared schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSchemaAuthority } from '../../scripts/check-schema-authority.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATED = 'if (process.env.ALLOW_DB_PUSH !== "1") { process.exit(2); }\n';

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'schema-authority-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const base = (pkgScripts = { 'db:push': 'node scripts/db-push-non-interactive.mjs' }) => ({
  'package.json': JSON.stringify({ scripts: pkgScripts }),
  'scripts/db-push-non-interactive.mjs': GATED + 'spawn("drizzle-kit push --force");\n',
});

test('the real repository passes the schema authority check', () => {
  assert.deepEqual(checkSchemaAuthority(repo), []);
});

test('a clean fixture with only the gated wrapper passes', () => {
  const dir = fixture(base());
  try {
    assert.deepEqual(checkSchemaAuthority(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a package script that runs drizzle-kit push directly fails', () => {
  const dir = fixture(base({ 'db:push': 'node scripts/db-push-non-interactive.mjs', 'db:fast': 'drizzle-kit push --force' }));
  try {
    const f = checkSchemaAuthority(dir);
    assert.ok(f.some((m) => m.includes('"db:fast"')), f.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a workflow or runtime file that calls drizzle-kit push fails', () => {
  const dir = fixture({
    ...base(),
    '.github/workflows/x.yml': 'steps:\n  - run: npx drizzle-kit push --force\n',
    'server/boot.ts': 'import { exec } from "node:child_process";\nexec("drizzle-kit push --force");\n',
  });
  try {
    const f = checkSchemaAuthority(dir);
    assert.ok(f.some((m) => m.startsWith('.github/workflows/x.yml')), f.join('\n'));
    assert.ok(f.some((m) => m.startsWith('server/boot.ts')), f.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a comment that mentions the command does not fail the check', () => {
  const dir = fixture({ ...base(), 'server/notes.ts': '// history: drizzle-kit push was removed\nexport {};\n' });
  try {
    assert.deepEqual(checkSchemaAuthority(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a wrapper without the ALLOW_DB_PUSH gate fails', () => {
  const dir = fixture({ ...base(), 'scripts/db-push-non-interactive.mjs': 'spawn("drizzle-kit push --force");\n' });
  try {
    const f = checkSchemaAuthority(dir);
    assert.ok(f.some((m) => m.includes('ALLOW_DB_PUSH=1 refusal gate')), f.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #253: app-local DDL ratchet.
import { checkAppLocalDdl } from '../../scripts/check-schema-authority.mjs';
const DDL_FILE = 'server/x.ts';
const DDL_BODY = 'await db.execute(sql`ALTER TABLE leads ADD COLUMN a text`);\nawait db.execute(sql`CREATE TABLE IF NOT EXISTS t (id int)`);\n';

test('app-local DDL that is not in the baseline fails', () => {
  const dir = fixture({ ...base(), [DDL_FILE]: DDL_BODY });
  try {
    const f = checkAppLocalDdl(dir, {});
    assert.ok(f.some((m) => m.startsWith(DDL_FILE) && m.includes('not in the baseline')), f.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DDL growth above the baseline count fails', () => {
  const dir = fixture({ ...base(), [DDL_FILE]: DDL_BODY });
  try {
    const f = checkAppLocalDdl(dir, { [DDL_FILE]: 1 });
    assert.ok(f.some((m) => m.includes('grew from 1 to 2')), f.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DDL within the baseline passes, and a count below it fails so the baseline is lowered', () => {
  const dir = fixture({ ...base(), [DDL_FILE]: DDL_BODY });
  try {
    assert.deepEqual(checkAppLocalDdl(dir, { [DDL_FILE]: 2 }), []);
    const f = checkAppLocalDdl(dir, { [DDL_FILE]: 5 });
    assert.ok(f.some((m) => m.includes('lower APP_LOCAL_DDL_BASELINE to 2')), f.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DDL in comments, tests and migrations is not counted', () => {
  const dir = fixture({
    ...base(),
    'server/notes.ts': '// ALTER TABLE leads ADD COLUMN x\nexport {};\n',
    'tests/t.test.mjs': 'const s = "CREATE TABLE x";\n',
    'migrations/0099.sql': 'CREATE TABLE y (id int);\n',
  });
  try {
    assert.deepEqual(checkAppLocalDdl(dir, {}), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real repository app-local DDL matches the ratchet baseline exactly', () => {
  assert.deepEqual(checkAppLocalDdl(repo), []);
});
