/**
 * Run and audit persistence, keyed by companyId. Every method takes companyId and checks it, so a run
 * stored for one company cannot be read with another company's id.
 *
 * - createMemoryRunStore(): in-memory, for tests and local use. Data is lost when the process exits.
 * - createUnavailableRunStore(): the production placeholder. Every call throws StoreUnavailableError until
 *   the schema exists. It is not a silent no-op, so a run can never look saved when it is not.
 *
 * The composition root injects the store. Nothing here imports the database.
 */
import { requireCompanyId } from '../../services/ai-runtime/company.ts';
import type { CompanyId } from '../../services/ai-runtime/types.ts';
import type { RunRecord } from './run.ts';

export const AUDIT_KINDS = [
  'run.created',
  'run.status',
  'run.retry',
  'run.handoff',
  'run.delegation',
  'run.delegation_closed',
  'run.approval_resumed',
  'tool.decision',
  'tool.execution',
  'workforce.export',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditEvent {
  id: string;
  /** null only for a call refused before a valid companyId was known. */
  companyId: CompanyId | null;
  runId: string | null;
  kind: AuditKind;
  at: string;
  /** Never holds raw params or raw output. Params are recorded as a hash. */
  data: Record<string, unknown>;
}

export interface AuditSink {
  record(event: AuditEvent): void | Promise<void>;
}

export class StoreUnavailableError extends Error {
  readonly code = 'store_unavailable';
  constructor(message = 'Run store is not configured. The workforce runtime schema has not been created.') {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}

/** Thrown when an update is based on a stale version of the run. The caller must reload and retry. */
export class RunVersionConflictError extends Error {
  readonly code = 'run_version_conflict';
  constructor(runId: string) {
    super(`run ${runId} was changed by another writer`);
    this.name = 'RunVersionConflictError';
  }
}

export interface RunStore {
  /** Stores a new run at version 1 and returns the stored copy. Throws if the id already exists. */
  insertRun(companyId: CompanyId, run: RunRecord): Promise<RunRecord>;
  /** Compare-and-set. Succeeds only if the stored version equals expectedVersion. Returns the copy at expectedVersion + 1. */
  updateRun(companyId: CompanyId, run: RunRecord, expectedVersion: number): Promise<RunRecord>;
  getRun(companyId: CompanyId, runId: string): Promise<RunRecord | null>;
  listRuns(companyId: CompanyId): Promise<RunRecord[]>;
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(companyId: CompanyId, runId?: string): Promise<AuditEvent[]>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface MemoryRunStore extends RunStore {
  /** Test helper: events recorded with companyId null (refusals before a valid company was known). */
  unscopedAudit(): AuditEvent[];
}

export function createMemoryRunStore(): MemoryRunStore {
  const runs = new Map<CompanyId, Map<string, RunRecord>>();
  const audit: AuditEvent[] = [];
  const unscoped: AuditEvent[] = [];

  function bucket(companyId: CompanyId): Map<string, RunRecord> {
    let existing = runs.get(companyId);
    if (!existing) {
      existing = new Map();
      runs.set(companyId, existing);
    }
    return existing;
  }

  return {
    async insertRun(companyId, run) {
      const scoped = requireCompanyId(companyId);
      if (run.companyId !== scoped) throw new Error('run companyId does not match the store call');
      const map = bucket(scoped);
      if (map.has(run.id)) throw new Error(`run already exists: ${run.id}`);
      const stored = { ...clone(run), version: 1 };
      map.set(run.id, stored);
      return clone(stored);
    },

    async updateRun(companyId, run, expectedVersion) {
      const scoped = requireCompanyId(companyId);
      if (run.companyId !== scoped) throw new Error('run companyId does not match the store call');
      const map = bucket(scoped);
      const current = map.get(run.id);
      if (!current) throw new Error(`run not found: ${run.id}`);
      if (current.version !== expectedVersion) throw new RunVersionConflictError(run.id);
      const stored = { ...clone(run), version: expectedVersion + 1 };
      map.set(run.id, stored);
      return clone(stored);
    },

    async getRun(companyId, runId) {
      const found = bucket(requireCompanyId(companyId)).get(runId);
      return found ? clone(found) : null;
    },

    async listRuns(companyId) {
      return [...bucket(requireCompanyId(companyId)).values()].map((r) => clone(r));
    },

    async appendAudit(event) {
      if (event.companyId === null) {
        unscoped.push(clone(event));
        return;
      }
      audit.push(clone({ ...event, companyId: requireCompanyId(event.companyId) }));
    },

    async listAudit(companyId, runId) {
      const scoped = requireCompanyId(companyId);
      return audit
        .filter((e) => e.companyId === scoped && (runId === undefined || e.runId === runId))
        .map((e) => clone(e));
    },

    unscopedAudit() {
      return unscoped.map((e) => clone(e));
    },
  };
}

/** Production placeholder. Every method throws until the run and audit tables exist. */
export function createUnavailableRunStore(): RunStore {
  const fail = async (): Promise<never> => {
    throw new StoreUnavailableError();
  };
  return {
    insertRun: fail,
    updateRun: fail,
    getRun: fail,
    listRuns: fail,
    appendAudit: fail,
    listAudit: fail,
  };
}
