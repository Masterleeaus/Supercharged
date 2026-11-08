import test from 'node:test';
import assert from 'node:assert/strict';

// No database. The fake executor records the audit insert values and returns them on a select.
const { createPgRunStore } = await import('../../server/workforce/runtime/pg-store.ts');
const { REDACTED } = await import('../../server/workforce/runtime/redact.ts');

const COMPANY_A = '6f1c2e3a-1111-4a5b-8c9d-00000000000a';
const RUN_ID = 'run-redact-1';
const TOKEN = 'abcDEF123456token7890';

function createFakeDb() {
  const inserts = [];
  return {
    inserts,
    async query(text, values) {
      if (text.includes('INSERT INTO workforce_audit_events')) {
        inserts.push({ text, values: [...values] });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected statement in redaction test: ${text.slice(0, 40)}`);
    },
  };
}

function makeEvent(overrides = {}) {
  return {
    id: 'audit-1',
    companyId: COMPANY_A,
    runId: RUN_ID,
    kind: 'tool.decision',
    at: '2026-11-03T09:00:00.000Z',
    data: {
      toolId: 'send-email',
      actorId: 'agent:tech',
      outcome: 'refused',
      detail: `Authorization: Bearer ${TOKEN} sent to jane.doe@example.com`,
    },
    ...overrides,
  };
}

test('an audit detail with a bearer token and an email is stored redacted', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  await store.appendAudit(makeEvent());

  assert.equal(db.inserts.length, 1);
  const stored = JSON.parse(db.inserts[0].values[6]);
  assert.ok(!stored.detail.includes(TOKEN), 'bearer token must not be stored');
  assert.ok(!stored.detail.includes('jane.doe@example.com'), 'full email must not be stored');
  assert.ok(stored.detail.includes(`Bearer ${REDACTED}`));
  assert.ok(stored.detail.includes('@example.com'), 'email domain is kept');
});

test('company id and action are stored unchanged', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  await store.appendAudit(makeEvent());

  const [id, company, run, kind, actor, outcome, , at] = db.inserts[0].values;
  assert.equal(id, 'audit-1');
  assert.equal(company, COMPANY_A);
  assert.equal(run, RUN_ID);
  assert.equal(kind, 'tool.decision');
  assert.equal(actor, 'agent:tech');
  assert.equal(outcome, 'refused');
  assert.equal(at, '2026-11-03T09:00:00.000Z');
});

test('the original event object is not mutated', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  const event = makeEvent();
  const before = structuredClone(event);
  await store.appendAudit(event);

  assert.deepEqual(event, before);
  assert.ok(event.data.detail.includes(TOKEN));
  assert.ok(event.data.detail.includes('jane.doe@example.com'));
});

test('a sensitive key in data is redacted and an event with no data still stores', async () => {
  const db = createFakeDb();
  const store = createPgRunStore(db);
  await store.appendAudit(makeEvent({ data: { apiKey: 'not-a-real-value', note: 'ok' } }));
  await store.appendAudit(makeEvent({ id: 'audit-2', data: undefined }));

  const first = JSON.parse(db.inserts[0].values[6]);
  assert.equal(first.apiKey, REDACTED);
  assert.equal(first.note, 'ok');
  assert.equal(db.inserts[1].values[6], '{}');
});
