import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATES = fileURLToPath(new URL('../../../migrations/candidates/', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../../../migrations/', import.meta.url));
const files = readdirSync(CANDIDATES).filter((f) => f.startsWith('voltagent_'));
const sql = files.map((f) => readFileSync(CANDIDATES + f, 'utf8')).join('\n');

test('candidate files exist and are named voltagent_*.sql', () => {
  assert.ok(files.length >= 1);
  for (const f of files) assert.match(f, /^voltagent_\d{4}_[a-z_]+\.sql$/);
});

test('no voltagent candidate sits in the promoted migrations folder', () => {
  const promoted = readdirSync(MIGRATIONS).filter((f) => f.startsWith('voltagent_'));
  assert.deepEqual(promoted, []);
});

test('candidates are marked as not promoted', () => {
  assert.match(sql, /NOT in the automatic migration manifest/);
  assert.match(sql, /NOT promoted/);
});

test('everything lives in the voltagent schema', () => {
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS voltagent;/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS (?!voltagent\.)/);
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\S+)/g)) {
    assert.ok(m[1].startsWith('voltagent.'), `table outside voltagent schema: ${m[1]}`);
  }
});

test('every table has a tenant column and forced RLS', () => {
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (voltagent\.\w+)/g)].map((m) => m[1]);
  assert.equal(tables.length, 3);
  for (const t of tables) {
    assert.match(sql, new RegExp(`${t.replace('.', '\\.')} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`${t.replace('.', '\\.')} FORCE ROW LEVEL SECURITY`));
  }
  assert.equal((sql.match(/company_id uuid NOT NULL/g) ?? []).length, 3);
});

test('no vector tables and no destructive statements', () => {
  assert.doesNotMatch(sql, /CREATE TABLE[^;]*\b(vector|embedding)/i);
  assert.doesNotMatch(sql, /CREATE EXTENSION/i);
  assert.doesNotMatch(sql, /\bDROP (TABLE|SCHEMA)\b/i);
});

test('no payload columns are stored', () => {
  assert.doesNotMatch(sql, /\b(payload|prompt|response_body|content|arguments)\b\s+(text|jsonb|json)/i);
});
