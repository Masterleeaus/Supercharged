// Escalation rules for overdue threads.
// Pure function: no state, no database, no clock of its own (the caller passes `now`).
//
// A thread escalates only when its breach status is 'breached'. Among the rules whose
// threshold has been reached (and whose minPriority gate the thread passes), the one with
// the highest afterMinutesOverdue wins. Rules must be sorted ascending by
// afterMinutesOverdue; an unsorted or malformed list is refused, never guessed at.
// Rules are scoped to one company; a rules set that names a different company is refused.

export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type BreachStatus = 'open' | 'breached' | 'replied';

export interface EscalationThread {
  readonly id: string;
  readonly companyId: string;
  readonly assignedTo?: string | null;
  // Missing priority is treated as 'normal'.
  readonly priority?: Priority;
  // Epoch milliseconds at which the thread's reply became due. Overdue time is measured from here.
  readonly dueAt: number;
}

export interface EscalationRule {
  readonly afterMinutesOverdue: number;
  readonly escalateTo: string;
  readonly minPriority?: Priority;
}

// Either a bare sorted list, or a list wrapped with the company it belongs to.
// Only the wrapped form can be checked against the thread's company.
export type EscalationRuleSet =
  | readonly EscalationRule[]
  | { readonly companyId: string; readonly rules: readonly EscalationRule[] };

export interface EvaluateEscalationInput {
  readonly thread: EscalationThread;
  readonly status: BreachStatus;
  // Epoch milliseconds.
  readonly now: number;
  readonly rules: EscalationRuleSet;
}

export type EscalationRefusalReason =
  | 'not_breached'
  | 'below_threshold'
  | 'invalid_rules'
  | 'company_mismatch'
  | 'invalid_thread'
  | 'invalid_status'
  | 'invalid_input';

export type EscalationResult =
  | { readonly escalate: false; readonly reason?: EscalationRefusalReason }
  | {
      readonly escalate: true;
      readonly rule: EscalationRule;
      readonly escalateTo: string;
      readonly minutesOverdue: number;
      readonly reason: 'rule_reached';
    };

const PRIORITY_RANK: Readonly<Record<Priority, number>> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

const MS_PER_MINUTE = 60_000;

function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PRIORITY_RANK, value);
}

function refuse(reason: EscalationRefusalReason): EscalationResult {
  return { escalate: false, reason };
}

function isValidRule(rule: unknown): rule is EscalationRule {
  if (!rule || typeof rule !== 'object') return false;
  const r = rule as Partial<EscalationRule>;
  if (typeof r.afterMinutesOverdue !== 'number' || !Number.isFinite(r.afterMinutesOverdue)) return false;
  if (r.afterMinutesOverdue < 0) return false;
  if (typeof r.escalateTo !== 'string' || r.escalateTo.trim() === '') return false;
  if (r.minPriority !== undefined && !isPriority(r.minPriority)) return false;
  return true;
}

export function evaluateEscalation(input: EvaluateEscalationInput): EscalationResult {
  const { thread, status, now, rules } = input;

  if (!thread || typeof thread.id !== 'string' || typeof thread.companyId !== 'string' || thread.companyId === '') {
    return refuse('invalid_thread');
  }
  if (typeof thread.dueAt !== 'number' || !Number.isFinite(thread.dueAt)) {
    return refuse('invalid_thread');
  }
  if (thread.priority !== undefined && !isPriority(thread.priority)) {
    return refuse('invalid_thread');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    return refuse('invalid_input');
  }

  // Resolve the rule list, checking company scope when the caller supplied one.
  let list: readonly unknown[];
  if (Array.isArray(rules)) {
    list = rules;
  } else if (rules && typeof rules === 'object' && Array.isArray((rules as { rules?: unknown }).rules)) {
    const wrapped = rules as { companyId?: unknown; rules: readonly unknown[] };
    if (wrapped.companyId !== thread.companyId) return refuse('company_mismatch');
    list = wrapped.rules;
  } else {
    return refuse('invalid_rules');
  }

  // Validate every rule before looking at status, so a broken rule set is always reported.
  let previous = -Infinity;
  for (const rule of list) {
    if (!isValidRule(rule)) return refuse('invalid_rules');
    if (rule.afterMinutesOverdue < previous) return refuse('invalid_rules');
    previous = rule.afterMinutesOverdue;
  }

  if (status !== 'breached') {
    if (status === 'open' || status === 'replied') return refuse('not_breached');
    return refuse('invalid_status');
  }

  const minutesOverdue = Math.max(0, Math.floor((now - thread.dueAt) / MS_PER_MINUTE));
  const threadRank = PRIORITY_RANK[thread.priority ?? 'normal'];

  // Sorted ascending, so the first eligible match scanning from the end is the highest reached rule.
  // When two rules share a threshold, the one later in the list wins.
  for (let i = list.length - 1; i >= 0; i--) {
    const rule = list[i] as EscalationRule;
    if (minutesOverdue < rule.afterMinutesOverdue) continue;
    if (rule.minPriority !== undefined && threadRank < PRIORITY_RANK[rule.minPriority]) continue;
    return {
      escalate: true,
      rule,
      escalateTo: rule.escalateTo,
      minutesOverdue,
      reason: 'rule_reached',
    };
  }

  return refuse('below_threshold');
}
