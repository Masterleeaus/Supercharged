import test from 'node:test';
import assert from 'node:assert/strict';
import { A, B, enabled, fixture } from './tenant-postgres-support.mjs';

test('PostgreSQL settings: company quiet hours are isolated per company', { skip: !enabled }, async () => {
  const f = fixture();
  try {
    assert.equal((await f.settings.setQuietHours(A, { startHour: 21, endHour: 7, timezone: 'Australia/Sydney' })).ok, true);
    assert.equal((await f.settings.setQuietHours(B, { startHour: 22, endHour: 6, timezone: 'Europe/London' })).ok, true);
    const readA = await f.settings.getQuietHours(A);
    const readB = await f.settings.getQuietHours(B);
    assert.equal(readA.settings.companyId, A);
    assert.equal(readA.settings.timezone, 'Australia/Sydney');
    assert.equal(readB.settings.companyId, B);
    assert.equal(readB.settings.timezone, 'Europe/London');
    // Company A clearing its own settings must not remove company B's row.
    assert.deepEqual(await f.settings.clearQuietHours(A), { ok: true, cleared: true });
    assert.equal((await f.settings.getQuietHours(A)).settings, null);
    assert.equal((await f.settings.getQuietHours(B)).settings.timezone, 'Europe/London');
  } finally {
    await f.close();
  }
});
