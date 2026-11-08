/*
 * Approval view for the person approving. Pure: no database, request, or environment access.
 *
 * Builds the fields an approver must see before deciding: company, agent, requested action,
 * exact parameters, affected records, risk, category, consequences, and timing. Any field the
 * input does not carry is returned as the string 'unknown'. No value is invented.
 */

import type { ApprovalStatus, ApprovalView } from './approval-service.ts';
import { CATEGORIES, type PolicyResult } from './policy-evaluator.ts';

export const UNKNOWN = 'unknown' as const;

const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired', 'revoked'];

/** One roster entry. Roles are optional: an entry without a role leaves the role unknown. */
export interface RosterEntry {
  id: string;
  roleId?: string;
}

export interface ApprovalViewOptions {
  /** Clock used for ageMs and expiresInMs. Injected so the view is deterministic. */
  now: Date | number;
  /** Policy decision for this approval, if the caller has one. */
  policy?: PolicyResult | null;
  /** Agents known to the company. Used to look up the agent's role id. */
  roster?: ReadonlyArray<RosterEntry> | null;
  /** Applied to parameters before they are returned. Omit to return parameters as stored. */
  redact?: ((params: Record<string, unknown>) => Record<string, unknown>) | null;
}

/**
 * The approval as the view reads it. ApprovalView carries no company, risk, category or
 * context, so the caller passes the stored row, which may include them. A missing field is
 * reported as unknown.
 */
export type ApprovalViewInput = ApprovalView & {
  companyId?: string | null;
  context?: Record<string, unknown> | null;
};

export interface ApprovalViewAgent {
  id: string;
  roleId: string;
}

export interface ApprovalViewPolicy {
  decision: string;
  reason: string;
}

export interface ApprovalViewModel {
  company: string;
  agent: ApprovalViewAgent;
  /** Current state. 'revoked' means the approval was withdrawn and must not run. */
  status: ApprovalStatus | typeof UNKNOWN;
  action: string;
  parameters: Record<string, unknown> | typeof UNKNOWN;
  affectedRecords: string[];
  risk: string;
  category: string;
  consequences: string;
  policy: ApprovalViewPolicy | typeof UNKNOWN;
  ageMs: number | typeof UNKNOWN;
  expiresInMs: number | typeof UNKNOWN;
}

const CONSEQUENCE_BY_CATEGORY: Readonly<Record<string, string>> = {
  money: 'Moves money',
  customer_send: 'Sends a message to a customer',
  delete: 'Deletes records',
};

const RISK_VALUES: readonly string[] = ['low', 'medium', 'high', 'critical'];

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? [...value] : null;
}

function toMs(value: Date | number | null | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveCategory(context: Record<string, unknown> | null | undefined): string {
  const raw = context?.category;
  if (typeof raw === 'string' && (CATEGORIES as readonly string[]).includes(raw)) return raw;
  return UNKNOWN;
}

function resolveRisk(context: Record<string, unknown> | null | undefined): string {
  const raw = context?.risk;
  return typeof raw === 'string' && RISK_VALUES.includes(raw) ? raw : UNKNOWN;
}

/** Consequence sentence: from the category when it is a known money, send or delete action, else the action name. */
function consequenceFor(category: string, action: string): string {
  const fromCategory = CONSEQUENCE_BY_CATEGORY[category];
  if (fromCategory !== undefined) return fromCategory;
  return action.length > 0 ? action : UNKNOWN;
}

export function buildApprovalView(approval: ApprovalViewInput, options: ApprovalViewOptions): ApprovalViewModel {
  const context = approval.context ?? null;
  const nowMs = toMs(options.now);

  // Company: the stored company id. No display name is stored on the approval.
  const company = nonEmptyString(approval.companyId) ?? UNKNOWN;

  // Agent: id from the approval, role from the roster when the roster has this agent with a role.
  const agentId = nonEmptyString(approval.agentId);
  const rosterEntry = agentId && options.roster ? options.roster.find((entry) => entry.id === agentId) : undefined;
  const agent: ApprovalViewAgent = {
    id: agentId ?? UNKNOWN,
    roleId: nonEmptyString(rosterEntry?.roleId) ?? UNKNOWN,
  };

  // Parameters: exactly as stored, unless a redact function is passed in.
  let parameters: Record<string, unknown> | typeof UNKNOWN = UNKNOWN;
  if (approval.params !== null && typeof approval.params === 'object' && !Array.isArray(approval.params)) {
    parameters = options.redact ? options.redact(approval.params) : approval.params;
  }

  // Affected records: ids listed in context. Empty when none are listed.
  const affectedRecords = stringArray(context?.affectedRecords) ?? stringArray(context?.recordIds) ?? [];

  const risk = resolveRisk(context);
  const category = resolveCategory(context);

  const createdMs = toMs(approval.createdAt);
  const expiresMs = toMs(approval.expiresAt);

  const status = (APPROVAL_STATUSES as readonly string[]).includes(approval.status)
    ? approval.status
    : UNKNOWN;

  return {
    company,
    agent,
    status,
    action: nonEmptyString(approval.action) ?? UNKNOWN,
    parameters,
    affectedRecords,
    risk,
    category,
    consequences: consequenceFor(category, nonEmptyString(approval.action) ?? ''),
    policy: options.policy ? { decision: options.policy.decision, reason: options.policy.reason } : UNKNOWN,
    ageMs: nowMs !== null && createdMs !== null ? nowMs - createdMs : UNKNOWN,
    expiresInMs: nowMs !== null && expiresMs !== null ? expiresMs - nowMs : UNKNOWN,
  };
}
