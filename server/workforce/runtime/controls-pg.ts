/**
 * Postgres persistence for the operator control state in controls.ts (pause, resume, disable, retire, run stop).
 * controls.ts keeps state in memory; this adapter loads one company's entries and writes each change through as
 * it happens, so a restart keeps a pause or a stop. The database is reached only through the injected
 * SqlExecutor (as in pg-store.ts), so this file never imports a driver.
 *
 * Table (expected, not created here; no migration is written by this file):
 *   workforce_control_state (company_id uuid, kind text 'agent' | 'run', entry_id text, status text,
 *     changed_by text, changed_at timestamptz, PRIMARY KEY (company_id, kind, entry_id))
 *   Agent rows hold an AgentStatus. Run rows hold 'stopped'.
 *
 * Tenant rules. Every statement takes company_id as $1 and is parameterised. A load reads only the named
 * company's rows, and a row whose company_id differs from the one requested is rejected. Every write is checked
 * against the company passed in, so one company's change never writes another company's row.
 *
 * Each operation loads the company's state, applies the matching controls.ts function, and writes only when
 * that function returns ok. A refused change issues no write. controls.ts is used unchanged: it exports
 * everything this adapter needs, and no hook is required.
 *
 * Compare-and-set. Every write names the status it read. An insert succeeds only when no row exists, and an
 * update succeeds only when the stored status still equals the one read. When a write loses the race, the change
 * reloads the state and runs the pure transition again, up to MAX_CONTROL_ATTEMPTS times. If the race never
 * settles, the change throws ControlConflictError and nothing is reported as applied. Two concurrent pauses, or a
 * pause and a resume, therefore cannot both succeed on the same stale state.
 */
import { requireCompanyId } from '../../services/ai-runtime/company.ts';
import {
  AGENT_STATUSES,
  createControlState,
  disableAgent,
  pauseAgent,
  resumeAgent,
  retireAgent,
  seedControls,
  stopRun,
  type AgentControlEntry,
  type AgentStatus,
  type ControlActor,
  type ControlOptions,
  type ControlResult,
  type ControlState,
  type RosterSeed,
  type RunStopEntry,
  type StopResult,
} from './controls.ts';
import type { SqlExecutor } from './pg-store.ts';

/** Exported so a test fake can recognise each statement. Every statement takes company_id as $1. */
export const CONTROL_SQL = {
  loadCompany: `SELECT company_id, kind, entry_id, status, changed_by, changed_at
FROM workforce_control_state
WHERE company_id = $1::uuid`,

  /** Creates the row only when none exists. rowCount 0 means another writer got there first. */
  insertIfAbsent: `INSERT INTO workforce_control_state (company_id, kind, entry_id, status, changed_by, changed_at)
VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::timestamptz)
ON CONFLICT (company_id, kind, entry_id) DO NOTHING`,

  /** Compare-and-set: changes the row only while its status is still $7. rowCount 0 means the state moved. */
  updateIfStatus: `UPDATE workforce_control_state
SET status = $4::text, changed_by = $5::text, changed_at = $6::timestamptz
WHERE company_id = $1::uuid AND kind = $2::text AND entry_id = $3::text AND status = $7::text`,
} as const;

/** Attempts per change before a race is reported as an error. */
export const MAX_CONTROL_ATTEMPTS = 3;

/** Thrown when concurrent writers keep changing the state faster than a change can reload and retry. */
export class ControlConflictError extends Error {
  constructor() {
    super('controls-pg: control state changed concurrently; retry the change');
    this.name = 'ControlConflictError';
  }
}

export interface PgControls {
  /** Loads one company's control state. Other companies' rows are never read. */
  load(companyId: string): Promise<ControlState>;
  pause(companyId: string, agentId: string, actor: ControlActor, options?: ControlOptions): Promise<ControlResult>;
  resume(companyId: string, agentId: string, actor: ControlActor, options?: ControlOptions): Promise<ControlResult>;
  disable(companyId: string, agentId: string, actor: ControlActor, options?: ControlOptions): Promise<ControlResult>;
  retire(companyId: string, agentId: string, actor: ControlActor, options?: ControlOptions): Promise<ControlResult>;
  stop(companyId: string, runId: string, actor: ControlActor, options?: ControlOptions): Promise<StopResult>;
  /** Seeds from the roster and writes back only the entries that changed. */
  seed(companyId: string, agents: readonly RosterSeed[], options?: ControlOptions): Promise<ControlState>;
}

function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && (AGENT_STATUSES as readonly string[]).includes(value);
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value !== '') return new Date(value).toISOString();
  throw new Error('controls-pg: changed_at is missing or invalid');
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`controls-pg: ${field} is missing`);
  return value;
}

/** Builds a ControlState holding only one company's namespace. Rows must already be checked for company. */
function buildState(companyId: string, rows: readonly Record<string, unknown>[]): ControlState {
  const agents = new Map<string, AgentControlEntry>();
  const runs = new Map<string, RunStopEntry>();
  for (const row of rows) {
    if (row.company_id !== companyId) throw new Error('controls-pg: row belongs to another company');
    const changed = { by: requireText(row.changed_by, 'changed_by'), at: toIso(row.changed_at) };
    const entryId = requireText(row.entry_id, 'entry_id');
    if (row.kind === 'agent') {
      if (!isAgentStatus(row.status)) throw new Error('controls-pg: unknown agent status');
      agents.set(entryId, { agentId: entryId, companyId, status: row.status, changed });
    } else if (row.kind === 'run') {
      if (row.status !== 'stopped') throw new Error('controls-pg: unknown run status');
      runs.set(entryId, { runId: entryId, companyId, stopped: true, changed });
    } else {
      throw new Error('controls-pg: unknown control kind');
    }
  }
  const base = createControlState();
  return {
    agents: agents.size > 0 ? new Map([[companyId, agents]]) : base.agents,
    runs: runs.size > 0 ? new Map([[companyId, runs]]) : base.runs,
  };
}

/** Status read for one entry, or null when no row exists. */
function storedStatus(state: ControlState, companyId: string, agentId: string): AgentStatus | null {
  return state.agents.get(companyId)?.get(agentId)?.status ?? null;
}

export function createPgControls(db: SqlExecutor): PgControls {
  async function load(companyId: string): Promise<ControlState> {
    const scoped = requireCompanyId(companyId);
    const result = await db.query(CONTROL_SQL.loadCompany, [scoped]);
    return buildState(scoped, result.rows);
  }

  /**
   * Writes one entry only if the stored status still equals `expected` (null means no row). Returns false when
   * another writer changed it first. Every value is bound as a parameter.
   */
  async function writeEntry(
    scoped: string,
    kind: 'agent' | 'run',
    entryId: string,
    expected: AgentStatus | 'stopped' | null,
    status: AgentStatus | 'stopped',
    stamp: { by: string; at: string },
  ): Promise<boolean> {
    if (expected === null) {
      const result = await db.query(CONTROL_SQL.insertIfAbsent, [scoped, kind, entryId, status, stamp.by, stamp.at]);
      return result.rowCount === 1;
    }
    const result = await db.query(CONTROL_SQL.updateIfStatus, [
      scoped,
      kind,
      entryId,
      status,
      stamp.by,
      stamp.at,
      expected,
    ]);
    return result.rowCount === 1;
  }

  /** Runs one agent transition: reload, apply the pure rule, compare-and-set the write, retry on a lost race. */
  async function transition(
    companyId: string,
    apply: (state: ControlState) => ControlResult,
  ): Promise<ControlResult> {
    const scoped = requireCompanyId(companyId);
    for (let attempt = 0; attempt < MAX_CONTROL_ATTEMPTS; attempt += 1) {
      const state = await load(scoped);
      const result = apply(state);
      if (!result.ok) return result;
      const expected = storedStatus(state, scoped, result.entry.agentId);
      if (await writeEntry(scoped, 'agent', result.entry.agentId, expected, result.entry.status as AgentStatus, result.entry.changed)) {
        return result;
      }
    }
    throw new ControlConflictError();
  }

  return {
    load,

    pause: (companyId, agentId, actor, options) =>
      transition(companyId, (s) => pauseAgent(s, companyId, agentId, actor, options)),
    resume: (companyId, agentId, actor, options) =>
      transition(companyId, (s) => resumeAgent(s, companyId, agentId, actor, options)),
    disable: (companyId, agentId, actor, options) =>
      transition(companyId, (s) => disableAgent(s, companyId, agentId, actor, options)),
    retire: (companyId, agentId, actor, options) =>
      transition(companyId, (s) => retireAgent(s, companyId, agentId, actor, options)),

    async stop(companyId, runId, actor, options) {
      const scoped = requireCompanyId(companyId);
      for (let attempt = 0; attempt < MAX_CONTROL_ATTEMPTS; attempt += 1) {
        const state = await load(scoped);
        const result = stopRun(state, companyId, runId, actor, options);
        if (!result.ok) return result;
        // A run already stopped keeps its first stamp. Stopping it again writes nothing and reports the stop.
        const existing = state.runs.get(scoped)?.get(runId);
        if (existing) return { ok: true, state, entry: existing };
        if (await writeEntry(scoped, 'run', runId, null, 'stopped', result.entry.changed)) return result;
      }
      throw new ControlConflictError();
    },

    async seed(companyId, agents, options) {
      const scoped = requireCompanyId(companyId);
      for (let attempt = 0; attempt < MAX_CONTROL_ATTEMPTS; attempt += 1) {
        const before = await load(scoped);
        const after = seedControls(before, scoped, agents, options);
        const beforeEntries = before.agents.get(scoped);
        const afterEntries = after.agents.get(scoped);
        let landed = true;
        if (afterEntries) {
          for (const [agentId, entry] of afterEntries) {
            if (beforeEntries?.get(agentId) === entry) continue;
            const expected = storedStatus(before, scoped, agentId);
            if (!(await writeEntry(scoped, 'agent', agentId, expected, entry.status as AgentStatus, entry.changed))) {
              landed = false;
              break;
            }
          }
        }
        if (landed) return after;
      }
      throw new ControlConflictError();
    },
  };
}
