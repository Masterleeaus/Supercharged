// Chatbot conversation store: every method runs inside one tenant-scoped transaction.
// No database is reached. A pg.Pool subclass records every statement drizzle sends and
// returns empty rows, so the test checks the order of statements only.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createDrizzleConversationStore } from '../../server/modules/chatbot/runtime/drizzle-conversation-store.ts';
import { withTenantTransaction } from '../../server/infrastructure/database/tenant-transaction.ts';
import { TenantContextError } from '../../server/infrastructure/database/tenant-context.ts';

const COMPANY = '6f1c2a3e-9b7d-4c5a-8e21-0a1b2c3d4e51';
const CHATBOT = '3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a';
const CONVERSATION = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const MESSAGE = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const NOW = new Date('2026-11-15T10:00:00Z');

class RecordingPool extends pg.Pool {
  constructor() {
    super({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' });
    this.clients = [];
    this.poolQueries = [];
    this.clientCount = 0;
  }
  async query(text) {
    this.poolQueries.push(String(text));
    return { rows: [], rowCount: 0, fields: [] };
  }
  async connect() {
    const id = ++this.clientCount;
    const log = [];
    this.clients.push({ id, log });
    return {
      async query(text, values) {
        log.push({ text: typeof text === 'string' ? text : text.text, values });
        return { rows: [], rowCount: 0, fields: [] };
      },
      release() {},
    };
  }
}

/** Runs one store call against a fresh recording pool and returns what it sent. */
async function recordCall(run) {
  const pool = new RecordingPool();
  const db = drizzle(pool);
  const store = createDrizzleConversationStore(db);
  try {
    await run(store);
  } catch {
    // Empty rows make some mappers throw. The statement order is what this test checks.
  }
  const client = pool.clients[0];
  const log = client ? client.log : [];
  return { pool, log, poolQueries: pool.poolQueries };
}

const calls = {
  chatbotBelongsTo: (s) => s.chatbotBelongsTo(COMPANY, CHATBOT),
  conversationOfMessage: (s) => s.conversationOfMessage(COMPANY, MESSAGE),
  findConversation: (s) => s.findConversation(COMPANY, CONVERSATION),
  listMessages: (s) => s.listMessages(COMPANY, CONVERSATION),
  setSummary: (s) => s.setSummary(COMPANY, CONVERSATION, 'summary', NOW),
  searchConversations: (s) => s.searchConversations(COMPANY, { limit: 10 }),
  setStatus: (s) => s.setStatus(COMPANY, CONVERSATION, 'archived', NOW, null),
  mergeConversations: (s) => s.mergeConversations(COMPANY, CONVERSATION, MESSAGE, NOW, { type: 'x', payload: {} }),
};

for (const [name, run] of Object.entries(calls)) {
  test(`chatbot conversation ${name}: set_config runs first in the transaction, with the company id`, async () => {
    const { log, poolQueries } = await recordCall(run);
    assert.ok(log.length >= 3, `${name}: statements recorded on one client`);
    assert.match(log[0].text, /^\s*begin/i, `${name}: opens a transaction first`);
    assert.match(log[1].text, /set_config/, `${name}: sets the tenant second`);
    assert.deepEqual(log[1].values, ['app.company_id', COMPANY], `${name}: binds the company id as a parameter`);
    assert.equal(poolQueries.length, 0, `${name}: no statement runs outside the transaction`);
    const commitOrRollback = log.some((entry) => /^\s*(commit|rollback)/i.test(entry.text));
    assert.ok(commitOrRollback, `${name}: transaction ends with commit or rollback`);
  });
}

test('chatbot conversation store: an invalid company id is refused before any connection is taken', async () => {
  const pool = new RecordingPool();
  const store = createDrizzleConversationStore(drizzle(pool));
  await assert.rejects(() => store.findConversation('not-a-uuid', CONVERSATION), TenantContextError);
  await assert.rejects(() => store.insertReply("'; drop table x; --", CONVERSATION, { id: MESSAGE, text: 'x', createdAt: NOW }, null), TenantContextError);
  assert.equal(pool.clientCount, 0, 'no connection taken for an invalid tenant');
  assert.equal(pool.poolQueries.length, 0, 'no query sent');
});

test('withTenantTransaction: rejects a bad id before opening a transaction', async () => {
  let opened = 0;
  const fakeDb = { transaction: async () => { opened += 1; } };
  await assert.rejects(() => withTenantTransaction(fakeDb, '', async () => 1), TenantContextError);
  assert.equal(opened, 0);
});
