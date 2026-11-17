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
