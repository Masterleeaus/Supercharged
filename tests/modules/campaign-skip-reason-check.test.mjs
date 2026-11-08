// Drift guard: the campaign_send_jobs.skip_reason CHECK in the DRAFT migration must list exactly the
// SkipReason values in campaigns/types.ts, and the campaigns index must export the send queue.
// Reads source text only: no database, no network, no provider.
const silence = () => {};
console.log = silence;
console.info = silence;
console.warn = silence;
console.debug = silence;

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sql = readFileSync(`${ROOT}migrations/DRAFT_campaigns.sql`, 'utf8');
const types = readFileSync(`${ROOT}server/modules/campaigns/types.ts`, 'utf8');

function quotedValues(text) {
  return [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

function checkValues() {
  const m = sql.match(/skip_reason\s+varchar\(\d+\)\s+CHECK\s*\(\s*skip_reason\s+IN\s*\(([^)]*)\)\s*\)/);
  assert.ok(m, 'skip_reason CHECK not found in DRAFT_campaigns.sql');
  return quotedValues(m[1]);
}

function skipReasonValues() {
  const m = types.match(/export type SkipReason\s*=([\s\S]*?);/);
  assert.ok(m, 'SkipReason type not found in types.ts');
  return quotedValues(m[1]);
}

test('skip_reason CHECK lists exactly the SkipReason values, with no duplicates', () => {
  const sqlValues = checkValues();
  const tsValues = skipReasonValues();
  assert.equal(new Set(sqlValues).size, sqlValues.length, 'CHECK list has duplicates');
  assert.equal(new Set(tsValues).size, tsValues.length, 'SkipReason has duplicates');
  assert.deepEqual([...sqlValues].sort(), [...tsValues].sort());
});

test('skip_reason CHECK includes the consent and suppression reasons dispatchJob writes', () => {
  const sqlValues = checkValues();
  for (const reason of ['quiet_hours', 'suppressed', 'no_consent', 'opted_out']) {
    assert.ok(sqlValues.includes(reason), `missing ${reason}`);
  }
});

test('the DRAFT migration keeps its do-not-run guard line', () => {
  assert.match(sql.split('\n')[0], /^-- DRAFT - DO NOT RUN/);
});

test('campaigns index exports the send queue', async () => {
  const index = await import(`${ROOT}server/modules/campaigns/index.ts`);
  assert.equal(typeof index.createSendQueue, 'function');
  assert.equal(typeof index.InMemorySendQueueStore, 'function');
  assert.equal(typeof index.idempotencyKey, 'function');
});
