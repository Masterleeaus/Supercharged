/**
 * Static checks for the user to company membership table (issue #130, migration 0017).
 * Reads files only; the PostgreSQL behaviour is covered by tests/postgres/tenant-postgres-memberships.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../shared/schema.ts';

const sql = readFileSync(new URL('../../migrations/0017_user_company_memberships.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../scripts/run-safe-migration.mjs', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8'));

test('Drizzle table user_company_memberships matches the migration columns', () => {
  const config = getTableConfig(schema.userCompanyMemberships);
  assert.equal(config.name, 'user_company_memberships');
  assert.deepEqual(config.columns.map((c) => c.name).sort(), ['company_id', 'created_at', 'user_id']);
  assert.equal(config.columns.find((c) => c.name === 'company_id').notNull, true);
  for (const column of config.columns) {
    assert.match(sql, new RegExp(`\\b${column.name}\\b`), `${column.name} appears in the migration`);
  }
});

test('migration is additive: no DROP, ALTER of existing tables, or RENAME', () => {
  const statements = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(statements, /\bDROP\s+COLUMN\b/i);
  assert.doesNotMatch(statements, /\bRENAME\b/i);
  assert.doesNotMatch(statements, /ALTER\s+TABLE\s+users\b/i);
});

test('migration documents its rollback', () => {
  assert.match(sql, /ROLLBACK/);
  assert.match(sql, /DROP TABLE IF EXISTS user_company_memberships;/);
});

test('runner and journal both register 0017 after 0016', () => {
  assert.match(runner, /\{ file: '0017_user_company_memberships\.sql', required: true \}/);
  const tags = journal.entries.map((e) => e.tag);
  assert.equal(tags[tags.length - 1], '0017_user_company_memberships');
  assert.equal(tags[tags.length - 2], '0016_chatbot_reminder_pipeline');
});
