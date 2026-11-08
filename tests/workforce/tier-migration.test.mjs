/**
 * Tests for server/workforce/catalogue/tier-migration.ts and migrations/DRAFT_workforce_tier_migration.sql.
 * Pure functions and a text check on the draft SQL. No database, no network.
 * Run: node --test --experimental-transform-types tests/workforce/tier-migration.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrateAutonomy, migrateRecord, AUTONOMY_TIERS } from '../../server/workforce/catalogue/tier-migration.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(HERE, '..', '..', 'migrations', 'archive', 'DRAFT_workforce_tier_migration.sql'), 'utf8');

const OLD_MAP = {
  observe_only: 'assist',
  recommend_only: 'suggest',
  prepare_only: 'suggest',
  approval_required: 'auto',
  delegated_autonomous: 'auto',
};

test('each old value maps to its decided tier', () => {
  for (const [oldValue, newValue] of Object.entries(OLD_MAP)) {
    assert.deepEqual(migrateAutonomy(oldValue), { ok: true, value: newValue }, oldValue);
  }
});

test('new values map to themselves, predictive included', () => {
  for (const tier of AUTONOMY_TIERS) {
    assert.deepEqual(migrateAutonomy(tier), { ok: true, value: tier }, tier);
  }
  assert.equal(migrateAutonomy('predictive').value, 'predictive');
});

test('unknown values are refused with unknown_value', () => {
  for (const bad of ['', 'Assist', 'observe-only', 'toString', '__proto__', 'constructor', 'hasOwnProperty', null, undefined, 42, {}]) {
    assert.deepEqual(migrateAutonomy(bad), { ok: false, reason: 'unknown_value' }, String(bad));
  }
});

test('migrateRecord returns a new object with autonomy migrated', () => {
  const input = { id: 'a1', company_id: 'c1', role_id: 'r1', autonomy: 'approval_required', status: 'active' };
  const out = migrateRecord(input);
  assert.notEqual(out, input);
  assert.equal(out.autonomy, 'auto');
  assert.equal(out.id, 'a1');
  assert.equal(out.status, 'active');
});

test('migrateRecord does not mutate its input', () => {
  const input = { id: 'a2', autonomy: 'observe_only', channels: ['email'] };
  const snapshot = JSON.stringify(input);
  const out = migrateRecord(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(input.autonomy, 'observe_only');
  assert.equal(out.autonomy, 'assist');
  assert.equal(out.channels, input.channels, 'untouched fields are shared, not copied wrongly');
});

test('migrateRecord leaves a current value unchanged', () => {
  const out = migrateRecord({ id: 'a3', autonomy: 'suggest' });
  assert.equal(out.autonomy, 'suggest');
});

test('migrateRecord refuses an unknown autonomy value', () => {
  assert.throws(
    () => migrateRecord({ id: 'a4', autonomy: 'turbo' }),
    (err) => err instanceof TypeError && err.reason === 'unknown_value',
  );
});

test('SQL names each old value exactly once in a WHEN clause', () => {
  for (const oldValue of Object.keys(OLD_MAP)) {
    const count = SQL.split(`WHEN '${oldValue}'`).length - 1;
    assert.equal(count, 1, `WHEN '${oldValue}' appears ${count} times`);
  }
});

test('SQL THEN values match the owner mapping', () => {
  const pairs = [...SQL.matchAll(/WHEN '(\w+)' THEN '(\w+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(Object.fromEntries(pairs), OLD_MAP);
});

test('SQL never assigns predictive', () => {
  const thens = [...SQL.matchAll(/THEN '(\w+)'/g)].map((m) => m[1]);
  assert.ok(thens.length > 0);
  assert.ok(!thens.includes('predictive'));
  assert.ok(!/SET[^;]*'predictive'/i.test(SQL));
});

test('SQL is a DRAFT header, updates only workforce_agents, and is idempotent by WHERE', () => {
  assert.match(SQL, /^-- DRAFT - NOT APPLIED/m);
  assert.match(SQL, /UPDATE workforce_agents/);
  assert.match(SQL, /WHERE autonomy IN \(/);
});
