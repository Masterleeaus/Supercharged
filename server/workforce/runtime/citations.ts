import { tryCompanyId } from '../../services/ai-runtime/company.ts'

/**
 * Citation checks for recommendations (checklist section 9).
 *
 * A consequential recommendation must cite at least one verified business record.
 * Generated summaries and predictions are labelled as such and never count as proof.
 * Sources are classified by kind; no free text from a source is ever returned.
 * - A 'record' source without a usable recordId is 'invalid'.
 * - A recordId must be 1 to 128 characters of letters, digits, '.', '_', ':' or '-'.
 *   Anything else is treated as invalid so that no free text reaches a citation.
 * - sourceUrl is accepted but never echoed into citations.
 */

export type SourceKind = 'record' | 'summary' | 'prediction'

export type CitationSource = {
  kind: SourceKind
  recordId?: string
  sourceUrl?: string
}

export type Basis = 'verified_record' | 'generated_summary' | 'prediction' | 'invalid'

export type ClassifiedSource = { basis: Basis; recordId?: string }

export type RecommendationCheck =
  | { consequential: boolean; sources: CitationSource[] }

export type CheckResult =
  | { ok: true; citations: string[] }
  | { ok: false; reason: 'needs_verified_citation' }

const RECORD_ID = /^[A-Za-z0-9._:-]{1,128}$/

const usableRecordId = (value: unknown): value is string =>
  typeof value === 'string' && RECORD_ID.test(value)

export function classifyBasis(source: CitationSource): { basis: Basis } {
  if (source === null || typeof source !== 'object') return { basis: 'invalid' }
  switch (source.kind) {
    case 'record':
      return { basis: usableRecordId(source.recordId) ? 'verified_record' : 'invalid' }
    case 'summary':
      return { basis: 'generated_summary' }
    case 'prediction':
      return { basis: 'prediction' }
    default:
      return { basis: 'invalid' }
  }
}

const label = (source: CitationSource, basis: Basis): string | null => {
  if (basis === 'verified_record') return `record ${source.recordId}`
  if (basis === 'generated_summary') return 'summary (generated)'
  if (basis === 'prediction') return 'prediction (generated)'
  return null
}

export function formatCitations(sources: CitationSource[]): string[] {
  const out: string[] = []
  for (const source of sources) {
    const { basis } = classifyBasis(source)
    const text = label(source, basis)
    if (text !== null) out.push(text)
  }
  return out
}

export function checkRecommendation(input: RecommendationCheck): CheckResult {
  const sources = Array.isArray(input.sources) ? input.sources : []
  const citations = formatCitations(sources)

  if (!input.consequential) return { ok: true, citations }

  const hasVerified = sources.some((s) => classifyBasis(s).basis === 'verified_record')
  if (!hasVerified) return { ok: false, reason: 'needs_verified_citation' }

  return { ok: true, citations }
}

/**
 * True when a recordId is safe to use in a citation: 1 to 128 characters from the allowed set.
 * Exported so that retrieval code builds source references that this module will accept.
 */
export const isUsableRecordId = (value: unknown): value is string => usableRecordId(value)

export type RetrievalCheck = {
  consequential: boolean
  /** The verified company, from the session. Missing or invalid means refuse. */
  companyId: unknown
  sources: CitationSource[]
  /**
   * The recordIds that company-scoped retrieval returned for this company in this run. A record source only
   * counts as verified when its recordId is in this set. Summaries and predictions never count.
   */
  retrievedRecordIds: ReadonlySet<string> | readonly string[]
}

export type RetrievalCheckResult =
  | { ok: true; citations: string[] }
  | { ok: false; reason: 'company_required' | 'needs_verified_citation' }

/**
 * Like checkRecommendation, but a consequential recommendation also needs a verified record that the company's
 * own retrieval returned. A caller cannot make a record count by naming an id. Fails closed when the company is
 * missing or invalid, even for a recommendation that is not consequential, so no output is attributed to no tenant.
 */
export function checkRecommendationAgainstRetrieval(input: RetrievalCheck): RetrievalCheckResult {
  if (tryCompanyId(input.companyId) === null) return { ok: false, reason: 'company_required' }

  const sources = Array.isArray(input.sources) ? input.sources : []
  const citations = formatCitations(sources)
  if (!input.consequential) return { ok: true, citations }

  const retrieved = input.retrievedRecordIds instanceof Set
    ? input.retrievedRecordIds
    : new Set(Array.isArray(input.retrievedRecordIds) ? input.retrievedRecordIds : [])

  const hasVerified = sources.some((s) => {
    const { basis } = classifyBasis(s)
    return basis === 'verified_record' && retrieved.has(s.recordId as string)
  })
  if (!hasVerified) return { ok: false, reason: 'needs_verified_citation' }

  return { ok: true, citations }
}
