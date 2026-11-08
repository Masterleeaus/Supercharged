/*
 * Company policy: the rules a company admin may set on top of the owner's rules.
 *
 * A company can make approvals stricter, never looser. The owner rules (money, customer_send
 * and delete always need approval) are a floor: mergeWithOwnerRules always includes them, and
 * any company input that omits one has it restored and listed in `corrections`.
 *
 * Pure. No database, request, or environment access. Unknown keys and malformed values are
 * refused (fail closed). The output shape matches CompanyPolicy in policy-evaluator.ts.
 */

import { z } from 'zod';

/** The owner rules. Always present in the effective requireApprovalFor list. */
export const OWNER_APPROVAL_RULES = ['money', 'customer_send', 'delete'] as const;

const MAX_ACTION_NAME_LENGTH = 200;

/** A non-blank action name: a category or a tool id. At most 200 characters. */
const actionName = z
  .string()
  .max(MAX_ACTION_NAME_LENGTH, `action name longer than ${MAX_ACTION_NAME_LENGTH} characters`)
  .refine((value) => value.trim().length > 0, 'action name is empty');

export const companyPolicySchema = z
  .object({
    requireApprovalFor: z.array(actionName),
    deniedTools: z.array(actionName),
    maxAmountCents: z.number().int().positive().optional(),
  })
  .strict();

export type CompanyPolicyInput = z.infer<typeof companyPolicySchema>;

export type ParseResult = { ok: true; policy: CompanyPolicyInput } | { ok: false; reason: string };

/**
 * First problem as a short reason. Built from the field path and fixed phrases only. zod's own messages for
 * enum and unknown-key problems include the submitted value, so they are replaced here. Role entries are
 * keyed by user-supplied ids, so the id is shown as a placeholder.
 */
function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'company policy invalid; failing closed';
  const path = issue.path.length === 0
    ? 'company policy'
    : issue.path[0] === 'roles' && issue.path.length > 1
      ? `roles.<role>${issue.path.length > 2 ? '.' + issue.path.slice(2).join('.') : ''}`
      : issue.path.join('.');
  let message: string;
  switch (issue.code) {
    case 'invalid_enum_value':
      message = 'not an allowed value';
      break;
    case 'unrecognized_keys':
      message = 'unknown field';
      break;
    case 'invalid_type':
      message = 'wrong type';
      break;
    default:
      message = issue.message;
  }
  return `${path}: ${message}; failing closed`;
}

/** Validate a company policy. Unknown keys, blank or oversize entries, and bad maxAmountCents are refused. */
export function parseCompanyPolicy(input: unknown): ParseResult {
  const parsed = companyPolicySchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: describeIssue(parsed.error) };
  return { ok: true, policy: parsed.data };
}

export interface EffectivePolicy {
  /** Owner rules first, then the company's additions. No duplicates. */
  requireApprovalFor: string[];
  deniedTools: string[];
  maxAmountCents?: number;
  /** Owner rules the company input left out, restored here. Empty when nothing was corrected. */
  corrections: string[];
}

export type MergeResult = ({ ok: true } & EffectivePolicy) | { ok: false; reason: string };

/**
 * Build the effective policy. The owner rules are always included in requireApprovalFor.
 * A company input that omits one is corrected, and the correction is listed in `corrections`.
 * Invalid input returns { ok: false } (fail closed).
 */
export function mergeWithOwnerRules(companyPolicy: unknown): MergeResult {
  const parsed = parseCompanyPolicy(companyPolicy);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const company = parsed.policy;
  const corrections: string[] = [];
  for (const rule of OWNER_APPROVAL_RULES) {
    if (!company.requireApprovalFor.includes(rule)) {
      corrections.push(`restored owner approval rule '${rule}' that the company policy omitted`);
    }
  }

  const requireApprovalFor: string[] = [...OWNER_APPROVAL_RULES];
  for (const action of company.requireApprovalFor) {
    if (!requireApprovalFor.includes(action)) requireApprovalFor.push(action);
  }

  const effective: { ok: true } & EffectivePolicy = {
    ok: true,
    requireApprovalFor,
    deniedTools: [...new Set(company.deniedTools)],
    corrections,
  };
  if (company.maxAmountCents !== undefined) effective.maxAmountCents = company.maxAmountCents;
  return effective;
}

/* ------------------------------------------------------------------------------------------------
 * Company controls: the full settings an admin writes for one company (roles, tiers, action limits,
 * budgets and approval rules). Pure, like the rest of this file. Writes are all-or-nothing: a value
 * that fails any check refuses the whole document, and nothing is stored.
 * ---------------------------------------------------------------------------------------------- */

/** Autonomy tiers in order, least to most autonomous. Same names as the authority ladder. */
export const CONTROL_TIERS = ['assist', 'suggest', 'auto', 'predictive'] as const;
export type ControlTier = (typeof CONTROL_TIERS)[number];

const TIER_RANK: Readonly<Record<ControlTier, number>> = { assist: 0, suggest: 1, auto: 2, predictive: 3 };

/** Budget keys, the same five limits budgets.ts enforces. */
export const BUDGET_KEYS = [
  'maxToolCallsPerRun',
  'maxTokensPerRun',
  'maxSpendCentsPerRun',
  'maxRunsPerCompanyPerDay',
  'maxSpendCentsPerCompanyPerDay',
] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];
export type CompanyBudgets = Record<BudgetKey, number>;

/** Largest budget a company may set. Above this the value is refused as a likely typing error. */
export const MAX_BUDGET_VALUE = 1_000_000_000;

export interface RoleControl {
  enabled: boolean;
  tier: ControlTier;
}

/** A complete company control document. Every role, the action policy and every budget are present. */
export interface CompanyControls {
  roles: Record<string, RoleControl>;
  policy: CompanyPolicyInput;
  budgets: CompanyBudgets;
}

/** What is shown when no document is stored. Budgets are null until an admin sets them. */
export interface ControlsDocument {
  roles: Record<string, RoleControl>;
  policy: CompanyPolicyInput;
  budgets: CompanyBudgets | null;
}

const tierSchema = z.enum(CONTROL_TIERS);
const budgetValue = z.number().int().positive().max(MAX_BUDGET_VALUE);

const roleControlSchema = z
  .object({
    enabled: z.boolean(),
    tier: tierSchema,
  })
  .strict();

const budgetsSchema = z
  .object({
    maxToolCallsPerRun: budgetValue,
    maxTokensPerRun: budgetValue,
    maxSpendCentsPerRun: budgetValue,
    maxRunsPerCompanyPerDay: budgetValue,
    maxSpendCentsPerCompanyPerDay: budgetValue,
  })
  .strict();

const controlsSchema = z
  .object({
    roles: z.record(z.string(), roleControlSchema),
    policy: companyPolicySchema,
    budgets: budgetsSchema,
  })
  .strict();

export type ControlsParseResult = { ok: true; controls: CompanyControls } | { ok: false; reason: string };

/**
 * Validates a full company control document against the role catalogue.
 * `roleCaps` maps each role id to that role's tier cap (its autonomy in the catalogue).
 *
 * Refused when: a key is unknown; a role in the catalogue is missing or an unknown role id is given;
 * a role's tier ranks above its cap; any budget is missing or not a positive integer within MAX_BUDGET_VALUE;
 * or an owner approval rule (money, customer_send, delete) is not in requireApprovalFor.
 * Refusal reasons never echo the submitted values, only field paths and fixed phrases.
 */
export function parseCompanyControls(input: unknown, roleCaps: ReadonlyMap<string, ControlTier>): ControlsParseResult {
  const parsed = controlsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: describeIssue(parsed.error) };
  const doc = parsed.data;

  for (const roleId of Object.keys(doc.roles)) {
    if (!roleCaps.has(roleId)) return { ok: false, reason: 'roles: unknown role id; failing closed' };
  }
  for (const [roleId, cap] of roleCaps) {
    const entry = doc.roles[roleId];
    if (!entry) return { ok: false, reason: `roles.${roleId}: missing; every role must be set; failing closed` };
    if (TIER_RANK[entry.tier] > TIER_RANK[cap]) {
      return { ok: false, reason: `roles.${roleId}.tier: above the role cap '${cap}'; failing closed` };
    }
  }
  for (const rule of OWNER_APPROVAL_RULES) {
    if (!doc.policy.requireApprovalFor.includes(rule)) {
      return { ok: false, reason: `policy.requireApprovalFor: owner rule '${rule}' cannot be turned off; failing closed` };
    }
  }

  return { ok: true, controls: doc as CompanyControls };
}

/**
 * The document shown before an admin has saved anything: every role disabled at the lowest tier, the owner
 * approval rules only, no extra denials, and no budgets. Fail closed: nothing is enabled by default.
 */
export function defaultControlsDocument(roleCaps: ReadonlyMap<string, ControlTier>): ControlsDocument {
  const roles: Record<string, RoleControl> = {};
  for (const roleId of roleCaps.keys()) roles[roleId] = { enabled: false, tier: 'assist' };
  return { roles, policy: { requireApprovalFor: [...OWNER_APPROVAL_RULES], deniedTools: [] }, budgets: null };
}

/**
 * Plain-language list of what changed between the stored document and the new one. Used for the audit
 * record. Returns an empty list when nothing differs.
 */
export function describeControlChanges(before: ControlsDocument, after: CompanyControls): string[] {
  const changes: string[] = [];
  const roleIds = new Set([...Object.keys(before.roles), ...Object.keys(after.roles)]);
  for (const roleId of roleIds) {
    const was = before.roles[roleId];
    const now = after.roles[roleId];
    if (!was || !now) continue;
    if (was.enabled !== now.enabled) changes.push(`role ${roleId}: ${was.enabled ? 'enabled' : 'disabled'} -> ${now.enabled ? 'enabled' : 'disabled'}`);
    if (was.tier !== now.tier) changes.push(`role ${roleId}: tier ${was.tier} -> ${now.tier}`);
  }
  const beforeApproval = new Set(before.policy.requireApprovalFor);
  const afterApproval = new Set(after.policy.requireApprovalFor);
  for (const item of afterApproval) if (!beforeApproval.has(item)) changes.push(`approval required for ${item}`);
  for (const item of beforeApproval) if (!afterApproval.has(item)) changes.push(`approval no longer required for ${item}`);
  const beforeDenied = new Set(before.policy.deniedTools);
  const afterDenied = new Set(after.policy.deniedTools);
  for (const item of afterDenied) if (!beforeDenied.has(item)) changes.push(`tool denied: ${item}`);
  for (const item of beforeDenied) if (!afterDenied.has(item)) changes.push(`tool no longer denied: ${item}`);
  if (before.policy.maxAmountCents !== after.policy.maxAmountCents) {
    changes.push(`max amount ${before.policy.maxAmountCents ?? 'none'} -> ${after.policy.maxAmountCents ?? 'none'} cents`);
  }
  for (const key of BUDGET_KEYS) {
    const was = before.budgets?.[key];
    if (was !== after.budgets[key]) changes.push(`budget ${key}: ${was ?? 'unset'} -> ${after.budgets[key]}`);
  }
  return changes;
}
