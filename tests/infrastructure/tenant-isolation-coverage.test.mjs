/**
 * Issue #127 ratchet: every table that stores company data must be named by a PostgreSQL
 * tenant-isolation test under tests/postgres/ (the CI jobs marketing-, inbox-, tenant- and approvals-postgres).
 *
 * A table counts as company-scoped when its Drizzle declaration has a company_id column. Tables on
 * tests/infrastructure/tenant-isolation-coverage-baseline.json are known gaps. The test fails on a
 * new uncovered table and on a baseline entry that is now covered or no longer exists (remove it).
 *
 * "Named by a test" is a text match on the table name, so it shows a test mentions the table, not
 * that the test proves isolation for it. A reviewer still checks the assertions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DECL = /export const \w+ = pgTable\(\s*["']([a-z_0-9]+)["']/g;

function walk(dir, keep, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'archive' || name === 'node_modules') continue;
      walk(full, keep, out);
    } else if (keep(name)) out.push(full);
  }
  return out;
}

/** name -> file, for every pgTable whose declaration block mentions company_id. */
export function companyScopedTables(root = ROOT) {
  const files = [
    join(root, 'shared/schema.ts'),
    ...walk(join(root, 'server'), (n) => n.endsWith('.ts') && !n.includes('.test.') && !n.includes('DRAFT')),
  ];
  const found = new Map();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(DECL)) {
      const start = m.index + m[0].length;
      const rest = src.slice(start, start + 4000);
      const end = rest.search(/\n\}?\);/);
      const block = end > 0 ? rest.slice(0, end) : rest;
      if (/company_id|companyId/.test(block)) found.set(m[1], relative(root, file));
    }
  }
  return found;
}

/** Table names mentioned anywhere in the Postgres isolation tests. */
export function coveredTables(root = ROOT) {
  const files = walk(join(root, 'tests/postgres'), (n) => n.endsWith('.mjs'));
  const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  return text;
}

test('every company-scoped table is named by a Postgres tenant-isolation test, or is on the baseline', () => {
  const baseline = new Set(JSON.parse(readFileSync(new URL('./tenant-isolation-coverage-baseline.json', import.meta.url), 'utf8')));
  const tables = companyScopedTables();
  const text = coveredTables();
  const uncovered = [...tables.keys()].filter((name) => !new RegExp(`\\b${name}\\b`).test(text)).sort();
  const newGaps = uncovered.filter((name) => !baseline.has(name));
  assert.deepEqual(newGaps, [], `company-scoped tables with no Postgres isolation test: ${newGaps.join(', ')}`);
  const stale = [...baseline].filter((name) => !uncovered.includes(name)).sort();
  assert.deepEqual(stale, [], `baseline entries that are covered now or no longer exist; remove them: ${stale.join(', ')}`);
});
