/**
 * Adapter from the vector store to the workforce KnowledgeSearchPort (Phase 1, W4, issue #378).
 *
 * The port embeds the query with an injected embed function, then searches only the caller's company and
 * owning user. An embed failure is thrown. retrieveCompanyKnowledge turns a thrown error into
 * { ok: false, error: 'retrieval_failed' }, so nothing is returned on failure.
 *
 * Licence: original TitanZero code. It copies no Mastra or VoltAgent source. See source/mastra-apache-only/README.md.
 */
import type { KnowledgeChunkHit, KnowledgeSearchPort } from '../../../workforce/runtime/knowledge-retrieval.ts';
import type { VectorStore } from './vector-store.ts';

export type EmbedFn = (texts: readonly string[]) => Promise<number[][]>;

export interface KnowledgePortOptions {
  store: VectorStore;
  embed: EmbedFn;
}

export function createKnowledgeSearchPort(options: KnowledgePortOptions): KnowledgeSearchPort {
  if (!options || !options.store || typeof options.store.search !== 'function') throw new Error('knowledge_store_required');
  if (typeof options.embed !== 'function') throw new Error('knowledge_embed_required');

  return {
    async searchChunks({ companyId, userId, query, limit }) {
      const vectors = await options.embed([query]);
      if (!Array.isArray(vectors) || vectors.length !== 1 || !Array.isArray(vectors[0])) {
        throw new Error('embed_result_invalid');
      }
      const hits = await options.store.search({
        companyId: String(companyId),
        ownerUserId: userId,
        vector: vectors[0],
        limit,
      });
      return hits.map<KnowledgeChunkHit>((hit) => ({
        knowledgeBaseId: hit.knowledgeBaseId,
        chunkIndex: hit.chunkIndex,
        chunkText: hit.chunkText,
        companyId: hit.companyId,
        score: hit.score,
      }));
    },
  };
}
