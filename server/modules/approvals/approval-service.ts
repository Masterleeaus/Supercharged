/*
 * Approval state machine (pending -> approved | rejected | expired), ported from
 * mcp-gateway-work (src/services/approvals.ts).
 *
 * MIT License
 *
 * Copyright (c) 2026 Aureo Bueno
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Desk changes: Drizzle queries run through an injected tenant runner (every
 * query is scoped to company_id), statuses are pending | approved | rejected |
 * expired, a policy gate runs before the human queue, and audit events go to
 * server/services/audit-log.ts. Waiters live on the instance, not module state.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import isSafeRegex from 'safe-regex2';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { logAuditEvent } from '../../services/audit-log';
import { approvalRules, approvals, type ApprovalInsert, type ApprovalRow, type ApprovalRuleRow } from './schema';
import { hashAction } from './approval-signing';
import { evaluatePolicy } from './policy-engine';
import type {
  ApprovalRequest,
  ApprovalUrgency,
  DecidedByValue,
  DecisionType,
  MatcherValue,
  Policy,
  PolicyRule,
  PolicyScope,
} from './types';
import { logger } from '../../utils/logger.ts';

/** Drizzle handle passed to queries. Typed loosely so the module does not import server/db. */
export type ApprovalDb = PgDatabase<any, any, any>;

/**
 * ASSUMED INTERFACE (from the parallel tenant-scoping work): withTenant(pool, companyId, fn).
 * The composition root binds the pool, e.g. { run: (cid, fn) => withTenant(pool, cid, fn) }.
 */
export interface TenantRunner {
  run<T>(companyId: string, fn: (db: ApprovalDb) => Promise<T>): Promise<T>;
}

/**
 * Transaction handle for the executed-marking write, following ApprovalMessageTx in apply-atomic.ts.
 * The caller supplies it when the claim must commit together with other writes. Every call is
 * scoped by companyId. Resolves to null when nothing applied.
 */
export interface ApprovalExecutionTx {
  claimExecuted(companyId: string, id: string, executedAt: Date): Promise<ApprovalRow | null>;
}

/** Conditional claim: approved, not yet executed, in this company. Shared by both paths of markExecuted. */
async function claimExecutedRow(db: ApprovalDb, companyId: string, id: string, executedAt: Date): Promise<ApprovalRow | null> {
  const rows = await db.update(approvals)
    .set({ executedAt, updatedAt: executedAt })
    .where(and(
      eq(approvals.companyId, companyId),
      eq(approvals.id, id),
      eq(approvals.status, 'approved'),
      isNull(approvals.executedAt)
    ))
    .returning();
  return rows[0] ?? null;
}

/**
 * Adapts a Drizzle handle that already runs inside the caller's transaction (tenant already set)
 * into an ApprovalExecutionTx.
 */
export function drizzleApprovalExecutionTx(db: ApprovalDb): ApprovalExecutionTx {
  return {
    claimExecuted(companyId: string, id: string, executedAt: Date): Promise<ApprovalRow | null> {
      if (!companyId) throw new Error('companyId is required for approval queries');
      return claimExecutedRow(db, companyId, id, executedAt);
    },
  };
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked';
export type RedactFn = (params: Record<string, unknown>) => Record<string, unknown>;

/** Result of a state-changing call. Routes map these to 200, 201, 404 or 409. */
export type ApprovalMutation =
  | { kind: 'ok'; approval: ApprovalView }
  | { kind: 'not_found' }
  | { kind: 'refused'; status: ApprovalStatus; executed: boolean; error: string };

/** Minimum window for a resubmitted approval, used if the original window is not positive. */
const MIN_RESUBMIT_TTL_MS = 60_000;

export interface ApprovalServiceOptions {
  tenant: TenantRunner;
  /** Applied to params and context before anything is persisted. Defaults to key-based redaction. */
  redact?: RedactFn;
  now?: () => Date;
}

export interface ApprovalView {
  id: string;
  requestedBy: string | null;
  agentId: string | null;
  action: string;
  urgency: string;
  params: Record<string, unknown>;
  status: ApprovalStatus;
  decision: string | null;
  policyId: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  /** Hash of the exact params the gate was asked about (context.paramsSha256). Null if absent. */
  paramsSha256: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  executedAt: Date | null;
  expiresAt: Date;
}

export interface GateActionInput {
  companyId: string;
  /** Verified caller id. Never copy this from a request body. */
  requestedBy: string | null;
  /** Verified agent id. Never copy this from a request body. */
  agentId: string | null;
  action: string;
  params: Record<string, unknown>;
  context?: Record<string, unknown>;
  urgency?: ApprovalUrgency;
  ttlMs: number;
}

export interface GateActionResult {
  status: ApprovalStatus;
  approval: ApprovalView;
  decision: DecisionType;
  policyId: string | null;
  approvers?: string[];
  channels?: string[];
}

export const POLICY_DECISIONS: readonly DecisionType[] = ['auto_approve', 'auto_deny', 'route_to_human', 'route_to_agent'];
const POLICY_SCOPES: readonly PolicyScope[] = ['global', 'per_agent', 'per_tool'];
const OPERATORS = ['$lt', '$gt', '$lte', '$gte', '$in', '$regex'] as const;

export interface RuleInput {
  name: string;
  priority: number;
  enabled: boolean;
  scope: PolicyScope;
  agentIds: string[];
  toolIds: string[];
  rules: PolicyRule[];
}

export interface RuleView extends RuleInput {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Redaction (default; replace with the real redactor when one exists in Desk)
// ---------------------------------------------------------------------------

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key/i;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 10) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export const defaultRedact: RedactFn = (params) => redactValue(params, 0) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Rule validation (write-time; the engine also fails closed at evaluation time)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStringList(value: unknown, field: string): ParseResult<string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > 200) return { ok: false, error: `${field} must be an array of up to 200 strings` };
  if (!value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 128)) {
    return { ok: false, error: `${field} entries must be non-empty strings up to 128 chars` };
  }
  return { ok: true, value: value as string[] };
}

function parseMatcher(path: string, matcher: unknown): ParseResult<MatcherValue> {
  if (typeof matcher === 'string' || typeof matcher === 'boolean') return { ok: true, value: matcher };
  if (typeof matcher === 'number' && Number.isFinite(matcher)) return { ok: true, value: matcher };
  if (!isPlainObject(matcher)) return { ok: false, error: `match.${path} must be a primitive or an operator object` };

  const keys = Object.keys(matcher);
  if (keys.length !== 1 || !(OPERATORS as readonly string[]).includes(keys[0])) {
    return { ok: false, error: `match.${path} must contain exactly one operator: ${OPERATORS.join(', ')}` };
  }
  const op = keys[0];
  const arg = matcher[op];

  if (op === '$regex') {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > 500) {
      return { ok: false, error: `match.${path}.$regex must be a string up to 500 chars` };
    }
    try {
      new RegExp(arg);
    } catch {
      return { ok: false, error: `match.${path}.$regex is not a valid regular expression` };
    }
    if (!isSafeRegex(arg)) return { ok: false, error: `match.${path}.$regex failed the ReDoS safety check` };
    return { ok: true, value: { $regex: arg } };
  }
  if (op === '$in') {
    if (!Array.isArray(arg) || !arg.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return { ok: false, error: `match.${path}.$in must be an array of strings or numbers` };
    }
    return { ok: true, value: { $in: arg as (string | number)[] } };
  }
  if (typeof arg !== 'number' || !Number.isFinite(arg)) {
    return { ok: false, error: `match.${path}.${op} must be a finite number` };
  }
  return { ok: true, value: { [op]: arg } as MatcherValue };
}

function parseRule(raw: unknown, index: number): ParseResult<PolicyRule> {
  if (!isPlainObject(raw)) return { ok: false, error: `rules[${index}] must be an object` };
  if (!isPlainObject(raw.match) || Object.keys(raw.match).length === 0) {
    return { ok: false, error: `rules[${index}].match must be a non-empty object` };
  }
  if (typeof raw.decision !== 'string' || !(POLICY_DECISIONS as readonly string[]).includes(raw.decision)) {
    return { ok: false, error: `rules[${index}].decision must be one of ${POLICY_DECISIONS.join(', ')}` };
  }
  const match: Record<string, MatcherValue> = {};
  for (const [path, matcher] of Object.entries(raw.match)) {
    if (path.length === 0 || path.length > 128) return { ok: false, error: `rules[${index}] has an invalid match path` };
    const parsed = parseMatcher(path, matcher);
    if (parsed.ok === false) return { ok: false, error: parsed.error };
    match[path] = parsed.value;
  }
  const approvers = parseStringList(raw.approvers, `rules[${index}].approvers`);
  if (approvers.ok === false) return { ok: false, error: approvers.error };
  const channels = parseStringList(raw.channels, `rules[${index}].channels`);
  if (channels.ok === false) return { ok: false, error: channels.error };
  if (raw.requireReason !== undefined && typeof raw.requireReason !== 'boolean') {
    return { ok: false, error: `rules[${index}].requireReason must be a boolean` };
  }
  return {
    ok: true,
    value: {
      match,
      decision: raw.decision as DecisionType,
      ...(approvers.value.length ? { approvers: approvers.value } : {}),
      ...(channels.value.length ? { channels: channels.value } : {}),
      ...(raw.requireReason !== undefined ? { requireReason: raw.requireReason as boolean } : {}),
    },
  };
}

/** Validates a rule payload. Company id is never read from the payload. */
export function parseRuleInput(raw: unknown): ParseResult<RuleInput> {
  if (!isPlainObject(raw)) return { ok: false, error: 'Body must be an object' };

  if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 120) {
    return { ok: false, error: 'name must be a non-empty string up to 120 chars' };
  }
  const priority = raw.priority ?? 100;
  if (typeof priority !== 'number' || !Number.isInteger(priority) || Math.abs(priority) > 10000) {
    return { ok: false, error: 'priority must be an integer between -10000 and 10000' };
  }
  const enabled = raw.enabled ?? true;
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' };
  const scope = raw.scope ?? 'global';
  if (typeof scope !== 'string' || !(POLICY_SCOPES as readonly string[]).includes(scope)) {
    return { ok: false, error: `scope must be one of ${POLICY_SCOPES.join(', ')}` };
  }
  const agentIds = parseStringList(raw.agentIds, 'agentIds');
  if (agentIds.ok === false) return { ok: false, error: agentIds.error };
  const toolIds = parseStringList(raw.toolIds, 'toolIds');
  if (toolIds.ok === false) return { ok: false, error: toolIds.error };
  if (scope === 'per_agent' && agentIds.value.length === 0) return { ok: false, error: 'per_agent scope needs agentIds' };
  if (scope === 'per_tool' && toolIds.value.length === 0) return { ok: false, error: 'per_tool scope needs toolIds' };

  if (!Array.isArray(raw.rules) || raw.rules.length === 0 || raw.rules.length > 100) {
    return { ok: false, error: 'rules must be an array of 1 to 100 rules' };
  }
  const rules: PolicyRule[] = [];
  for (let i = 0; i < raw.rules.length; i++) {
    const parsed = parseRule(raw.rules[i], i);
    if (parsed.ok === false) return { ok: false, error: parsed.error };
    rules.push(parsed.value);
  }

  return {
    ok: true,
    value: {
      name: raw.name.trim(),
      priority,
      enabled,
      scope: scope as PolicyScope,
      agentIds: agentIds.value,
      toolIds: toolIds.value,
      rules,
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface Waiter {
  resolvers: Array<(status: ApprovalStatus) => void>;
  timer: ReturnType<typeof setTimeout>;
}

const waiterKey = (companyId: string, id: string): string => `${companyId}:${id}`;

const statusForDecision = (decision: DecisionType): ApprovalStatus | null => {
  if (decision === 'auto_approve') return 'approved';
  if (decision === 'auto_deny') return 'rejected';
  return null; // route_to_human and route_to_agent wait in the human queue
};

/**
 * Why a row cannot be revoked, or null if it can. Pending rows must still be inside
 * their deadline. Approved rows must not have run. Anything else is terminal.
 */
export function revokeRefusal(
  row: { status: string; expiresAt: Date; executedAt: Date | null },
  now: Date
): string | null {
  if (row.executedAt !== null) return 'Approval has already been executed and cannot be revoked';
  if (row.status === 'approved') return null;
  if (row.status === 'pending' && row.expiresAt.getTime() > now.getTime()) return null;
  return 'Only pending or approved (not yet executed) approvals can be revoked';
}

/** Why a row cannot be edited and resubmitted, or null. Only rejected and expired rows qualify. */
export function resubmitRefusal(status: string): string | null {
  if (status === 'rejected' || status === 'expired') return null;
  return 'Only rejected or expired approvals can be edited and resubmitted';
}

/**
 * Builds the insert values for a resubmitted approval. Action, company and actor are
 * copied from the old row, never from the caller, so they cannot change. Only the
 * params (and the params hash the gate checks) are new. The link to the old row
 * lives in context.resubmittedFrom, because the old row is left untouched.
 */
export function buildResubmission(
  old: Pick<ApprovalRow, 'id' | 'companyId' | 'requestedBy' | 'agentId' | 'action' | 'urgency' | 'context' | 'expiresAt' | 'createdAt'>,
  params: Record<string, unknown>,
  resubmittedBy: string,
  redact: RedactFn,
  now: Date
): ApprovalInsert {
  const windowMs = Math.max(old.expiresAt.getTime() - old.createdAt.getTime(), MIN_RESUBMIT_TTL_MS);
  const paramsSha256 = hashAction(old.action, params);
  return {
    companyId: old.companyId,
    requestedBy: old.requestedBy,
    agentId: old.agentId,
    action: old.action,
    urgency: old.urgency,
    params: redact(params),
    context: redact({
      ...(old.context ?? {}),
      paramsSha256,
      resubmittedFrom: old.id,
      resubmittedBy,
    }),
    status: 'pending',
    decision: 'route_to_human',
    policyId: null,
    decidedBy: null,
    decisionReason: null,
    expiresAt: new Date(now.getTime() + windowMs),
    decidedAt: null,
    executedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

const toPolicy = (row: ApprovalRuleRow): Policy => ({
  id: row.id,
  name: row.name,
  rules: row.rules as PolicyRule[],
  priority: row.priority,
  enabled: row.enabled,
  scope: row.scope as PolicyScope,
  agentIds: row.agentIds,
  toolIds: row.toolIds,
});

const toRuleView = (row: ApprovalRuleRow): RuleView => ({
  id: row.id,
  name: row.name,
  priority: row.priority,
  enabled: row.enabled,
  scope: row.scope as PolicyScope,
  agentIds: row.agentIds,
  toolIds: row.toolIds,
  rules: row.rules as PolicyRule[],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class ApprovalService {
  private readonly tenant: TenantRunner;
  private readonly redact: RedactFn;
  private readonly now: () => Date;
  private readonly waiters = new Map<string, Waiter>();

  constructor(options: ApprovalServiceOptions) {
    this.tenant = options.tenant;
    this.redact = options.redact ?? defaultRedact;
    this.now = options.now ?? (() => new Date());
  }

  private scoped<T>(companyId: string, fn: (db: ApprovalDb) => Promise<T>): Promise<T> {
    if (!companyId) throw new Error('companyId is required for approval queries');
    return this.tenant.run(companyId, fn);
  }

  private toView(row: ApprovalRow): ApprovalView {
    return {
      id: row.id,
      requestedBy: row.requestedBy,
      agentId: row.agentId,
      action: row.action,
      urgency: row.urgency,
      params: row.params,
      // A row can stay "pending" past its deadline if the process restarted or the expiry
      // write failed. It can no longer be decided, so report it as expired.
      status: row.status === 'pending' && row.expiresAt.getTime() <= this.now().getTime()
        ? 'expired'
        : (row.status as ApprovalStatus),
      decision: row.decision,
      policyId: row.policyId,
      decidedBy: row.decidedBy,
      decisionReason: row.decisionReason,
      paramsSha256: typeof row.context?.paramsSha256 === 'string' ? row.context.paramsSha256 : null,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      executedAt: row.executedAt,
      expiresAt: row.expiresAt,
    };
  }

  // -- policy rules ---------------------------------------------------------

  async listRules(companyId: string): Promise<RuleView[]> {
    const rows = await this.scoped(companyId, (db) =>
      db.select().from(approvalRules)
        .where(eq(approvalRules.companyId, companyId))
        .orderBy(approvalRules.priority, approvalRules.id)
    );
    return rows.map(toRuleView);
  }

  /** Throws with code 23505 on a duplicate name (the route maps it to 409). */
  async createRule(companyId: string, input: RuleInput): Promise<RuleView> {
    const rows = await this.scoped(companyId, (db) =>
      db.insert(approvalRules).values({ companyId, ...input }).returning()
    );
    const row = rows[0];
    if (!row) throw new Error('Failed to persist approval rule');
    return toRuleView(row);
  }

  async updateRule(companyId: string, id: string, input: RuleInput): Promise<RuleView | null> {
    const rows = await this.scoped(companyId, (db) =>
      db.update(approvalRules)
        .set({ ...input, updatedAt: this.now() })
        .where(and(eq(approvalRules.companyId, companyId), eq(approvalRules.id, id)))
        .returning()
    );
    return rows[0] ? toRuleView(rows[0]) : null;
  }

  async deleteRule(companyId: string, id: string): Promise<boolean> {
    const rows = await this.scoped(companyId, (db) =>
      db.delete(approvalRules)
        .where(and(eq(approvalRules.companyId, companyId), eq(approvalRules.id, id)))
        .returning({ id: approvalRules.id })
    );
    return rows.length > 0;
  }

  // -- gate -----------------------------------------------------------------

  /**
   * Entry point for agent actions. Evaluates the company's policies first:
   * auto_approve and auto_deny decide immediately; anything else (including no
   * matching rule) lands in the human queue as pending.
   */
  async gateAction(input: GateActionInput): Promise<GateActionResult> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + input.ttlMs);
    const urgency = input.urgency ?? 'normal';

    const policies = await this.scoped(input.companyId, async (db) => {
      const rows = await db.select().from(approvalRules)
        .where(and(eq(approvalRules.companyId, input.companyId), eq(approvalRules.enabled, true)));
      return rows.map(toPolicy);
    });

    // The engine sees raw params in memory. Only the redacted copy is persisted.
    const request: ApprovalRequest = {
      id: '',
      action: input.action,
      params: input.params,
      context: input.context ?? {},
      status: 'pending',
      urgency,
      createdAt: now,
      updatedAt: now,
    };
    const decision = evaluatePolicy(request, policies, { agentId: input.agentId, tool: input.action });
    const policyId = decision.matchedRule
      ? policies.find((p) => p.rules.includes(decision.matchedRule as PolicyRule))?.id ?? null
      : null;
    const autoStatus = statusForDecision(decision.decision);
    const decidedBy = autoStatus && policyId ? (`policy:${policyId}` as DecidedByValue) : null;

    const row = await this.scoped(input.companyId, async (db) => {
      const rows = await db.insert(approvals).values({
        companyId: input.companyId,
        requestedBy: input.requestedBy,
        agentId: input.agentId,
        action: input.action,
        urgency,
        params: this.redact(input.params),
        context: this.redact(input.context ?? {}),
        status: autoStatus ?? 'pending',
        decision: decision.decision,
        policyId,
        decidedBy,
        decisionReason: autoStatus ? `Decided by policy (${decision.decision})` : null,
        expiresAt,
        decidedAt: autoStatus ? now : null,
      }).returning();
      const inserted = rows[0];
      if (!inserted) throw new Error('Failed to persist approval request');
      return inserted;
    });

    await logAuditEvent({
      action: 'approval.requested',
      userId: input.requestedBy ?? undefined,
      resourceType: 'approval',
      resourceId: row.id,
      metadata: { companyId: input.companyId, action: input.action, agentId: input.agentId, decision: decision.decision, policyId },
    });
    if (autoStatus === 'approved' || autoStatus === 'rejected') {
      await logAuditEvent({
        action: autoStatus === 'approved' ? 'approval.approved' : 'approval.rejected',
        resourceType: 'approval',
        resourceId: row.id,
        metadata: { companyId: input.companyId, action: input.action, automatic: true, policyId },
      });
    }

    return {
      status: row.status as ApprovalStatus,
      approval: this.toView(row),
      decision: decision.decision,
      policyId,
      approvers: decision.approvers,
      channels: decision.channels,
    };
  }

  // -- state machine --------------------------------------------------------

  async getApproval(companyId: string, id: string): Promise<ApprovalView | null> {
    const rows = await this.scoped(companyId, (db) =>
      db.select().from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.id, id)))
        .limit(1)
    );
    return rows[0] ? this.toView(rows[0]) : null;
  }

  async listApprovals(
    companyId: string,
    options: { status?: ApprovalStatus; limit?: number } = {}
  ): Promise<ApprovalView[]> {
    const now = this.now();
    const conditions = [eq(approvals.companyId, companyId)];
    if (options.status === 'pending') {
      conditions.push(eq(approvals.status, 'pending'), gt(approvals.expiresAt, now));
    } else if (options.status === 'expired') {
      const stalePending = and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, now));
      const expiredRow = eq(approvals.status, 'expired');
      const combined = or(expiredRow, stalePending);
      if (combined) conditions.push(combined);
    } else if (options.status) {
      conditions.push(eq(approvals.status, options.status));
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    const rows = await this.scoped(companyId, (db) =>
      db.select().from(approvals).where(and(...conditions)).orderBy(desc(approvals.createdAt)).limit(limit)
    );
    return rows.map((row) => this.toView(row));
  }

  /**
   * Resolves when the approval is decided or its deadline passes. Callers should
   * check getApproval first if the decision may already exist.
   */
  waitForDecision(companyId: string, id: string, ttlMs: number): Promise<ApprovalStatus> {
    const key = waiterKey(companyId, id);
    return new Promise<ApprovalStatus>((resolve) => {
      const existing = this.waiters.get(key);
      if (existing) {
        existing.resolvers.push(resolve);
        return;
      }
      const timer = setTimeout(() => {
        this.expireApproval(companyId, id)
          .then((status) => this.notify(key, status))
          .catch((error: unknown) => {
            // Never leave the caller hanging. decideApproval refuses rows past their deadline.
            logger.error('[Approvals] Failed to persist approval expiry', { approvalId: id, error });
            this.notify(key, 'expired');
          });
      }, ttlMs);
      this.waiters.set(key, { resolvers: [resolve], timer });
    });
  }

  /** Returns null if the row is missing, already decided, or past its deadline. */
  async decideApproval(
    companyId: string,
    id: string,
    decision: 'approved' | 'rejected',
    decidedBy: DecidedByValue,
    reason?: string
  ): Promise<ApprovalView | null> {
    const now = this.now();
    const row = await this.scoped(companyId, async (db) => {
      const rows = await db.update(approvals)
        .set({ status: decision, decidedBy, decidedAt: now, decisionReason: reason ?? null, updatedAt: now })
        .where(and(
          eq(approvals.companyId, companyId),
          eq(approvals.id, id),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, now)
        ))
        .returning();
      return rows[0] ?? null;
    });
    if (!row) return null;

    this.notify(waiterKey(companyId, id), decision);
    await logAuditEvent({
      action: decision === 'approved' ? 'approval.approved' : 'approval.rejected',
      userId: decidedBy.startsWith('dashboard:') ? decidedBy.slice('dashboard:'.length) : undefined,
      resourceType: 'approval',
      resourceId: id,
      metadata: { companyId, action: row.action, decidedBy },
    });
    return this.toView(row);
  }

  /**
   * Resolves the waiters on an approval now, for a decision committed through a path other than
   * decideApproval (for example the transactional apply path). Waiters are keyed by company and id,
   * so this cannot wake another tenant's waiter. A no-op when nobody is waiting.
   */
  notifyDecision(companyId: string, id: string, status: ApprovalStatus): void {
    this.notify(waiterKey(companyId, id), status);
  }

  private async readRow(companyId: string, id: string): Promise<ApprovalRow | null> {
    const rows = await this.scoped(companyId, (db) =>
      db.select().from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.id, id)))
        .limit(1)
    );
    return rows[0] ?? null;
  }

  /**
   * Revokes a pending (inside its deadline) or approved, not-yet-executed approval.
   * The state becomes 'revoked'. The conditional UPDATE repeats the checks, so a
   * concurrent approve or execute cannot slip through. The revoker goes in decidedBy
   * and decidedAt; the original approver stays in the audit log.
   */
  async revokeApproval(
    companyId: string,
    id: string,
    revokedBy: DecidedByValue,
    reason?: string
  ): Promise<ApprovalMutation> {
    const now = this.now();
    const current = await this.readRow(companyId, id);
    if (!current) return { kind: 'not_found' };
    const refusal = revokeRefusal(current, now);
    if (refusal) {
      return { kind: 'refused', status: this.toView(current).status, executed: current.executedAt !== null, error: refusal };
    }

    const row = await this.scoped(companyId, async (db) => {
      const rows = await db.update(approvals)
        .set({ status: 'revoked', decidedBy: revokedBy, decidedAt: now, decisionReason: reason ?? null, updatedAt: now })
        .where(and(
          eq(approvals.companyId, companyId),
          eq(approvals.id, id),
          isNull(approvals.executedAt),
          or(
            eq(approvals.status, 'approved'),
            and(eq(approvals.status, 'pending'), gt(approvals.expiresAt, now))
          )
        ))
        .returning();
      return rows[0] ?? null;
    });

    if (!row) {
      // Lost a race with a decision, execution or expiry. Report what happened.
      const latest = await this.readRow(companyId, id);
      if (!latest) return { kind: 'not_found' };
      return {
        kind: 'refused',
        status: this.toView(latest).status,
        executed: latest.executedAt !== null,
        error: revokeRefusal(latest, this.now()) ?? 'Approval changed state; reload and retry',
      };
    }

    this.notify(waiterKey(companyId, id), 'revoked');
    await logAuditEvent({
      action: 'approval.revoked',
      userId: revokedBy.startsWith('dashboard:') ? revokedBy.slice('dashboard:'.length) : undefined,
      resourceType: 'approval',
      resourceId: id,
      metadata: { companyId, action: row.action, previousStatus: current.status, revokedBy },
    });
    return { kind: 'ok', approval: this.toView(row) };
  }

  /**
   * Edits the params of a rejected or expired approval and creates a new pending
   * approval linked to it. At most one resubmission per source approval:
   *   1. Conditional UPDATE claims the source. It matches only while the source is
   *      rejected or expired and context.resubmittedTo is not set. It writes the new
   *      row's id into context.resubmittedTo.
   *   2. The new row is inserted only if the claim matched exactly one row.
   * Both steps run in one tenant transaction, so a failed insert rolls the claim back.
   * The partial unique index in migrations/DRAFT_approvals_resubmit_guard.sql is the
   * database backstop on the link (context.resubmittedFrom). Stale pending rows are
   * expired first, so the caller sees a terminal state.
   */
  async resubmitApproval(
    companyId: string,
    id: string,
    params: Record<string, unknown>,
    resubmittedBy: string
  ): Promise<ApprovalMutation> {
    if (!isPlainObject(params)) throw new TypeError('params must be an object');
    const now = this.now();
    let current = await this.readRow(companyId, id);
    if (!current) return { kind: 'not_found' };
    if (current.status === 'pending' && current.expiresAt.getTime() <= now.getTime()) {
      await this.expireApproval(companyId, id);
      current = await this.readRow(companyId, id);
      if (!current) return { kind: 'not_found' };
    }
    const view = this.toView(current);
    const refusal = resubmitRefusal(view.status);
    if (refusal) {
      return { kind: 'refused', status: view.status, executed: current.executedAt !== null, error: refusal };
    }

    const newId = randomUUID();
    const values = { ...buildResubmission(current, params, resubmittedBy, this.redact, now), id: newId };
    const row = await this.scoped(companyId, async (db) => {
      const claimed = await db.update(approvals)
        .set({
          context: sql`${approvals.context} || jsonb_build_object('resubmittedTo', ${newId}::text)`,
          updatedAt: now,
        })
        .where(and(
          eq(approvals.companyId, companyId),
          eq(approvals.id, id),
          inArray(approvals.status, ['rejected', 'expired']),
          isNull(sql`${approvals.context} ->> 'resubmittedTo'`)
        ))
        .returning({ id: approvals.id });
      if (claimed.length !== 1) return null;

      const rows = await db.insert(approvals).values(values).returning();
      const inserted = rows[0];
      if (!inserted) throw new Error('Failed to persist resubmitted approval');
      return inserted;
    });

    if (!row) {
      // Lost the claim to another resubmit, or the source changed state. Report what happened.
      const latest = await this.readRow(companyId, id);
      if (!latest) return { kind: 'not_found' };
      const latestView = this.toView(latest);
      const alreadyResubmitted = typeof latest.context?.resubmittedTo === 'string';
      return {
        kind: 'refused',
        status: latestView.status,
        executed: latest.executedAt !== null,
        error: alreadyResubmitted
          ? 'This approval has already been resubmitted'
          : resubmitRefusal(latestView.status) ?? 'Approval changed state; reload and retry',
      };
    }

    await logAuditEvent({
      action: 'approval.requested',
      userId: resubmittedBy,
      resourceType: 'approval',
      resourceId: row.id,
      metadata: { companyId, action: row.action, agentId: row.agentId, resubmittedFrom: id, decision: 'route_to_human' },
    });
    return { kind: 'ok', approval: this.toView(row) };
  }

  /**
   * Records that the gated action ran. Only valid for approved rows, once.
   * With no tx, the claim runs in its own tenant transaction and the audit event is written here.
   * With a tx, the claim runs on the caller's transaction and no audit event is written, because
   * it could record an execution that the caller's commit later rolls back. The caller must call
   * recordExecuted with the returned view after its transaction commits.
   */
  async markExecuted(
    companyId: string,
    id: string,
    actorId: string | null,
    tx?: ApprovalExecutionTx
  ): Promise<ApprovalView | null> {
    const now = this.now();
    let row: ApprovalRow | null;
    if (tx) {
      if (!companyId) throw new Error('companyId is required for approval queries');
      row = await tx.claimExecuted(companyId, id, now);
    } else {
      row = await this.scoped(companyId, (db) => claimExecutedRow(db, companyId, id, now));
    }
    if (!row) return null;

    const view = this.toView(row);
    if (tx) return view;

    await this.recordExecuted(companyId, view, actorId);
    return view;
  }

  /** Writes the approval.executed audit event for a row that markExecuted claimed. */
  async recordExecuted(companyId: string, approval: ApprovalView, actorId: string | null): Promise<void> {
    await logAuditEvent({
      action: 'approval.executed',
      userId: actorId ?? undefined,
      resourceType: 'approval',
      resourceId: approval.id,
      metadata: { companyId, action: approval.action },
    });
  }

  /** Marks a pending row expired. If a decision landed first, the stored decision wins. */
  private async expireApproval(companyId: string, id: string): Promise<ApprovalStatus> {
    const now = this.now();
    const outcome = await this.scoped(companyId, async (db) => {
      const expired = await db.update(approvals)
        .set({ status: 'expired', decidedAt: now, updatedAt: now })
        .where(and(eq(approvals.companyId, companyId), eq(approvals.id, id), eq(approvals.status, 'pending')))
        .returning({ id: approvals.id });
      if (expired.length > 0) return { status: 'expired' as ApprovalStatus, changed: true };

      const rows = await db.select({ status: approvals.status }).from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.id, id)))
        .limit(1);
      const current = rows[0]?.status;
      const status: ApprovalStatus = current === 'approved' || current === 'rejected' || current === 'revoked' ? current : 'expired';
      return { status, changed: false };
    });

    if (outcome.changed) {
      await logAuditEvent({
        action: 'approval.expired',
        resourceType: 'approval',
        resourceId: id,
        metadata: { companyId },
      });
    }
    return outcome.status;
  }

  private notify(key: string, status: ApprovalStatus): void {
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    clearTimeout(waiter.timer);
    for (const resolve of waiter.resolvers) resolve(status);
  }
}
