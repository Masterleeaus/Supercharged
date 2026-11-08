/**
 * Workforce runtime metrics and alert rules (checklist section 11).
 *
 * Pure: no prom-client, no timers, no network. Time comes only from the injected `now()` (epoch milliseconds).
 * The server's Prometheus registry in server/services/metrics.ts can export these numbers; this module only
 * counts, computes windows, and reports which configured thresholds are breached.
 *
 * Alert rules fire when a value reaches its configured threshold (>=). A threshold that is not set never alerts.
 */
import type { AuditEvent, AuditSink } from './store.ts';

export interface WorkforceThresholds {
  /** Alert when runsFailed / runsStarted reaches this ratio (0..1). Needs at least one started run. */
  maxFailureRatio?: number;
  /** Alert when provider errors inside the window reach this count. */
  maxProviderErrors?: number;
  /** Sliding window for provider errors, in ms. Defaults to one hour. */
  providerErrorWindowMs?: number;
  /** Alert when cumulative spend (cents) reaches this cap. */
  maxSpendCents?: number;
  /** Alert per company when its actions in the trailing hour reach this count. */
  maxActionsPerCompanyPerHour?: number;
}

export type WorkforceEvent =
  | { kind: 'run_started'; companyId?: string }
  | { kind: 'run_completed'; companyId?: string }
  | { kind: 'run_failed'; companyId?: string }
  | { kind: 'escalation'; companyId?: string }
  | { kind: 'tool_refused'; companyId?: string }
  | { kind: 'tool_retry'; companyId?: string }
  | { kind: 'provider_error'; provider?: string }
  | { kind: 'spend'; cents: number; companyId?: string }
  | { kind: 'action'; companyId: string };

export interface WorkforceSnapshot {
  runsStarted: number;
  runsCompleted: number;
  /** runsCompleted / runsStarted (0..n). 0 when no run has started. */
  completionRate: number;
  runsFailed: number;
  /** Count of `escalation` events. */
  escalations: number;
  toolCallsRefused: number;
  toolRetries: number;
  approvalsPending: number;
  approvalsDelayed: number;
  providerErrors: number;
  spendCents: number;
  actions: number;
}

/** One company's view. Only counts that carry a companyId on the event are included; global-only signals are not. */
export interface CompanyWorkforceSnapshot {
  runsStarted: number;
  runsCompleted: number;
  /** runsCompleted / runsStarted. 0 when no run has started. */
  completionRate: number;
  runsFailed: number;
  /** runsFailed / runsStarted. 0 when no run has started. */
  errorRate: number;
  escalations: number;
  toolCallsRefused: number;
  toolRetries: number;
  spendCents: number;
  actions: number;
}

export interface WorkforceAlert {
  code: 'failure_ratio_high' | 'provider_errors_high' | 'spend_over_cap' | 'action_volume_high';
  severity: 'warning' | 'critical';
  message: string;
}

/**
 * Maps a run-engine audit record to the metric event it represents, or null when it counts nothing.
 *   run.status -> to 'running' from 'queued'  => run_started   (approval resumes are not starts)
 *   run.status -> to 'completed'              => run_completed
 *   run.status -> to 'failed'                 => run_failed
 *   run.handoff with escalation: true         => escalation
 *   run.retry                                 => tool_retry
 *   tool.decision with outcome 'refused'      => tool_refused
 */
export function workforceEventFromAudit(event: AuditEvent): WorkforceEvent | null {
  const companyId = event.companyId ?? undefined;
  if (event.kind === 'run.status') {
    if (event.data.to === 'running' && event.data.from === 'queued') return { kind: 'run_started', companyId };
    if (event.data.to === 'completed') return { kind: 'run_completed', companyId };
    if (event.data.to === 'failed') return { kind: 'run_failed', companyId };
    return null;
  }
  if (event.kind === 'run.handoff' && event.data.escalation === true) return { kind: 'escalation', companyId };
  if (event.kind === 'run.retry') return { kind: 'tool_retry', companyId };
  if (event.kind === 'tool.decision' && event.data.outcome === 'refused') return { kind: 'tool_refused', companyId };
  return null;
}

/** An audit sink that feeds the metrics from the run engine's own audit records. Other records pass through unchanged. */
export function metricsAuditSink(metrics: Pick<WorkforceMetrics, 'record'>): AuditSink {
  return {
    record(event) {
      const mapped = workforceEventFromAudit(event);
      if (mapped) metrics.record(mapped);
    },
  };
}

export interface WorkforceMetricsOptions {
  now: () => number;
  thresholds?: WorkforceThresholds;
}

export interface WorkforceMetrics {
  record(event: WorkforceEvent): void;
  /** Gauge: the caller sets the current number of pending approvals. */
  setApprovalsPending(count: number): void;
  /** Counts approvals whose request time is at least thresholdMs before now. Stored for snapshot(). */
  approvalsDelayedOver(thresholdMs: number, requestedAtMs: readonly number[]): number;
  snapshot(): WorkforceSnapshot;
  alerts(): WorkforceAlert[];
  /** Per-company plain-number counts, keyed by companyId. */
  perCompany(): Record<string, { runsStarted: number; runsFailed: number; toolCallsRefused: number; actions: number }>;
  /** One company's counts. An unknown companyId returns zeros and does not create state. */
  companySnapshot(companyId: string): CompanyWorkforceSnapshot;
  /** Alerts that concern one company only. Provider errors are not attributed to a company, so they are never listed here. */
  companyAlerts(companyId: string): WorkforceAlert[];
}

const HOUR_MS = 60 * 60 * 1000;

interface CompanyCounts {
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  escalations: number;
  toolCallsRefused: number;
  toolRetries: number;
  spendCents: number;
  actionsTotal: number;
  actionTimes: number[];
}

function emptyCompanyCounts(): CompanyCounts {
  return {
    runsStarted: 0,
    runsCompleted: 0,
    runsFailed: 0,
    escalations: 0,
    toolCallsRefused: 0,
    toolRetries: 0,
    spendCents: 0,
    actionsTotal: 0,
    actionTimes: [],
  };
}

function assertNonNegativeFinite(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0, got ${String(value)}`);
  }
}

function validateThresholds(t: WorkforceThresholds): void {
  if (t.maxFailureRatio !== undefined) {
    assertNonNegativeFinite('maxFailureRatio', t.maxFailureRatio);
    if (t.maxFailureRatio > 1) throw new RangeError('maxFailureRatio must be <= 1');
  }
  if (t.maxProviderErrors !== undefined) assertNonNegativeFinite('maxProviderErrors', t.maxProviderErrors);
  if (t.providerErrorWindowMs !== undefined) assertNonNegativeFinite('providerErrorWindowMs', t.providerErrorWindowMs);
  if (t.maxSpendCents !== undefined) assertNonNegativeFinite('maxSpendCents', t.maxSpendCents);
  if (t.maxActionsPerCompanyPerHour !== undefined) {
    assertNonNegativeFinite('maxActionsPerCompanyPerHour', t.maxActionsPerCompanyPerHour);
  }
}

export function createWorkforceMetrics(options: WorkforceMetricsOptions): WorkforceMetrics {
  const { now } = options;
  if (typeof now !== 'function') throw new TypeError('now must be a function returning epoch milliseconds');
  const thresholds: WorkforceThresholds = { ...(options.thresholds ?? {}) };
  validateThresholds(thresholds);

  const providerWindowMs = thresholds.providerErrorWindowMs ?? HOUR_MS;
  // Keep enough history for every window that is in use; older timestamps are pruned on record.
  const retainMs = Math.max(providerWindowMs, HOUR_MS);

  let runsStarted = 0;
  let runsCompleted = 0;
  let runsFailed = 0;
  let escalations = 0;
  let toolCallsRefused = 0;
  let toolRetries = 0;
  let approvalsPending = 0;
  let approvalsDelayed = 0;
  let providerErrors = 0;
  let spendCents = 0;
  let actions = 0;

  const providerErrorTimes: number[] = [];
  const companies = new Map<string, CompanyCounts>();

  function company(companyId: string): CompanyCounts {
    let c = companies.get(companyId);
    if (!c) {
      c = emptyCompanyCounts();
      companies.set(companyId, c);
    }
    return c;
  }

  function prune(times: number[], cutoff: number): void {
    let drop = 0;
    while (drop < times.length && times[drop] < cutoff) drop++;
    if (drop > 0) times.splice(0, drop);
  }

  function pruneAll(t: number): void {
    prune(providerErrorTimes, t - retainMs);
    for (const c of companies.values()) prune(c.actionTimes, t - HOUR_MS);
  }

  function record(event: WorkforceEvent): void {
    const t = now();
    switch (event.kind) {
      case 'run_started':
        runsStarted++;
        if (event.companyId) company(event.companyId).runsStarted++;
        break;
      case 'run_completed':
        runsCompleted++;
        if (event.companyId) company(event.companyId).runsCompleted++;
        break;
      case 'run_failed':
        runsFailed++;
        if (event.companyId) company(event.companyId).runsFailed++;
        break;
      case 'escalation':
        escalations++;
        if (event.companyId) company(event.companyId).escalations++;
        break;
      case 'tool_refused':
        toolCallsRefused++;
        if (event.companyId) company(event.companyId).toolCallsRefused++;
        break;
      case 'tool_retry':
        toolRetries++;
        if (event.companyId) company(event.companyId).toolRetries++;
        break;
      case 'provider_error':
        providerErrors++;
        providerErrorTimes.push(t);
        break;
      case 'spend':
        assertNonNegativeFinite('spend cents', event.cents);
        spendCents += event.cents;
        if (event.companyId) company(event.companyId).spendCents += event.cents;
        break;
      case 'action':
        actions++;
        {
          const c = company(event.companyId);
          c.actionsTotal++;
          c.actionTimes.push(t);
        }
        break;
      default: {
        const unknown: never = event;
        throw new TypeError(`unknown workforce event: ${JSON.stringify(unknown)}`);
      }
    }
    pruneAll(t);
  }

  function providerErrorsInWindow(t: number): number {
    const cutoff = t - providerWindowMs;
    let n = 0;
    for (const ts of providerErrorTimes) if (ts >= cutoff) n++;
    return n;
  }

  function actionsInLastHour(c: CompanyCounts, t: number): number {
    const cutoff = t - HOUR_MS;
    let n = 0;
    for (const ts of c.actionTimes) if (ts >= cutoff) n++;
    return n;
  }

  function alerts(): WorkforceAlert[] {
    const t = now();
    pruneAll(t);
    const out: WorkforceAlert[] = [];

    if (thresholds.maxFailureRatio !== undefined && runsStarted > 0) {
      const ratio = runsFailed / runsStarted;
      if (ratio >= thresholds.maxFailureRatio) {
        out.push({
          code: 'failure_ratio_high',
          severity: 'warning',
          message: `Run failure ratio ${ratio.toFixed(3)} (${runsFailed} of ${runsStarted}) reached threshold ${thresholds.maxFailureRatio}`,
        });
      }
    }

    if (thresholds.maxProviderErrors !== undefined) {
      const inWindow = providerErrorsInWindow(t);
      if (inWindow >= thresholds.maxProviderErrors) {
        out.push({
          code: 'provider_errors_high',
          severity: 'critical',
          message: `${inWindow} provider errors in the last ${providerWindowMs} ms reached threshold ${thresholds.maxProviderErrors}`,
        });
      }
    }

    if (thresholds.maxSpendCents !== undefined && spendCents >= thresholds.maxSpendCents) {
      out.push({
        code: 'spend_over_cap',
        severity: 'critical',
        message: `Spend ${spendCents} cents reached cap ${thresholds.maxSpendCents} cents`,
      });
    }

    if (thresholds.maxActionsPerCompanyPerHour !== undefined) {
      for (const [companyId, c] of companies) {
        const count = actionsInLastHour(c, t);
        if (count >= thresholds.maxActionsPerCompanyPerHour) {
          out.push({
            code: 'action_volume_high',
            severity: 'warning',
            message: `Company ${companyId} performed ${count} actions in the last hour, reaching threshold ${thresholds.maxActionsPerCompanyPerHour}`,
          });
        }
      }
    }

    return out;
  }

  function companySnapshot(companyId: string): CompanyWorkforceSnapshot {
    const c = companies.get(companyId) ?? emptyCompanyCounts();
    return {
      runsStarted: c.runsStarted,
      runsCompleted: c.runsCompleted,
      completionRate: c.runsStarted > 0 ? c.runsCompleted / c.runsStarted : 0,
      runsFailed: c.runsFailed,
      errorRate: c.runsStarted > 0 ? c.runsFailed / c.runsStarted : 0,
      escalations: c.escalations,
      toolCallsRefused: c.toolCallsRefused,
      toolRetries: c.toolRetries,
      spendCents: c.spendCents,
      actions: c.actionsTotal,
    };
  }

  function companyAlerts(companyId: string): WorkforceAlert[] {
    const t = now();
    pruneAll(t);
    const c = companies.get(companyId);
    if (!c) return [];
    const out: WorkforceAlert[] = [];

    if (thresholds.maxFailureRatio !== undefined && c.runsStarted > 0) {
      const ratio = c.runsFailed / c.runsStarted;
      if (ratio >= thresholds.maxFailureRatio) {
        out.push({
          code: 'failure_ratio_high',
          severity: 'warning',
          message: `Run failure ratio ${ratio.toFixed(3)} (${c.runsFailed} of ${c.runsStarted}) reached threshold ${thresholds.maxFailureRatio}`,
        });
      }
    }

    if (thresholds.maxSpendCents !== undefined && c.spendCents >= thresholds.maxSpendCents) {
      out.push({
        code: 'spend_over_cap',
        severity: 'critical',
        message: `Spend ${c.spendCents} cents reached cap ${thresholds.maxSpendCents} cents`,
      });
    }

    if (thresholds.maxActionsPerCompanyPerHour !== undefined) {
      const count = actionsInLastHour(c, t);
      if (count >= thresholds.maxActionsPerCompanyPerHour) {
        out.push({
          code: 'action_volume_high',
          severity: 'warning',
          message: `${count} actions in the last hour reached threshold ${thresholds.maxActionsPerCompanyPerHour}`,
        });
      }
    }

    return out;
  }

  return {
    record,
    companySnapshot,
    companyAlerts,

    setApprovalsPending(count: number): void {
      assertNonNegativeFinite('approvalsPending', count);
      approvalsPending = count;
    },

    approvalsDelayedOver(thresholdMs: number, requestedAtMs: readonly number[]): number {
      assertNonNegativeFinite('thresholdMs', thresholdMs);
      const cutoff = now() - thresholdMs;
      let n = 0;
      for (const ts of requestedAtMs) if (ts <= cutoff) n++;
      approvalsDelayed = n;
      return n;
    },

    snapshot(): WorkforceSnapshot {
      return {
        runsStarted,
        runsCompleted,
        completionRate: runsStarted > 0 ? runsCompleted / runsStarted : 0,
        runsFailed,
        escalations,
        toolCallsRefused,
        toolRetries,
        approvalsPending,
        approvalsDelayed,
        providerErrors,
        spendCents,
        actions,
      };
    },

    alerts,

    perCompany() {
      const out: Record<string, { runsStarted: number; runsFailed: number; toolCallsRefused: number; actions: number }> = {};
      for (const [companyId, c] of companies) {
        out[companyId] = {
          runsStarted: c.runsStarted,
          runsFailed: c.runsFailed,
          toolCallsRefused: c.toolCallsRefused,
          actions: c.actionsTotal,
        };
      }
      return out;
    },
  };
}
