// Tenant isolation for the chatbot tables on main: 0010c (chatbots, conversations, messages) and
// 0016 (event outbox, webhook subscriptions and deliveries, reminder sends and attempts).
// Runs only against the disposable PostgreSQL built by scripts/tenant-postgres-prepare.mjs (CI job tenant-postgres).
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { A, B, enabled } from './tenant-postgres-support.mjs';
import { createDrizzleEventsStore } from '../../server/modules/chatbot/events/drizzle-store.ts';
import { createDrizzleProviderStore } from '../../server/modules/chatbot/booking-providers/drizzle-store.ts';
import { createDrizzleAttemptLog } from '../../server/modules/chatbot/booking-providers/reminder-attempt-log.ts';

const CHATBOT_TABLES = [
  'chatbot_webhook_deliveries',
  'chatbot_webhook_subscriptions',
  'chatbot_event_outbox',
  'chatbot_booking_reminder_attempts',
  'chatbot_booking_reminder_sends',
  'chatbot_messages',
  'chatbot_conversations',
  'chatbots',
];

function setup() {
  const pool = new pg.Pool({ connectionString: process.env.TENANT_PG_INTEGRATION_URL, max: 4 });
  const db = drizzle(pool);
  const reset = () => pool.query(`TRUNCATE ${CHATBOT_TABLES.join(', ')} CASCADE`);
  return { pool, db, reset, close: () => pool.end() };
}

function outboxEvent(id, dedupeKey, now) {
  return {
    id,
    topic: 'booking.created',
    aggregateId: `agg-${id}`,
    payload: { id },
    dedupeKey,
    status: 'pending',
    attempts: 0,
    availableAt: now,
    publishedAt: null,
    createdAt: now,
    lockedAt: null,
    lockedBy: null,
    realtimePublishedAt: null,
    lastError: null,
  };
}

async function expectFkViolation(promise) {
  await assert.rejects(promise, (error) => error.code === '23503');
}

test('PostgreSQL chatbot: 0010c child rows cannot point at another company parent', { skip: !enabled }, async () => {
  const f = setup();
  try {
    await f.reset();
    await f.pool.query(`INSERT INTO chatbots (id, company_id, title) VALUES ('bot-a', $1, 'A bot'), ('bot-b', $2, 'B bot')`, [A, B]);
    await f.pool.query(
      `INSERT INTO chatbot_conversations (id, company_id, chatbot_id, session_id) VALUES ('conv-a', $1, 'bot-a', 's-a'), ('conv-b', $2, 'bot-b', 's-b')`,
      [A, B],
    );
    // Company A cannot open a conversation under company B's chatbot.
    await expectFkViolation(
      f.pool.query(`INSERT INTO chatbot_conversations (company_id, chatbot_id, session_id) VALUES ($1, 'bot-b', 's-x')`, [A]),
    );
    // Company B cannot attach a message to company A's conversation.
    await expectFkViolation(
      f.pool.query(`INSERT INTO chatbot_messages (company_id, conversation_id, role, message) VALUES ($1, 'conv-a', 'user', 'leak')`, [B]),
    );
    // Same-company child rows still insert.
    await f.pool.query(`INSERT INTO chatbot_messages (company_id, conversation_id, role, message) VALUES ($1, 'conv-a', 'user', 'ok')`, [A]);
    const { rows } = await f.pool.query(`SELECT count(*)::int AS n FROM chatbot_messages WHERE company_id = $1`, [B]);
    assert.equal(rows[0].n, 0);
  } finally {
    await f.close();
  }
});

test('PostgreSQL chatbot: 0016 webhook deliveries cannot cross companies', { skip: !enabled }, async () => {
  const f = setup();
  try {
    await f.reset();
    const store = createDrizzleEventsStore(f.db);
    const now = new Date('2026-11-15T09:00:00Z');
    await store.appendEvent(A, outboxEvent('evt-a', 'dk-a', now));
    await store.appendEvent(B, outboxEvent('evt-b', 'dk-b', now));
    const sub = { id: 'sub-a', url: 'https://a.example/hook', topics: ['booking.created'], active: true, signingSecret: 'sealed-a' };
    await store.insertSubscription(A, sub);
    await store.insertSubscription(B, { ...sub, id: 'sub-b', signingSecret: 'sealed-b' });
    // A delivery under company A cannot reference company B's event or subscription.
    await expectFkViolation(
      f.pool.query(
        `INSERT INTO chatbot_webhook_deliveries (company_id, event_id, subscription_id, attempt, ok) VALUES ($1, 'evt-b', 'sub-a', 1, true)`,
        [A],
      ),
    );
    await expectFkViolation(
      f.pool.query(
        `INSERT INTO chatbot_webhook_deliveries (company_id, event_id, subscription_id, attempt, ok) VALUES ($1, 'evt-a', 'sub-b', 1, true)`,
        [A],
      ),
    );
  } finally {
    await f.close();
  }
});

test('PostgreSQL chatbot: event outbox store is scoped per company', { skip: !enabled }, async () => {
  const f = setup();
  try {
    await f.reset();
    const store = createDrizzleEventsStore(f.db);
    const now = new Date('2026-11-15T09:00:00Z');
    // Same event id and dedupe key in both companies: the primary key and dedupe index are per company.
    const rowA = await store.appendEvent(A, outboxEvent('evt-1', 'same-key', now));
    const rowB = await store.appendEvent(B, outboxEvent('evt-1', 'same-key', now));
    assert.equal(rowA.companyId, A);
    assert.equal(rowB.companyId, B);

    // Company A's claim returns only company A's event, and leaves company B's row unlocked.
    const claimed = await store.claimBatch(A, 10, now, { workerId: 'w-a', leaseSeconds: 60 });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].companyId, A);
    const { rows: beforeB } = await f.pool.query(`SELECT locked_by, status FROM chatbot_event_outbox WHERE company_id = $1`, [B]);
    assert.deepEqual(beforeB, [{ locked_by: null, status: 'pending' }]);

    // A write scoped to company B cannot use company A's lease to publish B's row.
    assert.equal(await store.markPublished(B, 'evt-1', now, 'w-a'), false);
    // Company A publishes its own row; company B's row is still pending.
    assert.equal(await store.markPublished(A, 'evt-1', now, 'w-a'), true);
    const { rows: stateB } = await f.pool.query(`SELECT status FROM chatbot_event_outbox WHERE company_id = $1`, [B]);
    assert.equal(stateB[0].status, 'pending');

    // Dead letters are listed per company only.
    assert.equal(await store.markDeadLetter(B, 'evt-1', { failedAt: now, lastError: 'boom' }), true);
    assert.deepEqual(await store.listDeadLetters(A, 10), []);
    const deadB = await store.listDeadLetters(B, 10);
    assert.equal(deadB.length, 1);
    assert.equal(deadB[0].companyId, B);

    // An invalid company id fails closed at the query, never as a wildcard.
    await assert.rejects(store.claimBatch('not-a-company', 10, now, { workerId: 'w', leaseSeconds: 60 }));
  } finally {
    await f.close();
  }
});

test('PostgreSQL chatbot: webhook subscriptions and deliveries are listed per company', { skip: !enabled }, async () => {
  const f = setup();
  try {
    await f.reset();
    const store = createDrizzleEventsStore(f.db);
    const now = new Date('2026-11-15T09:00:00Z');
    await store.appendEvent(A, outboxEvent('evt-1', 'k-a', now));
    await store.appendEvent(B, outboxEvent('evt-1', 'k-b', now));
    const base = { url: 'https://hooks.example/x', topics: ['booking.created'], active: true };
    // Same subscription id in both companies.
    await store.insertSubscription(A, { ...base, id: 'sub-1', signingSecret: 'sealed-a' });
    await store.insertSubscription(B, { ...base, id: 'sub-1', signingSecret: 'sealed-b' });

    const subsA = await store.listSubscriptions(A);
    assert.equal(subsA.length, 1);
    assert.equal(subsA[0].companyId, A);
    assert.equal(subsA[0].signingSecret, 'sealed-a');

    await store.recordDelivery(A, { subscriptionId: 'sub-1', eventId: 'evt-1', attempt: 1, httpStatus: 200, ok: true, errorMessage: null, deliveredAt: now });
    assert.equal((await store.listDeliveries(A, 'evt-1')).length, 1);
    // Company B sees none of company A's delivery attempts for the same event id.
    assert.deepEqual(await store.listDeliveries(B, 'evt-1'), []);
  } finally {
    await f.close();
  }
});

test('PostgreSQL chatbot: reminder ledger claims, completes and releases per company', { skip: !enabled }, async () => {
  const f = setup();
  try {
    await f.reset();
    const { ledger } = createDrizzleProviderStore(f.db);
    const now = new Date('2026-11-15T09:00:00Z');
    // The same appointment id can exist in two companies, and each company gets its own once-per-booking claim.
    assert.equal(await ledger.claim(A, 'appt-1', 'email', 'idem-a', now), true);
    assert.equal(await ledger.claim(B, 'appt-1', 'email', 'idem-b', now), true);
    assert.equal(await ledger.claim(A, 'appt-1', 'email', 'idem-a2', now), false);

    assert.equal((await ledger.find(A, 'appt-1', 'email')).idempotencyKey, 'idem-a');
    assert.equal((await ledger.find(B, 'appt-1', 'email')).idempotencyKey, 'idem-b');

    // Company A completes its send; company B's row stays in sending with no message id.
    await ledger.complete(A, 'appt-1', 'email', { status: 'sent', externalMessageId: 'msg-a' }, now);
    const sentB = await ledger.find(B, 'appt-1', 'email');
    assert.equal(sentB.status, 'sending');
    assert.equal(sentB.externalMessageId, null);
    assert.equal((await ledger.find(A, 'appt-1', 'email')).externalMessageId, 'msg-a');

    // Company B releasing its claim cannot remove company A's sent row.
    await ledger.release(B, 'appt-1', 'email');
    assert.equal(await ledger.find(B, 'appt-1', 'email'), null);
    assert.equal((await ledger.find(A, 'appt-1', 'email')).status, 'sent');

    // Cancelling company A's appointment does not touch another company's row for the same id.
    await ledger.claim(B, 'appt-2', 'sms', 'idem-b2', now);
    await ledger.cancel(A, 'appt-2', 'sms', now);
    assert.equal((await ledger.find(B, 'appt-2', 'sms')).status, 'sending');

    // An empty company id is refused before any query runs.
    await assert.rejects(ledger.claim('', 'appt-3', 'email', 'idem', now));
    await assert.rejects(ledger.find(undefined, 'appt-1', 'email'));
  } finally {
    await f.close();
  }
});

test('PostgreSQL chatbot: reminder attempt log counts per company', { skip: !enabled }, async () => {
  const f = setup();
  try {
    await f.reset();
    const log = createDrizzleAttemptLog(f.db);
    const entry = (companyId, status) => ({
      companyId,
      appointmentId: 'appt-1',
      channel: 'email',
      attemptNo: 1,
      status,
      idempotencyKey: `idem-${companyId}`,
      externalMessageId: null,
      reason: null,
    });
    await log.record(entry(A, 'sent'));
    await log.record(entry(A, 'error'));
    await log.record(entry(B, 'failed'));
    assert.equal(await log.countAttempts(A, 'appt-1', 'email'), 2);
    assert.equal(await log.countAttempts(B, 'appt-1', 'email'), 1);
    assert.equal(await log.countAttempts('', 'appt-1', 'email').catch(() => 'rejected'), 'rejected');
  } finally {
    await f.close();
  }
});
