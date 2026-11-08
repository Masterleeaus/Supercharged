/**
 * Knowledge base port: sources (what the customer uploaded or linked), chunks (pieces of text), embeddings
 * (one vector per chunk), and retrieval.
 *
 * Decision (similarity): embeddings are stored as plain numeric arrays, not in a vector database extension.
 * Similarity is cosine similarity computed in application code over the candidate rows. Candidates are first
 * narrowed by companyId and chatbotId, and by sourceIds when given. This is fine at the expected scale
 * (a few thousand chunks per chatbot). If a chatbot grows past that, the Retriever port is the seam to swap in
 * an index. The Retriever interface does not change.
 * Each Embedding records its model and dimensions. Vectors from different models must never be compared.
 *
 * Every method takes companyId first, and every stored row carries companyId.
 */
import type { ModelProviderKey } from "./ai.ts";

export const KNOWLEDGE_SOURCE_KINDS = ["url", "file", "text", "product_feed", "faq"] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];

export const KNOWLEDGE_SOURCE_STATUSES = ["pending", "indexing", "ready", "failed", "disabled"] as const;
export type KnowledgeSourceStatus = (typeof KNOWLEDGE_SOURCE_STATUSES)[number];

export interface KnowledgeSource {
  id: string;
  companyId: string;
  chatbotId: string;
  kind: KnowledgeSourceKind;
  title: string;
  /** URL for url sources, attachment id for file sources, null otherwise. */
  uri: string | null;
  status: KnowledgeSourceStatus;
  /** Hash of the content last indexed. A match means re-indexing can be skipped. */
  contentHash: string | null;
  lastIndexedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewKnowledgeSource {
  chatbotId: string;
  kind: KnowledgeSourceKind;
  title: string;
  uri: string | null;
}

export interface KnowledgeChunk {
  id: string;
  companyId: string;
  sourceId: string;
  chatbotId: string;
  /** Position of the chunk within its source, starting at 0. */
  ordinal: number;
  text: string;
  tokenCount: number;
  contentHash: string;
  /** Optional: page, heading path, product id, and similar. */
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * Chunk as the indexer writes it. The id is optional: when given, Embedding.chunkId must name it, so the indexer
 * can derive ids before the write. Added by change request 1 (knowledge slice).
 */
export type KnowledgeChunkInput = Omit<KnowledgeChunk, "id" | "createdAt"> & { id?: string };

export interface Embedding {
  chunkId: string;
  companyId: string;
  provider: ModelProviderKey;
  model: string;
  dimensions: number;
  /** Plain numeric array. Length must equal dimensions. */
  vector: number[];
  createdAt: Date;
}

export interface KnowledgeStorage {
  insertSource(companyId: string, input: NewKnowledgeSource): Promise<KnowledgeSource>;
  getSource(companyId: string, sourceId: string): Promise<KnowledgeSource | null>;
  listSources(companyId: string, chatbotId: string): Promise<KnowledgeSource[]>;
  setSourceStatus(
    companyId: string,
    sourceId: string,
    status: KnowledgeSourceStatus,
    detail: { contentHash?: string; lastError?: string | null; lastIndexedAt?: Date },
  ): Promise<KnowledgeSource | null>;
  /** Replaces every chunk and embedding of one source in a single transaction. */
  replaceChunks(
    companyId: string,
    sourceId: string,
    chunks: KnowledgeChunkInput[],
    embeddings: Omit<Embedding, "createdAt">[],
  ): Promise<number>;
  deleteSource(companyId: string, sourceId: string): Promise<boolean>;
}

export interface RetrievalQuery {
  companyId: string;
  chatbotId: string;
  text: string;
  topK: number;
  /** Hits below this cosine score are dropped. Range -1 to 1. */
  minScore: number;
  /** Restricts retrieval to these sources. Omitted means every ready source of the chatbot. */
  sourceIds?: string[];
  /** Model whose embeddings are compared. Required so vectors from different models never mix. */
  embeddingModel: { provider: ModelProviderKey; model: string; dimensions: number };
  timeoutMs: number;
}

export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  ordinal: number;
  text: string;
  score: number;
}

export interface Retriever {
  retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]>;
}

// ---------------------------------------------------------------------------
// Read ports added by change requests (knowledge slice, items 2 and 4)
// ---------------------------------------------------------------------------

/** A knowledge-base article, read by the caller from the article owner's table. The knowledge slice never writes it. */
export interface KnowledgeArticleRecord {
  id: string;
  title: string;
  content: string;
}

/**
 * Read-only list of articles for a company. Added by change request 2 (knowledge slice). The article owner
 * implements it. Optional: the indexer still accepts records passed in by the caller.
 */
export interface KnowledgeArticleReader {
  listArticles(companyId: string, chatbotId: string): Promise<KnowledgeArticleRecord[]>;
}

/** One candidate row for retrieval: a ready source's chunk with its vector for the requested model. */
export interface KnowledgeCandidate {
  companyId: string;
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  ordinal: number;
  text: string;
  vector: number[];
}

/**
 * Read port for retrieval candidates. Added by change request 4 (knowledge slice). Implementations filter by
 * companyId and chatbotId, return only chunks of ready sources, and return only embeddings whose provider,
 * model and dimensions match exactly. The retriever in knowledge/ keeps its own structurally identical type.
 */
export interface KnowledgeCandidateReader {
  listCandidates(
    companyId: string,
    chatbotId: string,
    model: { provider: ModelProviderKey; model: string; dimensions: number },
    sourceIds?: readonly string[],
  ): Promise<KnowledgeCandidate[]>;
}
