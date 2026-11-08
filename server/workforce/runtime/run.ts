/**
 * Run lifecycle: status machine, token and tool-call budgets, a retry policy for transient failures,
 * team handoffs and delegation, and an audit trail. Every state change and every tool decision is written
 * to the audit sink. The engine takes its tool registry, store and sink by injection, so it never imports
 * the database or makes a model call.
 *
 * Status machine (terminal states cannot change):
 *   queued -> running | cancelled
 *   running -> awaiting_approval | completed | failed | cancelled | budget_exhausted
 *   awaiting_approval -> running | failed | cancelled | budget_exhausted
 *
 * Budget: maxToolCalls counts every attempt, refused calls and retries included, so a loop of refusals
 * still ends. maxTokens is recorded from the model step that reports it. A step that takes the total
 * over the cap is recorded, and the run stops with budget_exhausted at once.
 *
 * Enforcement points. Before each model turn, beginModelTurn checks the run's token cap and the budget
 * ledger's headroom (turnHeadroom). After each model turn, recordTokens reserves the turn's tokens and spend
 * in the ledger. Before each tool call, callTool reserves a call against the ledger (tool-call cap, token cap,
 * run spend, run quota, company spend). A refusal ends the run as budget_exhausted with the refusal reason,
 * which is written to the run record and to the audit trail.
 *
 * Concurrency. Every status write is a compare-and-set on the version the run was read at. If another writer
 * (a cancel, stop, completion or another call) moved the run on, the write is refused with RunVersionConflictError
 * and the newer copy is left as it is. The engine never writes over it. A tool call is not invoked unless the run
 * still has the status and version the call committed at. If a conflict lands after the tool has run, the call's
 * result is returned (ok: true) with the run as the store now holds it, so an executed call is not reported as lost.
 *
 * Retry: only a failure marked transient (or a timeout) is retried, up to retry.maxAttempts. A denial, a
 * refusal or an approval wait is never retried.
 *
 * Reuse: createTeam/planHandoff/planDelegation (./team.ts), tryCompanyId and AiRuntimeError (ai-runtime),
 * and the registry (./tool-registry.ts). The status machine and budget-cap rules are new.
 */
import { tryCompanyId } from '../../services/ai-runtime/company.ts';
import { AiRuntimeError, type CompanyId } from '../../services/ai-runtime/types.ts';
import { RunVersionConflictError, type AuditKind, type AuditSink, type RunStore } from './store.ts';
import { canStartWork, isRunStopped, type ControlState, type StartDecision } from './controls.ts';
import {
  release,
  reserve,
  turnHeadroom,
  type BudgetLedger,
  type BudgetRefusalReason,
  type BudgetRequest,
  type ReserveResult,
} from './budgets.ts';
import {
  closeDelegation as planCloseDelegation,
  planDelegation,
  planHandoff,
  resolveTeamLimits,
  type CloseRefusal,
  type Delegation,
  type DelegationRefusal,
  type HandoffRefusal,
  type Team,
  type TeamLimits,
} from './team.ts';
import { hashToolParams, type ToolInvocationResult, type ToolRegistry } from './tool-registry.ts';

export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled', 'budget_exhausted'];

const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['awaiting_approval', 'completed', 'failed', 'cancelled', 'budget_exhausted'],
  awaiting_approval: ['running', 'failed', 'cancelled', 'budget_exhausted'],
  completed: [],
  failed: [],
  cancelled: [],
  budget_exhausted: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export interface RunBudget {
  maxTokens: number;
  maxToolCalls: number;
  tokensUsed: number;
  toolCalls: number;
}

export interface RetryPolicy {
  /** Total attempts, including the first. 1 means no retry. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({ maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000 });

export interface PendingApproval {
  approvalId: string;
  toolId: string;
  paramsSha256: string;
  /** Kind of the actor who asked. A resume must come from an actor of the same kind. */
  actorKind: 'agent' | 'human';
  /** Agent id or user id of the actor who asked. A resume must come from the same actor. */
  actorKey: string;
}

export interface RunRecord {
  id: string;
  companyId: CompanyId;
  status: RunStatus;
  /** Set by the store. Every update must pass the version it read (compare-and-set). */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Snapshot of the team at start. */
  team: Team;
  /** Handoff path. path[0] is the coordinator, and the last entry is the current owner. */
  path: string[];
  delegations: Delegation[];
  limits: TeamLimits;
  budget: RunBudget;
  retry: RetryPolicy;
  pendingApproval: PendingApproval | null;
  /** Reason for the latest status change. */
  reason: string | null;
  /** Role version the run was started with (prompt-version.ts roleVersion). Undefined when the caller gave no role. */
  roleVersion?: string;
}

export type RunRefusal =
  | 'company_id_required'
  | 'company_id_invalid'
  | 'run_not_found'
  | 'run_terminal'
  | 'run_not_queued'
  | 'run_not_running'
  | 'run_not_awaiting_approval'
  | 'illegal_transition'
  | 'budget_exhausted'
  | 'actor_invalid'
  | 'actor_not_in_team'
  | 'no_pending_approval'
  | 'approval_call_mismatch'
  | 'invalid_team'
  | 'invalid_budget'
  | 'invalid_retry'
  | 'invalid_limits'
  | 'invalid_amount'
  | 'run_stopped'
  | 'tool_not_in_role';

/** Refusals from operator controls (controls.ts), returned for an agent actor before a tool call. */
export type ControlReason = Exclude<StartDecision, { allowed: true }>['reason'];

export type RunReason = RunRefusal | ControlReason | BudgetRefusalReason | HandoffRefusal | DelegationRefusal | CloseRefusal;

export type RunResult =
  | { ok: true; run: RunRecord; detail?: Record<string, unknown> }
  | { ok: false; reason: RunReason; run: RunRecord | null };

export type RunToolResult =
  | { ok: true; run: RunRecord; tool: ToolInvocationResult }
  | { ok: false; reason: RunReason; run: RunRecord | null; tool: null };

export interface CreateRunInput {
  companyId: unknown;
  team: Team;
  budget: { maxTokens: number; maxToolCalls: number };
  retry?: Partial<RetryPolicy>;
  limits?: Partial<TeamLimits>;
  /** roleVersion(role) for the role the run is for. Passed by the caller; createRun does not receive the role object. */
  roleVersion?: string;
}

/** The actor as the caller states it. For agents, autonomy and toolRisk come from the team snapshot, never from here. */
export type RunActorInput = { kind: 'agent'; agentId: string; roleId: string } | { kind: 'human'; userId: string };

export interface RunToolCall {
  toolId: string;
  params?: Record<string, unknown>;
  actor: unknown;
}

/**
 * What the engine needs from a budget backend. The in-memory ledger (budgets.ts) is adapted to this shape, and the
 * Postgres store (pg-budgets.ts) has it directly. Both are awaited, so the engine behaves the same for each.
 */
export interface BudgetPort {
  reserve(req: BudgetRequest): Promise<ReserveResult> | ReserveResult;
  release(req: BudgetRequest): Promise<void> | void;
  turnHeadroom(req: Pick<BudgetRequest, 'companyId' | 'runId' | 'now'>): Promise<ReserveResult> | ReserveResult;
}

function isLedger(backend: BudgetLedger | BudgetPort): backend is BudgetLedger {
  const candidate = backend as Partial<BudgetLedger>;
  return candidate.runs instanceof Map && candidate.companies instanceof Map;
}

function asBudgetPort(backend: BudgetLedger | BudgetPort): BudgetPort {
  if (!isLedger(backend)) return backend;
  return {
    reserve: (req) => reserve(backend, req),
    release: (req) => release(backend, req),
    turnHeadroom: (req) => turnHeadroom(backend, req),
  };
}

export interface RunEngineOptions {
  registry: ToolRegistry;
  store: RunStore;
  /** Defaults to the store's audit log. */
  audit?: AuditSink;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /** Team limits used when a run does not set its own. Defaults to depth 3 and fan-out 4. */
  defaultLimits?: Partial<TeamLimits>;
  /** Operator controls. Read at each tool call, so a pause or stop made after the run started applies. Absent: no control checks. */
  controls?: { state(): ControlState };
  /**
   * Per-run and per-company budget ledger (budgets.ts), or the Postgres store (pg-budgets.ts). Absent: only the run's
   * own caps (maxToolCalls, maxTokens on the run record) are enforced; daily quotas and spend are not.
   */
  budgets?: BudgetLedger | BudgetPort;
  /**
   * Roster agent ids for a role, checked by handoff against operator controls. Default: `${roleId}-1`, the
   * one-agent-per-role convention the handoff tests use, until a roster lookup is passed in.
   */
  rosterAgents?: (companyId: CompanyId, roleId: string) => readonly string[];
  /**
   * Roles that are human review. A handoff to one of them is an escalation and its audit record carries
   * `escalation: true`. Default: ['human-review'].
   */
  humanReviewRoles?: readonly string[];
}

export interface RunEngine {
  createRun(input: CreateRunInput): Promise<RunResult>;
  startRun(companyId: unknown, runId: string): Promise<RunResult>;
  getRun(companyId: unknown, runId: string): Promise<RunRecord | null>;
  /** Records a model turn's tokens and spend (cents). Reserves them in the budget ledger when one is configured. */
  recordTokens(companyId: unknown, runId: string, tokens: number, spendCents?: number): Promise<RunResult>;
  /**
   * Checks the budget before a model turn starts. Refuses (and ends the run as budget_exhausted) when the run has no
   * token headroom or a daily or spend quota is already used up.
   */
  beginModelTurn(companyId: unknown, runId: string): Promise<RunResult>;
  callTool(companyId: unknown, runId: string, call: RunToolCall): Promise<RunToolResult>;
  resumeAfterApproval(companyId: unknown, runId: string, call: RunToolCall): Promise<RunToolResult>;
  handoff(companyId: unknown, runId: string, input: { actor: unknown; toRole: string }): Promise<RunResult>;
  delegate(companyId: unknown, runId: string, input: { actor: unknown; parentId?: string | null; toRole: string }): Promise<RunResult>;
  closeDelegation(companyId: unknown, runId: string, delegationId: string): Promise<RunResult>;
  complete(companyId: unknown, runId: string, reason?: string): Promise<RunResult>;
  fail(companyId: unknown, runId: string, reason: string): Promise<RunResult>;
  cancel(companyId: unknown, runId: string, reason?: string): Promise<RunResult>;
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

function companyOf(raw: unknown): { ok: true; companyId: CompanyId } | { ok: false; reason: RunRefusal } {
  const id = tryCompanyId(raw);
  if (id !== null) return { ok: true, companyId: id };
  const missing = raw === undefined || raw === null || raw === '';
  return { ok: false, reason: missing ? 'company_id_required' : 'company_id_invalid' };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normaliseRetry(input: Partial<RetryPolicy> | undefined): RetryPolicy | null {
  const policy = { ...DEFAULT_RETRY_POLICY, ...(input ?? {}) };
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10) return null;
  if (!Number.isInteger(policy.baseDelayMs) || policy.baseDelayMs < 0) return null;
  if (!Number.isInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) return null;
  return { ...policy };
}

/** Exponential backoff for the next attempt: base * 2^(attempt - 1), capped at maxDelayMs. */
export function backoffDelay(policy: RetryPolicy, attempt: number): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

/**
 * Counts coordinators as createTeam does (it requires exactly one). A Team holds one coordinator id, so a
 * second one can only appear as an extra id in `coordinator` or as a member entry flagged coordinator: true.
 */
function coordinatorCount(team: Record<string, unknown>): number {
  const named = Array.isArray(team.coordinator) ? team.coordinator : [team.coordinator];
  const flagged = Array.isArray(team.members) ? team.members.filter((m) => isPlainObject(m) && m.coordinator === true) : [];
  return named.filter(isNonEmptyString).length + flagged.length;
}

function isValidTeam(team: unknown): team is Team {
  if (!isPlainObject(team)) return false;
  if (!isNonEmptyString(team.id) || !isNonEmptyString(team.coordinator)) return false;
  if (!isPlainObject(team.roles) || !Array.isArray(team.members)) return false;
  if (coordinatorCount(team) !== 1) return false;
  const roles = team.roles;
  return (
    team.members.includes(team.coordinator) &&
    hasOwn(roles, team.coordinator) &&
    team.members.every((m) => typeof m === 'string' && hasOwn(roles, m))
  );
}

type ResolvedActor =
  | {
      kind: 'agent';
      agentId: string;
      roleId: string;
      autonomy: unknown;
      toolRisk: Readonly<Record<string, unknown>> | undefined;
      toolAccess: Readonly<Record<string, string>> | undefined;
    }
  | { kind: 'human'; userId: string };

function actorKeyOf(actor: ResolvedActor): string {
  // An agent is bound to its role as well as its id, so the same agent under another role cannot resume an approval.
  // Both sides of the approval check use this key, so older approvals with a plain agent id are refused (fail closed).
  return actor.kind === 'agent' ? `${actor.agentId}\u0000${actor.roleId}` : actor.userId;
}

function resolveActor(run: RunRecord, raw: unknown): { ok: true; actor: ResolvedActor } | { ok: false; reason: RunRefusal } {
  if (!isPlainObject(raw)) return { ok: false, reason: 'actor_invalid' };
  if (raw.kind === 'agent') {
    if (!isNonEmptyString(raw.agentId) || !isNonEmptyString(raw.roleId)) return { ok: false, reason: 'actor_invalid' };
    if (!hasOwn(run.team.roles, raw.roleId)) return { ok: false, reason: 'actor_not_in_team' };
    const role = run.team.roles[raw.roleId];
    return {
      ok: true,
      actor: {
        kind: 'agent',
        agentId: raw.agentId,
        roleId: raw.roleId,
        autonomy: role.autonomy,
        toolRisk: role.toolRisk,
        toolAccess: role.toolAccess,
      },
    };
  }
  if (raw.kind === 'human' && isNonEmptyString(raw.userId)) return { ok: true, actor: { kind: 'human', userId: raw.userId } };
  return { ok: false, reason: 'actor_invalid' };
}

export function createRunEngine(options: RunEngineOptions): RunEngine {
  if (!options || !options.registry || !options.store) throw new AiRuntimeError('config_invalid', 'run engine needs a registry and a store');
  const { registry, store } = options;
  const defaultLimits = resolveTeamLimits(options.defaultLimits ?? {});
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const newId = options.newId ?? (() => crypto.randomUUID());
  const sink: AuditSink = options.audit ?? { record: (event) => store.appendAudit(event) };
  const controlSource = options.controls;
  const port = options.budgets ? asBudgetPort(options.budgets) : null;
  const rosterAgents = options.rosterAgents ?? ((_companyId: CompanyId, roleId: string) => [`${roleId}-1`]);
  const humanReviewRoles = new Set<string>(options.humanReviewRoles ?? ['human-review']);

  async function audit(kind: AuditKind, companyId: CompanyId, runId: string, data: Record<string, unknown>): Promise<void> {
    await sink.record({ id: newId(), companyId, runId, kind, at: now().toISOString(), data });
  }

  /**
   * Compare-and-set on the version the run was read at. Status changes are conditioned on that version, so a stop,
   * cancel, pause or completion written since the read makes this write fail with RunVersionConflictError. The stale
   * copy is never written over the newer one, and is never retried.
   */
  async function commit(companyId: CompanyId, prev: RunRecord, patch: Partial<RunRecord>): Promise<RunRecord> {
    return store.updateRun(companyId, { ...prev, ...patch, updatedAt: now().toISOString() }, prev.version);
  }

  /** Every status change goes through here, so the table is checked and the change is audited. */
  async function move(
    companyId: CompanyId,
    prev: RunRecord,
    to: RunStatus,
    reason: string | null,
    patch: Partial<RunRecord> = {},
  ): Promise<RunRecord> {
    if (!canTransition(prev.status, to)) throw new AiRuntimeError('input_invalid', `illegal run transition ${prev.status} -> ${to}`);
    const saved = await commit(companyId, prev, { ...patch, status: to, reason });
    await audit('run.status', companyId, saved.id, { from: prev.status, to, reason });
    return saved;
  }

  async function loadLive(
    rawCompany: unknown,
    runId: string,
  ): Promise<{ ok: true; companyId: CompanyId; run: RunRecord } | { ok: false; reason: RunReason; run: RunRecord | null }> {
    const company = companyOf(rawCompany);
    if (!company.ok) return { ok: false, reason: company.reason, run: null };
    const run = await store.getRun(company.companyId, runId);
    if (!run) return { ok: false, reason: 'run_not_found', run: null };
    if (isTerminal(run.status)) return { ok: false, reason: 'run_terminal', run };
    return { ok: true, companyId: company.companyId, run };
  }

  async function exhaust(companyId: CompanyId, run: RunRecord, reason: string): Promise<RunRecord> {
    return move(companyId, run, 'budget_exhausted', reason);
  }

  /** Runs the call, with retries for transient failures only. Counts every attempt against the tool-call budget. */
  async function attempt(
    companyId: CompanyId,
    start: RunRecord,
    call: { toolId: string; params: Record<string, unknown>; actor: ResolvedActor },
    approvalId: string | null,
  ): Promise<RunToolResult> {
    let current = start;
    let tries = 0;

    while (true) {
      tries += 1;

      if (current.budget.toolCalls >= current.budget.maxToolCalls) {
        const exhausted = await exhaust(companyId, current, 'tool_call_cap');
        return { ok: false, reason: 'budget_exhausted', run: exhausted, tool: null };
      }

      current = await commit(companyId, current, {
        budget: { ...current.budget, toolCalls: current.budget.toolCalls + 1 },
      });

      // Operator controls, checked on every attempt. A stop ends the run. A paused, disabled or retired agent is refused.
      if (controlSource && isRunStopped(controlSource.state(), current.id, companyId)) {
        const stopped = await move(companyId, current, 'cancelled', 'run_stopped');
        return { ok: false, reason: 'run_stopped', run: stopped, tool: null };
      }
      if (controlSource && call.actor.kind === 'agent') {
        const decision = canStartWork(controlSource.state(), companyId, call.actor.agentId);
        if (decision.allowed === false) return { ok: false, reason: decision.reason, run: current, tool: null };
      }

      // Budget reservation before the call. A refusal ends the run with the budget's reason.
      let reserved: BudgetRequest | null = null;
      if (port) {
        const request: BudgetRequest = { companyId, runId: current.id, toolCalls: 1, tokens: 0, spendCents: 0, now: now().getTime() };
        const decision = await port.reserve(request);
        if (decision.allowed === false) {
          const ended = await move(companyId, current, 'budget_exhausted', decision.reason);
          return { ok: false, reason: decision.reason, run: ended, tool: null };
        }
        reserved = request;
      }

      // Last check before the call. The run must still be the copy this attempt committed (same version and status:
      // running, or awaiting_approval for a resumed call). A stop, cancel or completion that landed since the commit
      // above refuses the call, and its reservation is given back.
      const live = await store.getRun(companyId, current.id);
      if (!live || live.status !== current.status || live.version !== current.version) {
        if (port && reserved) await port.release(reserved);
        throw new RunVersionConflictError(current.id);
      }

      const tool = await registry.invoke({
        companyId,
        toolId: call.toolId,
        params: call.params,
        actor: call.actor,
        runId: current.id,
        correlationId: current.id,
        approvalId,
      });

      // A call that did not execute (refused, or waiting for approval) gives its reservation back.
      if (port && reserved && (tool.outcome === 'refused' || tool.outcome === 'awaiting_approval')) {
        await port.release(reserved);
      }

      // The tool has run (or is waiting) by this point. If another writer moved the run on now, the call is still
      // reported, with the run as the store holds it, so the caller does not retry an executed call.
      try {
        if (tool.outcome === 'awaiting_approval') {
          if (current.status === 'running') {
            current = await move(companyId, current, 'awaiting_approval', `approval ${tool.approvalId} requested for ${tool.toolId}`, {
              pendingApproval: {
                approvalId: tool.approvalId,
                toolId: tool.toolId,
                paramsSha256: tool.paramsSha256,
                actorKind: call.actor.kind,
                actorKey: actorKeyOf(call.actor),
              },
            });
          }
          return { ok: true, run: current, tool };
        }

        if (current.status === 'awaiting_approval') {
          const resumedFrom = current.pendingApproval;
          current = await move(companyId, current, 'running', 'approval resumed', { pendingApproval: null });
          await audit('run.approval_resumed', companyId, current.id, { approvalId: resumedFrom?.approvalId ?? null, toolId: call.toolId });
        }

        if (tool.outcome === 'refused' && approvalId !== null) {
          const failed = await move(companyId, current, 'failed', `approval ${approvalId}: ${tool.reason}`);
          return { ok: true, run: failed, tool };
        }

        // An approval covers one execution and is claimed before the first run, so a resumed call is not retried.
        const retryable = tool.outcome === 'failed' && tool.transient && approvalId === null;
        if (retryable && tries < current.retry.maxAttempts) {
          const delayMs = backoffDelay(current.retry, tries);
          await audit('run.retry', companyId, current.id, {
            toolId: call.toolId,
            attempt: tries,
            nextAttempt: tries + 1,
            delayMs,
            reason: tool.reason,
          });
          await sleep(delayMs);
          continue;
        }

        // Nothing was written after the call, so a stop that landed while it ran is not a conflict here. Report the
        // run as the store holds it, not the copy this attempt started from.
        const stored = await store.getRun(companyId, current.id);
        return { ok: true, run: stored ?? current, tool };
      } catch (err) {
        if (!(err instanceof RunVersionConflictError)) throw err;
        const fresh = await store.getRun(companyId, current.id);
        return { ok: true, run: fresh ?? current, tool };
      }
    }
  }

  return {
    async createRun(input) {
      const company = companyOf(input?.companyId);
      if (!company.ok) return { ok: false, reason: company.reason, run: null };
      if (!isValidTeam(input.team)) return { ok: false, reason: 'invalid_team', run: null };

      const budget = input.budget;
      if (!budget || !isCount(budget.maxTokens) || !isCount(budget.maxToolCalls)) {
        return { ok: false, reason: 'invalid_budget', run: null };
      }
      const retry = normaliseRetry(input.retry);
      if (retry === null) return { ok: false, reason: 'invalid_retry', run: null };

      let limits: TeamLimits;
      try {
        limits = resolveTeamLimits({ ...defaultLimits, ...(input.limits ?? {}) });
      } catch {
        return { ok: false, reason: 'invalid_limits', run: null };
      }

      const at = now().toISOString();
      const draft: RunRecord = {
        id: newId(),
        companyId: company.companyId,
        status: 'queued',
        version: 0,
        createdAt: at,
        updatedAt: at,
        team: structuredClone(input.team),
        path: [input.team.coordinator],
        delegations: [],
        limits,
        budget: { maxTokens: budget.maxTokens, maxToolCalls: budget.maxToolCalls, tokensUsed: 0, toolCalls: 0 },
        retry,
        pendingApproval: null,
        reason: null,
        ...(isNonEmptyString(input.roleVersion) ? { roleVersion: input.roleVersion } : {}),
      };
      const stored = await store.insertRun(company.companyId, draft);
      await audit('run.created', company.companyId, stored.id, {
        teamId: stored.team.id,
        coordinator: stored.team.coordinator,
        budget: { maxTokens: budget.maxTokens, maxToolCalls: budget.maxToolCalls },
        retry,
        limits,
      });
      return { ok: true, run: stored };
    },

    async startRun(companyId, runId) {
      const loaded = await loadLive(companyId, runId);
      if (!loaded.ok) return loaded;
      if (loaded.run.status !== 'queued') return { ok: false, reason: 'run_not_queued', run: loaded.run };
      const run = await move(loaded.companyId, loaded.run, 'running', 'started');
      return { ok: true, run };
    },

    async getRun(companyId, runId) {
      const company = companyOf(companyId);
      if (!company.ok) return null;
      return store.getRun(company.companyId, runId);
    },

    async recordTokens(companyId, runId, tokens, spendCents = 0) {
      if (!isCount(tokens) || !isCount(spendCents)) return { ok: false, reason: 'invalid_amount', run: null };
      const loaded = await loadLive(companyId, runId);
      if (!loaded.ok) return loaded;
      const { run } = loaded;
      if (run.status !== 'running') return { ok: false, reason: 'run_not_running', run };

      const used = run.budget.tokensUsed + tokens;
      const budget = { ...run.budget, tokensUsed: used };
      if (used > run.budget.maxTokens) {
        const exhausted = await move(loaded.companyId, run, 'budget_exhausted', 'token_cap', { budget });
        return { ok: false, reason: 'budget_exhausted', run: exhausted };
      }
      // The turn has happened, so its usage is reserved in the ledger even though the turn cannot be undone. A refusal
      // ends the run with the ledger's reason (token or spend cap, run quota or company spend).
      if (port) {
        const decision = await port.reserve({ companyId: loaded.companyId, runId, toolCalls: 0, tokens, spendCents, now: now().getTime() });
        if (decision.allowed === false) {
          const ended = await move(loaded.companyId, run, 'budget_exhausted', decision.reason, { budget });
          return { ok: false, reason: decision.reason, run: ended };
        }
      }
      const saved = await commit(loaded.companyId, run, { budget });
      return { ok: true, run: saved };
    },

    async beginModelTurn(companyId, runId) {
      const loaded = await loadLive(companyId, runId);
      if (!loaded.ok) return loaded;
      const { run } = loaded;
      if (run.status !== 'running') return { ok: false, reason: 'run_not_running', run };

      // The run's own token cap: a turn cannot start once the cap is reached.
      if (run.budget.tokensUsed >= run.budget.maxTokens) {
        const exhausted = await exhaust(loaded.companyId, run, 'token_cap');
        return { ok: false, reason: 'budget_exhausted', run: exhausted };
      }
      if (port) {
        const decision = await port.turnHeadroom({ companyId: loaded.companyId, runId, now: now().getTime() });
        if (decision.allowed === false) {
          const ended = await exhaust(loaded.companyId, run, decision.reason);
          return { ok: false, reason: decision.reason, run: ended };
        }
      }
      return { ok: true, run };
    },

    async callTool(companyId, runId, call) {
      const loaded = await loadLive(companyId, runId);
      if (!loaded.ok) return { ok: false, reason: loaded.reason, run: loaded.run, tool: null };
      const { run } = loaded;
      if (run.status !== 'running') return { ok: false, reason: 'run_not_running', run, tool: null };

      const actor = resolveActor(run, call?.actor);
      if (!actor.ok) return { ok: false, reason: actor.reason, run, tool: null };
      if (!isNonEmptyString(call?.toolId)) return { ok: false, reason: 'actor_invalid', run, tool: null };

      // The current owner may call only the tools in its own role's list, from the first call. Before any handoff the
      // owner is the coordinator, so its list applies then too. A missing list refuses every tool (fail closed).
      if (actor.actor.kind === 'agent') {
        const owner = run.path[run.path.length - 1];
        if (actor.actor.roleId === owner) {
          const allowed = run.team.roles[owner].tools;
          if (!allowed || !allowed.includes(call.toolId)) return { ok: false, reason: 'tool_not_in_role', run, tool: null };
        }
      }

      return attempt(loaded.companyId, run, { toolId: call.toolId, params: call.params ?? {}, actor: actor.actor }, null);
    },

    async resumeAfterApproval(companyId, runId, call) {
      const loaded = await loadLive(companyId, runId);
      if (!loaded.ok) return { ok: false, reason: loaded.reason, run: loaded.run, tool: null };
      const { run } = loaded;
      if (run.status !== 'awaiting_approval') return { ok: false, reason: 'run_not_awaiting_approval', run, tool: null };

      const pending = run.pendingApproval;
      if (!pending) return { ok: false, reason: 'no_pending_approval', run, tool: null };

      const actor = resolveActor(run, call?.actor);
      if (!actor.ok) return { ok: false, reason: actor.reason, run, tool: null };

      const params = call.params ?? {};
      let hash: string;
      try {
        hash = hashToolParams(params);
      } catch {
        return { ok: false, reason: 'approval_call_mismatch', run, tool: null };
      }
      if (actor.actor.kind !== pending.actorKind || actorKeyOf(actor.actor) !== pending.actorKey) {
        return { ok: false, reason: 'actor_mismatch', run, tool: null };
      }
      if (call.toolId !== pending.toolId || hash !== pending.paramsSha256) {
        return { ok: false, reason: 'approval_call_mismatch', run, tool: null };
      }

      return attempt(loaded.companyId, run, { toolId: call.toolId, params, actor: actor.actor }, pending.approvalId);
    },

    async handoff(companyId, runId, input) {
      const loaded = await loadLive(companyId, runId);
      if (!loaded.ok) return loaded;
      const { run } = loaded;
      if (run.status !== 'running') return { ok: false, reason: 'run_not_running', run };
      if (!isPlainObject(input?.actor) || input.actor.kind !== 'agent' || !isNonEmptyString(input.actor.roleId)) {
        return { ok: false, reason: 'actor_invalid', run };
      }

      const plan = planHandoff(run.team, run.path, input.actor.roleId, input.toRole, run.limits);
      if (!plan.ok) return { ok: false, reason: plan.reason, run };
      // Kept as a guard: planHandoff now applies run.limits, so this check agrees with it.
      if (run.path.length > run.limits.maxDelegationDepth) return { ok: false, reason: 'depth_exceeded', run };

      // Operator controls on the target role. The handoff is accepted if at least one of its roster agents can start
      // work; otherwise it is refused with the first agent's reason. Without a controls source no check runs,
      // which matches callTool.
      if (controlSource) {
        const state = controlSource.state();
        const agents = rosterAgents(loaded.companyId, input.toRole);
        if (agents.length > 0) {
          let refusal: ControlReason | null = null;
          let open = false;
          for (const agentId of agents) {
            const decision = canStartWork(state, loaded.companyId, agentId);
            if (decision.allowed) {
              open = true;
              break;
            }
            refusal ??= decision.reason;
          }
          if (!open && refusal !== null) return { ok: false, reason: refusal, run };
        }
      }

      const saved = await commit(loaded.companyId, run, { path: plan.path });
      // A handoff to a human-review role is an escalation. The audit record is the escalation event (workforce-metrics.ts).
      const escalation = humanReviewRoles.has(input.toRole);
      await audit('run.handoff', loaded.companyId, run.id, {
        from: input.actor.roleId,
        to: input.toRole,
        path: plan.path,
        ...(escalation ? { escalation: true } : {}),
      });
      return { ok: true, run: saved, detail: { path: plan.path } };
    },

    async delegate(companyId, runId, input) {
      const loaded = await loadLive(companyId, runId);
      if (!loaded.ok) return loaded;
      const { run } = loaded;
      if (run.status !== 'running') return { ok: false, reason: 'run_not_running', run };
      if (!isPlainObject(input?.actor) || input.actor.kind !== 'agent' || !isNonEmptyString(input.actor.roleId)) {
        return { ok: false, reason: 'actor_invalid', run };
      }

      const delegationId = newId();
      const plan = planDelegation(
        run.team,
        run.delegations,
        { id: delegationId, parentId: input.parentId ?? null, fromRole: input.actor.roleId, toRole: input.toRole },
        run.limits,
      );
      if (!plan.ok) return { ok: false, reason: plan.reason, run };

      const saved = await commit(loaded.companyId, run, { delegations: [...run.delegations, plan.delegation] });
      await audit('run.delegation', loaded.companyId, run.id, {
        delegationId,
        parentId: plan.delegation.parentId,
        from: plan.delegation.fromRole,
        to: plan.delegation.toRole,
        depth: plan.delegation.depth,
      });
      return { ok: true, run: saved, detail: { delegationId, depth: plan.delegation.depth } };
    },

    async closeDelegation(companyId, runId, delegationId) {
      const loaded = await loadLive(companyId, runId);
      if (!loaded.ok) return loaded;
      const { run } = loaded;
      const plan = planCloseDelegation(run.delegations, delegationId);
      if (!plan.ok) return { ok: false, reason: plan.reason, run };

      const saved = await commit(loaded.companyId, run, { delegations: plan.delegations });
      await audit('run.delegation_closed', loaded.companyId, run.id, { delegationId });
      return { ok: true, run: saved };
    },

    async complete(companyId, runId, reason = 'completed') {
      return finish(companyId, runId, 'completed', reason);
    },

    async fail(companyId, runId, reason) {
      return finish(companyId, runId, 'failed', reason);
    },

    async cancel(companyId, runId, reason = 'cancelled') {
      return finish(companyId, runId, 'cancelled', reason);
    },
  };

  async function finish(companyId: unknown, runId: string, to: RunStatus, reason: string): Promise<RunResult> {
    const loaded = await loadLive(companyId, runId);
    if (!loaded.ok) return loaded;
    if (!canTransition(loaded.run.status, to)) return { ok: false, reason: 'illegal_transition', run: loaded.run };
    // Reaching 'completed' is audited by move() as a run.status record with to: 'completed'. That record is the
    // run_completed event that workforce-metrics.ts counts.
    const saved = await move(loaded.companyId, loaded.run, to, reason);
    return { ok: true, run: saved };
  }
}
