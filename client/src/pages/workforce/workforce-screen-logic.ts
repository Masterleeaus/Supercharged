/**
 * Pure helpers for the workforce roster, hierarchy and agent detail screens.
 * No imports, no side effects, so tests can load this file directly.
 *
 * Data sources:
 *   GET /api/workforce/agents   roster items (id, roleId, status, name; optional teamId, coordinatorId, autonomy)
 *   agent detail               AgentView shape from server/workforce/runtime/agent-view.ts (no route yet)
 *
 * Every parser drops malformed rows instead of guessing values.
 */

// ---------- Roster and hierarchy ----------

export interface RosterItem {
  id: string;
  roleId: string;
  status: string;
  name: string;
  /** Present only when the roster response carries it. */
  teamId: string | null;
  /** Agent id this agent reports to. Present only when the roster response carries it. */
  coordinatorId: string | null;
  /** Autonomy tier. Present only when the roster response carries it. */
  autonomy: string | null;
}

const ROSTER_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  disabled: "Disabled",
  retired: "Retired",
};

export function rosterStatusLabel(status: string): string {
  return Object.prototype.hasOwnProperty.call(ROSTER_STATUS_LABELS, status)
    ? ROSTER_STATUS_LABELS[status]
    : "Unknown status";
}

const TIER_LABELS: Record<string, string> = {
  assist: "Assist",
  suggest: "Suggest",
  auto: "Auto",
  predictive: "Predictive",
};

/** Autonomy tier label. Missing or unknown tiers are shown as not known, never guessed. */
export function tierLabel(autonomy: string | null): string {
  if (autonomy === null) return "Not in roster list";
  return Object.prototype.hasOwnProperty.call(TIER_LABELS, autonomy) ? TIER_LABELS[autonomy] : "Unknown tier";
}

function optionalId(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Turns the roster response body into roster items. Rows without a string id are dropped. */
export function toRosterItems(rows: unknown): RosterItem[] {
  if (!Array.isArray(rows)) return [];
  const out: RosterItem[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const raw = row as Record<string, unknown>;
    const id = optionalId(raw.id);
    if (id === null) continue;
    const roleId = optionalId(raw.roleId) ?? "unknown";
    const status = typeof raw.status === "string" ? raw.status : "unknown";
    const name = optionalId(raw.name) ?? id;
    out.push({
      id,
      roleId,
      status,
      name,
      teamId: optionalId(raw.teamId),
      coordinatorId: optionalId(raw.coordinatorId),
      autonomy: optionalId(raw.autonomy),
    });
  }
  return out;
}

/** Alphabetical by name, then id. Returns a new array. */
export function sortRoster(items: readonly RosterItem[]): RosterItem[] {
  return [...items].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
}

export interface HierarchyNode {
  item: RosterItem;
  depth: number;
  /** The coordinator id is set but no roster item matches it. */
  coordinatorMissing: boolean;
  /** The agent sits in a coordinator loop and is shown at the top level. */
  inCycle: boolean;
}

/**
 * Builds the coordinator tree. Roots are agents with no coordinator, or with one that is not in the list.
 * Agents caught in a coordinator loop are shown at the top level, flagged, so nothing disappears.
 * Returns the nodes flattened in display order (parent before children).
 */
export function buildHierarchy(items: readonly RosterItem[]): HierarchyNode[] {
  const byId = new Map<string, RosterItem>();
  for (const item of items) byId.set(item.id, item);

  const childrenOf = new Map<string, RosterItem[]>();
  const roots: RosterItem[] = [];
  const missing = new Set<string>();

  for (const item of sortRoster(items)) {
    const coordinator = item.coordinatorId;
    if (coordinator !== null && coordinator !== item.id && byId.has(coordinator)) {
      const list = childrenOf.get(coordinator) ?? [];
      list.push(item);
      childrenOf.set(coordinator, list);
    } else {
      roots.push(item);
      if (coordinator !== null) missing.add(item.id);
    }
  }

  const out: HierarchyNode[] = [];
  const seen = new Set<string>();

  const walk = (item: RosterItem, depth: number, inCycle: boolean): void => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push({ item, depth, coordinatorMissing: missing.has(item.id), inCycle });
    for (const child of childrenOf.get(item.id) ?? []) walk(child, depth + 1, inCycle);
  };

  for (const root of roots) walk(root, 0, false);
  // Anything not reached from a root sits in a loop. Show it at the top level, flagged.
  for (const item of sortRoster(items)) {
    if (!seen.has(item.id)) walk(item, 0, true);
  }
  return out;
}

/** Team label for a roster item. Items without a team are grouped as unassigned. */
export function teamLabel(teamId: string | null): string {
  return teamId === null ? "No team in roster list" : `Team ${teamId}`;
}

// ---------- Agent detail (AgentView shape) ----------

export interface AgentWorkItem {
  runId: string;
  label: string;
  text: string;
  detail: string | null;
  updatedAt: string;
}

export interface AgentResultItem {
  runId: string;
  label: string;
  text: string;
  finishedAt: string;
}

export interface AgentErrorItem {
  runId: string;
  label: string;
  text: string;
  reason: string | null;
  finishedAt: string;
}

export interface AgentDetailData {
  agentId: string;
  roleId: string;
  roleName: string;
  autonomy: string;
  channels: string[];
  permissions: string[];
  state: string;
  assignedWork: AgentWorkItem[];
  recentResults: AgentResultItem[];
  errors: AgentErrorItem[];
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

function objectList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object");
}

/**
 * Reads an AgentView body. Returns null when the agent id is missing, so the screen can refuse to render.
 * Work, result and error rows without a run id are dropped.
 */
export function parseAgentDetail(raw: unknown): AgentDetailData | null {
  if (raw === null || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const agentId = optionalId(body.agentId);
  if (agentId === null) return null;

  const assignedWork: AgentWorkItem[] = [];
  for (const row of objectList(body.assignedWork)) {
    const runId = optionalId(row.runId);
    if (runId === null) continue;
    assignedWork.push({
      runId,
      label: stringOr(row.label, "needs_attention"),
      text: stringOr(row.text, "Status unknown"),
      detail: nullableString(row.detail),
      updatedAt: stringOr(row.updatedAt, ""),
    });
  }

  const recentResults: AgentResultItem[] = [];
  for (const row of objectList(body.recentResults)) {
    const runId = optionalId(row.runId);
    if (runId === null) continue;
    recentResults.push({
      runId,
      label: stringOr(row.label, "needs_attention"),
      text: stringOr(row.text, "Status unknown"),
      finishedAt: stringOr(row.finishedAt, ""),
    });
  }

  const errors: AgentErrorItem[] = [];
  for (const row of objectList(body.errors)) {
    const runId = optionalId(row.runId);
    if (runId === null) continue;
    errors.push({
      runId,
      label: stringOr(row.label, "failed"),
      text: stringOr(row.text, "Stopped because of an error"),
      reason: nullableString(row.reason),
      finishedAt: stringOr(row.finishedAt, ""),
    });
  }

  return {
    agentId,
    roleId: stringOr(body.roleId, "unknown"),
    roleName: stringOr(body.roleName, "unknown"),
    autonomy: stringOr(body.autonomy, "unknown"),
    channels: stringList(body.channels),
    permissions: stringList(body.permissions),
    state: stringOr(body.state, "unknown"),
    assignedWork,
    recentResults,
    errors,
  };
}

const AGENT_STATE_LABELS: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  disabled: "Disabled",
  retired: "Retired",
  unknown: "Status not known",
};

export function agentStateLabel(state: string): string {
  return Object.prototype.hasOwnProperty.call(AGENT_STATE_LABELS, state) ? AGENT_STATE_LABELS[state] : "Status not known";
}

/** Badge tone for a run label. Attention and error states stand out; everything else is neutral. */
export function runLabelTone(label: string): "attention" | "danger" | "neutral" {
  if (label === "failed") return "danger";
  if (label === "needs_attention" || label === "awaiting_approval") return "attention";
  return "neutral";
}

/** Short run label for screen readers and badges. Unknown labels read as needing attention. */
export function runLabelText(label: string): string {
  const known: Record<string, string> = {
    queued: "Queued",
    running: "Running",
    awaiting_approval: "Needs approval",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    needs_attention: "Needs attention",
  };
  return Object.prototype.hasOwnProperty.call(known, label) ? known[label] : "Needs attention";
}

/** Human time for list rows. Invalid times read as unknown, never as a date. */
export function formatWhen(iso: string): string {
  if (iso === "") return "Time unknown";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "Time unknown" : new Date(ms).toLocaleString();
}

/** Generic message for a failed read. Never echoes the response body. */
export function loadErrorMessage(status: number | null): string {
  if (status === 401) return "Sign in again to see the workforce.";
  if (status === 403) return "You need an admin or manager role to see this.";
  if (status === 404) return "This agent was not found in your company.";
  if (status === 503) return "The workforce service is not available yet.";
  return "This could not be loaded. Try again.";
}
