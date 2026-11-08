/**
 * User-facing view of one agent: role, autonomy tier, channels, permissions, current state, assigned work,
 * recent results and errors. Pure: no database, no clock of its own (the caller passes `now`), and no
 * internal status names in the labels (labels come from ./run-status-view.ts).
 *
 * Company scope: only runs and control state for the agent's own company are read. Runs from another
 * company are dropped even when their agentId matches.
 *
 * Run ownership: a run is attributed to an agent by its `agentId` field. Callers pass run records that carry
 * that field. `finishedAt` is read when present; otherwise `updatedAt` is used as the finish time, since a
 * terminal run is not updated after it finishes.
 */
import type { RosterAgent } from '../roster.ts';
import type { ControlState } from './controls.ts';
import { isTerminal, type RunRecord } from './run.ts';
import { runStatusView, type RunViewLabel } from './run-status-view.ts';

const RESULT_LIMIT = 5;
const ERROR_LIMIT = 5;

export type AgentRunInput = RunRecord & { agentId?: string; finishedAt?: string };

/** The subset of a role definition this view reads. */
export interface AgentViewRole {
  readonly name: string;
}

export interface AgentViewInput {
  agent: RosterAgent;
  role?: AgentViewRole | null;
  controlState: ControlState;
  runs: readonly AgentRunInput[];
  now: Date;
}

export interface AssignedWorkItem {
  runId: string;
  label: RunViewLabel;
  text: string;
  detail: string | null;
  updatedAt: string;
}

export interface RecentResultItem {
  runId: string;
  label: RunViewLabel;
  text: string;
  finishedAt: string;
}

export interface AgentErrorItem {
  runId: string;
  label: RunViewLabel;
  text: string;
  reason: string | null;
  finishedAt: string;
}

export interface AgentView {
  agentId: string;
  roleId: string;
  roleName: string;
  autonomy: RosterAgent['autonomy'];
  channels: string[];
  permissions: string[];
  /** The agent's control status for its company, or 'unknown' when no control entry exists. */
  state: string;
  assignedWork: AssignedWorkItem[];
  recentResults: RecentResultItem[];
  errors: AgentErrorItem[];
}

export function buildAgentView(input: AgentViewInput): AgentView {
  const { agent, role, controlState, runs, now } = input;
  const ownRuns = runs.filter((run) => run.companyId === agent.companyId && run.agentId === agent.agentId);

  const open = ownRuns.filter((run) => !isTerminal(run.status));
  const finished = ownRuns.filter((run) => isTerminal(run.status)).sort(newestFirst);
  const failed = finished.filter((run) => run.status === 'failed');

  return {
    agentId: agent.agentId,
    roleId: agent.roleId,
    roleName: role?.name ?? 'unknown',
    autonomy: agent.autonomy,
    channels: [...agent.channels],
    permissions: [...agent.permissions],
    state: controlState.agents.get(agent.companyId)?.get(agent.agentId)?.status ?? 'unknown',
    assignedWork: open.map((run) => {
      const view = runStatusView(run, now);
      return { runId: run.id, label: view.label, text: view.text, detail: view.detail, updatedAt: run.updatedAt };
    }),
    recentResults: finished.slice(0, RESULT_LIMIT).map((run) => {
      const view = runStatusView(run, now);
      return { runId: run.id, label: view.label, text: view.text, finishedAt: finishedAt(run) };
    }),
    errors: failed.slice(0, ERROR_LIMIT).map((run) => {
      const view = runStatusView(run, now);
      return { runId: run.id, label: view.label, text: view.text, reason: run.reason, finishedAt: finishedAt(run) };
    }),
  };
}

function finishedAt(run: AgentRunInput): string {
  return run.finishedAt ?? run.updatedAt;
}

/** Newest first by finish time. Unreadable timestamps sort last. */
function newestFirst(a: AgentRunInput, b: AgentRunInput): number {
  const left = Date.parse(finishedAt(a));
  const right = Date.parse(finishedAt(b));
  if (Number.isNaN(left) && Number.isNaN(right)) return 0;
  if (Number.isNaN(left)) return 1;
  if (Number.isNaN(right)) return -1;
  return right - left;
}
