// Licence: original TitanZero test code. No Mastra or VoltAgent source is copied.
// Issue #192: migration 0025 has a reversal script, and the pair uses the table name the store writes to.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const up = readFileSync(new URL('../../migrations/0025_central_link_nonces.sql', import.meta.url), 'utf8');
const down = readFileSync(new URL('../../migrations/0025_central_link_nonces.down.sql', import.meta.url), 'utf8');

test('migration 0025 creates the table the nonce store writes to, with no tenant column', () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS central_link_issued_nonces/);
  const body = up.match(/CREATE TABLE IF NOT EXISTS central_link_issued_nonces \([\s\S]*?\);/)[0];
  assert.equal(/company_id|tenant/i.test(body), false);
});

test('the 0025 reversal drops that table and its index, and nothing else', () => {
  assert.match(down, /DROP TABLE IF EXISTS central_link_issued_nonces;/);
  assert.match(down, /DROP INDEX IF EXISTS central_link_issued_nonces_expiry_idx;/);
  const drops = down.match(/DROP (TABLE|INDEX|POLICY|SCHEMA|DATABASE)\b[^;]*;/g) ?? [];
  assert.equal(drops.length, 2);
});

test('the reversal is wrapped in a transaction, like the forward migration', () => {
  assert.match(down, /^BEGIN;/m);
  assert.match(down, /^COMMIT;/m);
});
