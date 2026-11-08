/**
 * Production roster backed by the workforce_agents table (shared/schema.ts, migrations/DRAFT_workforce_agents.sql).
 * It offers the same operations and enforces the same rules as the in-memory roster in ./roster.ts, so agents
 * survive a restart. The database is reached only through the injected SqlExecutor, so this file never imports
 * a driver. The composition root passes in a pg Pool or Client.
 *
 * Tenant rules:
 * - Every query filters on company_id. The company is always the caller's argument, never a value read back.
 * - Unknown ids for another company return agent_not_found, exactly as roster.ts does.
 *
 * Rules are duplicated from roster.ts (its checks are not exported). Keep the two in step; the parity tests in
 * tests/workforce/pg-roster.test.mjs run the same cases against both.
 *
 * Writes are conditional: UPDATE ... WHERE status <> 'retired' so a retired agent is never changed, even by a
 * concurrent call that read the row before the retirement committed.
 */
import { AUTONOMY_LEVELS, AUTONOMY_RANK, type Autonomy, type Channel, type RoleDefinition } from "./catalogue/role.schema.ts";
import type { RoleCatalogue } from "./catalogue/loader.ts";
import {
  AGENT_STATUSES,
  type AgentPatch,
  type AgentStatus,
  type CreateAgentInput,
  type RosterAgent,
  type RosterReason,
  type RetireOptions,
  type RosterResult,
} from "./roster.ts";
import type { SqlExecutor, SqlResult } from "./runtime/pg-store.ts";

export interface PgRosterOptions {
  db: SqlExecutor;
  catalogue: RoleCatalogue;
  /** Clock for created_at and updated_at. Defaults to the current time. */
  now?: () => Date;
}

export interface PgRoster {
  getAgent(companyId: string, agentId: string): Promise<RosterAgent | undefined>;
  createAgent(input: CreateAgentInput): Promise<RosterResult>;
  configureAgent(companyId: string, agentId: string, patch: AgentPatch): Promise<RosterResult>;
  setAgentStatus(companyId: string, agentId: string, status: AgentStatus): Promise<RosterResult>;
  /** Guarded retirement: refuses while a task is running or when the running check fails. Same rules as roster.ts retireAgent. */
  retireAgent(companyId: string, agentId: string, options: RetireOptions): Promise<RosterResult>;
  listAgents(companyId: string): Promise<RosterAgent[]>;
}

type Failure = { ok: false; reason: RosterReason; message: string };

const CONFIGURABLE_FIELDS = ["teamId", "channels", "permissions", "autonomy"] as const;
const FIXED_FIELDS = ["companyId", "roleId", "agentId"] as const;

const AGENT_COLUMNS = "id, company_id, role_id, team_id, channels, permissions, autonomy, status";

const SELECT_AGENT = `SELECT ${AGENT_COLUMNS} FROM workforce_agents WHERE company_id = $1 AND id = $2`;

const SELECT_AGENTS = `SELECT ${AGENT_COLUMNS} FROM workforce_agents WHERE company_id = $1 ORDER BY created_at, id`;

// $1 id, $2 company, $3 role, $4 team, $5 channels, $6 permissions, $7 autonomy, $8 status, $9 created_at and updated_at.
// ON CONFLICT DO NOTHING: a row count of zero means a concurrent create won the race.
const INSERT_AGENT = `INSERT INTO workforce_agents (id, company_id, role_id, team_id, channels, permissions, autonomy, status, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
ON CONFLICT (company_id, id) DO NOTHING
RETURNING ${AGENT_COLUMNS}`;

// $1 company, $2 id, $3 team, $4 channels, $5 permissions, $6 autonomy, $7 updated_at.
const UPDATE_AGENT = `UPDATE workforce_agents SET team_id = $3, channels = $4, permissions = $5, autonomy = $6, updated_at = $7
WHERE company_id = $1 AND id = $2 AND status <> 'retired'
RETURNING ${AGENT_COLUMNS}`;

// $1 company, $2 id, $3 status, $4 updated_at.
const UPDATE_STATUS = `UPDATE workforce_agents SET status = $3, updated_at = $4
WHERE company_id = $1 AND id = $2 AND status <> 'retired'
RETURNING ${AGENT_COLUMNS}`;

// $1 company, $2 id, $3 updated_at. Only moves an agent that is not already retired, so a retirement cannot repeat.
const RETIRE_AGENT = `UPDATE workforce_agents SET status = 'retired', updated_at = $3
WHERE company_id = $1 AND id = $2 AND status <> 'retired'
RETURNING ${AGENT_COLUMNS}`;

const RUN_CHECK_UNAVAILABLE = "the running-task check is unavailable, so the agent was not retired";

export function createPgRoster(options: PgRosterOptions): PgRoster {
  const { db, catalogue } = options;
  const clock = options.now ?? (() => new Date());

  async function selectAgent(companyId: string, agentId: string): Promise<Record<string, unknown> | undefined> {
    const result = await db.query(SELECT_AGENT, [companyId, agentId]);
    return firstRow(result);
  }

  return {
    async getAgent(companyId: string, agentId: string): Promise<RosterAgent | undefined> {
      if (!isId(companyId) || !isId(agentId)) return undefined;
      const row = await selectAgent(companyId, agentId);
      return row ? toAgent(row, companyId) : undefined;
    },

    async createAgent(input: CreateAgentInput): Promise<RosterResult> {
      const raw = input as unknown as Record<string, unknown>;
      if (!isId(input.companyId) || !isId(input.agentId)) {
        return fail("invalid_input", "companyId and agentId must be non-empty strings");
      }
      const role = findRole(catalogue, input.roleId);
      if (!role) return fail("unknown_role", `no role "${String(input.roleId)}" in the catalogue`);

      if (raw.teamId !== undefined && raw.teamId !== null && !isId(raw.teamId)) {
        return fail("invalid_input", "teamId must be a non-empty string, null or omitted");
      }
      if (await selectAgent(input.companyId, input.agentId)) {
        return fail("duplicate_agent", "this company already has an agent with that id");
      }

      const autonomyError = checkAutonomy(role, input.autonomy);
      if (autonomyError) return autonomyError;
      const channelError = checkChannels(role, input.channels);
      if (channelError) return channelError;
      const permissionError = checkPermissions(role, input.permissions ?? []);
      if (permissionError) return permissionError;

      const teamId = (raw.teamId as string | null | undefined) ?? null;
      const now = clock();
      const result = await db.query(INSERT_AGENT, [
        input.agentId,
        input.companyId,
        role.id,
        teamId,
        JSON.stringify([...input.channels]),
        JSON.stringify([...(input.permissions ?? [])]),
        input.autonomy,
        "active",
        now,
      ]);
      const row = firstRow(result);
      if (!row) return fail("duplicate_agent", "this company already has an agent with that id");
      return { ok: true, agent: toAgent(row, input.companyId) };
    },

    async configureAgent(companyId: string, agentId: string, patch: AgentPatch): Promise<RosterResult> {
      if (typeof patch !== "object" || patch === null) return fail("invalid_input", "patch must be an object");
      for (const key of Object.keys(patch)) {
        if ((FIXED_FIELDS as readonly string[]).includes(key)) {
          return fail("immutable_field", `${key} cannot be changed after an agent is created`);
        }
        if (!(CONFIGURABLE_FIELDS as readonly string[]).includes(key)) {
          return fail("invalid_input", `unknown field "${key}"`);
        }
      }

      const row = isId(companyId) && isId(agentId) ? await selectAgent(companyId, agentId) : undefined;
      if (!row) return fail("agent_not_found", "no such agent in this company");
      if (row.status === "retired") return fail("agent_retired", "a retired agent cannot be changed");

      const role = findRole(catalogue, row.role_id);
      if (!role) return fail("unknown_role", `no role "${String(row.role_id)}" in the catalogue`);

      if ("teamId" in patch && patch.teamId !== null && patch.teamId !== undefined && !isId(patch.teamId)) {
        return fail("invalid_input", "teamId must be a non-empty string or null");
      }
      if ("autonomy" in patch) {
        const error = checkAutonomy(role, patch.autonomy);
        if (error) return error;
      }
      if ("channels" in patch) {
        const error = checkChannels(role, patch.channels);
        if (error) return error;
      }
      if ("permissions" in patch) {
        const error = checkPermissions(role, patch.permissions ?? []);
        if (error) return error;
      }

      // Every check passed: merge the patch over the stored row and write the whole row at once.
      const current = toAgent(row, companyId);
      const teamId = "teamId" in patch ? (patch.teamId ?? null) : current.teamId;
      const channels = "channels" in patch && patch.channels ? [...patch.channels] : [...current.channels];
      const permissions = "permissions" in patch ? [...(patch.permissions ?? [])] : [...current.permissions];
      const autonomy = "autonomy" in patch && patch.autonomy ? patch.autonomy : current.autonomy;

      const result = await db.query(UPDATE_AGENT, [
        companyId,
        agentId,
        teamId,
        JSON.stringify(channels),
        JSON.stringify(permissions),
        autonomy,
        clock(),
      ]);
      const updated = firstRow(result);
      if (updated) return { ok: true, agent: toAgent(updated, companyId) };
      return missingOrRetired(await selectAgent(companyId, agentId));
    },

    async setAgentStatus(companyId: string, agentId: string, status: AgentStatus): Promise<RosterResult> {
      if (!(AGENT_STATUSES as readonly unknown[]).includes(status)) {
        return fail("invalid_status", `status must be one of ${AGENT_STATUSES.join(", ")}`);
      }
      const row = isId(companyId) && isId(agentId) ? await selectAgent(companyId, agentId) : undefined;
      if (!row) return fail("agent_not_found", "no such agent in this company");
      if (row.status === "retired") return fail("agent_retired", "retired is terminal");

      const result = await db.query(UPDATE_STATUS, [companyId, agentId, status, clock()]);
      const updated = firstRow(result);
      if (updated) return { ok: true, agent: toAgent(updated, companyId) };
      return missingOrRetired(await selectAgent(companyId, agentId));
    },

    async retireAgent(companyId: string, agentId: string, options: RetireOptions): Promise<RosterResult> {
      if (!isId(companyId) || !isId(agentId)) {
        return fail("invalid_input", "companyId and agentId must be non-empty strings");
      }
      if (typeof options !== "object" || options === null || !isId(options.actor)) {
        return fail("invalid_input", "retiring an agent needs the acting user's id");
      }
      const before = await selectAgent(companyId, agentId);
      if (!before) return fail("agent_not_found", "no such agent in this company");
      if (before.status === "retired") return fail("agent_retired", "retired is terminal");

      // Fail closed: a missing, throwing or non-boolean running check refuses the retirement.
      if (typeof options.isRunning !== "function") return fail("run_check_unavailable", RUN_CHECK_UNAVAILABLE);
      let running: unknown;
      try {
        running = await options.isRunning(companyId, agentId);
      } catch {
        return fail("run_check_unavailable", RUN_CHECK_UNAVAILABLE);
      }
      if (typeof running !== "boolean") return fail("run_check_unavailable", RUN_CHECK_UNAVAILABLE);
      if (running) return fail("agent_running", "the agent has a task in progress; retire it after the task ends");

      const result = await db.query(RETIRE_AGENT, [companyId, agentId, clock()]);
      const updated = firstRow(result);
      if (updated) return { ok: true, agent: toAgent(updated, companyId) };
      return missingOrRetired(await selectAgent(companyId, agentId));
    },

    async listAgents(companyId: string): Promise<RosterAgent[]> {
      if (!isId(companyId)) return [];
      const result = await db.query(SELECT_AGENTS, [companyId]);
      return result.rows.map((row) => toAgent(row, companyId));
    },
  };

  /** A conditional write matched no row: the agent is either gone from this company or has just been retired. */
  function missingOrRetired(row: Record<string, unknown> | undefined): Failure {
    if (!row) return fail("agent_not_found", "no such agent in this company");
    return fail("agent_retired", "a retired agent cannot be changed");
  }
}

function firstRow(result: SqlResult): Record<string, unknown> | undefined {
  return result.rows[0];
}

function findRole(catalogue: RoleCatalogue, roleId: unknown): RoleDefinition | undefined {
  if (typeof roleId !== "string") return undefined;
  return catalogue.get(roleId);
}

function checkAutonomy(role: RoleDefinition, autonomy: unknown): Failure | null {
  if (!(AUTONOMY_LEVELS as readonly unknown[]).includes(autonomy)) {
    return fail("invalid_autonomy", `autonomy must be one of ${AUTONOMY_LEVELS.join(", ")}`);
  }
  if (AUTONOMY_RANK[autonomy as Autonomy] > AUTONOMY_RANK[role.autonomy]) {
    return fail("autonomy_exceeds_role", `autonomy "${String(autonomy)}" is above the role maximum "${role.autonomy}"`);
  }
  return null;
}

function checkChannels(role: RoleDefinition, channels: unknown): Failure | null {
  if (!Array.isArray(channels) || channels.length === 0) {
    return fail("invalid_input", "channels must be a non-empty list");
  }
  if (new Set(channels).size !== channels.length) {
    return fail("invalid_input", "channels must not repeat");
  }
  for (const channel of channels) {
    if (!(role.channels as readonly unknown[]).includes(channel)) {
      return fail("channel_not_allowed", `channel "${String(channel)}" is not allowed for role "${role.id}"`);
    }
  }
  return null;
}

function checkPermissions(role: RoleDefinition, permissions: unknown): Failure | null {
  if (!Array.isArray(permissions)) return fail("invalid_input", "permissions must be a list of tool ids");
  if (new Set(permissions).size !== permissions.length) {
    return fail("invalid_input", "permissions must not repeat");
  }
  for (const tool of permissions) {
    if (typeof tool !== "string" || !role.tools.includes(tool)) {
      return fail("permission_not_allowed", `permission "${String(tool)}" is not a tool of role "${role.id}"`);
    }
  }
  return null;
}

function parseJsonList<T>(value: unknown): T[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function toAgent(row: Record<string, unknown>, companyId: string): RosterAgent {
  return Object.freeze({
    companyId,
    agentId: String(row.id),
    roleId: String(row.role_id),
    teamId: row.team_id === null || row.team_id === undefined ? null : String(row.team_id),
    channels: Object.freeze(parseJsonList<Channel>(row.channels)),
    permissions: Object.freeze(parseJsonList<string>(row.permissions)),
    autonomy: row.autonomy as Autonomy,
    status: row.status as AgentStatus,
  });
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(reason: RosterReason, message: string): Failure {
  return { ok: false, reason, message };
}
