/**
 * Canonical decision service for Managed Portfolio Operations.
 *
 * Pure module: no I/O, no clock reads (callers pass `now`), no randomness. Each transition returns either a new
 * card with an audit entry, or a refusal with an audit entry. Refusals are returned, never thrown.
 *
 * Authority comes only from the actor and the card's approval_authority. The text of issue or recommended_action
 * is never read for permission. Persistence, idempotency storage and execution receipts belong to the caller.
 */
import {
  APPROVAL_AUTHORITIES,
  CUSTOMER_FACING_CATEGORIES,
  DECISION_CATEGORIES,
  DECISION_PRIORITIES,
  DECISION_STATUSES,
  FINANCIAL_CATEGORIES,
  RISK_LEVELS,
} from './decision-types.ts';
import type {
  BatchApproveResult,
  BatchItemResult,
  DecisionActor,
  DecisionAction,
  DecisionAuditEntry,
  DecisionCard,
  DecisionError,
  DecisionResult,
  DecisionStatus,
  DelegateRef,
  ScalarParameter,
} from './decision-types.ts';

export type CreateDecisionInput = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const TEXT_FIELDS = [
  'decision_id',
  'business_id',
  'issue',
  'recommended_action',
  'expected_result',
  'execution_capability',
  'policy_version',
  'idempotency_key',
] as const;

type Fault = DecisionError | null;

interface Move {
  action: DecisionAction;
  at: string;
  actor: unknown;
  target: unknown;
  from: DecisionStatus | null;
  to: DecisionStatus | null;
  reason: string | null;
}

const fault = (code: string, message: string): DecisionError => ({ code, message });
const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
const isScalar = (v: unknown): v is ScalarParameter =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const inList = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const optText = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const actorType = (v: unknown): 'human' | 'agent' | null => (v === 'human' || v === 'agent' ? v : null);
const statusOf = (card: unknown): DecisionStatus | null =>
  isObject(card) && inList(DECISION_STATUSES, card.status) ? card.status : null;
const isSensitiveCategory = (category: unknown): boolean =>
  inList(CUSTOMER_FACING_CATEGORIES, category) || inList(FINANCIAL_CATEGORIES, category);

function isDelegate(v: unknown): v is DelegateRef {
  return isObject(v) && nonEmpty(v.actor_id) && actorType(v.actor_type) !== null;
}

function isActor(v: unknown): v is DecisionActor {
  return (
    isDelegate(v) &&
    ((v as any).authority === null || inList(APPROVAL_AUTHORITIES, (v as any).authority)) &&
    Array.isArray((v as any).business_scopes) &&
    (v as any).business_scopes.every(nonEmpty)
  );
}

/** Structural and policy validation of a full card. Returns the first fault found, or null. */
export function validateDecisionCard(raw: unknown): Fault {
  return checkCard(raw);
}

function checkCard(raw: unknown): Fault {
  if (!isObject(raw)) return fault('invalid_card', 'Decision card is not an object.');
  const c = raw;
  for (const field of TEXT_FIELDS) {
    if (!nonEmpty(c[field])) return fault('missing_field', `Required field ${field} is missing or empty.`);
  }
  if (!UUID_RE.test(c.decision_id)) return fault('invalid_value', 'decision_id must be a UUID.');
  if (!isIso(c.created_at)) return fault('invalid_value', 'created_at must be an ISO timestamp.');
  if (!inList(DECISION_CATEGORIES, c.category)) return fault('invalid_value', 'category is not recognised.');
  if (!inList(DECISION_PRIORITIES, c.priority)) return fault('invalid_value', 'priority is not recognised.');
  if (!inList(RISK_LEVELS, c.risk_level)) return fault('invalid_value', 'risk_level is not recognised.');
  if (!inList(APPROVAL_AUTHORITIES, c.approval_authority)) {
    return fault('invalid_value', 'approval_authority is not recognised.');
  }
  if (!inList(DECISION_STATUSES, c.status)) return fault('invalid_value', 'status is not recognised.');

  if (!Array.isArray(c.evidence) || c.evidence.length === 0) {
    return fault('evidence_required', 'At least one evidence reference is required.');
  }
  for (const item of c.evidence) {
    if (!isObject(item) || !nonEmpty(item.ref) || !isIso(item.timestamp)) {
      return fault('evidence_invalid', 'Each evidence reference needs a ref and an ISO timestamp.');
    }
  }

  if (typeof c.approval_required !== 'boolean') {
    return fault('missing_field', 'Required field approval_required is missing or not a boolean.');
  }
  const highRisk = c.risk_level === 'high' || c.risk_level === 'critical';
  if (c.approval_required === false && highRisk) {
    return fault('approval_required_for_risk', 'High and critical risk cards always require approval.');
  }
  if (c.approval_required === false && isSensitiveCategory(c.category)) {
    return fault('approval_required_for_category', 'Customer-facing and financial cards always require approval.');
  }

  for (const flag of ['irreversible', 'destructive', 'disputed'] as const) {
    if (typeof c[flag] !== 'boolean') return fault('missing_field', `Required flag ${flag} is missing or not a boolean.`);
  }
  if (!Array.isArray(c.permitted_parameters) || !c.permitted_parameters.every(nonEmpty)) {
    return fault('invalid_value', 'permitted_parameters must be a list of names.');
  }
  if (!isObject(c.parameters) || !Object.values(c.parameters).every(isScalar)) {
    return fault('invalid_value', 'parameters must be an object of scalar values.');
  }
  if (c.delegated_to !== null && !isDelegate(c.delegated_to)) {
    return fault('invalid_value', 'delegated_to must be null or a valid actor reference.');
  }
  if (c.snoozed_until !== null && !isIso(c.snoozed_until)) {
    return fault('invalid_value', 'snoozed_until must be null or an ISO timestamp.');
  }
  if (c.snooze_condition !== null && !nonEmpty(c.snooze_condition)) {
    return fault('invalid_value', 'snooze_condition must be null or text.');
  }
  if (c.rejection_reason !== null && !nonEmpty(c.rejection_reason)) {
    return fault('invalid_value', 'rejection_reason must be null or text.');
  }
  if (c.approved_by !== null && !nonEmpty(c.approved_by)) return fault('invalid_value', 'approved_by is invalid.');
  if (c.approved_at !== null && !isIso(c.approved_at)) return fault('invalid_value', 'approved_at is invalid.');
  return null;
}

/** An agent may decide only low-risk, reversible, internal cards. */
function agentMayDecide(card: DecisionCard): boolean {
  return (
    card.risk_level === 'low' &&
    !isSensitiveCategory(card.category) &&
    !card.irreversible &&
    !card.destructive &&
    !card.disputed
  );
}

/** Authority, business scope and agent limits. Does not look at delegation. */
function authorityCheck(card: DecisionCard, actor: unknown): Fault {
  if (!isActor(actor)) {
    return fault('actor_invalid', 'Actor needs an id, a type, an authority (or null) and business scopes.');
  }
  if (actor.authority === null || actor.authority !== card.approval_authority) {
    return fault('not_authorised', 'Actor does not hold the approval authority for this decision.');
  }
  if (!actor.business_scopes.includes(card.business_id)) {
    return fault('business_scope_denied', 'Actor is not authorised for this business.');
  }
  if (actor.actor_type === 'agent' && !agentMayDecide(card)) {
    return fault('agent_not_permitted', 'Agents may decide only low-risk, reversible, internal cards.');
  }
  return null;
}

/** Full check for acting on a card: authority, plus the delegate if one is assigned. */
function authorise(card: DecisionCard, actor: unknown): Fault {
  const base = authorityCheck(card, actor);
  if (base) return base;
  const a = actor as DecisionActor;
  if (card.delegated_to && (card.delegated_to.actor_id !== a.actor_id || card.delegated_to.actor_type !== a.actor_type)) {
    return fault('not_delegate', 'Decision is delegated to another actor.');
  }
  return null;
}

function checkAwaiting(card: DecisionCard): Fault {
  return card.status === 'awaiting_approval'
    ? null
    : fault('not_awaiting_approval', `Decision is ${card.status}, not awaiting approval.`);
}

function audit(card: unknown, move: Move, refusal: DecisionError | null): DecisionAuditEntry {
  const c = isObject(card) ? card : {};
  const actor = isObject(move.actor) ? move.actor : {};
  const target = isObject(move.target) ? move.target : {};
  return {
    decision_id: text(c.decision_id),
    business_id: text(c.business_id),
    action: move.action,
    outcome: refusal ? 'refused' : 'applied',
    refusal_code: refusal ? refusal.code : null,
    actor_id: optText(actor.actor_id),
    actor_type: actorType(actor.actor_type),
    target_actor_id: optText(target.actor_id),
    from_status: move.from,
    to_status: refusal ? null : move.to,
    reason: move.reason,
    at: move.at,
    policy_version: optText(c.policy_version),
    idempotency_key: optText(c.idempotency_key),
  };
}

function refused<T>(card: unknown, move: Move, error: DecisionError): DecisionResult<T> {
  return { ok: false, error, audit: audit(card, move, error) };
}

function applied<T>(value: T, move: Move): DecisionResult<T> {
  return { ok: true, value, audit: audit(value, move, null) };
}

/** Validates and builds a new decision card in status awaiting_approval. */
export function createDecision(input: CreateDecisionInput, now: Date = new Date()): DecisionResult<DecisionCard> {
  const at = now.toISOString();
  const move: Move = { action: 'create', at, actor: null, target: null, from: null, to: 'awaiting_approval', reason: null };
  const src: Record<string, any> = isObject(input) ? input : {};
  if (src.status !== undefined && src.status !== 'awaiting_approval') {
    return refused(src, move, fault('status_not_awaiting', 'New decisions must start awaiting approval.'));
  }
  const candidate = {
    decision_id: src.decision_id,
    business_id: src.business_id,
    category: src.category,
    priority: src.priority,
    issue: src.issue,
    evidence: Array.isArray(src.evidence)
      ? src.evidence.map((e: unknown) => (isObject(e) ? { ref: e.ref, timestamp: e.timestamp } : e))
      : src.evidence,
    recommended_action: src.recommended_action,
    expected_result: src.expected_result,
    risk_level: src.risk_level,
    approval_required: src.approval_required,
    approval_authority: src.approval_authority,
    execution_capability: src.execution_capability,
    policy_version: src.policy_version,
    idempotency_key: src.idempotency_key,
    permitted_parameters: Array.isArray(src.permitted_parameters) ? [...src.permitted_parameters] : src.permitted_parameters,
    parameters: isObject(src.parameters) ? { ...src.parameters } : src.parameters,
    irreversible: src.irreversible,
    destructive: src.destructive,
    disputed: src.disputed,
    status: 'awaiting_approval' as const,
    created_at: at,
    delegated_to: null,
    snoozed_until: null,
    snooze_condition: null,
    rejection_reason: null,
    approved_by: null,
    approved_at: null,
  };
  const f = checkCard(candidate);
  if (f) return refused(src, move, f);
  return applied(candidate as DecisionCard, move);
}

function approveCore(card: DecisionCard, actor: DecisionActor, at: string, action: DecisionAction): DecisionResult<DecisionCard> {
  const move: Move = { action, at, actor, target: null, from: statusOf(card), to: 'approved', reason: null };
  const f = checkCard(card) ?? authorise(card, actor) ?? checkAwaiting(card);
  if (f) return refused(card, move, f);
  const next: DecisionCard = { ...card, status: 'approved', approved_by: actor.actor_id, approved_at: at };
  return applied(next, move);
}

/** Approves one card. Authority is checked on the card itself; a card can be approved only once. */
export function approve(card: DecisionCard, actor: DecisionActor, now: Date = new Date()): DecisionResult<DecisionCard> {
  return approveCore(card, actor, now.toISOString(), 'approve');
}

/** Rejects a card. A reason is required. Allowed from awaiting_approval or snoozed. */
export function reject(card: DecisionCard, actor: DecisionActor, reason: unknown, now: Date = new Date()): DecisionResult<DecisionCard> {
  const at = now.toISOString();
  const trimmed = nonEmpty(reason) ? reason.trim() : null;
  const move: Move = { action: 'reject', at, actor, target: null, from: statusOf(card), to: 'rejected', reason: trimmed };
  if (!trimmed) return refused(card, move, fault('reason_required', 'A rejection reason is required.'));
  const f = checkCard(card) ?? authorise(card, actor);
  if (f) return refused(card, move, f);
  if (card.status !== 'awaiting_approval' && card.status !== 'snoozed') {
    return refused(card, move, fault('not_open', `Decision is ${card.status} and cannot be rejected.`));
  }
  const next: DecisionCard = {
    ...card,
    status: 'rejected',
    rejection_reason: trimmed,
    snoozed_until: null,
    snooze_condition: null,
  };
  return applied(next, move);
}

const MODIFIABLE_FIELDS = ['priority', 'parameters'] as const;

/**
 * Changes permitted fields only: priority, or parameters whose names are listed in permitted_parameters.
 * The changed card is validated again before it is returned.
 */
export function modify(card: DecisionCard, actor: DecisionActor, changes: unknown, now: Date = new Date()): DecisionResult<DecisionCard> {
  const at = now.toISOString();
  const move: Move = { action: 'modify', at, actor, target: null, from: statusOf(card), to: statusOf(card), reason: null };
  if (!isObject(changes) || Object.keys(changes).length === 0) {
    return refused(card, move, fault('changes_required', 'Modify needs at least one change.'));
  }
  for (const key of Object.keys(changes)) {
    if (!(MODIFIABLE_FIELDS as readonly string[]).includes(key)) {
      return refused(card, move, fault('field_not_modifiable', `Field ${key} cannot be modified.`));
    }
  }
  const f = checkCard(card) ?? authorise(card, actor) ?? checkAwaiting(card);
  if (f) return refused(card, move, f);

  const next: DecisionCard = { ...card };
  if ('priority' in changes) {
    if (!inList(DECISION_PRIORITIES, changes.priority)) {
      return refused(card, move, fault('invalid_value', 'priority is not recognised.'));
    }
    next.priority = changes.priority;
  }
  if ('parameters' in changes) {
    if (!isObject(changes.parameters)) return refused(card, move, fault('invalid_value', 'parameters must be an object.'));
    for (const [name, value] of Object.entries(changes.parameters)) {
      if (!card.permitted_parameters.includes(name)) {
        return refused(card, move, fault('parameter_not_permitted', `Parameter ${name} cannot be changed.`));
      }
      if (!isScalar(value)) return refused(card, move, fault('invalid_value', `Parameter ${name} must be a scalar.`));
    }
    next.parameters = { ...card.parameters, ...changes.parameters };
  }
  const revalidated = checkCard(next);
  if (revalidated) return refused(card, move, revalidated);
  return applied(next, move);
}

export interface SnoozeInput {
  until?: unknown;
  condition?: unknown;
}

/** Defers a card until a future ISO time or until a named condition. Exactly one is required. */
export function snooze(card: DecisionCard, actor: DecisionActor, input: SnoozeInput, now: Date = new Date()): DecisionResult<DecisionCard> {
  const at = now.toISOString();
  const src: SnoozeInput = isObject(input) ? input : {};
  const move: Move = { action: 'snooze', at, actor, target: null, from: statusOf(card), to: 'snoozed', reason: null };
  const hasUntil = src.until !== undefined && src.until !== null;
  const hasCondition = src.condition !== undefined && src.condition !== null;
  if (hasUntil === hasCondition) {
    return refused(card, move, fault('snooze_target_required', 'Snooze needs exactly one of a time or a condition.'));
  }
  if (hasUntil && (!isIso(src.until) || Date.parse(src.until) <= now.getTime())) {
    return refused(card, move, fault('snooze_time_invalid', 'Snooze time must be a future ISO timestamp.'));
  }
  if (hasCondition && !nonEmpty(src.condition)) {
    return refused(card, move, fault('snooze_condition_invalid', 'Snooze condition must be text.'));
  }
  const f = checkCard(card) ?? authorise(card, actor) ?? checkAwaiting(card);
  if (f) return refused(card, move, f);
  const next: DecisionCard = {
    ...card,
    status: 'snoozed',
    snoozed_until: hasUntil ? (src.until as string) : null,
    snooze_condition: hasCondition ? (src.condition as string).trim() : null,
  };
  return applied(next, move);
}

/**
 * Returns a snoozed card to the queue once its time has passed or its condition is met. This is a system step,
 * not an approval, so it takes no actor.
 */
export function wake(card: DecisionCard, now: Date = new Date(), options: { conditionMet?: boolean } = {}): DecisionResult<DecisionCard> {
  const at = now.toISOString();
  const move: Move = { action: 'wake', at, actor: null, target: null, from: statusOf(card), to: 'awaiting_approval', reason: null };
  const f = checkCard(card) ?? (card.status === 'snoozed' ? null : fault('not_snoozed', 'Decision is not snoozed.'));
  if (f) return refused(card, move, f);
  const dueByTime = card.snoozed_until !== null && Date.parse(card.snoozed_until) <= now.getTime();
  const dueByCondition = card.snooze_condition !== null && options.conditionMet === true;
  if (!dueByTime && !dueByCondition) {
    return refused(card, move, fault('snooze_not_due', 'Snooze has not expired and its condition is not met.'));
  }
  const next: DecisionCard = { ...card, status: 'awaiting_approval', snoozed_until: null, snooze_condition: null };
  return applied(next, move);
}

/**
 * Assigns a card to a human or authorised agent. The target must hold the card's approval authority and be
 * scoped to the business. Only the current actor (or the current delegate) may delegate.
 */
export function delegate(card: DecisionCard, actor: DecisionActor, to: unknown, now: Date = new Date()): DecisionResult<DecisionCard> {
  const at = now.toISOString();
  const move: Move = { action: 'delegate', at, actor, target: to, from: statusOf(card), to: statusOf(card), reason: null };
  const targetFault = isActor(to) ? authorityCheck(card, to) : fault('actor_invalid', 'Delegate is not a valid actor.');
  const f = checkCard(card) ?? authorise(card, actor) ?? checkAwaiting(card) ?? targetFault;
  if (f) return refused(card, move, f);
  const t = to as DecisionActor;
  const next: DecisionCard = { ...card, delegated_to: { actor_id: t.actor_id, actor_type: t.actor_type } };
  return applied(next, move);
}

function batchFault(raw: unknown, homogeneous: boolean, seen: Set<string>): Fault {
  if (!homogeneous) {
    return fault('batch_not_homogeneous', 'A batch must hold cards of one category and one execution capability.');
  }
  const f = checkCard(raw);
  if (f) return f;
  const c = raw as DecisionCard;
  if (seen.has(c.decision_id)) return fault('duplicate_in_batch', 'This decision appears more than once in the batch.');
  if (c.risk_level !== 'low') return fault('batch_risk_not_low', 'Only low-risk cards can be batch approved.');
  if (isSensitiveCategory(c.category)) {
    return fault('batch_category_excluded', 'Customer-facing and financial cards cannot be batch approved.');
  }
  if (c.irreversible || c.destructive || c.disputed) {
    return fault('batch_excluded_flags', 'Irreversible, destructive or disputed cards cannot be batch approved.');
  }
  return null;
}

/**
 * Approves a homogeneous batch of low-risk cards. Each card is checked and approved on its own, so the result
 * holds one entry per input card. Business scope is checked per card. A mixed batch refuses every card.
 */
export function batchApprove(cards: unknown, actor: DecisionActor, now: Date = new Date()): BatchApproveResult {
  const at = now.toISOString();
  const list: unknown[] = Array.isArray(cards) ? cards : [];
  const first = list[0];
  const homogeneous =
    isObject(first) &&
    list.every((c) => isObject(c) && c.category === first.category && c.execution_capability === first.execution_capability);
  const seen = new Set<string>();

  const results: BatchItemResult[] = list.map((raw) => {
    const id = isObject(raw) ? text(raw.decision_id) : '';
    const businessId = isObject(raw) ? text(raw.business_id) : '';
    const f = batchFault(raw, homogeneous, seen);
    if (id) seen.add(id);
    if (f) {
      const move: Move = { action: 'batch_approve', at, actor, target: null, from: statusOf(raw), to: 'approved', reason: null };
      return { decision_id: id, business_id: businessId, ok: false, card: null, error: f, audit: audit(raw, move, f) };
    }
    const outcome = approveCore(raw as DecisionCard, actor, at, 'batch_approve');
    if (outcome.ok) {
      return { decision_id: id, business_id: businessId, ok: true, card: outcome.value, error: null, audit: outcome.audit };
    }
    return { decision_id: id, business_id: businessId, ok: false, card: null, error: outcome.error, audit: outcome.audit };
  });
  return { results };
}
