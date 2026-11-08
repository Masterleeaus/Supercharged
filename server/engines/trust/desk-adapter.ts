/*
 * Desk adapter for the trust readiness evaluator. Desk code.
 *
 * company_id is required on every call and is checked before persistence is touched.
 * Persistence must be injected. Without it every call refuses.
 */

import {
  evaluateEvidenceReadiness,
  type EvidenceItem,
  type EvidenceRule,
  type ReadinessResult,
} from './evaluator.ts';

export class DeskTrustError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'DeskTrustError';
  }
}

/** Persistence Desk binds. Implementations must scope every read to the company. */
export interface DeskReadinessPersistence {
  loadRules(companyId: string): Promise<EvidenceRule[]>;
  loadItems(companyId: string, jobId: string): Promise<EvidenceItem[]>;
}

export interface JobReadinessInput {
  companyId: string;
  jobId: string;
  templateId?: number | null;
  jobType?: string | null;
  siteType?: string | null;
}

const refusingPersistence: DeskReadinessPersistence = Object.freeze({
  loadRules: async () => {
    throw new DeskTrustError('persistence_not_injected');
  },
  loadItems: async () => {
    throw new DeskTrustError('persistence_not_injected');
  },
});

function requireCompanyId(companyId: unknown): string {
  if (typeof companyId !== 'string' || companyId.trim() === '') {
    throw new DeskTrustError('company_id_required');
  }
  return companyId;
}

export class DeskTrustReadiness {
  private readonly persistence: DeskReadinessPersistence;

  constructor(deps: { persistence?: DeskReadinessPersistence } = {}) {
    this.persistence = deps.persistence ?? refusingPersistence;
  }

  async evaluateJob(input: JobReadinessInput): Promise<ReadinessResult> {
    const companyId = requireCompanyId(input.companyId);
    const rules = await this.persistence.loadRules(companyId);
    const items = await this.persistence.loadItems(companyId, input.jobId);
    return evaluateEvidenceReadiness({
      companyId,
      jobId: input.jobId,
      ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
      ...(input.jobType !== undefined ? { jobType: input.jobType } : {}),
      ...(input.siteType !== undefined ? { siteType: input.siteType } : {}),
      rules,
      items,
    });
  }
}
