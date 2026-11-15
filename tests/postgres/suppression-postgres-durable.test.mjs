import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { withTenant } from '../../server/infrastructure/database/tenant-context.ts';
import { createDurableSuppressionList } from '../../server/modules/comms/suppression.ts';
import { enabled, fixture } from './suppression-postgres-support.mjs';

const CHILD = fileURLToPath(new URL('./suppression-restart-child.mjs', import.meta.url));

// Each test uses new company ids, so runs against the same database do not see each other's rows.
function ids() {
  return { companyId: randomUUID(), otherCompanyId: randomUUID() };
}

// Starts a new Node process that has no memory of this test. It reads the table and reports back.
function freshProcess(mode, input) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', CHILD, JSON.stringify({ mode, ...input })],
    { env: { ...process.env }, encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(result.status, 0, `restart child exited ${result.status}: ${String(result.stderr).slice(0, 300)}`);
  const lines = String(result.stdout).trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('a suppression survives a restart: a new process reads the table and honours it', { skip: !enabled }, async () => {
  const f = fixture();
  try {
    const { companyId, otherCompanyId } = ids();
    const ada = 'ada@example.com';
    const carol = 'carol@example.com';
    const bob = 'bob@example.com';

    const list = createDurableSuppressionList({ persistence: f.persistence });
    await list.warm(companyId);
    list.suppress(companyId, { address: ada, channel: 'email', reason: 'complaint' });
    list.suppress(companyId, { address: carol, channel: 'email', reason: 'unsubscribed' });
    list.unsuppress(companyId, { address: carol, channel: 'email' });
    list.suppress(companyId, { address: bob, channel: 'email', reason: 'bounce_soft' });
    list.suppress(companyId, { address: bob, channel: 'email', reason: 'bounce_soft' });
    await list.flush();

    const after = freshProcess('checks', { companyId, otherCompanyId, ada, carol, bob });
    assert.equal(after.adaSuppressed, true, 'complaint survives the restart');
    assert.equal(after.adaReason, 'complaint');
    assert.equal(after.carolSuppressed, false, 'a lifted unsubscribe stays lifted');
    assert.equal(after.otherSuppressed, false, 'another company is not affected');
    // Two soft bounces were stored before the restart, so the third one reaches the threshold.
    assert.deepEqual(after.bobThird, { ok: true, suppressed: true, reason: 'soft_bounce_count' });
  } finally {
    await f.close();
  }
});

test('a suppressed address is not sent to after a restart', { skip: !enabled }, async () => {
  const f = fixture();
  try {
    const { companyId, otherCompanyId } = ids();
    const list = createDurableSuppressionList({ persistence: f.persistence });
    await list.warm(companyId);
    list.suppress(companyId, { address: 'ada@example.com', channel: 'email', reason: 'bounce_hard' });
    await list.flush();

    const blocked = freshProcess('send', { companyId, otherCompanyId, sendTo: 'ada@example.com' });
    assert.equal(blocked.success, false);
    assert.equal(blocked.error, 'suppressed');
    assert.equal(blocked.baseCalls, 0, 'the transport must not be called for a suppressed address');

    // The same process sends to an address that is not suppressed, so the check above is not a blanket refusal.
    const allowed = freshProcess('send', { companyId, otherCompanyId, sendTo: 'grace@example.com' });
    assert.equal(allowed.success, true);
    assert.equal(allowed.baseCalls, 1);
  } finally {
    await f.close();
  }
});

test('PostgreSQL row-level security: a company session cannot read another company rows', { skip: !enabled }, async () => {
  const f = fixture();
  try {
    const { companyId, otherCompanyId } = ids();
    const list = createDurableSuppressionList({ persistence: f.persistence });
    await list.warm(companyId);
    list.suppress(companyId, { address: 'ada@example.com', channel: 'email', reason: 'complaint' });
    await list.flush();

    const seenByOther = await withTenant(f.pool, otherCompanyId, (client) =>
      client.query('SELECT count(*)::int AS n FROM comms_suppressions'),
    );
    assert.equal(seenByOther.rows[0].n, 0);

    const seenByOwner = await withTenant(f.pool, companyId, (client) =>
      client.query('SELECT count(*)::int AS n FROM comms_suppressions'),
    );
    assert.equal(seenByOwner.rows[0].n, 1);
  } finally {
    await f.close();
  }
});
