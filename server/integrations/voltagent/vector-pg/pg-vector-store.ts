/**
 * pgvector store with an HNSW index (Phase 1, W5, issue #379; Mastra gap 1).
 *
 * Every read and write is scoped by company_id and owner_user_id as real columns, not metadata. A search
 * cannot return another company's or another user's rows, even when a filter is supplied. Filters apply
 * only to the jsonb metadata column.
 *
 * The database handle is injected. It needs one method, query(text, params) returning { rows }, which the pg
 * package's Pool provides. Nothing here opens a connection.
 *
 * Gate G7 (EXPLAIN plan) is checked by tests/integrations/voltagent/vector-pg.test.mjs against a real Postgres
 * with pgvector. Cosine distance (<=>) is used, so the vector_cosine_ops HNSW index applies.
 *
 * Licence: original TitanZero code. See source/mastra-apache-only/README.md. No Mastra source is copied.
 */
import { metadataFilterClause, quoteIdent, vectorLiteral, type FilterValue } from './sql.ts';

export interface QueryableDb {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PgVectorStoreOptions {
  db: QueryableDb;
  table: string;
  dimensions: number;
  hnsw?: { m?: number; efConstruction?: number };
}

export interface PgStoredChunk {
  companyId: string;
  ownerUserId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  chunkText: string;
  vector: readonly number[];
  metadata?: Readonly<Record<string, FilterValue>>;
}

export interface PgScopedSearch {
  companyId: string;
  ownerUserId: string;
  vector: readonly number[];
  limit: number;
  filter?: Readonly<Record<string, FilterValue>>;
}

export interface PgSearchHit {
  companyId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  chunkText: string;
  score: number;
}

export interface PgVectorStore {
  ensureSchema(): Promise<void>;
  upsert(chunks: readonly PgStoredChunk[]): Promise<void>;
  search(query: PgScopedSearch): Promise<PgSearchHit[]>;
  /** Returns the EXPLAIN (FORMAT JSON) plan for a search. Used by the G7 check. */
  explainSearch(query: PgScopedSearch): Promise<unknown>;
}

const MAX_LIMIT = 100;
const SAFE_SCOPE = /^[A-Za-z0-9_-]{1,100}$/;

function assertScope(companyId: string, ownerUserId: string): void {
  if (typeof companyId !== 'string' || !SAFE_SCOPE.test(companyId)) throw new Error('pg_scope_company_invalid');
  if (typeof ownerUserId !== 'string' || ownerUserId.length === 0 || ownerUserId.length > 255) {
    throw new Error('pg_scope_user_invalid');
  }
}

export function createPgVectorStore(options: PgVectorStoreOptions): PgVectorStore {
  if (!options || !options.db || typeof options.db.query !== 'function') throw new Error('pg_db_required');
  if (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 16000) {
    throw new Error('pg_dimensions_invalid');
  }
  const table = quoteIdent(options.table);
  const dims = options.dimensions;
  const m = options.hnsw?.m ?? 16;
  const efConstruction = options.hnsw?.efConstruction ?? 64;
  if (!Number.isSafeInteger(m) || m < 2 || m > 100) throw new Error('pg_hnsw_invalid');
  if (!Number.isSafeInteger(efConstruction) || efConstruction < 4 || efConstruction > 1000) throw new Error('pg_hnsw_invalid');
  const db = options.db;
  const indexName = quoteIdent(`${options.table}_embedding_hnsw`);
  const scopeIndexName = quoteIdent(`${options.table}_scope_idx`);

  return {
    async ensureSchema() {
      await db.query('CREATE EXTENSION IF NOT EXISTS vector');
      await db.query(
        `CREATE TABLE IF NOT EXISTS ${table} (
          id BIGSERIAL PRIMARY KEY,
          company_id TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          knowledge_base_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          chunk_text TEXT NOT NULL,
          embedding vector(${dims}) NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          CONSTRAINT ${quoteIdent(`${options.table}_natural_key`)} UNIQUE (company_id, owner_user_id, knowledge_base_id, chunk_index)
        )`,
      );
      await db.query(`CREATE INDEX IF NOT EXISTS ${scopeIndexName} ON ${table} (company_id, owner_user_id)`);
      await db.query(
        `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING hnsw (embedding vector_cosine_ops) WITH (m = ${m}, ef_construction = ${efConstruction})`,
      );
    },

    async upsert(chunks) {
      for (const chunk of chunks) {
        assertScope(chunk.companyId, chunk.ownerUserId);
        if (!Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0) throw new Error('pg_chunk_index_invalid');
        if (typeof chunk.knowledgeBaseId !== 'string' || chunk.knowledgeBaseId.length === 0) throw new Error('pg_kb_invalid');
        await db.query(
          `INSERT INTO ${table} (company_id, owner_user_id, knowledge_base_id, chunk_index, chunk_text, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)
           ON CONFLICT (company_id, owner_user_id, knowledge_base_id, chunk_index)
           DO UPDATE SET chunk_text = EXCLUDED.chunk_text, embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata`,
          [
            chunk.companyId,
            chunk.ownerUserId,
            chunk.knowledgeBaseId,
            chunk.chunkIndex,
            chunk.chunkText,
            vectorLiteral(chunk.vector, dims),
            JSON.stringify(chunk.metadata ?? {}),
          ],
        );
      }
    },

    async search(query) {
      const built = buildSearch(query);
      const result = await db.query(built.text, built.params);
      return result.rows.map((row) => ({
        companyId: String(row.company_id),
        knowledgeBaseId: String(row.knowledge_base_id),
        chunkIndex: Number(row.chunk_index),
        chunkText: String(row.chunk_text),
        score: Number(row.score),
      }));
    },

    async explainSearch(query) {
      const built = buildSearch(query);
      const result = await db.query(`EXPLAIN (FORMAT JSON) ${built.text}`, built.params);
      return result.rows[0];
    },
  };

  function buildSearch(query: PgScopedSearch): { text: string; params: unknown[] } {
    assertScope(query.companyId, query.ownerUserId);
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT) throw new Error('pg_limit_invalid');
    const literal = vectorLiteral(query.vector, dims);
    const filter = metadataFilterClause(query.filter, 'metadata', 4);
    const text = `SELECT company_id, knowledge_base_id, chunk_index, chunk_text,
        1 - (embedding <=> $1::vector) AS score
      FROM ${table}
      WHERE company_id = $2 AND owner_user_id = $3${filter.sql}
      ORDER BY embedding <=> $1::vector
      LIMIT ${query.limit}`;
    return { text, params: [literal, query.companyId, query.ownerUserId, ...filter.params] };
  }
}
