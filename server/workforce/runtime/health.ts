/**
 * Health report for the workforce runtime. Each dependency gets its own status, and the overall status is
 * ready only when every dependency is ready. The model is never ready in this build, so overall is never ready.
 *
 * The check reads only what the runtime already holds. It makes no database or network call.
 */
import type { Request, Response } from 'express';
import { getActiveWorkforceRuntime, type WorkforceRuntime } from './compose.ts';

export type DependencyStatus = 'ready' | 'not_ready';

export interface RuntimeHealth {
  status: 'ready' | 'not_ready';
  dependencies: {
    store: DependencyStatus;
    catalogue: DependencyStatus;
    approvals: DependencyStatus;
    policy: DependencyStatus;
    model: 'NOT CONFIGURED';
    identity: DependencyStatus;
  };
}

const STORE_METHODS = ['insertRun', 'updateRun', 'getRun', 'listRuns', 'appendAudit', 'listAudit'] as const;
const GATE_METHODS = ['gateAction', 'readApproval', 'claimApproval'] as const;

function status(ok: boolean): DependencyStatus {
  return ok ? 'ready' : 'not_ready';
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  return value !== null && typeof value === 'object' && names.every((name) => typeof (value as Record<string, unknown>)[name] === 'function');
}

/** Returns per-dependency status. A null runtime (nothing composed yet) reports every dependency not ready. */
export function runtimeHealth(runtime: WorkforceRuntime | null): RuntimeHealth {
  const dependencies: RuntimeHealth['dependencies'] = {
    store: status(runtime !== null && hasMethods(runtime.store, STORE_METHODS)),
    catalogue: status(runtime !== null && runtime.catalogue instanceof Map && runtime.catalogue.size > 0),
    approvals: status(runtime !== null && hasMethods(runtime.gate, GATE_METHODS)),
    policy: status(runtime !== null && typeof runtime.policyEvaluator === 'function'),
    // No model provider exists in this build. This entry is fixed and never ready.
    model: 'NOT CONFIGURED',
    identity: status(runtime !== null && runtime.companyScope !== null),
  };

  const modelReady = false;
  const allReady =
    dependencies.store === 'ready' &&
    dependencies.catalogue === 'ready' &&
    dependencies.approvals === 'ready' &&
    dependencies.policy === 'ready' &&
    dependencies.identity === 'ready' &&
    modelReady;

  return { status: allReady ? 'ready' : 'not_ready', dependencies };
}

/** Express handler for GET /api/workforce/health. Responds 200 when ready and 503 otherwise. Mounted behind authentication and the admin role. */
export function workforceHealthHandler(_req: Request, res: Response): void {
  const health = runtimeHealth(getActiveWorkforceRuntime());
  res.status(health.status === 'ready' ? 200 : 503).json(health);
}
