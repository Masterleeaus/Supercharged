/**
 * Checks the tenancy inventory and the company_id draft against shared/schema.ts.
 * Pure text checks: no database, no network.
 *
 *   node --test tests/infrastructure/tenancy-inventory.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => readFileSync(root + rel, 'utf8');

const schema = read('shared/schema.ts');
const inventory = read('docs/TENANCY-INVENTORY.md');
const draft = read('migrations/archive/DRAFT_company_scope.sql');
const runner = read('scripts/run-safe-migration.mjs');

const extension = read('migrations/archive/DRAFT_company_scope_extension.sql');

const schemaTables = [...schema.matchAll(/pgTable\("(\w+)"/g)].map((m) => m[1]);

const CLASSES = new Set(['tenant', 'global', 'ambiguous', 'root']);
const rows = [...inventory.matchAll(/^\| (\d+) \| (\w+) \| (\w+) \| (.+?) \| (.*) \|$/gm)].map((m) => ({
  n: Number(m[1]),
  table: m[2],
  cls: m[3],
  parent: m[4],
}));
const tenantTables = rows.filter((r) => r.cls === 'tenant').map((r) => r.table);

// The three chatbot tables are tenant tables, but they are covered by migrations/DRAFT_chatbot.sql,
// which creates company_id NOT NULL from the start. They are new and empty, so they need no
// backfill and no STEP A/B/C/D work in the company-scope draft. Every other tenant table stays
// in the expected set below.
const CHATBOT_TABLES = ['chatbots', 'chatbot_conversations', 'chatbot_messages'];
const chatbotDraft = read('migrations/archive/DRAFT_chatbot.sql');

// A tenant table counts as covered if EITHER draft protects it (decision from Jason).
// DRAFT_company_scope_extension.sql protects the eight tables from DRAFT_chatbot.sql and the
// workforce drafts with row-level security. Those tables already carry company_id NOT NULL from
// their own drafts, so the original draft's STEP A/B/C/D expectations do not apply to them.
const extensionTables = [...extension
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .matchAll(/ALTER TABLE public\.(\w+) ENABLE ROW LEVEL SECURITY;/g)].map((m) => m[1]);
// Tenant tables created by migrations/0014_workforce_tool_tables.sql with company_id NOT NULL.
// That migration covers them directly: they are not in any archived draft, and they need no
// backfill because they are new. Only tables whose CREATE block has that column count.
const workforceMigration = read('migrations/0014_workforce_tool_tables.sql');
const ownMigrationTables = [...workforceMigration.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)]
  .filter((m) => /^\s*company_id\s+uuid\s+NOT NULL\b/m.test(m[2]))
  .map((m) => m[1])
  .filter((t) => tenantTables.includes(t));
// Tenant tables that only the original draft must cover (STEP A/B/C/D).
const companyScopeTenantTables = tenantTables.filter((t) => !extensionTables.includes(t) && !ownMigrationTables.includes(t));

/** Lines of SQL that are not comments, so commented-out statements do not count. */
const liveSql = draft
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

/** Live SQL between two step markers (markers are comments, so they are read from the raw draft). */
function liveSection(startMarker, endMarker) {
  const start = draft.indexOf(startMarker);
  const end = endMarker ? draft.indexOf(endMarker, start + 1) : draft.length;
  assert.ok(start >= 0, `missing marker ${startMarker}`);
  return draft
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

/** Table names from every statement that matches the pattern in the live SQL. */
function tablesMatching(pattern) {
  return [...liveSql.matchAll(pattern)].map((m) => m[1]);
}

test('schema.ts declares 130 tables, all unique', () => {
  assert.equal(schemaTables.length, 130);
  assert.equal(new Set(schemaTables).size, 130);
});

test('inventory has exactly one row per schema table, with a valid class', () => {
  const names = rows.map((r) => r.table);
  assert.equal(rows.length, 130, `expected 130 rows, got ${rows.length}`);
  assert.equal(new Set(names).size, names.length, 'duplicate table row');
  assert.deepEqual([...names].sort(), [...schemaTables].sort(), 'inventory and schema.ts differ');
  for (const r of rows) {
    assert.ok(CLASSES.has(r.cls), `${r.table} has unknown class ${r.cls}`);
  }
});

test('row numbers run 1..130 in schema order', () => {
  assert.deepEqual(
    rows.map((r) => r.n),
    Array.from({ length: 130 }, (_, i) => i + 1),
  );
  assert.deepEqual(rows.map((r) => r.table), schemaTables);
});

test('each tenant row names a parent; global and ambiguous rows do not get one', () => {
  for (const r of rows) {
    if (r.cls === 'tenant') {
      assert.notEqual(r.parent, '-', `${r.table} is tenant but has no backfill parent`);
    } else {
      assert.equal(r.parent, '-', `${r.table} is ${r.cls} but names a parent`);
    }
  }
});

test('the counts section matches the rows', () => {
  const count = (c) => rows.filter((r) => r.cls === c).length;
  assert.match(inventory, new RegExp(`- tenant: ${count('tenant')}\\n`));
  assert.match(inventory, new RegExp(`- global: ${count('global')}\\n`));
  assert.match(inventory, new RegExp(`- ambiguous: ${count('ambiguous')}\\n`));
  assert.match(inventory, new RegExp(`- root: ${count('root')} \\(companies\\)\\n`));
  assert.equal(count('tenant') + count('global') + count('ambiguous') + count('root'), 130);
  assert.match(inventory, /- total: 130\n/);
});

test('draft adds company_id to exactly the tenant tables, all in STEP A', () => {
  const stepA = liveSection('-- ==== STEP A', '-- ==== STEP B');
  const added = [...stepA.matchAll(/ALTER TABLE public\.(\w+) ADD COLUMN IF NOT EXISTS company_id uuid NULL;/g)].map((m) => m[1]);
  assert.deepEqual([...added].sort(), [...companyScopeTenantTables].sort());
  assert.equal(new Set(added).size, added.length, 'duplicate ADD COLUMN');
  // No ADD COLUMN for company_id appears outside STEP A (users is commented out as BLOCKED).
  assert.equal(tablesMatching(/ALTER TABLE public\.(\w+) ADD COLUMN IF NOT EXISTS company_id/g).length, added.length);
  // Combined set: STEP A, the extension and migration 0014 cover every tenant table, with no overlap.
  assert.deepEqual([...added, ...extensionTables, ...ownMigrationTables].sort(), [...tenantTables].sort(), 'drafts and 0014 do not cover every tenant table');
  assert.equal(added.filter((t) => extensionTables.includes(t)).length, 0, 'table covered by both drafts');
});

test('every tenant table gets a backfill UPDATE, an FK in STEP C and NOT NULL only in STEP D', () => {
  const stepB = liveSection('-- ==== STEP B', '-- ==== STEP C');
  const stepC = liveSection('-- ==== STEP C', '-- ==== STEP D');
  const stepD = liveSection('-- ==== STEP D');

  const backfilled = new Set([...stepB.matchAll(/UPDATE public\.(\w+) AS t SET company_id/g)].map((m) => m[1]));
  const fks = tablesMatching(/ALTER TABLE public\.(\w+) ADD CONSTRAINT \w+ FOREIGN KEY/g);
  const notNull = tablesMatching(/ALTER TABLE public\.(\w+) ALTER COLUMN company_id SET NOT NULL/g);

  assert.deepEqual([...backfilled].sort(), [...companyScopeTenantTables].sort(), 'backfill set differs from tenant set');
  assert.deepEqual([...fks].sort(), [...companyScopeTenantTables].sort(), 'FK set differs from tenant set');
  assert.deepEqual([...notNull].sort(), [...companyScopeTenantTables].sort(), 'NOT NULL set differs from tenant set');
  // Combined set: backfill from the original draft, RLS from the extension, and 0014 (no backfill needed) cover every tenant table.
  assert.deepEqual([...backfilled, ...extensionTables, ...ownMigrationTables].sort(), [...tenantTables].sort(), 'drafts and 0014 do not cover every tenant table');
  for (const t of extensionTables) {
    assert.match(extension, new RegExp(`ALTER TABLE public\\.${t} FORCE ROW LEVEL SECURITY;`), `${t} lacks FORCE ROW LEVEL SECURITY in the extension`);
  }

  assert.match(stepC, /NOT VALID;/);
  assert.equal(
    tablesMatching(/ALTER TABLE public\.(\w+) VALIDATE CONSTRAINT/g).length,
    companyScopeTenantTables.length,
  );
  // NOT NULL statements sit only in STEP D; the STEP B/C sections must not contain them.
  assert.equal(stepB.includes('SET NOT NULL'), false);
  assert.equal(stepC.includes('SET NOT NULL'), false);
  assert.equal(stepD.match(/SET NOT NULL/g).length, companyScopeTenantTables.length);
});

test('DRAFT_chatbot.sql creates all three chatbot tables with company_id NOT NULL', () => {
  const creates = [...chatbotDraft.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)];
  for (const table of CHATBOT_TABLES) {
    const block = creates.find((m) => m[1] === table);
    assert.ok(block, `DRAFT_chatbot.sql does not create ${table}`);
    assert.match(block[2], /^\s*company_id\s+uuid\s+NOT NULL\b/m, `${table} lacks company_id uuid NOT NULL`);
  }
});

test('every extension table already carries company_id NOT NULL in its own draft', () => {
  const ownDrafts = [chatbotDraft, ...readdirSync(root + 'migrations/archive')
    .filter((f) => /^DRAFT_workforce_.*\.sql$/.test(f))
    .map((f) => read('migrations/archive/' + f))].join('\n');
  for (const t of extensionTables) {
    const block = [...ownDrafts.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)].find((m) => m[1] === t);
    assert.ok(block, `no own draft creates ${t}`);
    assert.match(block[2], /^\s*company_id\s+uuid\s+NOT NULL\b/m, `${t} lacks company_id uuid NOT NULL in its own draft`);
  }
});

test('tables covered by no draft or migration are exactly the non-tenant rows (no tenant table is unprotected)', () => {
  // Taken from the draft statements themselves, not from the derived lists above.
  const addedInDraft = tablesMatching(/ALTER TABLE public\.(\w+) ADD COLUMN IF NOT EXISTS company_id/g);
  const backfilledInDraft = tablesMatching(/UPDATE public\.(\w+) AS t SET company_id/g);
  const covered = new Set([...addedInDraft, ...backfilledInDraft, ...extensionTables, ...ownMigrationTables, 'companies']);
  const uncovered = schemaTables.filter((t) => !covered.has(t)).sort();
  const expected = rows.filter((r) => r.cls !== 'tenant' && r.table !== 'companies').map((r) => r.table).sort();
  assert.deepEqual(uncovered, expected, 'a tenant table is covered by no draft');
});

test('backfill never runs for global or ambiguous tables', () => {
  const nonTenant = new Set(rows.filter((r) => r.cls !== 'tenant').map((r) => r.table));
  const touched = [
    ...tablesMatching(/UPDATE public\.(\w+) AS t SET company_id/g),
    ...tablesMatching(/ALTER TABLE public\.(\w+) (?:ADD|ALTER|VALIDATE)/g),
  ];
  for (const t of touched) {
    assert.equal(nonTenant.has(t), false, `${t} is not tenant but the draft changes it`);
  }
});

test('STEP order is A, B, C, D, and the guard sits above section 1', () => {
  const idx = (s) => draft.indexOf(s);
  const guard = idx("DO $$ BEGIN RAISE EXCEPTION 'DRAFT_company_scope.sql must not be executed");
  const sec1 = idx('-- 1. Restricted application role');
  assert.ok(guard > 0 && guard < sec1, 'guard must come before section 1');
  const order = ['-- ==== STEP A', '-- ==== STEP B', '-- ==== STEP C', '-- ==== STEP D'].map(idx);
  for (const p of order) assert.ok(p > 0, 'missing step marker');
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('the draft is not wired into the migration runner', () => {
  assert.equal(runner.includes('DRAFT_company_scope'), false);
});
