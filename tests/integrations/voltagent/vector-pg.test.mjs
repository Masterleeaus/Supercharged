// Licence: original TitanZero test code. No Mastra or VoltAgent source is copied.
// Runs against a real Postgres with the pgvector extension. Set VOLTAGENT_TEST_DATABASE_URL to enable.
// Optional: VOLTAGENT_PG_MODULE points at the pg module when it is not resolvable from the repo.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { describe, before, after } from 'node:test';
import { createPgVectorStore } from '../../../server/integrations/voltagent/vector-pg/pg-vector-store.ts';

const URL_ = process.env.VOLTAGENT_TEST_DATABASE_URL;
const SKIP = URL_ ? false : 'VOLTAGENT_TEST_DATABASE_URL not set';
const DIMS = 3;

describe('pgvector store against real Postgres (gate G7)', { skip: SKIP }, () => {
  let client;
  let table;
  let store;

  before(async () => {
    const mod = await import(process.env.VOLTAGENT_PG_MODULE || 'pg');
    const pg = mod.default ?? mod;
    client = new pg.Client({ connectionString: URL_ });
    await client.connect();
    table = `vt_w5_${randomBytes(4).toString('hex')}`;
    store = createPgVectorStore({ db: client, table, dimensions: DIMS });
    await store.ensureSchema();
  });

  after(async () => {
    if (client) {
      await client.query(`DROP TABLE IF EXISTS "${table}"`);
      await client.end();
    }
  });

  const row = (companyId, ownerUserId, kb, idx, text, vector, metadata) => ({
    companyId, ownerUserId, knowledgeBaseId: kb, chunkIndex: idx, chunkText: text, vector, metadata,
  });

  test('ensureSchema creates the table and an HNSW cosine index', async () => {
    const idx = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexdef ILIKE '%hnsw%' AND indexdef ILIKE '%vector_cosine_ops%'`,
      [table],
    );
    assert.equal(idx.rows.length, 1);
    const ext = await client.query(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    assert.equal(ext.rows.length, 1);
  });

  test('upsert then search returns company and user scoped rows, best score first', async () => {
    await store.upsert([
      row('7', 'u1', 'kb-a', 0, 'boiler', [1, 0, 0]),
      row('7', 'u1', 'kb-a', 1, 'pool', [0, 1, 0]),
      row('7', 'u2', 'kb-b', 0, 'other user boiler', [1, 0, 0]),
      row('8', 'u1', 'kb-c', 0, 'other company boiler', [1, 0, 0]),
    ]);
    const hits = await store.search({ companyId: '7', ownerUserId: 'u1', vector: [1, 0, 0], limit: 10 });
    assert.deepEqual(hits.map((h) => h.chunkText), ['boiler', 'pool']);
    assert.ok(hits[0].score > hits[1].score);
    assert.ok(hits.every((h) => h.companyId === '7'));
  });

  test('upsert on the same natural key updates the row and does not duplicate it', async () => {
    await store.upsert([row('7', 'u1', 'kb-a', 0, 'boiler v2', [1, 0, 0])]);
    const hits = await store.search({ companyId: '7', ownerUserId: 'u1', vector: [1, 0, 0], limit: 10 });
    assert.equal(hits.filter((h) => h.knowledgeBaseId === 'kb-a' && h.chunkIndex === 0).length, 1);
    assert.equal(hits.find((h) => h.chunkIndex === 0).chunkText, 'boiler v2');
  });

  test('metadata filter narrows results and cannot widen the company or user scope', async () => {
    await store.upsert([row('7', 'u1', 'kb-m', 0, 'tagged', [0, 0, 1], { region: 'vic' })]);
    const narrowed = await store.search({ companyId: '7', ownerUserId: 'u1', vector: [0, 0, 1], limit: 10, filter: { region: 'vic' } });
    assert.deepEqual(narrowed.map((h) => h.chunkText), ['tagged']);
    const none = await store.search({ companyId: '7', ownerUserId: 'u1', vector: [0, 0, 1], limit: 10, filter: { region: 'nsw' } });
    assert.equal(none.length, 0);
    const wider = await store.search({ companyId: '8', ownerUserId: 'u1', vector: [0, 0, 1], limit: 10, filter: { region: 'vic' } });
    assert.ok(wider.every((h) => h.companyId === '8'));
    assert.ok(!wider.some((h) => h.chunkText === 'tagged'));
  });

  test('filter keys and values are validated before SQL is built', async () => {
    await assert.rejects(() => store.search({ companyId: '7', ownerUserId: 'u1', vector: [1, 0, 0], limit: 5, filter: { "a'b": 'x' } }), /pg_filter_key_invalid/);
    await assert.rejects(() => store.search({ companyId: '7', ownerUserId: 'u1', vector: [1, 0, 0], limit: 5, filter: { k: { nested: 1 } } }), /pg_filter_value_invalid/);
  });

  test('dimension mismatch, non-finite values and bad limits are refused', async () => {
    await assert.rejects(() => store.upsert([row('7', 'u1', 'kb-x', 9, 't', [1, 2])]), /pg_vector_dimension_mismatch/);
    await assert.rejects(() => store.upsert([row('7', 'u1', 'kb-x', 9, 't', [1, NaN, 0])]), /pg_vector_value_invalid/);
    await assert.rejects(() => store.search({ companyId: '7', ownerUserId: 'u1', vector: [1, 0, 0], limit: 0 }), /pg_limit_invalid/);
    await assert.rejects(() => store.search({ companyId: '7', ownerUserId: 'u1', vector: [1, 0, 0], limit: 101 }), /pg_limit_invalid/);
  });

  test('a missing company or user is refused before any query', async () => {
    await assert.rejects(() => store.search({ companyId: '', ownerUserId: 'u1', vector: [1, 0, 0], limit: 5 }), /pg_scope_company_invalid/);
    await assert.rejects(() => store.search({ companyId: '7', ownerUserId: '', vector: [1, 0, 0], limit: 5 }), /pg_scope_user_invalid/);
  });

  test('G7: with sequential scans disabled, the search plan uses the HNSW index', async () => {
    // Realistic shape: the table is shared by many tenants and the searched scope is one slice of it.
    // With only the searched scope in the table, the scope btree index matches every row and the planner
    // can prefer it over HNSW, so the other tenants are seeded here.
    const rows = [];
    for (let c = 10; c < 20; c += 1) {
      for (let i = 0; i < 200; i += 1) {
        rows.push(row(String(c), `u${c}`, `kb-${c}`, i, `other ${c} ${i}`, [Math.cos(i + c), Math.sin(i + c), (i + c) / 300]));
      }
    }
    for (let i = 0; i < 200; i += 1) {
      rows.push(row('9', 'g7', 'kb-g7', i, `chunk ${i}`, [Math.cos(i), Math.sin(i), i / 200]));
    }
    await store.upsert(rows);
    await client.query(`ANALYZE "${table}"`);
    await client.query('SET enable_seqscan = off');
    try {
      const plan = await store.explainSearch({ companyId: '9', ownerUserId: 'g7', vector: [1, 0, 0], limit: 5 });
      const text = JSON.stringify(plan);
      assert.ok(text.includes('Index Scan'), `expected an index scan node; plan: ${text.slice(0, 2000)}`);
      assert.ok(text.includes(`${table}_embedding_hnsw`), `expected the HNSW index in the plan; plan: ${text.slice(0, 2000)}`);
    } finally {
      await client.query('RESET enable_seqscan');
    }
  });

  test('a table name that is not a plain identifier is refused at construction', () => {
    assert.throws(() => createPgVectorStore({ db: client, table: 'x; DROP TABLE y', dimensions: DIMS }), /pg_identifier_invalid/);
  });
});
