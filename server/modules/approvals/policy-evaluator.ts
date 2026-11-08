/*
 * Policy evaluator: one decision that combines the authority ladder with company policy,
 * user permissions, approval state and money limits.
 *
 * Pure. No database, request, or environment access. The caller supplies every input and
 * must set approvalState only after it has verified the owner's decision (see
 * approval-signing.ts). The ladder (evaluateAuthority) is always consulted first, and a
 * ladder deny is final: no company rule, permission, or approval can turn it into an allow.
 *
 * Evaluation order:
 *   1. Input validation. Any unknown or malformed value denies.
 *   2. Authority ladder. A ladder deny returns deny.
 *   3. Company deniedTools. A match returns deny.
 *   4. User permissions. An action missing from the granted set returns deny.
 *   5. Money limit. Used plus this amount above the maximum returns deny.
 *   6. Approval state 'rejected' returns deny.
 *   7. Approval needed? The ladder asks for approval, or company requireApprovalFor lists the
 *      action, or the category is a gated category. A tool on the always-approval list (see
 *      runtime/always-approval.ts) takes its listed category even when the caller passed none, so
 *      it is gated too. If so, 'approved' allows this one action and anything else returns require_approval.
 *   8. Otherwise the ladder's allow stands.
 * Denials are checked before approval, so an approval never masks a denial.
 */

import {
  HUMAN_ACTOR,
  TOOL_ACCESS,
  evaluateAuthority,
  isAutonomyLevel,
  isRiskTier,
  type RiskTier,
  type ToolAccess,
} from './authority-ladder.ts';
import { alwaysApprovalCategoryOf } from '../../workforce/runtime/always-approval.ts';

/**
 * Action category. The caller sets it. Absent means 'none'. Any other value denies.
 *  - money:          moves money (payments, refunds, transfers, payouts). Always needs owner
 *                    approval. Limit checks apply when `limits` is given (uses `amountCents`).
 *  - customer_send:  sends a message to a customer (email, SMS, chat reply). Always needs owner approval.
 *  - delete:         deletes a record. Always needs owner approval.
 *  - none:           anything else. No category gate.
 */
export const CATEGORIES = ['money', 'customer_send', 'delete', 'none'] as const;
export type ActionCategory = (typeof CATEGORIES)[number];

/** Categories that need a verified owner approval whenever the ladder would allow the action. */
const GATED_CATEGORIES: ReadonlySet<string> = new Set<ActionCategory>(['money', 'customer_send', 'delete']);

/**
 * What the predictive tier may do. Predictive prepares tomorrow and next week from data.
 * Its risk cells are the same as auto's (see authority-ladder.ts), so these lists add
 * only the rule that predictive cannot run the approval-required activities unattended.
 *  - allowed:          runs without owner approval, subject to the risk cells. A read,
 *                      or a low or medium write with no category. 'prepare', 'draft' and
 *                      'schedule' all arrive as that write: the evaluator's inputs cannot
 *                      tell them apart, so they share one class.
 *  - approvalRequired: always needs a verified owner approval, whatever the risk.
 *                      'send' is a customer message, 'money' moves money, 'delete'
 *                      deletes a record, and 'write_high_risk' is a high or critical write.
 */
export const PREDICTIVE_PERMISSIONS = {
  allowed: ['read', 'prepare', 'draft', 'schedule'],
  approvalRequired: ['send', 'money', 'delete', 'write_high_risk'],
} as const;
export type PredictivePermission =
  | (typeof PREDICTIVE_PERMISSIONS.allowed)[number]
  | (typeof PREDICTIVE_PERMISSIONS.approvalRequired)[number];

/** Classify one predictive action into a permission. Category is checked first. */
export function predictivePermissionFor(category: ActionCategory, access: ToolAccess, risk: RiskTier): PredictivePermission {
  if (category === 'money') return 'money';
  if (category === 'customer_send') return 'send';
  if (category === 'delete') return 'delete';
  if (access === 'read') return 'read';
  if (risk === 'high' || risk === 'critical') return 'write_high_risk';
  return 'prepare';
}

/** Approval state for this one action. Set by the caller after verifying the decision. */
export const APPROVAL_STATES = ['none', 'pending', 'approved', 'rejected', 'expired'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/** Who is acting. The verified flag must be true, or the action denies. */
export interface PolicyActor {
  kind: 'agent' | 'human';
  verified: boolean;
}

export interface CompanyPolicy {
  /** Action names that need approval, even where the ladder allows them. */
  requireApprovalFor?: string[];
  /** Action names that are refused outright. */
  deniedTools?: string[];
}

export interface PolicyLimits {
  /** Largest amount, in cents, the company allows for money actions. */
  maxAmountCents?: number;
  /** Amount, in cents, already used in the current period. */
  usedAmountCents?: number;
}

export interface PolicyInput {
  /** Autonomy tier: assist, suggest, auto, predictive, or user_only for a verified human. */
  tier: unknown;
  /** Tool access: 'read' or 'write'. Required. Any other value denies. */
  access: unknown;
  /** Risk tier: low, medium, high, critical. Required. Any other value denies. */
  risk: unknown;
  /** Action name, matched against company lists and user permissions. Required. */
  action: unknown;
  /** The actor. Must be verified. */
  actor: unknown;
  /** Action category (see CATEGORIES). Optional; absent means 'none'. */
  category?: unknown;
  /** Company policy. Optional. */
  companyPolicy?: unknown;
  /** Actions the user is granted. Optional: when absent, no user-permission check runs. */
  userPermissions?: unknown;
  /** Approval state for this action. Required. Any other value denies. */
  approvalState: unknown;
  /** Money limits. Optional. Checked only for category 'money'. */
  limits?: unknown;
  /** Amount in cents for this action. Required when `limits` is given and category is 'money'. */
  amountCents?: unknown;
}

export interface PolicyResult {
  decision: 'allow' | 'require_approval' | 'deny';
  reason: string;
}

function deny(reason: string): PolicyResult {
  return { decision: 'deny', reason };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Decide whether an action may run. Never throws. Unknown or malformed input returns deny.
 */
export function evaluatePolicy(input: PolicyInput): PolicyResult {
  if (!input || typeof input !== 'object') return deny('policy input missing; failing closed');

  // 1. Validate. Every value must be a known one before any rule reads it.
  const access = input.access;
  if (typeof access !== 'string' || !(TOOL_ACCESS as readonly string[]).includes(access)) {
    return deny('unknown tool access; failing closed');
  }
  if (!isRiskTier(input.risk)) return deny('unknown risk tier; failing closed');
  const risk: RiskTier = input.risk;

  const actor = input.actor as PolicyActor | undefined;
  if (
    !actor ||
    typeof actor !== 'object' ||
    (actor.kind !== 'agent' && actor.kind !== 'human') ||
    typeof actor.verified !== 'boolean'
  ) {
    return deny('unknown actor; failing closed');
  }
  if (actor.verified !== true) return deny('actor is not verified; failing closed');

  const tier = input.tier;
  if (actor.kind === 'human') {
    if (tier !== HUMAN_ACTOR) return deny('a human actor must use the user_only tier; failing closed');
  } else if (!isAutonomyLevel(tier) && tier !== HUMAN_ACTOR) {
    // An agent may claim user_only here; the ladder refuses it with its own reason below.
    return deny('unknown autonomy tier; failing closed');
  }

  if (typeof input.action !== 'string' || input.action.length === 0) {
    return deny('action name missing; failing closed');
  }
  const action = input.action;

  const callerCategory: unknown = input.category === undefined ? 'none' : input.category;
  if (typeof callerCategory !== 'string' || !(CATEGORIES as readonly string[]).includes(callerCategory)) {
    return deny('unknown action category; failing closed');
  }
  // Owner rule: a tool on the always-approval list stays gated whatever category the caller passed.
  // Money always takes the money path (limits and gate). A caller that passes no category gets the list's.
  const listed = alwaysApprovalCategoryOf(action);
  const category: string =
    listed === 'money' ? 'money' : listed !== null && callerCategory === 'none' ? listed : callerCategory;

  if (typeof input.approvalState !== 'string' || !(APPROVAL_STATES as readonly string[]).includes(input.approvalState)) {
    return deny('unknown approval state; failing closed');
  }
  const approvalState = input.approvalState as ApprovalState;

  let companyPolicy: CompanyPolicy = {};
  if (input.companyPolicy !== undefined) {
    const raw = input.companyPolicy as CompanyPolicy;
    if (!raw || typeof raw !== 'object') return deny('company policy malformed; failing closed');
    if (raw.requireApprovalFor !== undefined && !isStringArray(raw.requireApprovalFor)) {
      return deny('company requireApprovalFor malformed; failing closed');
    }
    if (raw.deniedTools !== undefined && !isStringArray(raw.deniedTools)) {
      return deny('company deniedTools malformed; failing closed');
    }
    companyPolicy = raw;
  }

  let granted: ReadonlySet<string> | null = null;
  if (input.userPermissions !== undefined) {
    const raw = input.userPermissions;
    if (raw instanceof Set) {
      if (!isStringArray([...raw])) return deny('user permissions malformed; failing closed');
      granted = raw as ReadonlySet<string>;
    } else if (isStringArray(raw)) {
      granted = new Set(raw);
    } else {
      return deny('user permissions malformed; failing closed');
    }
  }

  let limits: PolicyLimits | null = null;
  if (input.limits !== undefined) {
    const raw = input.limits as PolicyLimits;
    if (!raw || typeof raw !== 'object') return deny('limits malformed; failing closed');
    if (!isNonNegativeInt(raw.maxAmountCents) || !isNonNegativeInt(raw.usedAmountCents)) {
      return deny('limits malformed; failing closed');
    }
    limits = raw;
  }

  // 2. Ladder. Only 'approved' reaches the ladder as humanApproved. 'rejected' and 'expired' never do.
  const ladder = evaluateAuthority({
    tier: risk,
    autonomy: tier,
    access: access as ToolAccess,
    humanApproved: approvalState === 'approved',
    actorIsHuman: actor.kind === 'human',
  });
  if (ladder.decision === 'deny') {
    return deny(ladder.reason);
  }

  // 3. Company deniedTools.
  if (companyPolicy.deniedTools?.includes(action)) {
    return deny(`company policy denies the action ${action}`);
  }

  // 4. User permissions.
  if (granted !== null && !granted.has(action)) {
    return deny(`user does not have permission for the action ${action}`);
  }

  // 5. Money limit.
  if (limits !== null && category === 'money') {
    if (!isNonNegativeInt(input.amountCents)) {
      return deny('money amount missing or malformed; failing closed');
    }
    const maxAmount = limits.maxAmountCents as number;
    const usedAmount = limits.usedAmountCents as number;
    if (usedAmount + input.amountCents > maxAmount) {
      return deny('money limit exceeded');
    }
  }

  // 6. A rejected approval stops the action.
  if (approvalState === 'rejected') {
    return deny('owner rejected this action');
  }

  // 7a. Predictive. The approval-required permissions always need a verified owner approval.
  if (tier === 'predictive') {
    const permission = predictivePermissionFor(category as ActionCategory, access as ToolAccess, risk);
    if ((PREDICTIVE_PERMISSIONS.approvalRequired as readonly string[]).includes(permission) && approvalState !== 'approved') {
      return { decision: 'require_approval', reason: `predictive ${permission} actions need a verified owner approval` };
    }
  }

  // 7. Approval. The ladder, company list, or category gate can each require it.
  const companyRequires = companyPolicy.requireApprovalFor?.includes(action) === true;
  const categoryGated = GATED_CATEGORIES.has(category);
  const needsApproval = ladder.decision === 'require_approval' || companyRequires || categoryGated;

  if (needsApproval) {
    if (approvalState === 'approved') {
      return { decision: 'allow', reason: `${ladder.reason}; owner approval verified for this one action` };
    }
    if (categoryGated && ladder.decision === 'allow') {
      return { decision: 'require_approval', reason: `${category} actions need a verified owner approval` };
    }
    if (companyRequires && ladder.decision === 'allow') {
      return { decision: 'require_approval', reason: `company policy requires approval for the action ${action}` };
    }
    return { decision: 'require_approval', reason: ladder.reason };
  }

  // 8. Ladder allows, and nothing else applies.
  return { decision: 'allow', reason: ladder.reason };
}
