/**
 * In-memory roster: maps each workforce role to agent instances bound to a
 * company, a team, permissions, channels and an autonomy tier.
 *
 * The role catalogue is read-only and is never changed here. Every agent is
 * keyed by company first, so one company can never see or change another
 * company's agents. Nothing is persisted; a roster lives as long as the
 * object returned by createRoster.
 *
 * Autonomy restriction: AUTONOMY_RANK is assist(0) < suggest(1) < auto(2) <
 * predictive(3). An agent's autonomy may not rank above its role's autonomy.
 */
import { AUTONOMY_LEVELS, AUTONOMY_RANK, type Autonomy, type Channel, type RoleDefinition } from "./catalogue/role.schema.ts";
import type { RoleCatalogue } from "./catalogue/loader.ts";

export const AGENT_STATUSES = ["active", "paused", "retired"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export type RosterReason =
  | "unknown_role"
  | "invalid_input"
  | "invalid_autonomy"
  | "autonomy_exceeds_role"
  | "channel_not_allowed"
  | "permission_not_allowed"
  | "duplicate_agent"
  | "agent_not_found"
  | "agent_retired"
  | "agent_running"
  | "run_check_unavailable"
  | "immutable_field"
  | "invalid_status";

export interface RosterAgent {
  readonly companyId: string;
  readonly agentId: string;
  readonly roleId: string;
  readonly teamId: string | null;
  readonly channels: readonly Channel[];
  /** Tool ids this agent may use. Always a subset of the role's tools. */
  readonly permissions: readonly string[];
  readonly autonomy: Autonomy;
  readonly status: AgentStatus;
  /** Set only once the agent is retired: when, and by which acting user. The record itself is kept. */
  readonly retiredAt?: string;
  readonly retiredBy?: string;
}

export type RosterResult =
  | { ok: true; agent: RosterAgent }
  | { ok: false; reason: RosterReason; message: string };

export interface CreateAgentInput {
  companyId: string;
  roleId: string;
  agentId: string;
  teamId?: string | null;
  channels: readonly Channel[];
  permissions?: readonly string[];
  autonomy: Autonomy;
}

/** Fields that configureAgent may change. companyId, roleId and agentId are fixed. */
export interface AgentPatch {
  teamId?: string | null;
  channels?: readonly Channel[];
  permissions?: readonly string[];
  autonomy?: Autonomy;
}

interface AgentRecord {
  companyId: string;
  agentId: string;
  roleId: string;
  teamId: string | null;
  channels: Channel[];
  permissions: string[];
  autonomy: Autonomy;
  status: AgentStatus;
  retiredAt: string | null;
  retiredBy: string | null;
}

/** Opaque handle. Use only through the exported functions. */
export interface Roster {
  readonly catalogue: RoleCatalogue;
  readonly companies: Map<string, Map<string, AgentRecord>>;
}

type Failure = { ok: false; reason: RosterReason; message: string };

const CONFIGURABLE_FIELDS = ["teamId", "channels", "permissions", "autonomy"] as const;
const FIXED_FIELDS = ["companyId", "roleId", "agentId"] as const;

export function createRoster(catalogue: RoleCatalogue): Roster {
  return { catalogue, companies: new Map() };
}

export function createAgent(roster: Roster, input: CreateAgentInput): RosterResult {
  const raw = input as unknown as Record<string, unknown>;
  if (!isId(input.companyId) || !isId(input.agentId)) {
    return fail("invalid_input", "companyId and agentId must be non-empty strings");
  }
  const role = findRole(roster, input.roleId);
  if (!role) return fail("unknown_role", `no role "${String(input.roleId)}" in the catalogue`);

  if (raw.teamId !== undefined && raw.teamId !== null && !isId(raw.teamId)) {
    return fail("invalid_input", "teamId must be a non-empty string, null or omitted");
  }
  if (findRecord(roster, input.companyId, input.agentId)) {
    return fail("duplicate_agent", "this company already has an agent with that id");
  }

  const autonomyError = checkAutonomy(role, input.autonomy);
  if (autonomyError) return autonomyError;
  const channelError = checkChannels(role, input.channels);
  if (channelError) return channelError;
  const permissionError = checkPermissions(role, input.permissions ?? []);
  if (permissionError) return permissionError;

  const record: AgentRecord = {
    companyId: input.companyId,
    agentId: input.agentId,
    roleId: role.id,
    teamId: (raw.teamId as string | null | undefined) ?? null,
    channels: [...input.channels],
    permissions: [...(input.permissions ?? [])],
    autonomy: input.autonomy,
    status: "active",
    retiredAt: null,
    retiredBy: null,
  };
  let agents = roster.companies.get(input.companyId);
  if (!agents) {
    agents = new Map();
    roster.companies.set(input.companyId, agents);
  }
  agents.set(input.agentId, record);
  return { ok: true, agent: snapshot(record) };
}

export function configureAgent(
  roster: Roster,
  companyId: string,
  agentId: string,
  patch: AgentPatch,
): RosterResult {
  if (typeof patch !== "object" || patch === null) return fail("invalid_input", "patch must be an object");
  const keys = Object.keys(patch);
  for (const key of keys) {
    if ((FIXED_FIELDS as readonly string[]).includes(key)) {
      return fail("immutable_field", `${key} cannot be changed after an agent is created`);
    }
    if (!(CONFIGURABLE_FIELDS as readonly string[]).includes(key)) {
      return fail("invalid_input", `unknown field "${key}"`);
    }
  }

  const record = findRecord(roster, companyId, agentId);
  if (!record) return fail("agent_not_found", "no such agent in this company");
  if (record.status === "retired") return fail("agent_retired", "a retired agent cannot be changed");

  const role = findRole(roster, record.roleId);
  if (!role) return fail("unknown_role", `no role "${record.roleId}" in the catalogue`);

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

  // Every check passed: apply the whole patch at once.
  if ("teamId" in patch) record.teamId = patch.teamId ?? null;
  if ("channels" in patch && patch.channels) record.channels = [...patch.channels];
  if ("permissions" in patch) record.permissions = [...(patch.permissions ?? [])];
  if ("autonomy" in patch && patch.autonomy) record.autonomy = patch.autonomy;
  return { ok: true, agent: snapshot(record) };
}

export function setAgentStatus(
  roster: Roster,
  companyId: string,
  agentId: string,
  status: AgentStatus,
): RosterResult {
  if (!(AGENT_STATUSES as readonly unknown[]).includes(status)) {
    return fail("invalid_status", `status must be one of ${AGENT_STATUSES.join(", ")}`);
  }
  const record = findRecord(roster, companyId, agentId);
  if (!record) return fail("agent_not_found", "no such agent in this company");
  if (record.status === "retired") return fail("agent_retired", "retired is terminal");
  record.status = status;
  return { ok: true, agent: snapshot(record) };
}

export interface RetireOptions {
  /** The acting user's id, taken from the caller's verified session. Required and stored with the retirement. */
  actor: string;
  /**
   * Whether the agent has a task in progress. It must resolve to a boolean. A missing, throwing or
   * non-boolean answer refuses the retirement (fail closed).
   */
  isRunning: (companyId: string, agentId: string) => boolean | Promise<boolean>;
  /** Clock for retiredAt. Defaults to the real clock. */
  now?: () => Date;
}

const RUN_CHECK_UNAVAILABLE = "the running-task check is unavailable, so the agent was not retired";

/**
 * Retires one agent of one company. Terminal: after this, pause, resume, configure and any other status
 * change refuse with agent_retired. The record stays in the roster with retiredAt and retiredBy, so its
 * history is kept. Refuses (agent_running) while the agent has a task in progress. companyId must come
 * from the caller's session, never from request input.
 */
export async function retireAgent(
  roster: Roster,
  companyId: string,
  agentId: string,
  options: RetireOptions,
): Promise<RosterResult> {
  if (!isId(companyId) || !isId(agentId)) {
    return fail("invalid_input", "companyId and agentId must be non-empty strings");
  }
  if (typeof options !== "object" || options === null || !isId(options.actor)) {
    return fail("invalid_input", "retiring an agent needs the acting user's id");
  }
  const before = findRecord(roster, companyId, agentId);
  if (!before) return fail("agent_not_found", "no such agent in this company");
  if (before.status === "retired") return fail("agent_retired", "retired is terminal");

  if (typeof options.isRunning !== "function") return fail("run_check_unavailable", RUN_CHECK_UNAVAILABLE);
  let running: unknown;
  try {
    running = await options.isRunning(companyId, agentId);
  } catch {
    return fail("run_check_unavailable", RUN_CHECK_UNAVAILABLE);
  }
  if (typeof running !== "boolean") return fail("run_check_unavailable", RUN_CHECK_UNAVAILABLE);
  if (running) return fail("agent_running", "the agent has a task in progress; retire it after the task ends");

  // Re-read after the await: the agent may have been retired while the check was running.
  const record = findRecord(roster, companyId, agentId);
  if (!record) return fail("agent_not_found", "no such agent in this company");
  if (record.status === "retired") return fail("agent_retired", "retired is terminal");
  record.status = "retired";
  record.retiredAt = (options.now ?? (() => new Date()))().toISOString();
  record.retiredBy = options.actor;
  return { ok: true, agent: snapshot(record) };
}

/** Every agent of one company, including paused and retired ones. Other companies are never returned. */
export function listAgents(roster: Roster, companyId: string): RosterAgent[] {
  const agents = roster.companies.get(companyId);
  if (!agents) return [];
  return [...agents.values()].map(snapshot);
}

/** One agent of one company, or undefined. Another company's agent id is never found. */
export function getAgent(roster: Roster, companyId: string, agentId: string): RosterAgent | undefined {
  if (!isId(companyId) || !isId(agentId)) return undefined;
  const record = findRecord(roster, companyId, agentId);
  return record ? snapshot(record) : undefined;
}

/**
 * The operations the admin routes need, shaped so the in-memory roster (createRosterPort) and the
 * Postgres roster (pg-roster.ts) both fit. Results may be returned directly or as a promise.
 */
export interface AgentRosterPort {
  getAgent(companyId: string, agentId: string): RosterAgent | undefined | Promise<RosterAgent | undefined>;
  createAgent(input: CreateAgentInput): RosterResult | Promise<RosterResult>;
  configureAgent(companyId: string, agentId: string, patch: AgentPatch): RosterResult | Promise<RosterResult>;
  setAgentStatus(companyId: string, agentId: string, status: AgentStatus): RosterResult | Promise<RosterResult>;
  /** Optional so a port without the guarded retirement fails closed (the admin router answers 503). */
  retireAgent?(companyId: string, agentId: string, options: RetireOptions): RosterResult | Promise<RosterResult>;
  listAgents(companyId: string): RosterAgent[] | Promise<RosterAgent[]>;
}

/** Adapts an in-memory roster to the port shape. */
export function createRosterPort(roster: Roster): AgentRosterPort {
  return {
    getAgent: (companyId, agentId) => getAgent(roster, companyId, agentId),
    createAgent: (input) => createAgent(roster, input),
    configureAgent: (companyId, agentId, patch) => configureAgent(roster, companyId, agentId, patch),
    setAgentStatus: (companyId, agentId, status) => setAgentStatus(roster, companyId, agentId, status),
    retireAgent: (companyId, agentId, options) => retireAgent(roster, companyId, agentId, options),
    listAgents: (companyId) => listAgents(roster, companyId),
  };
}

function findRole(roster: Roster, roleId: unknown): RoleDefinition | undefined {
  if (typeof roleId !== "string") return undefined;
  return roster.catalogue.get(roleId);
}

function findRecord(roster: Roster, companyId: string, agentId: string): AgentRecord | undefined {
  return roster.companies.get(companyId)?.get(agentId);
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

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(reason: RosterReason, message: string): Failure {
  return { ok: false, reason, message };
}

/** A frozen copy, so callers can never reach the roster's internal state. */
function snapshot(record: AgentRecord): RosterAgent {
  return Object.freeze({
    companyId: record.companyId,
    agentId: record.agentId,
    roleId: record.roleId,
    teamId: record.teamId,
    channels: Object.freeze([...record.channels]),
    permissions: Object.freeze([...record.permissions]),
    autonomy: record.autonomy,
    status: record.status,
    ...(record.retiredAt !== null ? { retiredAt: record.retiredAt, retiredBy: record.retiredBy ?? undefined } : {}),
  });
}
