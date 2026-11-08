// Response-time targets (node:test). Pure functions only: no database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dueAt,
  breachStatus,
  targetFor,
} from '../../server/modules/comms/response-targets.ts';

const MIN = 60_000;
const utc = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

// 2026-11-02 is a Monday; 2026-11-03 is a Tuesday (checked against Date below).
test('calendar anchors used by these tests are the expected weekdays', () => {
  assert.equal(new Date(utc(2026, 11, 2)).getUTCDay(), 1); // Mon
  assert.equal(new Date(utc(2026, 11, 6)).getUTCDay(), 5); // Fri
  assert.equal(new Date(utc(2026, 11, 7)).getUTCDay(), 6); // Sat
  assert.equal(new Date(utc(2026, 11, 8)).getUTCDay(), 0); // Sun
});

test('dueAt with no business hours is receivedAt plus the target', () => {
  const received = utc(2026, 11, 6, 22, 15); // Friday night, no clock pause
  assert.equal(dueAt({ receivedAt: received, targetMinutes: 90 }), received + 90 * MIN);
  assert.equal(dueAt({ receivedAt: received, targetMinutes: 0 }), received);
});

test('dueAt business clock skips the night and the weekend', () => {
  const bh = { startHour: 9, endHour: 17, timezone: 'UTC', days: [1, 2, 3, 4, 5] };

  // Friday 16:30, 60 minutes: 30 minutes left Friday, so Monday 09:30.
  assert.equal(
    dueAt({ receivedAt: utc(2026, 11, 6, 16, 30), targetMinutes: 60, businessHours: bh }),
    utc(2026, 11, 9, 9, 30),
  );

  // Monday 18:00 (after hours), 10 hours: Tuesday 8h (09:00-17:00), Wednesday 2h -> 11:00.
  assert.equal(
    dueAt({ receivedAt: utc(2026, 11, 2, 18, 0), targetMinutes: 600, businessHours: bh }),
    utc(2026, 11, 4, 11, 0),
  );

  // Saturday 10:00 (weekend), 30 minutes: Monday 09:30.
  assert.equal(
    dueAt({ receivedAt: utc(2026, 11, 7, 10, 0), targetMinutes: 30, businessHours: bh }),
    utc(2026, 11, 9, 9, 30),
  );

  // Received exactly at closing time, with a zero target: due at receipt.
  assert.equal(
    dueAt({ receivedAt: utc(2026, 11, 2, 17, 0), targetMinutes: 0, businessHours: bh }),
    utc(2026, 11, 2, 17, 0),
  );
});

test('dueAt business clock counts a partial minute from a non-aligned receipt', () => {
  const bh = { startHour: 9, endHour: 17, timezone: 'UTC', days: [1, 2, 3, 4, 5] };
  // Received 08:59:30 on Monday, 1 minute target: the clock starts at 09:00:00, due 09:01.
  const received = utc(2026, 11, 2, 8, 59) + 30_000;
  assert.equal(
    dueAt({ receivedAt: received, targetMinutes: 1, businessHours: bh }),
    utc(2026, 11, 2, 9, 1),
  );
});

test('dueAt handles a window that crosses midnight', () => {
  const bh = { startHour: 22, endHour: 6, timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6] };

  // Monday 05:00 is inside the overnight window: 60 minutes to 06:00, then 22:00-23:00 Monday.
  assert.equal(
    dueAt({ receivedAt: utc(2026, 11, 2, 5, 0), targetMinutes: 120, businessHours: bh }),
    utc(2026, 11, 2, 23, 0),
  );

  // Monday 21:30 is before the window opens, so the clock starts at 22:00 and 60 minutes end at 23:00.
  assert.equal(
    dueAt({ receivedAt: utc(2026, 11, 2, 21, 30), targetMinutes: 60, businessHours: bh }),
    utc(2026, 11, 2, 23, 0),
  );

  // Crossing midnight into business days only: the 22:00 shift counts on Friday, not on a Sunday.
  const weekdaysOnly = { startHour: 22, endHour: 6, timezone: 'UTC', days: [1, 2, 3, 4, 5] };
  // Saturday 02:00 belongs to Friday's night shift, so it is business time: 60 minutes -> 03:00.
  assert.equal(
    dueAt({ receivedAt: utc(2026, 11, 7, 2, 0), targetMinutes: 60, businessHours: weekdaysOnly }),
    utc(2026, 11, 7, 3, 0),
  );
  // Sunday 02:00 belongs to Saturday's shift, which is not a business day. Next opens Monday 22:00.
  assert.equal(
    dueAt({ receivedAt: utc(2026, 11, 8, 2, 0), targetMinutes: 30, businessHours: weekdaysOnly }),
    utc(2026, 11, 9, 22, 30),
  );
});

test('dueAt respects the business timezone (Melbourne, AEDT +11 in November)', () => {
  const bh = { startHour: 9, endHour: 17, timezone: 'Australia/Melbourne', days: [1, 2, 3, 4, 5] };
  // Monday 16:30 local = 05:30 UTC. 30 minutes left Monday, then Tuesday 09:00 local = Monday 22:00 UTC.
  assert.equal(
    dueAt({ receivedAt: utc(2026, 11, 2, 5, 30), targetMinutes: 60, businessHours: bh }),
    utc(2026, 11, 2, 22, 30),
  );
});

test('dueAt rejects invalid business hours', () => {
  const base = { receivedAt: utc(2026, 11, 2, 9, 0), targetMinutes: 10 };
  assert.throws(() => dueAt({ ...base, businessHours: { startHour: 9, endHour: 9, timezone: 'UTC', days: [1] } }), RangeError);
  assert.throws(() => dueAt({ ...base, businessHours: { startHour: 9, endHour: 17, timezone: 'UTC', days: [] } }), RangeError);
  assert.throws(() => dueAt({ ...base, businessHours: { startHour: 9, endHour: 17, timezone: 'UTC', days: [7] } }), RangeError);
  assert.throws(() => dueAt({ ...base, businessHours: { startHour: 9, endHour: 17, timezone: 'Not/AZone', days: [1] } }), RangeError);
});

test('breachStatus: reply on or before the due time is replied', () => {
  assert.equal(breachStatus({ dueAt: 1000, repliedAt: 900, now: 2000 }), 'replied');
  assert.equal(breachStatus({ dueAt: 1000, repliedAt: 1000, now: 2000 }), 'replied');
});

test('breachStatus: a late reply is breached even though it was answered', () => {
  assert.equal(breachStatus({ dueAt: 1000, repliedAt: 1200, now: 1500 }), 'breached');
  assert.equal(breachStatus({ dueAt: 1000, repliedAt: 1001, now: 1001 }), 'breached');
});

test('breachStatus: no reply after the due time is breached, before it is open', () => {
  assert.equal(breachStatus({ dueAt: 1000, repliedAt: null, now: 1001 }), 'breached');
  assert.equal(breachStatus({ dueAt: 1000, now: 5000 }), 'breached');
  assert.equal(breachStatus({ dueAt: 1000, repliedAt: null, now: 1000 }), 'open');
  assert.equal(breachStatus({ dueAt: 1000, repliedAt: undefined, now: 900 }), 'open');
});

test('targetFor uses the channel value when present', () => {
  assert.equal(targetFor('email', { default: 240, email: 60 }), 60);
  assert.equal(targetFor('sms', { default: 240, sms: 0 }), 0);
});

test('targetFor falls back to the default for an unknown channel', () => {
  assert.equal(targetFor('whatsapp', { default: 240, email: 60 }), 240);
});

test('targetFor refuses when there is no default and no channel target', () => {
  assert.throws(
    () => targetFor('whatsapp', { email: 60 }),
    (err) => err.message === 'no_target' && err.code === 'no_target',
  );
  assert.throws(
    () => targetFor('email', {}),
    (err) => err.code === 'no_target',
  );
});
