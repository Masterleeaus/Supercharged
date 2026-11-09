/**
 * One tool registry shared by every agent. Each call is checked in this order, and the first failure refuses it:
 *   1. companyId (tryCompanyId, from ai-runtime)
 *   2. actor: an agent with agentId and roleId, or a human with userId
 *   3. tool id is registered (unknown tools fail closed)
 *   4. params are a plain object, carry no tenant override key, and match the tool's schema
 *   5. effective risk tier = the higher of the tool's tier and the calling role's toolRisk entry
 *   6. evaluatePolicy (approvals/policy-evaluator.ts), with the tool's risk, access and category, the company
 *      policy, and approval state 'none'. It runs the authority ladder first, then company rules and category
 *      gates. deny refuses; require_approval goes to the gate
 *   7. approval, when required: the gate records the request, and the call runs only after a human approval is
 *      re-read from the gate and checked against companyId, tool id and a hash of the exact params. The policy
 *      is then evaluated again with approval state 'approved', and it must allow
 *   8. the decision is audited before the handler runs. If the audit write fails, the call is refused.
 *   9. the handler runs through ToolExecutor (allowlist, timeout, AbortSignal). Output is redacted, then size-capped.
 *
 * Reuse: evaluatePolicy and CATEGORIES (approvals/policy-evaluator.ts), which in turn use evaluateAuthority and
 * RISK_TIERS (approvals/authority-ladder.ts), tryCompanyId and
 * DEFAULT_TOOL_TIMEOUT_MS (ai-runtime/company.ts, tools.ts), ToolExecutor (ai-runtime/tools.ts).
 * Ported in concept from Clean-Hub app/Titan/AI/ToolRouter.php: the tenant-override check
 * (containsTenantOverride) and the registered-tool-only rule. Not ported: capability and WorkCore
 * action dispatch, idempotency keys, and the Laravel container.
 *
 * Only this module and the injected gate touch approvals. It does not import the approval service or the database.
 */
import { createHash } from 'node:crypto';
import { isRiskTier, RISK_TIERS, type RiskTier, type ToolAccess } from '../../modules/approvals/authority-ladder.ts';
import { evaluatePolicy, type ActionCategory, type CompanyPolicy, type PolicyInput } from '../../modules/approvals/policy-evaluator.ts';
import { DEFAULT_TOOL_TIMEOUT_MS, ToolExecutor, type ToolHandler, type ToolResult } from '../../services/ai-runtime/tools.ts';
import { tryCompanyId } from '../../services/ai-runtime/company.ts';
import { AiRuntimeError, type CompanyId } from '../../services/ai-runtime/types.ts';
import type { AuditSink } from './store.ts';
import { idempotencyKey, type ClaimResult, type IdempotencyStore } from './idempotency.ts';
import { assertFreshForAction, FRESHNESS_KINDS, type FreshnessItem, type FreshnessKind } from './freshness.ts';
import type { SqlExecutor } from './pg-store.ts';
import { runActionWithJournal } from './action-journal-pg.ts';
import { providerIdempotencyKey } from './provider-idempotency.ts';
import { resolveUnknownOutcome, type UnknownOutcomeChange, type UnknownOutcomeResolution } from './unknown-outcomes.ts';
import { refusePredictiveDirectWrite, stagePredictiveAction, type PredictiveShadow, type PredictiveStageParams } from './predictive-staging.ts';
import type { ShadowCategory } from './shadow-changes.ts';

export { RISK_TIERS, type RiskTier };
export type { ToolHandler };

/**
 * Version of the policy rules this registry applies (evaluatePolicy plus evaluateAuthority). evaluatePolicy returns
 * no version of its own, so this constant stands in for it. Bump it whenever those rules change.
 */
export const TOOL_POLICY_VERSION = 'policy-evaluator/v1';
/** Tier recorded for a refusal where the tool is unknown or the role override is invalid. The most severe tier, so the record fails closed. */
const FAIL_CLOSED_TIER: RiskTier = RISK_TIERS[RISK_TIERS.length - 1];

export const DEFAULT_MAX_OUTPUT_BYTES = 16_384;
/** Total attempts (first try included) for a write that carries an idempotency key. Unkeyed writes get one attempt. */
export const KEYED_WRITE_MAX_ATTEMPTS = 3;
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;
/** Approval namespaces that count as a human decision. Policy auto-approval ('policy:...') does not. */
export const HUMAN_DECIDER_NAMESPACES: readonly string[] = ['dashboard', 'slack', 'discord'];

const TOOL_ID_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;
const TENANT_OVERRIDE_KEYS = new Set(['companyid', 'company_id', 'tenantid', 'tenant_id', 'tenant']);
const MAX_NESTING = 10;

export type ToolFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';
export interface ToolField {
  type: ToolFieldType;
  required?: boolean;
}
export type ToolSchema = Readonly<Record<string, ToolField>>;

/** The actor as the caller supplies it. For agents, autonomy and toolRisk are passed through from the role. */
export interface AgentActor {
  kind: 'agent';
  agentId: string;
  roleId: string;
  autonomy?: unknown;
  toolRisk?: Readonly<Record<string, unknown>>;
  /** The role's access class per tool id, used when a tool does not declare its own access. */
  toolAccess?: Readonly<Record<string, unknown>>;
}
export interface HumanActor {
  kind: 'human';
  userId: string;
}
export type ToolActor = AgentActor | HumanActor;

/** Tool-level category: 'money', 'customer_send', 'delete', or 'other' (the policy category 'none'). */
export type ToolCategory = 'money' | 'customer_send' | 'delete' | 'other';
const TOOL_CATEGORIES: readonly string[] = ['money', 'customer_send', 'delete', 'other'];

export interface ToolHandlerContext {
  companyId: CompanyId;
  signal: AbortSignal;
  /**
   * The idempotency key of this write call, when it has one. A retry of the same call carries the same key, so the
   * external system can recognise and skip a repeat. Absent for reads and for writes with no key.
   */
  idempotencyKey?: string;
  /**
   * The journal's executor, set only for a write that runs inside the action journal transaction (R4). A handler that
   * writes to the database should use it, so its writes commit or roll back with the journal row. Do not use it after
   * the handler's attempt has returned: the transaction is closed then and the query is refused.
   */
  db?: SqlExecutor;
}

export interface ToolDefinition {
  id: string;
  risk: RiskTier;
  /** 'read' or 'write'. Absent means 'write'. A suggest agent may run only read tools. */
  access?: ToolAccess;
  /**
   * Action category, passed to evaluatePolicy. Absent means 'other'. Allowed values:
   *  - 'money':         moves money (payments, refunds, transfers, payouts). Always needs owner approval.
   *  - 'customer_send': sends a message to a customer. Always needs owner approval.
   *  - 'delete':        deletes a record. Always needs owner approval.
   *  - 'other':         anything else. No category gate. Maps to the policy category 'none'.
   * Any other value is refused at registration.
   */
  category?: ToolCategory;
  schema: ToolSchema;
  /** Data kinds this tool relies on (keys of FRESHNESS_LIMITS). Informational unless freshnessOf is set. */
  requiresFresh?: readonly FreshnessKind[];
  /**
   * Returns the context items this call depends on, for the freshness check. Called with the params and the
   * registry clock before the handler. When present, every item must be fresh or the call is refused with
   * 'stale_data'. Absent means no freshness check.
   */
  freshnessOf?: (params: Record<string, unknown>, now: Date) => readonly FreshnessItem[];
  /**
   * How to confirm a write whose outcome is unknown (unknown-outcomes.ts). plan() returns the change this call should
   * have made to the record, or null when it cannot say. readBack() reads the record's current value. Absent: an
   * uncertain write goes to the owner without a read-back.
   */
  outcomeCheck?: {
    plan: (params: Record<string, unknown>) => UnknownOutcomeChange | null;
    readBack: (change: UnknownOutcomeChange) => unknown | Promise<unknown>;
  };
  /**
   * How a predictive agent's write is staged as a shadow change (predictive-staging.ts). Absent: a predictive write is
   * refused and nothing is staged. Returns null when the params cannot be staged.
   */
  stage?: (params: Record<string, unknown>) => { category: ShadowCategory; change: PredictiveStageParams } | null;
  /**
   * Per-tool timeout in milliseconds, a positive integer. Declared on the definition; the registry-wide timeout
   * (ToolRegistryOptions.timeoutMs) is still the one applied to every call.
   */
  timeoutMs?: number;
  handler: (params: Record<string, unknown>, context: ToolHandlerContext) => unknown | Promise<unknown>;
}

/** Redacts secrets from a record. Required. The default redactor lives in services/redaction.ts. */
export type Redactor = (value: Record<string, unknown>) => Record<string, unknown>;

export interface ApprovalRequest {
  companyId: CompanyId;
  requestedBy: string | null;
  agentId: string | null;
  action: string;
  /** Redacted params. The gate is never given the raw params. */
  params: Record<string, unknown>;
  /** Carries paramsSha256 so the gate can store it and return it from readApproval. */
  context: Record<string, unknown>;
  urgency: 'normal';
  ttlMs: number;
}

export interface ApprovalRecord {
  id: string;
  companyId: CompanyId;
  action: string;
  status: string;
  decidedBy: string | null;
  paramsSha256: string | null;
  /** True once a call has claimed this approval. An approval covers one execution. */
  executed: boolean;
}

/**
 * The approval gate, injected. The composition root backs it with ApprovalService:
 *   gateAction      = ApprovalService.gateAction (same input and result shape)
 *   readApproval    = ApprovalService.getApproval, with companyId, paramsSha256 and executed added by the adapter
 *   claimApproval   = ApprovalService.markExecuted, but it must be atomic: succeed only when the approval is
 *                     approved and not yet executed, then return true. Return false otherwise.
 * The adapter must store context.paramsSha256 on the approval, or every approved call will be refused as a mismatch.
 */
export interface ApprovalGate {
  gateAction(request: ApprovalRequest): Promise<{ status: string; approval: { id: string } }>;
  readApproval(companyId: CompanyId, approvalId: string): Promise<ApprovalRecord | null>;
  claimApproval(companyId: CompanyId, approvalId: string, actorId: string | null): Promise<boolean>;
}

export interface ToolRegistryOptions {
  gate: ApprovalGate;
  redact: Redactor;
  audit: AuditSink;
  maxOutputBytes?: number;
  timeoutMs?: number;
  approvalTtlMs?: number;
  /**
   * Optional idempotency store (createIdempotencyStore). When passed, write, money, customer_send and delete tools
   * claim a key per run and call index, and a repeat of a completed call returns its previous output. Absent means
   * no idempotency check.
   */
  idempotencyStore?: IdempotencyStore;
  /** How long a claimed idempotency key blocks repeats, in milliseconds. Defaults to DEFAULT_APPROVAL_TTL_MS. */
  idempotencyTtlMs?: number;
  humanDeciders?: readonly string[];
  /**
   * Single-connection executor (a checked-out pool client, not the pool itself). When set, every executed write runs
   * with its action journal row in one transaction (R4, action-journal-pg.ts). Absent: no journal row is written.
   */
  journal?: { db: SqlExecutor };
  /**
   * Tells the owner that an uncertain write could not be confirmed by read-back (R6). Absent: the audit record of the
   * outcome is the only notice.
   */
  notifyOwner?: (notice: { companyId: CompanyId; runId: string | null; toolId: string; change: UnknownOutcomeChange | null }) => unknown | Promise<unknown>;
  /** Shadow service for predictive writes (R8). Absent: a predictive write is refused and nothing is staged. */
  predictiveShadow?: PredictiveShadow;
  /**
   * Company rules (requireApprovalFor, deniedTools) applied to every call through evaluatePolicy.
   * Optional. Absent means no company rules. A malformed value refuses every call.
   */
  companyPolicy?: CompanyPolicy;
  now?: () => Date;
}

export type RefusalReason =
  | 'company_id_required'
  | 'company_id_invalid'
  | 'actor_invalid'
  | 'actor_unverified'
  | 'tool_unknown'
  | 'input_invalid'
  | 'tenant_override'
  | 'authority_denied'
  | 'gate_error'
  | 'approval_unknown'
  | 'approval_mismatch'
  | 'approval_rejected'
  | 'approval_expired'
  | 'approval_revoked'
  | 'approval_not_human'
  | 'approval_consumed'
  | 'audit_unavailable'
  | 'stale_data'
  | 'freshness_error'
  | 'idempotency_error'
  | 'duplicate_in_flight'
  | 'direct_write_refused';

export interface ToolInvocation {
  companyId: unknown;
  toolId: unknown;
  params: unknown;
  actor: unknown;
  /**
   * True only when the caller has authenticated the actor. The registry refuses any call where this is not exactly
   * true, and it is the verified flag the policy evaluator reads.
   */
  identityVerified: boolean;
  runId?: string | null;
  /** Position of this call within the run. Required for idempotent tools when an idempotency store is passed. */
  callIndex?: number | null;
  correlationId?: string | null;
  /** Set when resuming a call that was waiting for approval. */
  approvalId?: string | null;
}

export type ToolInvocationResult =
  | {
      outcome: 'executed';
      toolId: string;
      tier: RiskTier;
      output: Record<string, unknown>;
      truncated: boolean;
      /** Set when an idempotent repeat returned the output of the earlier, completed call. The handler did not run. */
      reason?: 'duplicate_suppressed';
    }
  | {
      outcome: 'failed';
      toolId: string;
      tier: RiskTier;
      reason: 'tool_failed' | 'tool_timed_out' | 'output_rejected' | 'journal_failed';
      transient: boolean;
      message: string;
      /** Set on a write whose outcome could not be confirmed. A write is never transient, so run.ts does not retry it. */
      uncertain?: boolean;
      /** Set on an uncertain write once read-back and, if needed, the owner have settled it. */
      resolution?: UnknownOutcomeResolution;
    }
  | { outcome: 'awaiting_approval'; toolId: string; tier: RiskTier; approvalId: string; paramsSha256: string }
  /** A draft tool was allowed to proceed. It is recorded as staged for review. No handler ran and no provider was called. */
  | { outcome: 'staged'; toolId: string; tier: RiskTier; paramsSha256: string }
  | {
      outcome: 'refused';
      toolId: string | null;
      reason: RefusalReason;
      message: string;
      /** Set with 'stale_data': each stale or undated context item, by kind and reason. */
      reasons?: Array<{ kind: string; reason: string }>;
      /** Set with 'direct_write_refused' when a predictive write was staged instead (predictive-staging.ts). */
      stagedChangeId?: string;
    };

export interface ToolRegistry {
  register(definition: ToolDefinition): void;
  has(toolId: string): boolean;
  list(): Array<{ id: string; risk: RiskTier }>;
  invoke(invocation: ToolInvocation): Promise<ToolInvocationResult>;
}

/** Marks a handler error as transient (retryable). Use it for timeouts, rate limits and network errors. */
export function transientError(message: string): Error & { transient: true } {
  const error = new Error(message) as Error & { transient: true };
  error.transient = true;
  return error;
}

export function isTransientError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { transient?: unknown }).transient === true;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

/** SHA-256 of the params with keys sorted, so the same params always hash the same. Throws on non-JSON values. */
export function hashToolParams(params: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(params)).digest('hex');
}

function hasTenantOverride(value: unknown, depth = 0): boolean {
  if (depth > MAX_NESTING) return false;
  if (Array.isArray(value)) return value.some((item) => hasTenantOverride(item, depth + 1));
  if (isPlainObject(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (TENANT_OVERRIDE_KEYS.has(key.toLowerCase())) return true;
      if (hasTenantOverride(inner, depth + 1)) return true;
    }
  }
  return false;
}

function matchesType(type: ToolFieldType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
  }
}

/** Returns issue strings naming fields only. Values are never echoed back. */
export function validateToolParams(schema: ToolSchema, params: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const key of Object.keys(params)) {
    if (!hasOwn(schema, key)) issues.push(`${key}: unknown field`);
  }
  for (const [field, rule] of Object.entries(schema)) {
    const value = hasOwn(params, field) ? params[field] : undefined;
    const absent = value === undefined || value === null;
    if (absent) {
      if (rule.required === true) issues.push(`${field}: required`);
      continue;
    }
    if (!matchesType(rule.type, value) || (rule.required === true && value === '')) {
      issues.push(`${field}: expected ${rule.type}`);
    }
  }
  return issues;
}

function isValidSchema(schema: unknown): schema is ToolSchema {
  if (!isPlainObject(schema)) return false;
  const types: readonly string[] = ['string', 'number', 'boolean', 'object', 'array'];
  return Object.values(schema).every(
    (rule) => isPlainObject(rule) && types.includes(rule.type as string) && (rule.required === undefined || typeof rule.required === 'boolean'),
  );
}

type NormalisedActor =
  | {
      kind: 'agent';
      agentId: string;
      roleId: string;
      autonomy: unknown;
      toolRisk: Readonly<Record<string, unknown>> | undefined;
      toolAccess: Readonly<Record<string, unknown>> | undefined;
    }
  | { kind: 'human'; userId: string };

/**
 * Effective access for one call: the stricter of the tool's own access and the role's claim for this tool, so 'write'
 * wins when they differ. A tool with no declared access is 'write' (fail closed). A role with no entry for this tool
 * makes no claim. A role entry other than 'read' counts as 'write'. A tool access value other than 'read' or 'write'
 * is returned unchanged, so evaluatePolicy refuses it at every tier.
 */
function resolveAccess(definition: ToolDefinition, actor: NormalisedActor | null): ToolAccess {
  const own: unknown = definition.access;
  if (own === undefined) return 'write';
  if (own !== 'read') return own as ToolAccess;
  const fromRole = actor !== null && actor.kind === 'agent' ? actor.toolAccess : undefined;
  if (fromRole === undefined || !Object.prototype.hasOwnProperty.call(fromRole, definition.id)) return 'read';
  return fromRole[definition.id] === 'read' ? 'read' : 'write';
}

/**
 * A draft tool produces text or a proposal for a person to review. It never executes. Identified by the last segment
 * of its ID: 'draft' or 'draft_<something>' (customer_messages.draft, messages.draft_customer, purchase_orders.draft).
 */
function isDraftTool(toolId: string): boolean {
  const last = toolId.split('.').pop() ?? '';
  return last === 'draft' || last.startsWith('draft_');
}

function parseActor(raw: unknown): NormalisedActor | null {
  if (!isPlainObject(raw)) return null;
  if (raw.kind === 'agent') {
    if (!isNonEmptyString(raw.agentId) || !isNonEmptyString(raw.roleId)) return null;
    if (raw.toolRisk !== undefined && !isPlainObject(raw.toolRisk)) return null;
    if (raw.toolAccess !== undefined && !isPlainObject(raw.toolAccess)) return null;
    return {
      kind: 'agent',
      agentId: raw.agentId,
      roleId: raw.roleId,
      autonomy: raw.autonomy,
      toolRisk: raw.toolRisk as Readonly<Record<string, unknown>> | undefined,
      toolAccess: raw.toolAccess as Readonly<Record<string, unknown>> | undefined,
    };
  }
  if (raw.kind === 'human' && isNonEmptyString(raw.userId)) return { kind: 'human', userId: raw.userId };
  return null;
}

function actorKey(actor: NormalisedActor): string {
  return actor.kind === 'agent' ? actor.agentId : actor.userId;
}

/** Effective tier: the higher of the tool's tier and the role's override. Returns null for an invalid override. */
function effectiveTier(base: RiskTier, toolId: string, actor: NormalisedActor): RiskTier | null {
  if (actor.kind !== 'agent' || !actor.toolRisk || !hasOwn(actor.toolRisk, toolId)) return base;
  const raw = actor.toolRisk[toolId];
  if (!isRiskTier(raw)) return null;
  return RISK_TIERS.indexOf(raw) > RISK_TIERS.indexOf(base) ? raw : base;
}

const WRITE_CATEGORIES: readonly string[] = ['money', 'customer_send', 'delete'];

/** Tools that get an idempotency check: any tool with access 'write' (absent counts as write), or a write-like category. */
function isWriteLike(definition: ToolDefinition): boolean {
  return (definition.access ?? 'write') === 'write' || (definition.category !== undefined && WRITE_CATEGORIES.includes(definition.category));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fields every tool audit event carries. Built once per call, before any check can refuse it. */
interface AuditBase {
  runId: string | null;
  toolId: string | null;
  tier: RiskTier;
  policyVersion: string;
  actorKind: 'agent' | 'human' | null;
  actorId: string | null;
  roleId: string | null;
  paramsSha256: string | null;
}

function auditFields(base: AuditBase): Record<string, unknown> {
  return {
    toolId: base.toolId,
    tier: base.tier,
    policyVersion: base.policyVersion,
    actorKind: base.actorKind,
    actorId: base.actorId,
    roleId: base.roleId,
    paramsSha256: base.paramsSha256,
  };
}

/** Hash of the raw params as the caller sent them. Null when they are not a plain object or not JSON-serialisable. */
function safeParamsHash(raw: unknown): string | null {
  if (raw === undefined) return hashToolParams({});
  if (!isPlainObject(raw)) return null;
  try {
    return hashToolParams(raw);
  } catch {
    return null;
  }
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  if (!options || typeof options.gate !== 'object' || options.gate === null) throw new AiRuntimeError('config_invalid', 'tool registry needs a gate');
  if (typeof options.redact !== 'function') throw new AiRuntimeError('config_invalid', 'tool registry needs a redactor');
  if (!options.audit || typeof options.audit.record !== 'function') throw new AiRuntimeError('config_invalid', 'tool registry needs an audit sink');

  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new AiRuntimeError('config_invalid', 'maxOutputBytes must be a positive integer');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new AiRuntimeError('config_invalid', 'timeoutMs must be a positive integer');
  if (!Number.isFinite(approvalTtlMs) || approvalTtlMs <= 0) throw new AiRuntimeError('config_invalid', 'approvalTtlMs must be positive');
  if (!Number.isFinite(idempotencyTtlMs) || idempotencyTtlMs <= 0) throw new AiRuntimeError('config_invalid', 'idempotencyTtlMs must be positive');
  if (options.idempotencyStore !== undefined && (typeof options.idempotencyStore !== 'object' || options.idempotencyStore === null)) {
    throw new AiRuntimeError('config_invalid', 'idempotencyStore must be an idempotency store');
  }

  const gate = options.gate;
  const idempotencyStore = options.idempotencyStore;
  const redact = options.redact;
  const sink = options.audit;
  const humanDeciders = new Set(options.humanDeciders ?? HUMAN_DECIDER_NAMESPACES);
  const now = options.now ?? (() => new Date());
  const tools = new Map<string, ToolDefinition>();

  /** Refusals never run anything, so a sink failure here still refuses. */
  async function auditSafely(event: { companyId: CompanyId | null; runId: string | null; data: Record<string, unknown> }): Promise<boolean> {
    try {
      await sink.record({
        id: crypto.randomUUID(),
        companyId: event.companyId,
        runId: event.runId,
        kind: 'tool.decision',
        at: now().toISOString(),
        data: event.data,
      });
      return true;
    } catch {
      return false;
    }
  }

  function isHumanDecision(decidedBy: string | null): boolean {
    if (!isNonEmptyString(decidedBy)) return false;
    const namespace = decidedBy.split(':')[0];
    return humanDeciders.has(namespace);
  }

  async function refuse(companyId: CompanyId | null, base: AuditBase, reason: RefusalReason, message: string): Promise<ToolInvocationResult> {
    await auditSafely({ companyId, runId: base.runId, data: { ...auditFields(base), outcome: 'refused', reason } });
    return { outcome: 'refused', toolId: base.toolId, reason, message };
  }

  /**
   * R8: a predictive agent's write is refused as a direct write, and staged as a pending shadow change when the tool
   * can be staged and a shadow service is configured. Staging never applies the change. It still needs Auto or approval.
   */
  async function stagePredictive(
    companyId: CompanyId,
    base: AuditBase,
    definition: ToolDefinition,
    actor: Extract<NormalisedActor, { kind: 'agent' }>,
    params: Record<string, unknown>,
    runId: string | null,
    detail: string,
  ): Promise<ToolInvocationResult> {
    const staging = definition.stage?.(params) ?? null;
    if (options.predictiveShadow === undefined || staging === null) {
      return refuse(companyId, base, 'direct_write_refused', detail);
    }
    const change: PredictiveStageParams = { ...staging.change, runId: runId ?? staging.change.runId };
    let staged: Awaited<ReturnType<typeof stagePredictiveAction>>;
    try {
      staged = await stagePredictiveAction(
        { shadow: options.predictiveShadow },
        { companyId, agentId: actor.agentId, roleId: actor.roleId, toolId: definition.id, params: change, category: staging.category },
      );
    } catch {
      return refuse(companyId, base, 'direct_write_refused', 'Predictive write could not be staged. Nothing ran.');
    }
    if (!staged.ok) return refuse(companyId, base, 'direct_write_refused', 'Predictive write could not be staged. Nothing ran.');
    const refusal = await refuse(companyId, base, 'direct_write_refused', 'Predictive writes are staged for approval. Nothing ran.');
    return { ...refusal, stagedChangeId: staged.change.id };
  }

  async function verifyApproval(
    companyId: CompanyId,
    approvalId: string,
    toolId: string,
    paramsSha256: string,
  ): Promise<{ state: 'approved' } | { state: 'pending' } | { state: 'refused'; reason: RefusalReason }> {
    let record: ApprovalRecord | null;
    try {
      record = await gate.readApproval(companyId, approvalId);
    } catch {
      return { state: 'refused', reason: 'gate_error' };
    }
    if (!record || record.companyId !== companyId) return { state: 'refused', reason: 'approval_unknown' };
    if (record.action !== toolId || record.paramsSha256 !== paramsSha256) return { state: 'refused', reason: 'approval_mismatch' };
    if (record.executed === true) return { state: 'refused', reason: 'approval_consumed' };
    switch (record.status) {
      case 'pending':
        return { state: 'pending' };
      case 'rejected':
        return { state: 'refused', reason: 'approval_rejected' };
      case 'expired':
        return { state: 'refused', reason: 'approval_expired' };
      case 'revoked':
        return { state: 'refused', reason: 'approval_revoked' };
      case 'approved':
        return isHumanDecision(record.decidedBy) ? { state: 'approved' } : { state: 'refused', reason: 'approval_not_human' };
      default:
        return { state: 'refused', reason: 'gate_error' };
    }
  }

  /** Keys for one call: the Desk intent key (store dedupe) and the provider key sent with the call (R5). */
  interface IdemClaim {
    key: string;
    providerKey: string;
  }

  interface AttemptRun {
    result: ToolResult;
    failure: string;
    transient: boolean;
    attempts: number;
  }

  /**
   * The attempt loop. A write with an idempotency key (idem !== null) is retried after a timeout or a transient error,
   * up to KEYED_WRITE_MAX_ATTEMPTS, and every attempt carries the same provider key. Any other write runs once.
   * Reads run once here; run.ts retries them via `transient`. db is the journal executor, or undefined without a journal.
   */
  async function runAttempts(
    companyId: CompanyId,
    definition: ToolDefinition,
    params: Record<string, unknown>,
    idem: IdemClaim | null,
    db: SqlExecutor | undefined,
  ): Promise<AttemptRun> {
    const toolId = definition.id;
    const isWrite = (definition.access ?? 'write') === 'write';
    const maxAttempts = isWrite && idem !== null ? KEYED_WRITE_MAX_ATTEMPTS : 1;
    let transient = false;
    let failure = '';

    const handler: ToolHandler = async (input, context) => {
      try {
        return await definition.handler(input, { ...context, idempotencyKey: idem?.providerKey, db });
      } catch (error) {
        transient = isTransientError(error);
        failure = errorText(error);
        throw error;
      }
    };

    let result: ToolResult;
    let attempts = 0;
    for (let attempt = 1; ; attempt++) {
      transient = false;
      failure = '';
      attempts = attempt;
      const executor = new ToolExecutor({
        manifest: { [toolId]: { handler, input_schema: {} } },
        allowedTools: [toolId],
        timeoutMs: definition.timeoutMs ?? timeoutMs,
      });
      result = await executor.execute(toolId, params, { companyId });
      if (result.ok) break;
      const retryable = result.error_code === 'tool_timed_out' || transient;
      if (!isWrite || idem === null || !retryable || attempt >= maxAttempts) break;
    }
    return { result, failure, transient, attempts };
  }

  /** Confirms an uncertain write: read the record back first, and tell the owner only if the record still does not show the outcome. */
  async function resolveUncertain(
    companyId: CompanyId,
    base: AuditBase,
    definition: ToolDefinition,
    params: Record<string, unknown>,
  ): Promise<UnknownOutcomeResolution> {
    const check = definition.outcomeCheck;
    const notify = async (change: UnknownOutcomeChange | null): Promise<void> => {
      try {
        await options.notifyOwner?.({ companyId, runId: base.runId, toolId: definition.id, change });
      } catch {
        // The 'owner_decides' record below still keeps the case open. A failed notice does not change the outcome.
      }
    };
    const record = async (resolution: UnknownOutcomeResolution): Promise<void> => {
      await auditSafely({
        companyId,
        runId: base.runId,
        data: { ...auditFields(base), outcome: 'unknown_resolved', resolution },
      });
    };

    let change: UnknownOutcomeChange | null = null;
    if (check !== undefined) {
      try {
        change = check.plan(params);
      } catch {
        change = null;
      }
    }
    if (check === undefined || change === null) {
      await notify(null);
      await record('owner_decides');
      return 'owner_decides';
    }
    try {
      return await resolveUnknownOutcome(
        {
          readBack: (c) => check.readBack(c),
          notifyOwner: (c) => notify(c),
          record: (resolution) => record(resolution),
        },
        change,
      );
    } catch {
      await notify(change);
      await record('owner_decides');
      return 'owner_decides';
    }
  }

  async function execute(
    companyId: CompanyId,
    base: AuditBase,
    definition: ToolDefinition,
    params: Record<string, unknown>,
    idem: IdemClaim | null,
  ): Promise<ToolInvocationResult> {
    const toolId = definition.id;
    const tier = base.tier;
    const isWrite = (definition.access ?? 'write') === 'write';
    const journalDb = options.journal?.db;

    // R4: an executed write and its journal row commit together. The retry loop runs inside the transaction, so the
    // journal row records the final attempt. The handler's executor is closed when its attempt returns.
    let attempted: AttemptRun | null = null;
    if (isWrite && journalDb !== undefined) {
      try {
        attempted = await runActionWithJournal<AttemptRun>(journalDb, {
          journalRow: (done) => ({
            company_id: companyId,
            run_id: base.runId,
            tool_id: toolId,
            tier,
            actor_kind: base.actorKind,
            actor_id: base.actorId,
            role_id: base.roleId,
            params_sha256: base.paramsSha256,
            idempotency_key: idem?.key ?? null,
            attempts: done.attempts,
            handler_outcome: done.result.ok ? 'completed' : done.result.error_code === 'tool_timed_out' ? 'timed_out' : 'failed',
            created_at: now().toISOString(),
          }),
          action: async (db) => {
            let open = true;
            const scoped: SqlExecutor = {
              query: async (text, values) => {
                if (!open) throw new Error('action journal transaction is closed');
                return db.query(text, values);
              },
            };
            try {
              return await runAttempts(companyId, definition, params, idem, scoped);
            } finally {
              open = false;
            }
          },
        });
      } catch {
        // Neither the handler's writes nor the journal row were kept. The external effect may still have happened.
        attempted = null;
      }
    } else {
      attempted = await runAttempts(companyId, definition, params, idem, undefined);
    }

    const finish = async (data: Record<string, unknown>): Promise<void> => {
      try {
        await sink.record({
          id: crypto.randomUUID(),
          companyId,
          runId: base.runId,
          kind: 'tool.execution',
          at: now().toISOString(),
          data: { ...auditFields(base), ...data },
        });
      } catch {
        // The decision was audited before the handler ran. A failed write here cannot undo the run.
      }
    };

    if (attempted === null || !attempted.result.ok) {
      const journalFailed = attempted === null;
      const timedOut = !journalFailed && attempted.result.error_code === 'tool_timed_out';
      const transient = journalFailed ? false : attempted.transient;
      const reason = journalFailed ? 'journal_failed' : timedOut ? 'tool_timed_out' : 'tool_failed';
      // A write that timed out, failed transiently, or whose journal could not be written may have acted on the outside
      // world. It is uncertain, never transient, and is confirmed by read-back before anyone decides (R6).
      const uncertain = isWrite && (journalFailed || timedOut || transient);
      // Reads have no side effects and keep their retry through run.ts.
      const retryable = !isWrite && (timedOut || transient);
      const message = redactedMessage(
        journalFailed ? 'Action journal could not be written.' : attempted.failure || attempted.result.message,
      );
      const resolution = uncertain ? await resolveUncertain(companyId, base, definition, params) : undefined;
      const settled = resolution === undefined ? {} : { resolution };
      await finish({ toolId, tier, outcome: 'failed', reason, transient: retryable, uncertain, ...settled });
      return { outcome: 'failed', toolId, tier, reason, transient: retryable, uncertain, message, ...settled };
    }
    const result = attempted.result;

    let redacted: Record<string, unknown>;
    let serialized: string;
    try {
      redacted = redact(result.data);
      serialized = JSON.stringify(redacted) ?? 'null';
    } catch {
      await finish({ toolId, tier, outcome: 'failed', reason: 'output_rejected', transient: false });
      return { outcome: 'failed', toolId, tier, reason: 'output_rejected', transient: false, message: 'Output could not be redacted.' };
    }

    const bytes = Buffer.byteLength(serialized, 'utf8');
    const truncated = bytes > maxOutputBytes;
    const output = truncated ? { truncated: true, bytes, preview: serialized.slice(0, maxOutputBytes) } : redacted;
    await finish({ toolId, tier, outcome: 'executed', bytes, truncated });
    return { outcome: 'executed', toolId, tier, output, truncated };
  }

  function redactedMessage(text: string): string {
    try {
      const cleaned = redact({ message: text }).message;
      return typeof cleaned === 'string' ? cleaned.slice(0, 200) : '[redacted]';
    } catch {
      return '[redaction_failed]';
    }
  }

  return {
    register(definition) {
      if (!isPlainObject(definition)) throw new AiRuntimeError('config_invalid', 'tool definition must be an object');
      if (typeof definition.id !== 'string' || !TOOL_ID_PATTERN.test(definition.id)) {
        throw new AiRuntimeError('config_invalid', 'tool id must be lowercase, start with a letter, and be at most 128 characters');
      }
      if (!isRiskTier(definition.risk)) throw new AiRuntimeError('config_invalid', `tool ${definition.id} needs a risk tier (${RISK_TIERS.join(', ')})`);
      if (typeof definition.handler !== 'function') throw new AiRuntimeError('config_invalid', `tool ${definition.id} needs a handler`);
      if (definition.timeoutMs !== undefined && (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs < 1)) {
        throw new AiRuntimeError('config_invalid', `tool ${definition.id} timeoutMs must be a positive integer`);
      }
      if (!isValidSchema(definition.schema)) throw new AiRuntimeError('config_invalid', `tool ${definition.id} has an invalid schema`);
      if (definition.category !== undefined && !TOOL_CATEGORIES.includes(definition.category)) {
        throw new AiRuntimeError('config_invalid', `tool ${definition.id} has an unknown category (${TOOL_CATEGORIES.join(', ')})`);
      }
      if (definition.requiresFresh !== undefined) {
        const kinds = definition.requiresFresh as unknown;
        if (!Array.isArray(kinds) || !kinds.every((k) => (FRESHNESS_KINDS as readonly string[]).includes(k as string))) {
          throw new AiRuntimeError('config_invalid', `tool ${definition.id} has an unknown requiresFresh kind (${FRESHNESS_KINDS.join(', ')})`);
        }
      }
      if (definition.freshnessOf !== undefined && typeof definition.freshnessOf !== 'function') {
        throw new AiRuntimeError('config_invalid', `tool ${definition.id} has a freshnessOf that is not a function`);
      }
      if (tools.has(definition.id)) throw new AiRuntimeError('config_invalid', `tool already registered: ${definition.id}`);
      tools.set(definition.id, { ...definition, schema: { ...definition.schema } });
    },

    has(toolId) {
      return tools.has(toolId);
    },

    list() {
      return [...tools.values()].map((t) => ({ id: t.id, risk: t.risk }));
    },

    async invoke(invocation) {
      const runId = typeof invocation?.runId === 'string' ? invocation.runId : null;
      const toolId = typeof invocation?.toolId === 'string' ? invocation.toolId : null;
      // Actor and tool are read before the company check, so even a call with no company records who sent it.
      const actor = parseActor(invocation?.actor);
      const registered = toolId !== null ? tools.get(toolId) : undefined;
      // Access is resolved once here, so every later check (idempotency, journal, policy, predictive gate) agrees.
      const definition: ToolDefinition | undefined = registered === undefined ? undefined : { ...registered, access: resolveAccess(registered, actor) };
      const base: AuditBase = {
        runId,
        toolId,
        tier: definition === undefined ? FAIL_CLOSED_TIER : actor === null ? definition.risk : (effectiveTier(definition.risk, definition.id, actor) ?? FAIL_CLOSED_TIER),
        policyVersion: TOOL_POLICY_VERSION,
        actorKind: actor === null ? null : actor.kind,
        actorId: actor === null ? null : actorKey(actor),
        roleId: actor !== null && actor.kind === 'agent' ? actor.roleId : null,
        paramsSha256: safeParamsHash(invocation?.params),
      };

      const rawCompany = invocation?.companyId;
      const companyId = tryCompanyId(rawCompany);
      if (companyId === null) {
        const missing = rawCompany === undefined || rawCompany === null || rawCompany === '';
        return refuse(null, base, missing ? 'company_id_required' : 'company_id_invalid', 'companyId is required for every tool call.');
      }

      if (actor === null) return refuse(companyId, base, 'actor_invalid', 'Actor must be an agent with agentId and roleId, or a human with userId.');
      if (invocation.identityVerified !== true) return refuse(companyId, base, 'actor_unverified', 'The actor identity is not verified. Nothing ran.');

      if (!definition || toolId === null) return refuse(companyId, base, 'tool_unknown', 'Tool is not registered.');

      const params = invocation.params === undefined ? {} : invocation.params;
      if (!isPlainObject(params)) return refuse(companyId, base, 'input_invalid', 'Input must be an object.');
      if (hasTenantOverride(params)) return refuse(companyId, base, 'tenant_override', 'Input may not name a company or tenant.');

      const issues = validateToolParams(definition.schema, params);
      if (issues.length > 0) return refuse(companyId, base, 'input_invalid', `Input is invalid: ${issues.join('; ')}`);

      const paramsSha256 = base.paramsSha256 ?? '';
      if (paramsSha256 === '') return refuse(companyId, base, 'input_invalid', 'Input must be JSON-serialisable.');

      const tier = effectiveTier(definition.risk, toolId, actor);
      if (tier === null) return refuse(companyId, base, 'authority_denied', 'Role tool risk is not a valid tier.');

      // R8: a predictive agent may only stage a write. A direct write is refused, and staged when the tool can be staged.
      if (actor.kind === 'agent' && actor.autonomy === 'predictive') {
        const gateDecision = refusePredictiveDirectWrite(definition.access ?? 'write');
        if (!gateDecision.allowed) return stagePredictive(companyId, base, definition, actor, params, runId, gateDecision.detail);
      }

      const autonomy = actor.kind === 'agent' ? actor.autonomy : 'user_only';
      // Resolved access (tool, then role, then 'write'), as set at the top of invoke.
      const policyBase: Omit<PolicyInput, 'approvalState'> = {
        tier: autonomy,
        access: definition.access ?? 'write',
        risk: tier,
        action: toolId,
        actor: { kind: actor.kind, verified: invocation.identityVerified === true },
        category: definition.category === undefined || definition.category === 'other' ? 'none' : (definition.category as ActionCategory),
        companyPolicy: options.companyPolicy,
      };
      const first = evaluatePolicy({ ...policyBase, approvalState: 'none' });
      if (first.decision === 'deny') return refuse(companyId, base, 'authority_denied', first.reason);

      // Freshness is checked before any approval is requested, so a stale call never reaches the gate.
      if (typeof definition.freshnessOf === 'function') {
        let verdict: ReturnType<typeof assertFreshForAction>;
        try {
          const items = definition.freshnessOf(params, now());
          if (!Array.isArray(items)) throw new TypeError('freshnessOf must return an array');
          verdict = assertFreshForAction(items, { now: now().getTime() });
        } catch {
          return refuse(companyId, base, 'freshness_error', 'Freshness check failed. Nothing ran.');
        }
        if (!verdict.ok) {
          const refusal = await refuse(companyId, base, 'stale_data', 'Input depends on stale or undated context. Nothing ran.');
          return { ...refusal, reasons: verdict.reasons.map((f) => ({ kind: f.item.kind, reason: f.reason })) };
        }
      }

      let approvalUsed: string | null = null;
      if (first.decision === 'require_approval') {
        let approvalId: string;
        if (typeof invocation.approvalId === 'string' && invocation.approvalId !== '') {
          approvalId = invocation.approvalId;
        } else {
          try {
            const requested = await gate.gateAction({
              companyId,
              requestedBy: actor.kind === 'human' ? actor.userId : null,
              agentId: actor.kind === 'agent' ? actor.agentId : null,
              action: toolId,
              params: redact(params),
              context: { paramsSha256, runId, tier, roleId: actor.kind === 'agent' ? actor.roleId : null },
              urgency: 'normal',
              ttlMs: approvalTtlMs,
            });
            approvalId = requested.approval.id;
          } catch {
            return refuse(companyId, base, 'gate_error', 'Approval check failed. Nothing ran.');
          }
        }

        const check = await verifyApproval(companyId, approvalId, toolId, paramsSha256);
        if (check.state === 'refused') return refuse(companyId, base, check.reason, `Approval refused: ${check.reason}.`);
        if (check.state === 'pending') {
          const logged = await auditSafely({
            companyId,
            runId,
            data: { ...auditFields(base), outcome: 'awaiting_approval', reason: first.reason, approvalId },
          });
          if (!logged) return refuse(companyId, base, 'audit_unavailable', 'Decision could not be recorded. Nothing ran.');
          return { outcome: 'awaiting_approval', toolId, tier, approvalId, paramsSha256 };
        }

        const second = evaluatePolicy({ ...policyBase, approvalState: 'approved' });
        if (second.decision !== 'allow') return refuse(companyId, base, 'authority_denied', second.reason);
        approvalUsed = approvalId;
      }

      const allowed = await auditSafely({
        companyId,
        runId,
        data: {
          ...auditFields(base),
          outcome: 'allowed',
          reason: first.reason,
          autonomy: autonomy ?? null,
        },
      });
      if (!allowed) return refuse(companyId, base, 'audit_unavailable', 'Decision could not be recorded. Nothing ran.');

      // A draft is never executed. Policy and approval have already run above, so a draft that needs approval still
      // waits for it. Once allowed, the draft is staged: no handler, no provider call, no idempotency claim.
      if (isDraftTool(toolId)) {
        const staged = await auditSafely({
          companyId,
          runId,
          data: { ...auditFields(base), outcome: 'staged', reason: 'draft_staged' },
        });
        if (!staged) return refuse(companyId, base, 'audit_unavailable', 'Decision could not be recorded. Nothing ran.');
        return { outcome: 'staged', toolId, tier, paramsSha256 };
      }

      // Idempotency is claimed before the approval is consumed, so a repeat of a completed write does not use up
      // a second approval.
      let idempotent: IdemClaim | null = null;
      if (idempotencyStore !== undefined && isWriteLike(definition)) {
        let claim: ClaimResult;
        let key: string;
        let providerKey: string;
        try {
          if (runId === null || typeof invocation.callIndex !== 'number') {
            throw new TypeError('runId and callIndex are required for idempotent tools');
          }
          key = idempotencyKey({ companyId, runId, callIndex: invocation.callIndex, tool: toolId, params });
          // R5: the provider sees a domain-separated key, never the Desk intent key. Desk dedupes on the intent key above.
          providerKey = providerIdempotencyKey({ companyId, runId, callIndex: invocation.callIndex, toolId, params });
          claim = idempotencyStore.claim(key, { now: now().getTime(), ttlMs: idempotencyTtlMs, companyId });
        } catch {
          return refuse(companyId, base, 'idempotency_error', 'Idempotency check failed. Nothing ran.');
        }
        if (claim.claimed !== true) {
          if (claim.previous.completed !== true) {
            return refuse(companyId, base, 'duplicate_in_flight', 'The same call is already in progress. Nothing ran.');
          }
          const prior = claim.previous.outcome as { output?: unknown; truncated?: unknown } | undefined;
          if (!isPlainObject(prior) || !isPlainObject(prior.output) || typeof prior.truncated !== 'boolean') {
            return refuse(companyId, base, 'idempotency_error', 'Idempotency record is unreadable. Nothing ran.');
          }
          await auditSafely({
            companyId,
            runId,
            data: { ...auditFields(base), outcome: 'duplicate_suppressed', reason: 'duplicate_suppressed' },
          });
          return {
            outcome: 'executed',
            toolId,
            tier,
            output: prior.output,
            truncated: prior.truncated,
            reason: 'duplicate_suppressed',
          };
        }
        idempotent = { key, providerKey };
      }

      if (approvalUsed !== null) {
        // Claim before running, so a second call with the same approval cannot run the handler again.
        let claimed: boolean;
        try {
          claimed = await gate.claimApproval(companyId, approvalUsed, actor.kind === 'human' ? actor.userId : null);
        } catch {
          return refuse(companyId, base, 'gate_error', 'Approval claim failed. Nothing ran.');
        }
        if (claimed !== true) return refuse(companyId, base, 'approval_consumed', 'Approval was already used. Nothing ran.');
      }

      // In-flight marker for a write, recorded before the handler can act. If the process dies mid-call, no settle record
      // (tool.execution) follows it. The run engine reads the open marker as an uncertain outcome and does not replay
      // the call (run.ts, hasUnresolvedWrite). If the marker cannot be written, nothing runs.
      if ((definition.access ?? 'write') === 'write') {
        const marked = await auditSafely({
          companyId,
          runId,
          data: { ...auditFields(base), outcome: 'uncertain', reason: 'in_flight' },
        });
        if (!marked) return refuse(companyId, base, 'audit_unavailable', 'Decision could not be recorded. Nothing ran.');
      }

      const outcome = await execute(companyId, base, definition, params, idempotent);

      // Completion is recorded only after a successful run. A failed run leaves the key claimed but not completed,
      // so a repeat is refused as in-flight until the claim expires. If the write fails, the same thing happens.
      if (idempotent !== null && idempotencyStore !== undefined && outcome.outcome === 'executed') {
        try {
          idempotencyStore.complete(idempotent.key, { output: outcome.output, truncated: outcome.truncated }, { companyId });
        } catch {
          // The handler already ran. The unfinished claim keeps repeats refused until it expires.
        }
      }
      return outcome;
    },
  };
}
