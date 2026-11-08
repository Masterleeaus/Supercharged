/**
 * Completion report for one finished run (SuperchargedAt checklist 3). Pure function: no I/O, no clock,
 * no database. The caller passes the run, its handoffs, tool calls and escalations, and gets back a plain
 * summary of who did what and what was escalated.
 *
 * Every input is filtered to the companyId given. A record whose companyId is missing or differs is
 * dropped, so one tenant's report never shows another tenant's rows. A value that is absent is shown as
 * 'unknown'; it is never guessed. The companyId must be a UUID, or the call throws 'invalid_company'.
 */

export const UNKNOWN = 'unknown';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CompletionRunInput {
  id?: unknown;
  companyId?: unknown;
  status?: unknown;
  /** Handoff path as run.ts keeps it: path[0] is the coordinator who started the work. */
  path?: unknown;
  startedByRole?: unknown;
  finishedAt?: unknown;
}

export interface CompletionHandoffInput {
  companyId?: unknown;
  from?: unknown;
  to?: unknown;
  at?: unknown;
}

export interface CompletionToolCallInput {
  companyId?: unknown;
  tool?: unknown;
  outcome?: unknown;
}

export interface CompletionEscalationInput {
  companyId?: unknown;
  reason?: unknown;
  escalatedTo?: unknown;
  at?: unknown;
}

export interface BuildCompletionReportInput {
  companyId: unknown;
  run: CompletionRunInput;
  handoffs?: readonly CompletionHandoffInput[];
  toolCalls?: readonly CompletionToolCallInput[];
  escalations?: readonly CompletionEscalationInput[];
}

export interface HandoffChainEntry {
  from: string;
  to: string;
  at: string;
}

export interface ToolCallSummaryEntry {
  tool: string;
  outcome: string;
  count: number;
}

export interface EscalationEntry {
  reason: string;
  escalatedTo: string;
  at: string;
}

export interface CompletionReport {
  runId: string;
  status: string;
  startedByRole: string;
  rolesInvolved: string[];
  handoffChain: HandoffChainEntry[];
  toolCallSummary: ToolCallSummaryEntry[];
  escalations: EscalationEntry[];
  finishedAt: string;
  outcomeText: string;
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : UNKNOWN;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** True only when the record names this company exactly. A record with no companyId is dropped. */
function belongsTo<T extends { companyId?: unknown }>(items: readonly T[] | undefined, companyId: string): T[] {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item !== null && typeof item === 'object' && item.companyId === companyId);
}

function outcomeSentence(status: string, toolCount: number, handoffCount: number, escalationCount: number): string {
  const counts = `${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}, ${handoffCount} ${
    handoffCount === 1 ? 'handoff' : 'handoffs'
  } and ${escalationCount} ${escalationCount === 1 ? 'escalation' : 'escalations'}`;
  if (status === 'completed') return `The run completed with ${counts}.`;
  if (status === 'failed') return `The run failed after ${counts}.`;
  if (status === 'unknown') return `The run status is unknown, with ${counts}.`;
  return `The run ended with status ${status} after ${counts}.`;
}

/**
 * Builds the completion report for one run. Throws Error('invalid_company') when companyId is not a UUID.
 * Roles are listed in first-appearance order, with no duplicates. 'unknown' is not a role, so it is left out.
 */
export function buildCompletionReport(input: BuildCompletionReportInput): CompletionReport {
  if (!isUuid(input?.companyId)) {
    const error = new Error('invalid_company') as Error & { code: string };
    error.code = 'invalid_company';
    throw error;
  }
  const companyId = input.companyId;
  const run = input.run ?? {};
  if (run.companyId !== companyId) {
    const error = new Error('run_not_in_company') as Error & { code: string };
    error.code = 'run_not_in_company';
    throw error;
  }

  const handoffs = belongsTo(input.handoffs, companyId);
  const toolCalls = belongsTo(input.toolCalls, companyId);
  const escalations = belongsTo(input.escalations, companyId);

  const path = Array.isArray(run.path) ? run.path : [];
  const startedByRole = text(run.startedByRole ?? path[0]);

  const roles: string[] = [];
  const addRole = (role: string) => {
    if (role !== UNKNOWN && !roles.includes(role)) roles.push(role);
  };
  addRole(startedByRole);

  const handoffChain: HandoffChainEntry[] = handoffs.map((h) => {
    const from = text(h.from);
    const to = text(h.to);
    addRole(from);
    addRole(to);
    return { from, to, at: text(h.at) };
  });

  const toolCounts = new Map<string, ToolCallSummaryEntry>();
  for (const call of toolCalls) {
    const tool = text(call.tool);
    const outcome = text(call.outcome);
    const key = JSON.stringify([tool, outcome]);
    const existing = toolCounts.get(key);
    if (existing) existing.count += 1;
    else toolCounts.set(key, { tool, outcome, count: 1 });
  }

  const escalationEntries: EscalationEntry[] = escalations.map((e) => {
    const escalatedTo = text(e.escalatedTo);
    addRole(escalatedTo);
    return { reason: text(e.reason), escalatedTo, at: text(e.at) };
  });

  const status = text(run.status);
  const toolCallTotal = toolCalls.length;

  return {
    runId: text(run.id),
    status,
    startedByRole,
    rolesInvolved: roles,
    handoffChain,
    toolCallSummary: [...toolCounts.values()],
    escalations: escalationEntries,
    finishedAt: text(run.finishedAt),
    outcomeText: outcomeSentence(status, toolCallTotal, handoffChain.length, escalationEntries.length),
  };
}
