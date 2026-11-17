// W12 storage candidate checks. Static checks on migrations/candidates/voltagent_*.sql.
// Run explicitly: node --test tests/integrations/voltagent/storage-candidates.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const sqlPath = join(repoRoot, 'migrations', 'candidates', 'voltagent_0001_schema.sql');

const raw = existsSync(sqlPath) ? readFileSync(sqlPath, 'utf8') : '';
// Strip line comments so header prose cannot trip the checks.
const sql = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

test('candidate file exists and is not empty', () => {
  assert.ok(existsSync(sqlPath), `missing ${sqlPath}`);
  assert.ok(sql.trim().length > 0);
});

test('creates the voltagent schema idempotently', () => {
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS voltagent\s*;/);
});

test('every CREATE TABLE is IF NOT EXISTS and schema-qualified', () => {
  const creates = sql.match(/CREATE\s+TABLE\b[^\n(]*/gi) ?? [];
  assert.ok(creates.length >= 5, `expected at least 5 tables, found ${creates.length}`);
  for (const c of creates) {
    assert.match(c, /^CREATE TABLE IF NOT EXISTS voltagent\.[a-z_]+\s*$/i, `bad CREATE TABLE: ${c}`);
  }
});

test('every CREATE INDEX is IF NOT EXISTS', () => {
  const creates = sql.match(/CREATE\s+(UNIQUE\s+)?INDEX\b[^\n]*/gi) ?? [];
  for (const c of creates) {
    assert.match(c, /CREATE (UNIQUE )?INDEX IF NOT EXISTS /i, `bad CREATE INDEX: ${c}`);
  }
});

test('no DROP statements', () => {
  assert.doesNotMatch(sql, /\bDROP\b/i);
});

test('no statement touches a public-schema table', () => {
  assert.doesNotMatch(sql, /\bpublic\s*\./i);
  // Every REFERENCES target must be voltagent-qualified.
  const refs = sql.match(/REFERENCES\s+[^\s(]+/gi) ?? [];
  for (const r of refs) {
    assert.match(r, /REFERENCES\s+voltagent\./i, `unqualified reference: ${r}`);
  }
});

test('no vector extension or vector columns (W5 owns those)', () => {
  assert.doesNotMatch(sql, /CREATE\s+EXTENSION/i);
  assert.doesNotMatch(sql, /\bvector\s*\(/i);
  assert.doesNotMatch(sql, /\bVECTOR\b/);
});
