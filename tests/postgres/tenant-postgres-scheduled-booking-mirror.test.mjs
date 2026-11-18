// Tenant isolation for the Scheduled booking mirror (migration 0020: scheduled_booking_events and
// scheduled_booking_mirror). Runs only against the disposable PostgreSQL built by
// scripts/tenant-postgres-prepare.mjs (CI job tenant-postgres).
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { A, B, enabled } from './tenant-postgres-support.mjs';
import { createPgScheduledBookingStore } from '../../server/infrastructure/scheduled-booking-mirror/pg-store.ts';

const MIRROR_TABLES = ['scheduled_booking_mirror', 'scheduled_booking_events'];

function setup() {
  const pool = new pg.Pool({ connectionString: process.env.TENANT_PG_INTEGRATION_URL, max: 4 });
  const store = createPgScheduledBookingStore(pool);
  const reset = () => pool.query(`TRUNCATE ${MIRROR_TABLES.join(', ')}`);
  return { pool, store, reset, close: () => pool.end() };
}

/** A verified Scheduled event for one company. Same booking id and key are reused across companies on purpose. */
function event(companyId, overrides = {}) {
  return {
    companyId,
    idempotencyKey: 'evt-key-1',
    eventId: 'evt-1',
    eventType: 'booking_created',
    bookingId: 'bk-1',
    status: 'booked',
    startsAt: '2026-12-01T09:00:00Z',
    endsAt: '2026-12-01T10:00:00Z',
    occurredAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

test('PostgreSQL booking mirror: the same booking id and idempotency key in two companies are two separate rows', { skip: !enabled }, async () => {
  const f = setup();
  try {
    await f.reset();
    // Company B's first event carries the same key as company A's. It must apply, not read as a duplicate.
    assert.equal(await f.store.apply(event(A)), 'applied');
    assert.equal(await f.store.apply(event(B)), 'applied');
    const { rows } = await f.pool.query(`SELECT company_id, count(*)::int AS n FROM scheduled_booking_mirror GROUP BY company_id ORDER BY company_id`);
    assert.deepEqual(rows.map((r) => [r.company_id, r.n]), [[A, 1], [B, 1]]);
  } finally {
    await f.close();
  }
});

test('PostgreSQL booking mirror: a duplicate key in company A does not change company B', { skip: !enabled }, async () => {
  const f = setup();
  try {
    await f.reset();
    await f.store.apply(event(A));
    await f.store.apply(event(B, { status: 'cancelled', eventType: 'booking_cancelled', eventId: 'evt-b' }));
    // Replaying company A's event is a duplicate for A only; B keeps its cancelled state.
    assert.equal(await f.store.apply(event(A)), 'duplicate');
    const { rows } = await f.pool.query(`SELECT company_id, status FROM scheduled_booking_mirror WHERE booking_id = 'bk-1' ORDER BY company_id`);
    assert.deepEqual(rows.map((r) => [r.company_id, r.status]), [[A, 'booked'], [B, 'cancelled']]);
  } finally {
    await f.close();
  }
});

test('PostgreSQL booking mirror: a stale event for company A cannot overwrite a newer row in company A or touch B', { skip: !enabled }, async () => {
  const f = setup();
  try {
    await f.reset();
    await f.store.apply(event(A, { occurredAt: '2026-11-10T00:00:00Z', status: 'cancelled', eventType: 'booking_cancelled', eventId: 'evt-a2', idempotencyKey: 'evt-key-2' }));
    await f.store.apply(event(B, { occurredAt: '2026-11-01T00:00:00Z' }));
    // Older event for A arrives late. It is stale for A and leaves B's row alone.
    assert.equal(await f.store.apply(event(A, { occurredAt: '2026-11-01T00:00:00Z', idempotencyKey: 'evt-key-3', eventId: 'evt-a3' })), 'stale');
    const { rows } = await f.pool.query(`SELECT company_id, status FROM scheduled_booking_mirror WHERE booking_id = 'bk-1' ORDER BY company_id`);
    assert.deepEqual(rows.map((r) => [r.company_id, r.status]), [[A, 'cancelled'], [B, 'booked']]);
  } finally {
    await f.close();
  }
});

test('PostgreSQL booking mirror: company scoped reads return only that company rows', { skip: !enabled }, async () => {
  const f = setup();
  try {
    await f.reset();
    await f.store.apply(event(A));
    await f.store.apply(event(B, { bookingId: 'bk-b-only', idempotencyKey: 'evt-key-b', eventId: 'evt-b' }));
    const { rows: onlyA } = await f.pool.query(`SELECT booking_id FROM scheduled_booking_mirror WHERE company_id = $1`, [A]);
    const { rows: eventsB } = await f.pool.query(`SELECT booking_id FROM scheduled_booking_events WHERE company_id = $1`, [B]);
    assert.deepEqual(onlyA.map((r) => r.booking_id), ['bk-1']);
    assert.deepEqual(eventsB.map((r) => r.booking_id), ['bk-b-only']);
  } finally {
    await f.close();
  }
});
