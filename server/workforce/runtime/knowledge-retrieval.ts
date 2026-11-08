/**
 * Company-scoped retrieval over the existing knowledge base (checklist section 9).
 *
 * Rules:
 * - The company comes from the caller's verified context, never from the query or params. A missing or invalid
 *   company is refused before the search port is called.
 * - Search is done through an injected port, so this module writes no SQL and holds no database handle. The port is
 *   expected to wrap the existing knowledge search (server/services/rag-knowledge.ts, searchKnowledge). That search
 *   filters by user, not company, so the port must scope to the company's knowledge bases.
 * - Every hit is checked again here. A hit whose companyId is missing or differs from the requested company is dropped
 *   and counted in `dropped`. Legacy rows with no company are therefore never returned.
 * - Every result carries a source reference, `kb:<knowledgeBaseId>:<chunkIndex>`, which is a 'record' basis
 *   for citations.ts. Uploaded documents are company-supplied records, not generated summaries.
 * - Errors are generic codes. Provider or database messages are never returned.
 */

import { tryCompanyId } from '../../services/ai-runtime/company.ts'
import type { CompanyId } from '../../services/ai-runtime/types.ts'
import { isUsableRecordId } from './citations.ts'
import type { ToolDefinition } from './tool-registry.ts'

export const MAX_QUERY_LENGTH = 500
export const MAX_RESULTS_CAP = 10
export const DEFAULT_MAX_RESULTS = 5
export const MAX_SNIPPET_LENGTH = 800

const KB_ID = /^[A-Za-z0-9_-]{1,100}$/

export interface KnowledgeChunkHit {
  knowledgeBaseId: string
  chunkIndex: number
  chunkText: string
  /** The company the chunk belongs to. Null or missing means the hit is dropped. */
  companyId: unknown
  score: number
}

export interface KnowledgeSearchPort {
  /** The port must scope the search to the company's knowledge bases and to the owning user. */
  searchChunks(input: { companyId: CompanyId; userId: string; query: string; limit: number }): Promise<readonly KnowledgeChunkHit[]>
}

export interface KnowledgeResult {
  sourceRef: string
  kind: 'record'
  snippet: string
  score: number
}

export type RetrievalErrorCode = 'company_required' | 'user_required' | 'invalid_query' | 'retrieval_failed'

export type RetrievalOutcome =
  | { ok: true; results: KnowledgeResult[]; dropped: number }
  | { ok: false; error: RetrievalErrorCode }

export interface RetrievalRequest {
  companyId: unknown
  userId: unknown
  query: unknown
  maxResults?: unknown
}

const clampLimit = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS
  return Math.min(MAX_RESULTS_CAP, Math.max(1, Math.floor(value)))
}

const sourceRefFor = (hit: KnowledgeChunkHit): string | null => {
  if (typeof hit.knowledgeBaseId !== 'string' || !KB_ID.test(hit.knowledgeBaseId)) return null
  if (!Number.isSafeInteger(hit.chunkIndex) || hit.chunkIndex < 0) return null
  const ref = `kb:${hit.knowledgeBaseId}:${hit.chunkIndex}`
  return isUsableRecordId(ref) ? ref : null
}

/**
 * Searches the company's knowledge base. Fails closed on a missing company or an invalid query.
 * Never throws: an error from the port becomes { ok: false, error: 'retrieval_failed' }.
 */
export async function retrieveCompanyKnowledge(
  port: KnowledgeSearchPort,
  request: RetrievalRequest,
): Promise<RetrievalOutcome> {
  const companyId = tryCompanyId(request.companyId)
  if (companyId === null) return { ok: false, error: 'company_required' }

  const userId = request.userId
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 255) {
    return { ok: false, error: 'user_required' }
  }

  if (typeof request.query !== 'string' || request.query.trim().length === 0
    || request.query.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: 'invalid_query' }
  }

  const limit = clampLimit(request.maxResults)

  let hits: readonly KnowledgeChunkHit[]
  try {
    hits = await port.searchChunks({ companyId, userId, query: request.query, limit })
  } catch {
    return { ok: false, error: 'retrieval_failed' }
  }
  if (!Array.isArray(hits)) return { ok: false, error: 'retrieval_failed' }

  let dropped = 0
  const results: KnowledgeResult[] = []
  for (const hit of hits) {
    if (hit === null || typeof hit !== 'object') { dropped += 1; continue }
    if (tryCompanyId(hit.companyId) !== companyId) { dropped += 1; continue }
    const sourceRef = sourceRefFor(hit)
    if (sourceRef === null || typeof hit.chunkText !== 'string') { dropped += 1; continue }
    results.push({
      sourceRef,
      kind: 'record',
      snippet: hit.chunkText.slice(0, MAX_SNIPPET_LENGTH),
      score: Number.isFinite(hit.score) ? hit.score : 0,
    })
  }

  results.sort((a, b) => b.score - a.score)
  return { ok: true, results: results.slice(0, limit), dropped }
}

/**
 * Tool-facing wrapper for the runtime tool registry. The company is read from the handler context, which the
 * registry fills from the verified session. Any companyId in the params is ignored.
 */
export function createKnowledgeSearchTool(port: KnowledgeSearchPort): ToolDefinition {
  return {
    id: 'knowledge.search',
    risk: 'low',
    access: 'read',
    schema: {
      query: { type: 'string', required: true },
      maxResults: { type: 'number' },
    },
    handler: (params, context) => retrieveCompanyKnowledge(port, {
      companyId: context.companyId,
      // The user is read from the handler context when the registry supplies one. Absent means refused.
      userId: (context as { userId?: unknown }).userId,
      query: params.query,
      maxResults: params.maxResults,
    }),
  }
}
