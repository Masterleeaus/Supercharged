/**
 * User-facing task view: one run's plan, evidence, tool calls, approvals, audit trail and final outcome.
 * Pure: no database, no clock, no I/O. The caller passes the run and its related records.
 *
 * Scoping: every input is filtered to the given companyId before anything else. A run belonging to another
 * company returns null, and any related record whose companyId or runId does not match is dropped, so
 * another company's data is never read into the output.
 *
 * Free text (plan steps, evidence summaries, outcome reason, approval action, audit action) passes through
 * `redact` when one is given. Raw tool params are never copied into the view.
 *
 * Plan: the run record has no plan field of its own. The plan is `run.plan` or `run.steps` when either is an
 * array, otherwise an empty list. It is never inferred from tool calls.
 */
import type { AuditEvent } from './store.ts';
import type { RunRecord, RunStatus } from './run.ts';

export type TaskRedactor = (text: string) => string;

export interface TaskToolCallRecord {
  id?: string;
  companyId: string;
  runId: string;
  toolId: string;
  callIndex: number;
  outcome: string;
  attempt: number;
  /** A short description of the result. Raw params are not read from this record. */
  summary?: string | null;
}

export interface TaskApprovalRecord {
  id: string;
  companyId: string;
  runId: string;
  action: string;
  status: string;
}

export interface BuildTaskViewInput {
  run: RunRecord | null | undefined;
  toolCalls?: readonly TaskToolCallRecord[] | null;
  approvals?: readonly TaskApprovalRecord[] | null;
  auditEvents?: readonly AuditEvent[] | null;
  companyId: string;
  redact?: TaskRedactor;
}

export interface TaskPlanStep {
  text: string;
}

export interface TaskEvidenceItem {
  tool: string;
  outcome: string;
  summary: string | null;
}

export interface TaskToolCallView {
  tool: string;
  callIndex: number;
  outcome: string;
  attempt: number;
}

export interface TaskApprovalView {
  id: string;
  status: string;
  action: string;
}

export interface TaskOutcomeView {
  status: RunStatus;
  reason: string | null;
}

export interface TaskAuditView {
  action: string;
  createdAt: string;
}

export interface TaskView {
  runId: string;
  status: RunStatus;
  plan: TaskPlanStep[];
  evidence: TaskEvidenceItem[];
  toolCalls: TaskToolCallView[];
  approvals: TaskApprovalView[];
  outcome: TaskOutcomeView;
  audit: TaskAuditView[];
}

function text(value: string, redact: TaskRedactor | undefined): string {
  return redact ? redact(value) : value;
}

function optionalText(value: string | null | undefined, redact: TaskRedactor | undefined): string | null {
  if (typeof value !== 'string') return null;
  return text(value, redact);
}

function readPlan(run: RunRecord, redact: TaskRedactor | undefined): TaskPlanStep[] {
  const raw: unknown = Array.isArray((run as unknown as { plan?: unknown }).plan)
    ? (run as unknown as { plan: unknown[] }).plan
    : Array.isArray((run as unknown as { steps?: unknown }).steps)
      ? (run as unknown as { steps: unknown[] }).steps
      : [];
  const steps: TaskPlanStep[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item === 'string') {
      steps.push({ text: text(item, redact) });
    } else if (item !== null && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
      steps.push({ text: text((item as { text: string }).text, redact) });
    }
  }
  return steps;
}

export function buildTaskView(input: BuildTaskViewInput): TaskView | null {
  const { run, companyId, redact } = input;
  if (!run || typeof companyId !== 'string' || companyId === '') return null;
  if (run.companyId !== companyId) return null;

  const runId = run.id;

  const toolCalls = (input.toolCalls ?? [])
    .filter((c) => c.companyId === companyId && c.runId === runId)
    .slice()
    .sort((a, b) => a.callIndex - b.callIndex);

  const approvals = (input.approvals ?? []).filter((a) => a.companyId === companyId && a.runId === runId);

  const audit = (input.auditEvents ?? [])
    .filter((e) => e.companyId === companyId && e.runId === runId)
    .map((e, index) => ({ e, index }))
    .sort((a, b) => {
      const diff = Date.parse(a.e.at) - Date.parse(b.e.at);
      return (Number.isNaN(diff) ? 0 : diff) || a.index - b.index;
    })
    .map(({ e }) => e);

  return {
    runId,
    status: run.status,
    plan: readPlan(run, redact),
    evidence: toolCalls.map((c) => ({
      tool: c.toolId,
      outcome: c.outcome,
      summary: optionalText(c.summary, redact),
    })),
    toolCalls: toolCalls.map((c) => ({
      tool: c.toolId,
      callIndex: c.callIndex,
      outcome: c.outcome,
      attempt: c.attempt,
    })),
    approvals: approvals.map((a) => ({
      id: a.id,
      status: a.status,
      action: text(a.action, redact),
    })),
    outcome: {
      status: run.status,
      reason: optionalText(run.reason, redact),
    },
    audit: audit.map((e) => ({ action: text(e.kind, redact), createdAt: e.at })),
  };
}
