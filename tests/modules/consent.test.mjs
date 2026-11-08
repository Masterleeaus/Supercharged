// Consent module tests (node:test). Pure functions only: no database, no network, no clock.
const silence = () => {};
console.log = silence;
console.info = silence;
console.warn = silence;
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkConsent,
  isQuietHours,
  parseOptOutKeyword,
} from '../../server/modules/comms/consent.ts';

const NOON_UTC = '2026-11-03T12:00:00Z';
// Fixed clock values for quiet-hours tests. 2026-11-03T12:00Z is 23:00 in Melbourne (AEDT, UTC+11)
// and 07:00 in New York (EST, UTC-5, US DST has ended by then).
const MELBOURNE = 'Australia/Melbourne';
const NEW_YORK = 'America/New_York';
const LATE_NIGHT_WINDOW = { startHour: 22, endHour: 6 };
const contact = (overrides = {}) => ({
  handles: { email: 'ada@example.com', phone: '+61400000000', telegram: '@ada', messenger: 'ada.m', instagram: 'ada.i' },
  consents: [{ channel: 'email', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
  ...overrides,
});

test('allowed when the channel has a contact opt-in and no opt-out', () => {
  assert.deepEqual(checkConsent({ channel: 'email', contact: contact(), now: NOON_UTC }), { allowed: true });
});

test('reason no_consent when the contact has no consent records at all', () => {
  const c = contact({ consents: [] });
  assert.deepEqual(checkConsent({ channel: 'email', contact: c, now: NOON_UTC }), { allowed: false, reason: 'no_consent' });
});

test('reason channel_not_consented when records exist but none grant this channel', () => {
  const r = checkConsent({ channel: 'sms', contact: contact(), now: NOON_UTC });
  assert.deepEqual(r, { allowed: false, reason: 'channel_not_consented' });
});

test('reason opted_out when the channel was opted out', () => {
  const c = contact({
    consents: [
      { channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' },
      { channel: 'sms', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
    ],
  });
  assert.deepEqual(checkConsent({ channel: 'sms', contact: c, now: NOON_UTC }), { allowed: false, reason: 'opted_out' });
});

test('reason quiet_hours when the local time is inside the window', () => {
  const r = checkConsent({
    channel: 'email',
    contact: contact({ timezone: 'UTC' }),
    now: NOON_UTC,
    quietHours: { startHour: 9, endHour: 17 },
  });
  assert.deepEqual(r, { allowed: false, reason: 'quiet_hours' });
});

test('reason invalid_contact for a missing contact, an unknown channel, or a missing handle', () => {
  assert.deepEqual(checkConsent({ channel: 'email', contact: null, now: NOON_UTC }), { allowed: false, reason: 'invalid_contact' });
  assert.deepEqual(checkConsent({ channel: 'pigeon', contact: contact(), now: NOON_UTC }), { allowed: false, reason: 'invalid_contact' });
  const noEmail = contact({ handles: { phone: '+61400000000' } });
  assert.deepEqual(checkConsent({ channel: 'email', contact: noEmail, now: NOON_UTC }), { allowed: false, reason: 'invalid_contact' });
});

test('reason invalid_contact for a consent record with an unreadable timestamp', () => {
  const c = contact({ consents: [{ channel: 'email', action: 'opt_in', at: 'not a date', source: 'contact' }] });
  assert.deepEqual(checkConsent({ channel: 'email', contact: c, now: NOON_UTC }), { allowed: false, reason: 'invalid_contact' });
});

test('channel consent does not carry across channels', () => {
  const c = contact({
    consents: [{ channel: 'whatsapp', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
  });
  assert.equal(checkConsent({ channel: 'whatsapp', contact: c, now: NOON_UTC }).allowed, true);
  for (const other of ['sms', 'telegram', 'email', 'messenger', 'instagram', 'phone']) {
    assert.deepEqual(
      checkConsent({ channel: other, contact: c, now: NOON_UTC }),
      { allowed: false, reason: 'channel_not_consented' },
      `${other} must not inherit whatsapp consent`,
    );
  }
});

test('a general opt-in does not cover another channel', () => {
  const c = contact({
    consents: [{ channel: 'all', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
  });
  assert.deepEqual(checkConsent({ channel: 'email', contact: c, now: NOON_UTC }), { allowed: false, reason: 'channel_not_consented' });
});

test('opt-out beats an older opt-in', () => {
  const c = contact({
    consents: [
      { channel: 'email', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' },
      { channel: 'email', action: 'opt_out', at: '2026-06-01T00:00:00Z', source: 'contact' },
    ],
  });
  assert.deepEqual(checkConsent({ channel: 'email', contact: c, now: NOON_UTC }), { allowed: false, reason: 'opted_out' });
});

test('a newer contact opt-in after an opt-out does not reinstate the channel', () => {
  const c = contact({
    consents: [
      { channel: 'email', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
      { channel: 'email', action: 'opt_in', at: '2026-03-01T00:00:00Z', source: 'contact' },
    ],
  });
  assert.deepEqual(checkConsent({ channel: 'email', contact: c, now: NOON_UTC }), { allowed: false, reason: 'opted_out' });
});

test('repeated opt-ins after an opt-out, from any source, never reinstate the channel', () => {
  const c = contact({
    consents: [
      { channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' },
      { channel: 'sms', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
      { channel: 'sms', action: 'opt_in', at: '2026-03-01T00:00:00Z', source: 'contact' },
      { channel: 'sms', action: 'opt_in', at: '2026-04-01T00:00:00Z', source: 'staff' },
    ],
  });
  assert.deepEqual(checkConsent({ channel: 'sms', contact: c, now: NOON_UTC }), { allowed: false, reason: 'opted_out' });
});

test('a newer opt-in from staff or an import does not override an opt-out', () => {
  const c = contact({
    consents: [
      { channel: 'email', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
      { channel: 'email', action: 'opt_in', at: '2026-03-01T00:00:00Z', source: 'import' },
    ],
  });
  assert.deepEqual(checkConsent({ channel: 'email', contact: c, now: NOON_UTC }), { allowed: false, reason: 'opted_out' });
});

test('an opt-in with the same timestamp as the opt-out does not override it', () => {
  const c = contact({
    consents: [
      { channel: 'email', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
      { channel: 'email', action: 'opt_in', at: '2026-02-01T00:00:00Z', source: 'contact' },
    ],
  });
  assert.deepEqual(checkConsent({ channel: 'email', contact: c, now: NOON_UTC }), { allowed: false, reason: 'opted_out' });
});

test('a channel-wide opt-out (all) blocks every channel, and a later channel opt-in does not lift it', () => {
  const blocked = contact({
    consents: [
      { channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' },
      { channel: 'all', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
    ],
  });
  assert.deepEqual(checkConsent({ channel: 'sms', contact: blocked, now: NOON_UTC }), { allowed: false, reason: 'opted_out' });

  const notReinstated = contact({
    consents: [
      { channel: 'all', action: 'opt_out', at: '2026-02-01T00:00:00Z', source: 'contact' },
      { channel: 'sms', action: 'opt_in', at: '2026-03-01T00:00:00Z', source: 'contact' },
    ],
  });
  assert.deepEqual(checkConsent({ channel: 'sms', contact: notReinstated, now: NOON_UTC }), { allowed: false, reason: 'opted_out' });
});

test('quiet hours: outside the window is allowed', () => {
  const r = checkConsent({
    channel: 'email',
    contact: contact({ timezone: 'UTC' }),
    now: '2026-11-03T20:00:00Z',
    quietHours: { startHour: 9, endHour: 17 },
  });
  assert.deepEqual(r, { allowed: true });
});

test('quiet hours use the recipient timezone: Melbourne recipient at 23:00 is held', () => {
  const r = checkConsent({
    channel: 'email',
    contact: contact({ timezone: MELBOURNE }),
    now: NOON_UTC,
    quietHours: LATE_NIGHT_WINDOW,
  });
  assert.deepEqual(r, { allowed: false, reason: 'quiet_hours' });
});

test('quiet hours use the recipient timezone: New York recipient at 07:00 is allowed', () => {
  const r = checkConsent({
    channel: 'email',
    contact: contact({ timezone: NEW_YORK }),
    now: NOON_UTC,
    quietHours: LATE_NIGHT_WINDOW,
  });
  assert.deepEqual(r, { allowed: true });
});

test('a timezone passed on the input is ignored: only the recipient zone counts', () => {
  // The company zone would be UTC (12:00, outside the window). The recipient zone is Melbourne (23:00, inside).
  const r = checkConsent({
    channel: 'telegram',
    contact: contact({ handles: { telegram: '@ada' }, timezone: MELBOURNE, consents: [
      { channel: 'telegram', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' },
    ] }),
    now: NOON_UTC,
    quietHours: LATE_NIGHT_WINDOW,
    timezone: 'UTC',
  });
  assert.deepEqual(r, { allowed: false, reason: 'quiet_hours' });
});

test('fail closed: a window is set and the contact has no timezone, so the send is refused', () => {
  const missing = contact();
  assert.deepEqual(
    checkConsent({ channel: 'email', contact: missing, now: NOON_UTC, quietHours: LATE_NIGHT_WINDOW }),
    { allowed: false, reason: 'invalid_contact' },
  );
  const blank = contact({ timezone: '   ' });
  assert.deepEqual(
    checkConsent({ channel: 'email', contact: blank, now: NOON_UTC, quietHours: LATE_NIGHT_WINDOW }),
    { allowed: false, reason: 'invalid_contact' },
  );
});

test('fail closed: an unknown timezone name is refused, not read as UTC', () => {
  const c = contact({ timezone: 'Mars/Olympus' });
  assert.deepEqual(
    checkConsent({ channel: 'email', contact: c, now: NOON_UTC, quietHours: LATE_NIGHT_WINDOW }),
    { allowed: false, reason: 'invalid_contact' },
  );
});

test('no window set: a missing timezone does not block the send', () => {
  assert.deepEqual(
    checkConsent({ channel: 'email', contact: contact(), now: NOON_UTC, quietHours: null }),
    { allowed: true },
  );
});

test('one-to-one reply path: a messenger reply to a Melbourne recipient is held in their late evening', () => {
  const c = contact({
    handles: { messenger: 'ada.m' },
    timezone: MELBOURNE,
    consents: [{ channel: 'messenger', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
  });
  assert.deepEqual(
    checkConsent({ channel: 'messenger', contact: c, now: NOON_UTC, quietHours: LATE_NIGHT_WINDOW }),
    { allowed: false, reason: 'quiet_hours' },
  );
});

test('isQuietHours refuses a missing or invalid timezone instead of guessing one', () => {
  assert.throws(() => isQuietHours(NOON_UTC, LATE_NIGHT_WINDOW, undefined), RangeError);
  assert.throws(() => isQuietHours(NOON_UTC, LATE_NIGHT_WINDOW, ''), RangeError);
  assert.throws(() => isQuietHours(NOON_UTC, LATE_NIGHT_WINDOW, 'Mars/Olympus'), RangeError);
});

test('isQuietHours inside and outside a same-day window', () => {
  const window = { startHour: 9, endHour: 17 };
  assert.equal(isQuietHours('2026-11-03T09:00:00Z', window, 'UTC'), true, 'start hour is inside');
  assert.equal(isQuietHours('2026-11-03T16:59:00Z', window, 'UTC'), true, 'last minute is inside');
  assert.equal(isQuietHours('2026-11-03T17:00:00Z', window, 'UTC'), false, 'end hour is outside');
  assert.equal(isQuietHours('2026-11-03T08:59:00Z', window, 'UTC'), false, 'before start is outside');
});

test('isQuietHours handles a window that crosses midnight', () => {
  const window = { startHour: 22, endHour: 6 };
  assert.equal(isQuietHours('2026-11-03T23:30:00Z', window, 'UTC'), true, 'late evening is inside');
  assert.equal(isQuietHours('2026-11-04T03:00:00Z', window, 'UTC'), true, 'after midnight is inside');
  assert.equal(isQuietHours('2026-11-04T05:59:00Z', window, 'UTC'), true, 'just before end is inside');
  assert.equal(isQuietHours('2026-11-04T06:00:00Z', window, 'UTC'), false, 'end hour is outside');
  assert.equal(isQuietHours('2026-11-03T12:00:00Z', window, 'UTC'), false, 'midday is outside');
});

test('isQuietHours reads the hour in the given timezone, not UTC', () => {
  // 2026-11-03T12:00Z is 23:00 in Melbourne (AEDT, UTC+11), so a 22-06 window is active there.
  const window = { startHour: 22, endHour: 6 };
  assert.equal(isQuietHours(NOON_UTC, window, 'Australia/Melbourne'), true);
  assert.equal(isQuietHours(NOON_UTC, window, 'UTC'), false);
});

test('isQuietHours with no window or an empty window returns false', () => {
  assert.equal(isQuietHours(NOON_UTC, null, 'UTC'), false);
  assert.equal(isQuietHours(NOON_UTC, { startHour: 12, endHour: 12 }, 'UTC'), false);
});

test('parseOptOutKeyword matches each opt-out word as a whole message, any case', () => {
  for (const word of ['STOP', 'stop', 'Unsubscribe', 'END', 'cancel', 'QUIT', '  stop  ']) {
    assert.deepEqual(parseOptOutKeyword(word), { optOut: true }, `"${word}" should opt out`);
  }
});

test('parseOptOutKeyword ignores keywords that are part of a longer message', () => {
  for (const text of ['stop it', 'Please stop texting me', 'STOP.', 'do not stop', 'ending', 'quit my job']) {
    assert.deepEqual(parseOptOutKeyword(text), { optOut: false }, `"${text}" must not opt out`);
  }
});

test('parseOptOutKeyword recognises START and YES as opt-in only when the whole message is that word', () => {
  assert.deepEqual(parseOptOutKeyword('START'), { optOut: false, optIn: true });
  assert.deepEqual(parseOptOutKeyword('yes'), { optOut: false, optIn: true });
  assert.deepEqual(parseOptOutKeyword('yes please'), { optOut: false });
  assert.deepEqual(parseOptOutKeyword('start my order'), { optOut: false });
});

test('parseOptOutKeyword returns no opt-out for non-string input', () => {
  assert.deepEqual(parseOptOutKeyword(undefined), { optOut: false });
  assert.deepEqual(parseOptOutKeyword(null), { optOut: false });
  assert.deepEqual(parseOptOutKeyword(42), { optOut: false });
});
