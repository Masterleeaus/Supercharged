/**
 * Static checks for widget company scope, additive step (issue #127, migration 0026; renumbered from 0018 at merge).
 * Reads files only. The PostgreSQL backfill is covered by tests/postgres/tenant-postgres-widget-company.test.mjs.
 * Dashboard reads and writes must stay user-scoped until the owner answers the open questions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../migrations/0026_website_widgets_company_id.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../scripts/run-safe-migration.mjs', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../migrations/meta/_journal.json', import.meta.url), 'utf8'));
const service = readFileSync(new URL('../../server/modules/widget/widget-service.ts', import.meta.url), 'utf8');
const storage = readFileSync(new URL('../../server/modules/widget/widget-storage.ts', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../../server/modules/widget/widget-routes.ts', import.meta.url), 'utf8');

test('migration 0026 is additive: no DROP COLUMN, RENAME, NOT NULL, or ALTER of users', () => {
  const statements = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(statements, /\bDROP\s+COLUMN\b/i);
  assert.doesNotMatch(statements, /\bRENAME\b/i);
  assert.doesNotMatch(statements, /\bSET\s+NOT\s+NULL\b/i);
  assert.doesNotMatch(statements, /ALTER\s+TABLE\s+users\b/i);
  assert.doesNotMatch(statements, /\bDELETE\s+FROM\b/i);
});

test('migration 0026 documents its rollback', () => {
  assert.match(sql, /ROLLBACK/);
  assert.match(sql, /DROP INDEX IF EXISTS website_widgets_company_id_idx;/);
  assert.match(sql, /ALTER TABLE website_widgets DROP COLUMN IF EXISTS company_id;/);
});

test('runner and journal register 0026 directly after 0025, which follows 0024', () => {
  assert.match(runner, /\{ file: '0026_website_widgets_company_id\.sql', required: true \}/);
  const tags = journal.entries.map((e) => e.tag);
  const i24 = tags.indexOf('0024_inbox_tenant_rls');
  assert.ok(i24 >= 0, '0024 is in the journal');
  assert.equal(tags[i24 + 1], '0025_central_link_nonces');
  assert.equal(tags[i24 + 2], '0026_website_widgets_company_id');
});

test('createWidget sets company_id from the server-side owner, after the request spread', () => {
  assert.match(service, /const companyId = await this\.resolveOwnerCompanyId\(userId\);/);
  const body = service.slice(service.indexOf('async createWidget('), service.indexOf('async resolveOwnerCompanyId('));
  assert.ok(body.indexOf('...data') < body.indexOf('companyId,'), 'companyId comes after ...data');
  assert.match(service, /select\(\{ companyId: users\.companyId \}\)/);
});

test('request input cannot set company_id: it is not in the widget field whitelist', () => {
  const list = routes.slice(routes.indexOf('const allowedUpdateFields'), routes.indexOf('] as const;'));
  assert.doesNotMatch(list, /companyId|company_id/);
});

test('storage insert accepts companyId without widening the public insert schema', () => {
  assert.match(storage, /createWidget\(data: InsertWebsiteWidget & \{ companyId\?: string \| null \}\)/);
});

test('dashboard reads and writes are still user-scoped (not switched in this step)', () => {
  const storageFns = storage.slice(storage.indexOf('async getWidgetsByUserId'), storage.indexOf('async incrementWidgetStats'));
  assert.match(storageFns, /eq\(websiteWidgets\.userId, userId\)/);
  assert.doesNotMatch(storageFns, /websiteWidgets\.companyId/);
});
