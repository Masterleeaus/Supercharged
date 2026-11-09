// Company quiet-hours settings, in-memory test adapter. One setting per company.
// Node test runner, no database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanySettingsStore } from '../../server/modules/settings/company-settings.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const FIXED = new Date('2026-11-03T00:00:00.000Z');

function setup() {
  return createCompanySettingsStore({ memoryForTests: true, now: () => FIXED });
}

test('a valid set is returned by get with updatedAt from the injected clock', async () => {
  const store = setup();
  const set = await store.setQuietHours(CO_A, { startHour: 21, endHour: 7, timezone: 'Australia/Melbourne' });
  assert.equal(set.ok, true);
  assert.equal(set.settings.updatedAt, FIXED.toISOString());

  const got = await store.getQuietHours(CO_A);
  assert.equal(got.ok, true);
  assert.deepEqual(got.settings, {
    companyId: CO_A,
    startHour: 21,
    endHour: 7,
    timezone: 'Australia/Melbourne',
    updatedAt: FIXED.toISOString(),
  });
});

test('an out-of-range or non-integer hour is refused with invalid_hour', async () => {
  const store = setup();
  for (const bad of [-1, 24, 1.5, NaN, '7', null, undefined]) {
    const r = await store.setQuietHours(CO_A, { startHour: bad, endHour: 7, timezone: 'UTC' });
    assert.deepEqual(r, { ok: false, reason: 'invalid_hour' }, `startHour ${String(bad)}`);
  }
  const r = await store.setQuietHours(CO_A, { startHour: 22, endHour: 24, timezone: 'UTC' });
  assert.deepEqual(r, { ok: false, reason: 'invalid_hour' });
  assert.equal((await store.getQuietHours(CO_A)).settings, null);
});

test('an invalid IANA timezone is refused with invalid_timezone', async () => {
  const store = setup();
  for (const bad of ['Mars/Olympus', 'Not A Zone', '', 'UTC+10', 42]) {
    const r = await store.setQuietHours(CO_A, { startHour: 9, endHour: 17, timezone: bad });
    assert.deepEqual(r, { ok: false, reason: 'invalid_timezone' }, `timezone ${String(bad)}`);
  }
  assert.equal((await store.getQuietHours(CO_A)).settings, null);
});

test('another company gets null, never this company\'s setting', async () => {
  const store = setup();
  await store.setQuietHours(CO_A, { startHour: 21, endHour: 7, timezone: 'Australia/Melbourne' });
  assert.deepEqual(await store.getQuietHours(CO_B), { ok: true, settings: null });
});

test('clear removes the setting for that company only', async () => {
  const store = setup();
  await store.setQuietHours(CO_A, { startHour: 21, endHour: 7, timezone: 'UTC' });
  await store.setQuietHours(CO_B, { startHour: 1, endHour: 2, timezone: 'UTC' });

  assert.deepEqual(await store.clearQuietHours(CO_A), { ok: true, cleared: true });
  assert.equal((await store.getQuietHours(CO_A)).settings, null);
  assert.equal((await store.getQuietHours(CO_B)).settings.startHour, 1);
  assert.deepEqual(await store.clearQuietHours(CO_A), { ok: true, cleared: false });
});

test('a non-UUID companyId is refused with invalid_company on every operation', async () => {
  const store = setup();
  for (const bad of ['', 'company-1', '11111111-1111-4111-8111-11111111111', ' ' + CO_A, undefined, null, 123]) {
    assert.deepEqual(
      await store.setQuietHours(bad, { startHour: 1, endHour: 2, timezone: 'UTC' }),
      { ok: false, reason: 'invalid_company' },
    );
    assert.deepEqual(await store.getQuietHours(bad), { ok: false, reason: 'invalid_company' });
    assert.deepEqual(await store.clearQuietHours(bad), { ok: false, reason: 'invalid_company' });
  }
});

test('a window that crosses midnight is stored as given', async () => {
  const store = setup();
  await store.setQuietHours(CO_A, { startHour: 22, endHour: 6, timezone: 'Pacific/Auckland' });
  const { settings } = await store.getQuietHours(CO_A);
  assert.equal(settings.startHour, 22);
  assert.equal(settings.endHour, 6);
  assert.equal(settings.timezone, 'Pacific/Auckland');
});

test('returned settings are copies, so mutating them does not change the store', async () => {
  const store = setup();
  await store.setQuietHours(CO_A, { startHour: 22, endHour: 6, timezone: 'UTC' });
  const held = (await store.getQuietHours(CO_A)).settings;
  held.startHour = 3;
  assert.equal((await store.getQuietHours(CO_A)).settings.startHour, 22);
});
