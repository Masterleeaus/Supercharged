/**
 * Composition root for the workforce runtime. Builds the tool registry, run engine and approval gate from
 * injected dependencies and fails closed: a missing store, catalogue, approval service, read store or
 * redactor throws at startup, so a half-built runtime is never returned.
 *
 * No model provider exists in this build. The runtime reports model NOT CONFIGURED (see health.ts), and
 * its engine refuses startRun, because a run cannot progress without a model. No database, network or
 * environment access happens here. Every dependency is passed in by the caller.
 *
 * Optional controls, budgets and company policy are passed through to the run engine and tool registry.
 * An absent dependency means that check does not run, as before. A roster, when given, seeds the controls
 * state for this company once, at compose time.
 *
 * Handoff resolves the target role's agents from the roster store. With no roster store, every handoff is
 * refused (roster_missing). A role with no roster agent is refused too (roster_role_unstaffed). Compose does
 * not guess agent ids. Each company's first engine call in a process sweeps runs left in 'running' by a crash,
 * once per process per company, and that call waits for the sweep. The sweep is keyed on the company the call
 * names, not on the company the runtime was composed for.
 *
 * onRunFinished, when given, is told about each run that completes, fails or is cancelled. It runs after the
 * transition and its errors are not returned to the caller. The nightly pass covers any run whose hook failed.
 */
import { AiRuntimeError, type CompanyId } from '../../services/ai-runtime/types.ts';
import { tryCompanyId } from '../../services/ai-runtime/company.ts';
import { createApprovalGate, type ApprovalServiceLike } from '../../modules/approvals/approval-gate-adapter.ts';
import { evaluatePolicy, type CompanyPolicy } from '../../modules/approvals/policy-evaluator.ts';
import type { RoleCatalogue } from '../catalogue/loader.ts';
import { registerReadTools, type ReadStore } from '../tools/read-handlers.ts';
import { createRunEngine, type RunEngine, type RunResult } from './run.ts';
import { createToolRegistry, type ApprovalGate, type Redactor, type ToolRegistry } from './tool-registry.ts';
import type { AuditSink, RunStore } from './store.ts';
import type { BudgetLedger } from './budgets.ts';
import { createControlState, seedControls, type ControlState, type RosterSeed } from './controls.ts';
import { recoverInterruptedRuns } from './recovery.ts';

export type PolicyEvaluator = typeof evaluatePolicy;

/** Operator control state. state() is read at each tool call. replace() is needed only when a roster seeds it. */
export interface ControlSource {
  state(): ControlState;
  replace?(next: ControlState): void;
}

/**
 * Synchronous read of one company's roster agents, used by handoff. The in-memory roster (roster.ts
 * listAgents) fits directly. An async store (pg-roster) must be read into a snapshot first, because the
 * engine checks the roster inside a synchronous call path.
 */
export interface RosterReader {
  listAgents(companyId: string): readonly { agentId: string; roleId: string }[];
}

export interface WorkforceRuntimeDeps {
  /** Run and audit persistence. Required. */
  store: RunStore;
  /** Validated role catalogue from loadRoleCatalogue. Required. */
  catalogue: RoleCatalogue;
  /** ApprovalService (or a test double with the same three methods). Required. */
  approvalService: ApprovalServiceLike;
  /** Data access for the bound read tools. Required. */
  readStore: ReadStore;
  /** Secret redactor for tool output and refusal messages. Required by the tool registry. */
  redact: Redactor;
  /** The company this process serves. Optional at compose time; health reports identity not ready when absent or invalid. */
  companyScope?: unknown;
  /** Defaults to the store's audit log. */
  audit?: AuditSink;
  policyEvaluator?: PolicyEvaluator;
  /** Operator controls (pause, disable, retire, stop). Absent: the engine runs no control checks. */
  controls?: ControlSource;
  /** Per-run tool-call and spend ledger. Absent: budgets are not enforced. */
  budgets?: BudgetLedger;
  /** Company rules for the tool registry (requireApprovalFor, deniedTools). Absent: no company rules. */
  companyPolicy?: CompanyPolicy;
  /** Roster agents of this company. Seeds controls once at compose time. Needs companyScope and, with controls, a replace(). */
  roster?: readonly RosterSeed[];
  /** Roster store for handoff: maps a target role to its roster agent ids. Absent: every handoff is refused. */
  rosterStore?: RosterReader;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /** Called after a run completes, fails or is cancelled. Absent: nothing is called. */
  onRunFinished?: (companyId: string, runId: string) => unknown;
}

export interface ModelRefusal {
  ok: false;
  reason: 'model_not_configured';
  run: null;
}

/** Refused by compose before the engine runs: the roster cannot name the target role's agents. */
export interface RosterRefusal {
  ok: false;
  reason: 'roster_missing' | 'roster_role_unstaffed';
  run: null;
}

/** The run engine as the runtime exposes it. startRun is replaced: no run can start without a model. handoff may refuse on the roster. */
export interface WorkforceEngine extends Omit<RunEngine, 'startRun' | 'handoff'> {
  startRun(companyId: unknown, runId: string): Promise<ModelRefusal>;
  handoff(companyId: unknown, runId: string, input: { actor: unknown; toRole: string }): Promise<RunResult | RosterRefusal>;
}

export interface WorkforceRuntime {
  companyScope: CompanyId | null;
  store: RunStore;
  catalogue: RoleCatalogue;
  registry: ToolRegistry;
  gate: ApprovalGate;
  policyEvaluator: PolicyEvaluator;
  engine: WorkforceEngine;
  /** The controls source passed to the engine, or null when none was given and no roster seeded one. */
  controls: ControlSource | null;
  /** Always null in this build. A model provider would be injected here. */
  model: null;
}

const REQUIRED_STORE_METHODS = ['insertRun', 'updateRun', 'getRun', 'listRuns', 'appendAudit', 'listAudit'] as const;

function requireDep(value: unknown, name: string): void {
  if (value === undefined || value === null) throw new AiRuntimeError('config_invalid', `workforce runtime needs ${name}`);
}

/** Companies whose interrupted runs have already been swept (or are being swept) in this process. */
const sweptCompanies = new Set<string>();
/** The sweep each company's engine awaits before its first call. Removed on failure so a later call retries. */
const companySweeps = new Map<string, Promise<unknown>>();

interface SweepDeps {
  store: RunStore;
  audit: AuditSink;
  now: () => Date;
  newId?: () => string;
}

/** Starts the recovery sweep for one company on its first call in this process. Later calls reuse it. */
function sweepCompanyOnce(companyId: CompanyId, deps: SweepDeps): Promise<unknown> {
  const key = companyId as string;
  if (sweptCompanies.has(key)) return companySweeps.get(key) ?? Promise.resolve();
  sweptCompanies.add(key);
  const sweep = recoverInterruptedRuns(deps, companyId).catch((err: unknown) => {
    sweptCompanies.delete(key);
    companySweeps.delete(key);
    throw err;
  });
  sweep.catch(() => undefined);
  companySweeps.set(key, sweep);
  return sweep;
}

/** The company an engine argument names: a bare company id, or the companyId field of a create input. */
function companyNamedBy(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'companyId' in value) return (value as { companyId: unknown }).companyId;
  return value;
}

/** Test seam: forget which companies were swept. Not used by the runtime. */
export function resetCompanySweepsForTests(): void {
  sweptCompanies.clear();
  companySweeps.clear();
}

export function composeWorkforceRuntime(deps: WorkforceRuntimeDeps): WorkforceRuntime {
  if (!deps || typeof deps !== 'object') throw new AiRuntimeError('config_invalid', 'workforce runtime needs dependencies');
  requireDep(deps.store, 'a run store');
  for (const method of REQUIRED_STORE_METHODS) {
    if (typeof (deps.store as unknown as Record<string, unknown>)[method] !== 'function') {
      throw new AiRuntimeError('config_invalid', `run store is missing ${method}`);
    }
  }
  requireDep(deps.catalogue, 'a role catalogue');
  if (!(deps.catalogue instanceof Map)) throw new AiRuntimeError('config_invalid', 'role catalogue must be a role map');
  requireDep(deps.approvalService, 'an approval service');
  requireDep(deps.readStore, 'a read store');
  requireDep(deps.redact, 'a redactor');

  const scoped = deps.companyScope === undefined ? null : tryCompanyId(deps.companyScope);

  let controls: ControlSource | null = deps.controls ?? null;
  if (deps.roster !== undefined) {
    if (scoped === null) throw new AiRuntimeError('config_invalid', 'roster seeding needs a valid company scope');
    if (controls === null) {
      let snapshot = seedControls(createControlState(), scoped, deps.roster, { now: deps.now });
      controls = { state: () => snapshot, replace: (next) => { snapshot = next; } };
    } else if (typeof controls.replace !== 'function') {
      throw new AiRuntimeError('config_invalid', 'roster seeding needs a replaceable controls source');
    } else {
      controls.replace(seedControls(controls.state(), scoped, deps.roster, { now: deps.now }));
    }
  }

  if (deps.rosterStore !== undefined && deps.rosterStore !== null && typeof deps.rosterStore.listAgents !== 'function') {
    throw new AiRuntimeError('config_invalid', 'roster store needs listAgents');
  }
  const rosterStore = deps.rosterStore ?? null;
  // No roster store means no agent ids: the handoff check sees none and the engine refuses before it runs.
  const rosterAgents = (companyId: CompanyId, roleId: string): readonly string[] =>
    rosterStore === null ? [] : rosterStore.listAgents(companyId).filter((agent) => agent.roleId === roleId).map((agent) => agent.agentId);

  const gate = createApprovalGate(deps.approvalService);
  const audit = deps.audit ?? { record: (event) => deps.store.appendAudit(event) };
  const registry = createToolRegistry({ gate, redact: deps.redact, audit, now: deps.now, companyPolicy: deps.companyPolicy });
  registerReadTools(registry, deps.readStore);

  const engineCore = createRunEngine({
    registry,
    store: deps.store,
    audit,
    now: deps.now,
    sleep: deps.sleep,
    newId: deps.newId,
    controls: controls ?? undefined,
    budgets: deps.budgets,
    rosterAgents,
  });

  // Sweep interrupted runs once per process for each company, on that company's first call. The call waits for
  // the sweep, so no engine work for a company runs before its sweep has finished.
  const sweepDeps: SweepDeps = { store: deps.store, audit, now: deps.now ?? (() => new Date()), newId: deps.newId };
  const ready = async (companyId: unknown): Promise<void> => {
    const company = tryCompanyId(companyId);
    // An invalid company gets no sweep. The engine refuses it.
    if (company !== null) await sweepCompanyOnce(company, sweepDeps);
  };
  const gated =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await ready(companyNamedBy(args[0]));
      return fn(...args);
    };

  const notifyFinished = (companyId: unknown, runId: unknown, result: RunResult): void => {
    if (!result.ok || !deps.onRunFinished || typeof companyId !== 'string' || typeof runId !== 'string') return;
    try {
      const pending = deps.onRunFinished(companyId, runId);
      if (pending instanceof Promise) pending.catch(() => undefined);
    } catch {
      // The hook never changes the run's outcome. The nightly pass covers what it missed.
    }
  };
  const finished =
    (fn: (companyId: unknown, runId: string, reason?: string) => Promise<RunResult>) =>
    async (companyId: unknown, runId: string, reason?: string): Promise<RunResult> => {
      await ready(companyId);
      const result = await fn(companyId, runId, reason);
      notifyFinished(companyId, runId, result);
      return result;
    };

  const engine: WorkforceEngine = {
    createRun: gated(engineCore.createRun),
    getRun: gated(engineCore.getRun),
    recordTokens: gated(engineCore.recordTokens),
    callTool: gated(engineCore.callTool),
    resumeAfterApproval: gated(engineCore.resumeAfterApproval),
    delegate: gated(engineCore.delegate),
    closeDelegation: gated(engineCore.closeDelegation),
    complete: finished(engineCore.complete),
    fail: finished((companyId, runId, reason) => engineCore.fail(companyId, runId, reason as string)),
    cancel: finished(engineCore.cancel),
    async handoff(companyId, runId, input) {
      await ready(companyId);
      if (rosterStore === null) return { ok: false, reason: 'roster_missing', run: null };
      const company = tryCompanyId(companyId);
      if (company !== null && rosterAgents(company, input.toRole).length === 0) {
        return { ok: false, reason: 'roster_role_unstaffed', run: null };
      }
      return engineCore.handoff(companyId, runId, input);
    },
    async startRun(): Promise<ModelRefusal> {
      return { ok: false, reason: 'model_not_configured', run: null };
    },
  };

  return {
    companyScope: scoped,
    store: deps.store,
    catalogue: deps.catalogue,
    registry,
    gate,
    policyEvaluator: deps.policyEvaluator ?? evaluatePolicy,
    engine,
    controls,
    model: null,
  };
}

// Process-wide handle for the health route. Nothing is registered until a composition root calls
// setActiveWorkforceRuntime, so the route reports not ready until then.
let activeRuntime: WorkforceRuntime | null = null;

export function setActiveWorkforceRuntime(runtime: WorkforceRuntime | null): void {
  activeRuntime = runtime;
}

export function getActiveWorkforceRuntime(): WorkforceRuntime | null {
  return activeRuntime;
}
