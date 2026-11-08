/**
 * Citation attachment. Ported from TitanPro:
 *   - Modules/TitanZero/Services/Citations/CitationResolver.php (chunk lookup, source typing, excerpt)
 *   - Modules/TitanZero/DTO/Citation.php (result shape)
 *   - Modules/TitanCore/Contracts/AI/CitationContract.php (the pipeline stage contract)
 *
 * Attaches a source reference to each retrieved chunk. Matching a claim in the model's answer to a source
 * sentence is not done here, and TitanPro does not do it either. The pipeline attaches every retrieved chunk.
 *
 * Changes from TitanPro (see PORT-MAP.md):
 * - Chunks are loaded by an injected function that takes the tenant. Each loaded chunk is checked against
 *   companyId, and a mismatch is dropped. TitanPro's resolver queries chunks by document_id with no tenant
 *   check.
 * - Unresolvable chunks are returned in `unresolved`, not as null entries that callers must filter.
 *
 * Pure functions, plus one async wrapper around the injected loader.
 */
import { requireCompanyId, tryCompanyId } from './company.ts';
import type { CompanyId } from './types.ts';
import type { RetrievalResult } from './retrieval.ts';

export const CITATION_EXCERPT_MAX = 200;

export interface Citation {
  document_id: number;
  title: string;
  chunk_index: number;
  content_hash: string;
  /** Set only when the stored source is an http or https URL. */
  source_url: string | null;
  /** Set when the stored source is a module-scoped reference rather than a URL. */
  module_reference: string | null;
  excerpt: string;
}

export interface ChunkRecord {
  company_id: CompanyId;
  document_id: number;
  chunk_index: number;
  content: string;
  content_hash: string;
  document_title: string | null;
  document_source: string | null;
}

export interface CitationOutcome {
  citations: Citation[];
  unresolved: string[];
}

/** Parses "{document_id}:{chunk_index}" with digits only. Returns null for anything else. */
export function parseChunkId(chunkId: string): { document_id: number; chunk_index: number } | null {
  const parts = String(chunkId).split(':');
  if (parts.length !== 2) return null;
  const [doc, idx] = parts;
  if (!/^\d+$/.test(doc) || !/^\d+$/.test(idx)) return null;
  return { document_id: Number(doc), chunk_index: Number(idx) };
}

export function chunkKey(documentId: number, chunkIndex: number): string {
  return `${documentId}:${chunkIndex}`;
}

export function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

export function buildCitation(chunk: ChunkRecord): Citation {
  const source = chunk.document_source ?? '';
  const isUrl = isHttpUrl(source);
  return {
    document_id: chunk.document_id,
    title: chunk.document_title ?? 'Unknown source',
    chunk_index: chunk.chunk_index,
    content_hash: chunk.content_hash,
    source_url: isUrl ? source : null,
    module_reference: !isUrl && source !== '' ? source : null,
    excerpt: [...chunk.content].slice(0, CITATION_EXCERPT_MAX).join(''),
  };
}

/** Pure resolution against a map of already-loaded chunks keyed by "{document_id}:{chunk_index}". */
export function resolveCitations(input: {
  companyId: CompanyId;
  results: readonly RetrievalResult[];
  chunks: ReadonlyMap<string, ChunkRecord>;
}): CitationOutcome {
  const companyId = requireCompanyId(input.companyId);
  const citations: Citation[] = [];
  const unresolved: string[] = [];

  for (const result of input.results) {
    const chunk = input.chunks.get(chunkKey(result.document_id, result.chunk_index));
    if (!chunk || tryCompanyId(chunk.company_id) !== companyId) {
      unresolved.push(result.chunk_id);
      continue;
    }
    citations.push(buildCitation(chunk));
  }

  return { citations, unresolved };
}

/** Loads the chunks for the given results from the injected loader, then resolves them for the tenant. */
export async function attachCitations(input: {
  companyId: CompanyId;
  results: readonly RetrievalResult[];
  loadChunks: (keys: { document_id: number; chunk_index: number }[], companyId: CompanyId) => Promise<ChunkRecord[]>;
}): Promise<CitationOutcome> {
  const companyId = requireCompanyId(input.companyId);
  if (input.results.length === 0) return { citations: [], unresolved: [] };

  const keys = input.results.map((r) => ({ document_id: r.document_id, chunk_index: r.chunk_index }));
  const loaded = await input.loadChunks(keys, companyId);
  const map = new Map<string, ChunkRecord>();
  for (const chunk of loaded) {
    map.set(chunkKey(chunk.document_id, chunk.chunk_index), chunk);
  }
  return resolveCitations({ companyId, results: input.results, chunks: map });
}

/** Builds the citation stage used by the pipeline. Returns citations only; `unresolved` is dropped. */
export function createCitationStage(
  loadChunks: (keys: { document_id: number; chunk_index: number }[], companyId: CompanyId) => Promise<ChunkRecord[]>,
): (results: RetrievalResult[], companyId: CompanyId) => Promise<Citation[]> {
  return async (results, companyId) => (await attachCitations({ companyId, results, loadChunks })).citations;
}
