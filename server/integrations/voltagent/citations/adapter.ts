/**
 * Adapter from the ai-runtime citation stage (server/services/ai-runtime/citation.ts) to a
 * VoltAgent-style citation function. Chunk lookup and the tenant check stay in citation.ts.
 * This adapter only maps the output. Matching claims to source sentences is not done here.
 * Checked against @voltagent/core 2.11.1 (dist/index.d.ts): that release declares no citation type, so
 * the output shape here is app-local, not a VoltAgent contract. Tenant check: chunks are loaded for the
 * tenant and any chunk whose company_id differs is dropped (see citation.ts).
 */
import { attachCitations, type ChunkRecord, type Citation } from '../../../services/ai-runtime/citation.ts';
import type { RetrievalResult } from '../../../services/ai-runtime/retrieval.ts';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';

export interface VoltCitationSource {
  title: string;
  url: string | null;
  reference: string | null;
  excerpt: string;
  chunk: { document_id: number; index: number };
}

export interface VoltCitationOutput {
  sources: VoltCitationSource[];
  unresolved: number;
}

export type ChunkLoader = (keys: { document_id: number; chunk_index: number }[], companyId: string) => Promise<ChunkRecord[]>;

export function toVoltCitation(citation: Citation): VoltCitationSource {
  return {
    title: citation.title,
    url: citation.source_url,
    reference: citation.module_reference,
    excerpt: citation.excerpt,
    chunk: { document_id: citation.document_id, index: citation.chunk_index },
  };
}

export function createVoltCitationResolver(loadChunks: ChunkLoader) {
  return async (results: readonly RetrievalResult[], companyId: string): Promise<VoltCitationOutput> => {
    const tenant = requireCompanyId(companyId);
    const outcome = await attachCitations({ companyId: tenant, results, loadChunks });
    return { sources: outcome.citations.map(toVoltCitation), unresolved: outcome.unresolved.length };
  };
}
