/**
 * Retriever: embeds the query, reads candidate vectors for one chatbot and one embedding model, scores them
 * by cosine similarity in app code, and returns the best topK above minScore.
 *
 * Port of KnowledgeBase::call (PHP), which took the top 5 of every embedding with no threshold. The contract
 * adds topK and minScore. Ties are broken by source, ordinal and chunk id so the order is stable.
 */
import type { ModelProvider, ModelProviderKey, RetrievalQuery, RetrievedChunk, Retriever } from "../contracts/index.ts";
import { CONTRACT_FLAGS, readFlag as defaultReadFlag, type FlagEnv, type ReadFlag } from "../contracts/index.ts";
import { requireCompanyId } from "../chatbot-scope.ts";
import { cosineSimilarity } from "./cosine.ts";
import { type EmbeddingModel, embedInputs } from "./embedding.ts";
import { KnowledgeError } from "./errors.ts";

/** One candidate row: a ready source's chunk with its vector for the requested model. */
export interface EmbeddedCandidate {
  companyId: string;
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  ordinal: number;
  text: string;
  vector: number[];
}

/**
 * Read port for retrieval. Implementations must filter by companyId and chatbotId, return only chunks of
 * ready sources, and return only embeddings whose provider, model and dimensions match exactly.
 */
export interface KnowledgeCandidateReader {
  listCandidates(
    companyId: string,
    chatbotId: string,
    model: EmbeddingModel,
    sourceIds?: readonly string[],
  ): Promise<EmbeddedCandidate[]>;
}

export const RETRIEVAL_TOP_K_MAX = 50;

export interface KnowledgeRetrieverOptions {
  reader: KnowledgeCandidateReader;
  /** Looks up the provider for a key. Returns null when that provider is not configured. */
  providerFor: (key: ModelProviderKey) => ModelProvider | null;
  env: FlagEnv;
  readFlag?: ReadFlag;
}

export class KnowledgeRetriever implements Retriever {
  private readonly reader: KnowledgeCandidateReader;
  private readonly providerFor: (key: ModelProviderKey) => ModelProvider | null;
  private readonly env: FlagEnv;
  private readonly readFlag: ReadFlag;

  constructor(options: KnowledgeRetrieverOptions) {
    this.reader = options.reader;
    this.providerFor = options.providerFor;
    this.env = options.env;
    this.readFlag = options.readFlag ?? defaultReadFlag;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    const companyId = requireCompanyId(query.companyId);
    if (!this.readFlag(CONTRACT_FLAGS.KNOWLEDGE_ENABLED, this.env)) return [];

    if (!Number.isInteger(query.topK) || query.topK < 1 || query.topK > RETRIEVAL_TOP_K_MAX) {
      throw new KnowledgeError("invalid_input", `topK must be an integer from 1 to ${RETRIEVAL_TOP_K_MAX}.`);
    }
    if (!Number.isFinite(query.minScore) || query.minScore < -1 || query.minScore > 1) {
      throw new KnowledgeError("invalid_input", "minScore must be between -1 and 1.");
    }
    if (!Number.isInteger(query.timeoutMs) || query.timeoutMs < 1) {
      throw new KnowledgeError("invalid_input", "timeoutMs must be a positive integer.");
    }
    const text = query.text.trim();
    if (!text) return [];
    if (query.sourceIds && query.sourceIds.length === 0) return [];

    const model = query.embeddingModel;
    const provider = this.providerFor(model.provider);
    if (!provider) {
      throw new KnowledgeError("provider_unavailable", "The embedding provider is not configured.", 503);
    }
    const [queryVector] = await embedInputs(provider, companyId, model, [text], query.timeoutMs);

    const candidates = await this.reader.listCandidates(companyId, query.chatbotId, model, query.sourceIds);

    const scored: Array<RetrievedChunk & { sortKey: string }> = [];
    for (const row of candidates) {
      // Defence in depth: a row from another company is dropped even if the reader returned it.
      if (row.companyId !== companyId) continue;
      if (row.vector.length !== model.dimensions) continue;
      const score = cosineSimilarity(row.vector, queryVector);
      if (score < query.minScore) continue;
      scored.push({
        chunkId: row.chunkId,
        sourceId: row.sourceId,
        sourceTitle: row.sourceTitle,
        ordinal: row.ordinal,
        text: row.text,
        score,
        sortKey: `${row.sourceId}\u001f${String(row.ordinal).padStart(10, "0")}\u001f${row.chunkId}`,
      });
    }

    scored.sort((a, b) => b.score - a.score || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    return scored.slice(0, query.topK).map(({ sortKey: _sortKey, ...hit }) => hit);
  }
}
