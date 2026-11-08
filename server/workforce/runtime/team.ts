/**
 * Teams, handoffs and delegation for the workforce runtime. Pure functions: no I/O, no clock, no database.
 *
 * Concepts ported from the Clean-Hub multi-agent reference (read only):
 *   - team: a named set of roles for one domain       (AgentTeamManager::createTeam)
 *   - handoff: moves the work to another role         (AgentTeamManager::createHandoff)
 *   - ownership: only the role that owns the work may hand it on (AgentTeamManager::acceptHandoff, to_agent check)
 *
 * Not ported: selectAgents scoring, per-agent task queues and getWorkload (the run budget replaces
 * them), the Laravel collection types, now() and Str::uuid(). See RUNTIME.md.
 *
 * Role data comes from the catalogue fields handoffTo, toolRisk and autonomy. The catalogue SCHEMA.md
 * did not exist when this was written, so RoleSpec below is the brief's field list. Check it when the
 * schema lands.
 */
import { AiRuntimeError } from '../../services/ai-runtime/types.ts';

export interface RoleSpec {
  id: string;
  /** Roles this role may hand work to or delegate to (catalogue handoffTo). */
  handoffTo: readonly string[];
  /** Tool id to risk tier (catalogue toolRisk). A role can raise a tool's tier, never lower it. */
  toolRisk?: Readonly<Record<string, string>>;
  /** Autonomy level for this role's agent. Missing or unknown fails closed at each tool call. */
  autonomy?: unknown;
  /** Tool ids this role may call (catalogue tools). After a handoff, the receiving role is limited to these. */
  tools?: readonly string[];
  /**
   * Access class per tool id (catalogue toolAccess): 'read' or 'write'. Used when a tool does not declare its own
   * access. A tool missing here, or with any other value, is treated as 'write' (fail closed).
   */
  toolAccess?: Readonly<Record<string, string>>;
}

/** Looks up a role by id. The composition root backs this with the catalogue. */
export interface RoleSource {
  getRole(roleId: string): RoleSpec | null | undefined;
}

export interface TeamMemberInput {
  roleId: string;
  /** Exactly one member must set this. */
  coordinator?: boolean;
}

export interface TeamInput {
  id: string;
  name: string;
  members: readonly TeamMemberInput[];
}

/**
 * A team as the run sees it. Roles are copied at creation, so a run keeps the handoff, toolRisk and
 * autonomy it started with even if the catalogue changes later.
 */
export interface Team {
  id: string;
  name: string;
  coordinator: string;
  members: readonly string[];
  roles: Readonly<Record<string, RoleSpec>>;
}

export interface TeamLimits {
  /** Deepest delegation allowed. Root delegations from the coordinator are depth 1. */
  maxDelegationDepth: number;
  /** Most open delegations one parent may have at once. */
  maxFanOut: number;
}

export const DEFAULT_TEAM_LIMITS: Readonly<TeamLimits> = Object.freeze({ maxDelegationDepth: 3, maxFanOut: 4 });

export type HandoffRefusal =
  | 'path_empty'
  | 'role_not_in_team'
  | 'not_owner'
  | 'not_in_handoff_to'
  | 'handoff_cycle'
  | 'depth_exceeded';

export type HandoffPlan = { ok: true; path: string[] } | { ok: false; reason: HandoffRefusal };

export interface Delegation {
  id: string;
  parentId: string | null;
  fromRole: string;
  toRole: string;
  depth: number;
  status: 'open' | 'closed';
}

export type DelegationRefusal =
  | 'role_not_in_team'
  | 'root_not_coordinator'
  | 'parent_unknown'
  | 'parent_closed'
  | 'parent_role_mismatch'
  | 'not_in_handoff_to'
  | 'delegation_cycle'
  | 'depth_exceeded'
  | 'fan_out_exceeded';

export type DelegationPlan = { ok: true; delegation: Delegation } | { ok: false; reason: DelegationRefusal };

export type CloseRefusal = 'delegation_unknown' | 'delegation_closed' | 'open_children';

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function configError(message: string): AiRuntimeError {
  return new AiRuntimeError('config_invalid', message);
}

/** Fills in defaults and rejects non-positive or non-integer limits. Throws on bad configuration. */
export function resolveTeamLimits(partial: Partial<TeamLimits> = {}): TeamLimits {
  const limits = { ...DEFAULT_TEAM_LIMITS, ...partial };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw configError(`team limit ${key} must be a positive integer`);
    }
  }
  return limits;
}

/**
 * Builds a team from member role ids. Throws on configuration errors: an unknown role, a duplicate
 * member, or anything other than exactly one coordinator.
 */
export function createTeam(input: TeamInput, roles: RoleSource): Team {
  if (!input || !isNonEmptyString(input.id) || !isNonEmptyString(input.name)) {
    throw configError('team needs a non-empty id and name');
  }
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw configError('team needs at least one member');
  }

  const members: string[] = [];
  const snapshot: Record<string, RoleSpec> = {};
  let coordinator: string | null = null;
  let coordinators = 0;

  for (const member of input.members) {
    if (!isNonEmptyString(member?.roleId)) throw configError('team member needs a roleId');
    if (hasOwn(snapshot, member.roleId)) throw configError(`duplicate team member: ${member.roleId}`);

    const role = roles.getRole(member.roleId);
    if (!role || role.id !== member.roleId) throw configError(`unknown role in team: ${member.roleId}`);
    if (!Array.isArray(role.handoffTo) || !role.handoffTo.every(isNonEmptyString)) {
      throw configError(`role ${member.roleId} has an invalid handoffTo list`);
    }

    members.push(member.roleId);
    snapshot[member.roleId] = {
      id: role.id,
      handoffTo: [...role.handoffTo],
      toolRisk: role.toolRisk ? { ...role.toolRisk } : undefined,
      autonomy: role.autonomy,
      tools: Array.isArray(role.tools) ? role.tools.filter(isNonEmptyString) : undefined,
      toolAccess: snapshotToolAccess(role.toolAccess),
    };
    if (member.coordinator === true) {
      coordinators += 1;
      coordinator = member.roleId;
    }
  }

  if (coordinators !== 1 || coordinator === null) {
    throw configError(`invalid_team: team must have exactly one coordinator, found ${coordinators}`);
  }

  return { id: input.id, name: input.name, coordinator, members, roles: snapshot };
}

/** Copies the valid access levels only. Anything else is dropped, so the tool falls back to 'write'. */
function snapshotToolAccess(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [toolId, level] of Object.entries(raw)) {
    if (isNonEmptyString(toolId) && (level === 'read' || level === 'write')) out[toolId] = level;
  }
  return out;
}

function isMember(team: Team, roleId: string): boolean {
  return hasOwn(team.roles, roleId);
}

/**
 * Plans one handoff. `path` is the run's handoff path: the coordinator first, then each role the work
 * has passed to. The last entry is the current owner. Checks run in this order: membership, ownership,
 * the handoffTo list (refused as not_in_handoff_to), cycles (a handoff back to any role already on the
 * path, refused as handoff_cycle), then depth. A handoff chain has one hop per handoff, so after this
 * handoff it has path.length hops. That count must not exceed limits.maxDelegationDepth
 * (refused as depth_exceeded). `limits` defaults to DEFAULT_TEAM_LIMITS, so callers that pass nothing keep depth 3.
 */
export function planHandoff(
  team: Team,
  path: readonly string[],
  fromRole: string,
  toRole: string,
  limits: TeamLimits = DEFAULT_TEAM_LIMITS,
): HandoffPlan {
  if (path.length === 0) return { ok: false, reason: 'path_empty' };
  if (!isMember(team, fromRole) || !isMember(team, toRole)) return { ok: false, reason: 'role_not_in_team' };
  if (fromRole !== path[path.length - 1]) return { ok: false, reason: 'not_owner' };
  if (!team.roles[fromRole].handoffTo.includes(toRole)) return { ok: false, reason: 'not_in_handoff_to' };
  if (path.includes(toRole)) return { ok: false, reason: 'handoff_cycle' };
  if (path.length > limits.maxDelegationDepth) return { ok: false, reason: 'depth_exceeded' };
  return { ok: true, path: [...path, toRole] };
}

export interface DelegationRequest {
  id: string;
  /** null for a delegation from the coordinator to a root child. */
  parentId: string | null;
  fromRole: string;
  toRole: string;
}

/**
 * Plans one delegation. Delegation uses the same handoffTo edges as handoff. A root delegation must
 * come from the coordinator. A child delegation must come from the parent's toRole. Limits: depth
 * (root is 1), open children per parent (fan-out), and no role may appear twice on the chain of open
 * ancestors.
 */
export function planDelegation(
  team: Team,
  delegations: readonly Delegation[],
  request: DelegationRequest,
  limits: TeamLimits,
): DelegationPlan {
  const { id, parentId, fromRole, toRole } = request;
  if (!isMember(team, fromRole) || !isMember(team, toRole)) return { ok: false, reason: 'role_not_in_team' };

  let depth: number;
  const chain = new Set<string>([fromRole]);

  if (parentId === null) {
    if (fromRole !== team.coordinator) return { ok: false, reason: 'root_not_coordinator' };
    depth = 1;
  } else {
    const parent = delegations.find((d) => d.id === parentId);
    if (!parent) return { ok: false, reason: 'parent_unknown' };
    if (parent.status !== 'open') return { ok: false, reason: 'parent_closed' };
    if (parent.toRole !== fromRole) return { ok: false, reason: 'parent_role_mismatch' };
    depth = parent.depth + 1;

    let cursor: Delegation | undefined = parent;
    while (cursor) {
      chain.add(cursor.fromRole);
      chain.add(cursor.toRole);
      const nextId: string | null = cursor.parentId;
      cursor = nextId === null ? undefined : delegations.find((d) => d.id === nextId);
    }
  }

  if (!team.roles[fromRole].handoffTo.includes(toRole)) return { ok: false, reason: 'not_in_handoff_to' };
  if (chain.has(toRole)) return { ok: false, reason: 'delegation_cycle' };
  if (depth > limits.maxDelegationDepth) return { ok: false, reason: 'depth_exceeded' };

  const openChildren = delegations.filter((d) => d.parentId === parentId && d.status === 'open').length;
  if (openChildren >= limits.maxFanOut) return { ok: false, reason: 'fan_out_exceeded' };

  return { ok: true, delegation: { id, parentId, fromRole, toRole, depth, status: 'open' } };
}

/** Marks one delegation closed. A parent cannot close while a child is still open. */
export function closeDelegation(
  delegations: readonly Delegation[],
  delegationId: string,
): { ok: true; delegations: Delegation[] } | { ok: false; reason: CloseRefusal } {
  const target = delegations.find((d) => d.id === delegationId);
  if (!target) return { ok: false, reason: 'delegation_unknown' };
  if (target.status !== 'open') return { ok: false, reason: 'delegation_closed' };
  if (delegations.some((d) => d.parentId === delegationId && d.status === 'open')) {
    return { ok: false, reason: 'open_children' };
  }
  return {
    ok: true,
    delegations: delegations.map((d) => (d.id === delegationId ? { ...d, status: 'closed' as const } : { ...d })),
  };
}
