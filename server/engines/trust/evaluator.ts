/*
 * Evidence readiness evaluator. Pure: no I/O, no clock, no database.
 *
 * Given the evidence rules and evidence items a caller has already loaded, it
 * answers one question for one job: is the required evidence present?
 *
 * Rules are scored for specificity and the best match wins. Requirements not met
 * mean "not_ready". When no rule applies, the result is "no_rule" with ready =
 * false. Readiness is never granted by default.
 *
 * Every operation is bound to a company_id. Rules and items that belong to another
 * company are ignored, and a missing company_id throws.
 *
 * Clean-room port, see README.md. Written from observed behaviour only.
 */

export const DEFAULT_REQUIREMENT_TYPES = ['before', 'after', 'incident', 'signoff', 'general'] as const;

export interface EvidenceRule {
  id: string;
  companyId: string;
  /** Template the rule is written for, or null for "any template". */
  templateId: number | null;
  jobType: string | null;
  siteType: string | null;
  /** Minimum item count per evidence type. */
  required: Readonly<Record<string, unknown>>;
}

export interface EvidenceItem {
  companyId: string;
  jobId: string;
  evidenceType: string;
}

export interface ReadinessQuery {
  companyId: string;
  jobId: string;
  templateId?: number | null;
  jobType?: string | null;
  siteType?: string | null;
  rules: readonly EvidenceRule[];
  items: readonly EvidenceItem[];
}

export type ReadinessStatus = 'ready' | 'not_ready' | 'no_rule';

export interface ReadinessResult {
  status: ReadinessStatus;
  /** True only when status is 'ready'. */
  ready: boolean;
  rule: {
    id: string;
    templateId: number | null;
    jobType: string | null;
    siteType: string | null;
  } | null;
  required: Record<string, number>;
  captured: Record<string, number>;
  missing: Record<string, number>;
}

export class TrustReadinessError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'TrustReadinessError';
  }
}

const isPresent = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== '' && value !== 0;

const requireCompany = (companyId: unknown): string => {
  if (typeof companyId !== 'string' || companyId.trim() === '') {
    throw new TrustReadinessError('company_id_required');
  }
  return companyId;
};

const requireNonEmpty = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TrustReadinessError(code);
  }
  return value;
};

const toCount = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TrustReadinessError('invalid_required_count');
  }
  return value;
};

/**
 * Specificity score for one rule against the job's attributes. Higher is more
 * specific. Zero means the rule does not apply.
 *   template match              100
 *   job type and site type      80
 *   job type only               60
 *   site type only              40
 *   catch-all (no attributes)   10
 */
function specificity(rule: EvidenceRule, query: ReadinessQuery): number {
  const templateWanted = isPresent(query.templateId) ? query.templateId : null;
  const jobWanted = isPresent(query.jobType) ? query.jobType : null;
  const siteWanted = isPresent(query.siteType) ? query.siteType : null;

  if (templateWanted !== null && rule.templateId === templateWanted) return 100;
  if (jobWanted !== null && siteWanted !== null && rule.jobType === jobWanted && rule.siteType === siteWanted) {
    return 80;
  }
  if (jobWanted !== null && rule.jobType === jobWanted && !isPresent(rule.siteType)) return 60;
  if (siteWanted !== null && rule.siteType === siteWanted && !isPresent(rule.jobType)) return 40;
  if (!isPresent(rule.templateId) && !isPresent(rule.jobType) && !isPresent(rule.siteType)) return 10;
  return 0;
}

/**
 * Pick the most specific applicable rule for this company. On a tie, the rule that
 * appears first in the input wins. Returns null when nothing applies.
 */
export function selectEvidenceRule(query: ReadinessQuery): EvidenceRule | null {
  const companyId = requireCompany(query.companyId);
  let best: EvidenceRule | null = null;
  let bestScore = 0;

  for (const rule of query.rules) {
    if (rule.companyId !== companyId) continue;
    const score = specificity(rule, query);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Evaluate readiness for one job. Throws TrustReadinessError for malformed input
 * (missing company_id, bad job_id, non-integer required counts). It never returns
 * "ready" without a matching rule.
 */
export function evaluateEvidenceReadiness(query: ReadinessQuery): ReadinessResult {
  const companyId = requireCompany(query.companyId);
  const jobId = requireNonEmpty(query.jobId, 'job_id_required');

  const rule = selectEvidenceRule({ ...query, companyId });
  if (!rule) {
    return {
      status: 'no_rule',
      ready: false,
      rule: null,
      required: {},
      captured: {},
      missing: {},
    };
  }

  const required: Record<string, number> = {};
  for (const type of DEFAULT_REQUIREMENT_TYPES) required[type] = 0;
  for (const [type, value] of Object.entries(rule.required)) required[type] = toCount(value);

  const counts = new Map<string, number>();
  for (const item of query.items) {
    if (item.companyId !== companyId || item.jobId !== jobId) continue;
    counts.set(item.evidenceType, (counts.get(item.evidenceType) ?? 0) + 1);
  }

  const captured: Record<string, number> = {};
  const missing: Record<string, number> = {};
  let ready = true;

  for (const [type, need] of Object.entries(required)) {
    const have = counts.get(type) ?? 0;
    captured[type] = have;
    missing[type] = Math.max(0, need - have);
    if (missing[type] > 0) ready = false;
  }

  return {
    status: ready ? 'ready' : 'not_ready',
    ready,
    rule: {
      id: rule.id,
      templateId: rule.templateId,
      jobType: rule.jobType,
      siteType: rule.siteType,
    },
    required,
    captured,
    missing,
  };
}
