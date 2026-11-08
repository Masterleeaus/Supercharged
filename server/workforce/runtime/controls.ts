/**
 * Operator controls for agents and runs: pause, resume, disable and retire an agent, and stop a run.
 * In-memory and copy-on-write: every transition returns a new state object and leaves the old one
 * untouched. No database, network or clock access except the injectable `now`.
 *
 * Agent status machine:
 *   active -> paused | disabled | retired
 *   paused -> active | disabled | retired
 *   disabled -> active | retired
 *   retired is terminal and refuses every change.
 *
 * Only a human actor may pause, resume, disable or retire. stopRun accepts a human or an agent actor.
 * Namespacing: agent and run state is keyed by company first (companyId, then agentId or runId). Each
 * company has its own namespace, so one company's changes never read or write another company's entries,
 * and a company cannot block another company's agent id or run id.
 *
 * Seeding: seedControls sets each agent's starting status from the roster (active, paused or retired) for
 * one company. It only tightens: a roster status never loosens an operator's pause, disable or retire.
 *
 * Integration: compose.ts passes the control state to the run engine. The engine calls canStartWork for an
 * agent actor before registry.invoke in callTool, and isRunStopped before a run takes another step.
 */

export const AGENT_STATUSES = ['active', 'paused', 'disabled', 'retired'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export type ControlActor = { kind: 'human'; userId: string } | { kind: 'agent'; agentId: string };

export interface ControlStamp {
  /** Who made the change: 'human:<userId>' or 'agent:<agentId>'. */
  by: string;
  at: string;
}

export interface AgentControlEntry {
  agentId: string;
  companyId: string;
  status: AgentStatus;
  changed: ControlStamp;
}

export interface RunStopEntry {
  runId: string;
  companyId: string;
  stopped: true;
  changed: ControlStamp;
}

/** State keyed by company first: companyId -> agentId -> entry, and companyId -> runId -> entry. */
export interface ControlState {
  readonly agents: ReadonlyMap<string, ReadonlyMap<string, AgentControlEntry>>;
  readonly runs: ReadonlyMap<string, ReadonlyMap<string, RunStopEntry>>;
}

/** One roster agent's status, as seedControls reads it. A roster agent record satisfies this shape. */
export interface RosterSeed {
  readonly agentId: string;
  /** When present and different from the seeded company, the entry is skipped. */
  readonly companyId?: string;
  readonly status: 'active' | 'paused' | 'retired';
}

export type ControlRefusal =
  | 'company_id_required'
  | 'agent_id_required'
  | 'run_id_required'
  | 'actor_invalid'
  | 'human_only'
  | 'company_mismatch'
  | 'agent_retired'
  | 'invalid_transition';

export type ControlResult = { ok: true; state: ControlState; entry: AgentControlEntry } | { ok: false; reason: ControlRefusal; state: ControlState };

export type StopResult = { ok: true; state: ControlState; entry: RunStopEntry } | { ok: false; reason: ControlRefusal; state: ControlState };

export type StartDecision =
  | { allowed: true }
  | { allowed: false; reason: 'agent_paused' | 'agent_disabled' | 'agent_retired' | 'company_mismatch' | 'company_id_required' | 'agent_id_required' };

export interface ControlOptions {
  /** Clock for change stamps. Defaults to the real clock. */
  now?: () => Date;
}

const TRANSITIONS: Readonly<Record<'pause' | 'resume' | 'disable' | 'retire', { from: readonly AgentStatus[]; to: AgentStatus }>> = {
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused', 'disabled'], to: 'active' },
  disable: { from: ['active', 'paused'], to: 'disabled' },
  retire: { from: ['active', 'paused', 'disabled'], to: 'retired' },
};

const START_REASON: Readonly<Record<'paused' | 'disabled' | 'retired', 'agent_paused' | 'agent_disabled' | 'agent_retired'>> = {
  paused: 'agent_paused',
  disabled: 'agent_disabled',
  retired: 'agent_retired',
};

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function emptyState(): ControlState {
  return { agents: new Map(), runs: new Map() };
}

/** A fresh, empty control state. */
export function createControlState(): ControlState {
  return emptyState();
}

function stampOf(actor: ControlActor, options: ControlOptions | undefined): ControlStamp {
  const at = (options?.now ?? (() => new Date()))().toISOString();
  return { by: actor.kind === 'human' ? `human:${actor.userId}` : `agent:${actor.agentId}`, at };
}

function actorValid(actor: unknown): actor is ControlActor {
  if (!actor || typeof actor !== 'object') return false;
  const a = actor as { kind?: unknown; userId?: unknown; agentId?: unknown };
  if (a.kind === 'human') return nonEmpty(a.userId);
  if (a.kind === 'agent') return nonEmpty(a.agentId);
  return false;
}

/** The agent entry for one company. Other companies' entries are never consulted. */
function agentEntry(state: ControlState, companyId: string, agentId: string): AgentControlEntry | undefined {
  return state.agents.get(companyId)?.get(agentId);
}

/** Copy-on-write: copies the outer map and the one company's inner map. */
function withAgent(state: ControlState, entry: AgentControlEntry): ControlState {
  const agents = new Map(state.agents);
  const inCompany = new Map(agents.get(entry.companyId) ?? []);
  inCompany.set(entry.agentId, entry);
  agents.set(entry.companyId, inCompany);
  return { agents, runs: state.runs };
}

/** Restriction strength used by seeding. Seeding may raise a status but never lower it. */
const RESTRICTION_RANK: Readonly<Record<AgentStatus, number>> = { active: 0, paused: 1, disabled: 2, retired: 3 };

function applyTransition(
  state: ControlState,
  action: keyof typeof TRANSITIONS,
  companyId: string,
  agentId: string,
  actor: ControlActor,
  options?: ControlOptions,
): ControlResult {
  if (!nonEmpty(companyId)) return { ok: false, reason: 'company_id_required', state };
  if (!nonEmpty(agentId)) return { ok: false, reason: 'agent_id_required', state };
  if (!actorValid(actor)) return { ok: false, reason: 'actor_invalid', state };
  if (actor.kind !== 'human') return { ok: false, reason: 'human_only', state };

  const existing = agentEntry(state, companyId, agentId);
  const current: AgentStatus = existing ? existing.status : 'active';
  if (current === 'retired') return { ok: false, reason: 'agent_retired', state };

  const rule = TRANSITIONS[action];
  if (!rule.from.includes(current)) return { ok: false, reason: 'invalid_transition', state };

  const entry: AgentControlEntry = {
    agentId,
    companyId,
    status: rule.to,
    changed: stampOf(actor, options),
  };
  const next = withAgent(state, entry);
  return { ok: true, state: next, entry };
}

export function pauseAgent(
  state: ControlState,
  companyId: string,
  agentId: string,
  actor: ControlActor,
  options?: ControlOptions,
): ControlResult {
  return applyTransition(state, 'pause', companyId, agentId, actor, options);
}

export function resumeAgent(
  state: ControlState,
  companyId: string,
  agentId: string,
  actor: ControlActor,
  options?: ControlOptions,
): ControlResult {
  return applyTransition(state, 'resume', companyId, agentId, actor, options);
}

export function disableAgent(
  state: ControlState,
  companyId: string,
  agentId: string,
  actor: ControlActor,
  options?: ControlOptions,
): ControlResult {
  return applyTransition(state, 'disable', companyId, agentId, actor, options);
}

export function retireAgent(
  state: ControlState,
  companyId: string,
  agentId: string,
  actor: ControlActor,
  options?: ControlOptions,
): ControlResult {
  return applyTransition(state, 'retire', companyId, agentId, actor, options);
}

/** Marks a run stopped. Either kind of actor may stop a run. A run owned by another company is refused. */
export function stopRun(
  state: ControlState,
  companyId: string,
  runId: string,
  actor: ControlActor,
  options?: ControlOptions,
): StopResult {
  if (!nonEmpty(companyId)) return { ok: false, reason: 'company_id_required', state };
  if (!nonEmpty(runId)) return { ok: false, reason: 'run_id_required', state };
  if (!actorValid(actor)) return { ok: false, reason: 'actor_invalid', state };

  const entry: RunStopEntry = { runId, companyId, stopped: true, changed: stampOf(actor, options) };
  const runs = new Map(state.runs);
  const inCompany = new Map(runs.get(companyId) ?? []);
  inCompany.set(runId, entry);
  runs.set(companyId, inCompany);
  return { ok: true, state: { agents: state.agents, runs }, entry };
}

/**
 * Whether an agent may begin new work. Unknown agents are active by default. Paused, disabled and
 * retired agents are refused with the matching reason. Only this company's entries are read.
 */
export function canStartWork(state: ControlState, companyId: string, agentId: string): StartDecision {
  if (!nonEmpty(companyId)) return { allowed: false, reason: 'company_id_required' };
  if (!nonEmpty(agentId)) return { allowed: false, reason: 'agent_id_required' };

  const entry = agentEntry(state, companyId, agentId);
  if (!entry) return { allowed: true };
  if (entry.status === 'active') return { allowed: true };
  return { allowed: false, reason: START_REASON[entry.status] };
}

/**
 * True when the run has a stop flag. Unknown runs are not stopped.
 * With a companyId, only that company's namespace is read. Without one, a stop recorded by any company
 * counts, so the check fails closed for callers that do not pass a company (such as the run engine today).
 */
export function isRunStopped(state: ControlState, runId: string, companyId?: string): boolean {
  if (companyId !== undefined) return state.runs.get(companyId)?.has(runId) ?? false;
  for (const inCompany of state.runs.values()) {
    if (inCompany.has(runId)) return true;
  }
  return false;
}

/**
 * Sets each agent's status for one company from its roster status. Entries whose companyId differs from
 * companyId are skipped, so other companies are never touched. The result is never looser than the
 * current state: an operator's pause, disable or retire is kept when the roster says active. Returns a
 * new state object. Pass the same state back when there is nothing to seed.
 */
export function seedControls(
  state: ControlState,
  companyId: string,
  agents: readonly RosterSeed[],
  options?: ControlOptions,
): ControlState {
  if (!nonEmpty(companyId) || !Array.isArray(agents)) return state;
  let next = state;
  const at = (options?.now ?? (() => new Date()))().toISOString();
  for (const seed of agents) {
    if (!seed || typeof seed !== 'object') continue;
    if (seed.companyId !== undefined && seed.companyId !== companyId) continue;
    if (!nonEmpty(seed.agentId)) continue;
    const status: AgentStatus | undefined = seed.status === 'active' || seed.status === 'paused' || seed.status === 'retired' ? seed.status : undefined;
    if (status === undefined) continue;
    const existing = agentEntry(next, companyId, seed.agentId);
    if (existing && RESTRICTION_RANK[existing.status] > RESTRICTION_RANK[status]) continue;
    if (existing && existing.status === status) continue;
    next = withAgent(next, {
      agentId: seed.agentId,
      companyId,
      status,
      changed: { by: 'roster:seed', at },
    });
  }
  return next;
}
