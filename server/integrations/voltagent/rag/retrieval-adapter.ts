/**
 * RAG retrieval adapter (W4).
 *
 * Chunks documents with VoltAgent's SentenceChunker (@voltagent/rag), then ranks the chunks with the
 * existing keyword retrieval in server/services/ai-runtime/retrieval.ts. The output is that module's
 * RetrievalResult, so callers see the same shape as before.
 *
 * Off unless VOLTAGENT_RAG_ENABLED is exactly "true". When it is off, retrieveRagChunks() rejects
 * with AiRuntimeError('config_invalid') before it reads any document.
 *
 * Nothing here calls a database or a provider. The memory store is for tests and small in-process use.
 * The Postgres store is a later workstream and is not started here.
 */
import { SentenceChunker, whitespaceTokenizer, type Chunk } from '@voltagent/rag';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import {
  retrieveChunks,
  type ChunkCandidate,
  type DocumentMetadata,
  type RetrievalPolicy,
  type RetrievalResult,
  type RetrievalStore,
  type RetrievalStoreQuery,
} from '../../../services/ai-runtime/retrieval.ts';
import { AiRuntimeError, type CompanyId } from '../../../services/ai-runtime/types.ts';
import { readVoltAgentFlags } from '../flags.ts';

/** Token budget per chunk. The whitespace tokenizer counts words, which is close enough for keyword scoring. */
export const DEFAULT_CHUNK_MAX_TOKENS = 256;

export interface RagDocument {
  /** Positive integer, the same id the existing document store uses. */
  documentId: number;
  text: string;
  metadata?: Partial<DocumentMetadata>;
}

export interface RagRetrievalInput {
  companyId: CompanyId | number;
  query: string;
  documents: readonly RagDocument[];
  policy?: RetrievalPolicy;
  limit?: number;
  maxTokens?: number;
  /** Defaults to process.env. Passed in by tests. */
  env?: NodeJS.ProcessEnv;
}

const chunker = new SentenceChunker(whitespaceTokenizer);

/** Throws unless VOLTAGENT_RAG_ENABLED is exactly "true". */
export function assertRagEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!readVoltAgentFlags(env).ragEnabled) {
    throw new AiRuntimeError('config_invalid', 'VOLTAGENT_RAG_ENABLED is not "true"; RAG retrieval is off');
  }
}

function normaliseMetadata(partial: Partial<DocumentMetadata> | undefined): DocumentMetadata {
  return {
    title: partial?.title ?? null,
    doc_type: partial?.doc_type ?? null,
    authority_level: partial?.authority_level ?? null,
    jurisdiction: partial?.jurisdiction ?? null,
    is_superseded: partial?.is_superseded === true,
    preferred_weight: Number(partial?.preferred_weight ?? 0),
    source: partial?.source ?? null,
  };
}

/**
 * Splits every document into chunks for one tenant. chunk_index counts from 0 within each document.
 * Throws input_invalid for a bad document id or a repeated document id.
 */
export async function chunkDocuments(
  companyId: CompanyId,
  documents: readonly RagDocument[],
  maxTokens: number = DEFAULT_CHUNK_MAX_TOKENS,
): Promise<ChunkCandidate[]> {
  const seen = new Set<number>();
  const candidates: ChunkCandidate[] = [];

  for (const doc of documents) {
    if (!Number.isSafeInteger(doc.documentId) || doc.documentId < 1) {
      throw new AiRuntimeError('input_invalid', 'documentId must be a positive integer');
    }
    if (seen.has(doc.documentId)) {
      throw new AiRuntimeError('input_invalid', `documentId ${doc.documentId} appears more than once`);
    }
    seen.add(doc.documentId);

    const chunks: Chunk[] = await chunker.chunk(doc.text ?? '', { maxTokens, docId: String(doc.documentId) });
    const metadata = normaliseMetadata(doc.metadata);
    chunks.forEach((chunk, chunkIndex) => {
      candidates.push({
        company_id: companyId,
        document_id: doc.documentId,
        chunk_index: chunkIndex,
        content: chunk.content,
        document: metadata,
      });
    });
  }

  return candidates;
}

/**
 * In-memory RetrievalStore over a fixed list of candidates. Keeps only the candidates of the requested
 * tenant that contain a query term. It orders them by how many terms they contain, then applies the limit,
 * so a strong match is not cut off by insertion order.
 */
export function createMemoryRetrievalStore(candidates: readonly ChunkCandidate[]): RetrievalStore {
  return {
    async findCandidates({ companyId, terms, limit }: RetrievalStoreQuery): Promise<ChunkCandidate[]> {
      const matches: { candidate: ChunkCandidate; hits: number }[] = [];
      for (const candidate of candidates) {
        if (candidate.company_id !== companyId) continue;
        const text = candidate.content.toLowerCase();
        const hits = terms.filter((term) => text.includes(term)).length;
        if (hits > 0) matches.push({ candidate, hits });
      }
      matches.sort((a, b) => b.hits - a.hits);
      return matches.slice(0, limit).map((m) => m.candidate);
    },
  };
}

/**
 * Chunks the documents for one tenant and returns the top chunks for the query.
 * Rejects when the flag is off. Returns [] for an empty document list or a query with no usable terms.
 */
export async function retrieveRagChunks(input: RagRetrievalInput): Promise<RetrievalResult[]> {
  assertRagEnabled(input.env);
  const companyId = requireCompanyId(input.companyId);
  const candidates = await chunkDocuments(companyId, input.documents, input.maxTokens);
  return retrieveChunks({
    companyId,
    query: input.query,
    policy: input.policy,
    limit: input.limit,
    store: createMemoryRetrievalStore(candidates),
  });
}
