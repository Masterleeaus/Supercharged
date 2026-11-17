/**
 * Vector store port and the in-memory path for tests (Phase 1, W4, issue #378).
 *
 * Every read and write is scoped by companyId and by the owning user. A search never returns a chunk from
 * another company or from another user's knowledge. The in-memory store is for tests only and must not be
 * mounted in a running server. The Postgres store is the W5 work (see vector-pg/).
 *
 * Licence: original TitanZero code. It copies no Mastra or VoltAgent source. See source/mastra-apache-only/README.md.
 */
export interface StoredChunk {
  companyId: string;
  ownerUserId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  chunkText: string;
  vector: readonly number[];
}

export interface ScopedSearch {
  companyId: string;
  ownerUserId: string;
  vector: readonly number[];
  limit: number;
}

export interface SearchHit {
  companyId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  chunkText: string;
  score: number;
}

export interface VectorStore {
  upsert(chunks: readonly StoredChunk[]): Promise<void>;
  search(query: ScopedSearch): Promise<SearchHit[]>;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Test-only store. Holds chunks in memory and scores them with cosine similarity. */
export function createInMemoryVectorStoreForTests(): VectorStore {
  const rows: StoredChunk[] = [];
  return {
    async upsert(chunks) {
      for (const chunk of chunks) {
        if (!chunk.companyId || !chunk.ownerUserId) throw new Error('vector_scope_required');
        rows.push({ ...chunk, vector: [...chunk.vector] });
      }
    },
    async search(query) {
      if (!query.companyId) throw new Error('vector_scope_required');
      if (!query.ownerUserId) throw new Error('vector_scope_required');
      if (!Number.isSafeInteger(query.limit) || query.limit < 1) throw new Error('vector_limit_invalid');
      return rows
        .filter((row) => row.companyId === query.companyId && row.ownerUserId === query.ownerUserId)
        .map((row) => ({
          companyId: row.companyId,
          knowledgeBaseId: row.knowledgeBaseId,
          chunkIndex: row.chunkIndex,
          chunkText: row.chunkText,
          score: cosineSimilarity(row.vector, query.vector),
        }))
        .sort((a, b) => b.score - a.score || a.knowledgeBaseId.localeCompare(b.knowledgeBaseId) || a.chunkIndex - b.chunkIndex)
        .slice(0, query.limit);
    },
  };
}
