/**
 * Admin routes for the workforce human review inbox, the pause/resume controls, and the agent roster
 * (create, configure, retire).
 *
 *   GET   /api/workforce/review-inbox
 *   POST  /api/workforce/agents/:agentId/pause          admin only
 *   POST  /api/workforce/agents/:agentId/resume         admin only
 *   POST  /api/workforce/agents                         admin or manager
 *   PATCH /api/workforce/agents/:agentId                admin or manager
 *   POST  /api/workforce/agents/:agentId/retire         admin or manager
 *
 * (GET /api/workforce/agents, the list, is served by server/routes/workforce-roster-routes.ts.)
 *
 * Every route runs the same chain, in this order: authenticate, role, company scope.
 * Company scope comes only from the verified token (req.user.companyId, through getCompanyScope), which is
 * copied to res.locals.companyId. Request bodies, queries, params and headers are never read for tenancy.
 * The actor for every write is the session user (req.userId), and only humans may act.
 *
 * Refusals return the reason from the controls or roster module. A dependency that was not configured
 * returns 503 instead of crashing.
 *
 * Retirement is written to controls.ts first, so work is refused at once, and then to the roster. A retired
 * agent cannot be resumed, configured or retired again.
 *
 * The pause state lives in one module-level holder (workforceControls) so it persists for the process.
 */
import { Router, type Request, type RequestHandler, type Response, type NextFunction } from 'express';
import { getCompanyScope } from '../../middleware/company-scope.ts';
import { apiRateLimiter } from '../../middleware/rateLimiter.ts';
import { buildReviewInbox, type InboxApproval, type InboxRun } from './review-inbox.ts';
import {
  createControlState,
  pauseAgent,
  resumeAgent,
  retireAgent,
  type ControlActor,
  type ControlState,
} from './controls.ts';
import type { AgentPatch, AgentRosterPort, CreateAgentInput, RetireOptions, RosterAgent, RosterResult } from '../roster.ts';
import { TERMINAL_RUN_STATUSES, type RunRecord } from './run.ts';

/** The roster port plus the guarded retirement. Retirement is optional on the type so a port without it fails closed (503). */
export type RetirableRosterPort = AgentRosterPort & {
  retireAgent?: (companyId: string, agentId: string, options: RetireOptions) => Promise<RosterResult>;
};

/** Mutable holder for the control state. The pure control functions return new state, so the holder is replaced on each change. */
export interface ControlHolder {
  state: ControlState;
}

export interface WorkforceAdminDeps {
  controls?: ControlHolder;
  roster?: RetirableRosterPort;
  /**
   * True when the agent is on this company's roster. Pause and resume check it first: an agent that is not on
   * the caller's roster gets 404. When this is not configured, pause and resume are refused (503), never allowed.
   */
  isRosterAgent?: (companyId: string, agentId: string) => boolean | Promise<boolean>;
  getApprovals?: (companyId: string) => Promise<readonly InboxApproval[]> | readonly InboxApproval[];
  getRuns?: (companyId: string) => Promise<readonly InboxRun[]> | readonly InboxRun[];
}

/**
 * Guards are passed in so the real auth middleware is wired by the caller and tests can use stubs.
 * requireManager allows admin or manager. When it is not supplied, the agent write routes fall back to
 * requireAdmin, which is the narrower rule, so a missing guard never widens access.
 */
export interface WorkforceAdminGuards {
  authenticate: RequestHandler;
  requireAdmin: RequestHandler;
  requireManager?: RequestHandler;
  requireCompanyScope: RequestHandler;
}

/** One module-level control state for the process. Pause state persists across requests. */
export const workforceControls: ControlHolder = { state: createControlState() };

export const REVIEW_INBOX_PATH = '/api/workforce/review-inbox';
export const AGENTS_PATH = '/api/workforce/agents';
export const AGENT_PATH = '/api/workforce/agents/:agentId';
export const AGENT_PAUSE_PATH = '/api/workforce/agents/:agentId/pause';
export const AGENT_RESUME_PATH = '/api/workforce/agents/:agentId/resume';
export const AGENT_RETIRE_PATH = '/api/workforce/agents/:agentId/retire';

/** Sets res.locals.companyId from the verified session company. Fails closed with 403 when absent. */
function setScopedCompany(req: Request, res: Response, next: NextFunction): void {
  try {
    res.locals.companyId = getCompanyScope(req);
  } catch {
    res.status(403).json({ error: 'Company scope required' });
    return;
  }
  next();
}

function scopedCompanyId(res: Response): string {
  return res.locals.companyId as string;
}

function sessionActor(req: Request): ControlActor | null {
  const userId = (req as Request & { userId?: unknown }).userId;
  return typeof userId === 'string' && userId.trim() !== '' ? { kind: 'human', userId } : null;
}

function unavailable(res: Response, name: string): void {
  res.status(503).json({ error: 'dependency_not_configured', dependency: name });
}

/** A JSON object body, or null. Arrays, primitives and a missing body are refused. */
function objectBody(req: Request): Record<string, unknown> | null {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

const INPUT_REASONS = new Set(['invalid_input', 'invalid_autonomy', 'invalid_status', 'immutable_field', 'unknown_role']);

/** HTTP status for a roster refusal: bad input 400, missing agent 404, anything else (a state conflict) 409. */
function rosterRefusalStatus(reason: string): number {
  if (INPUT_REASONS.has(reason)) return 400;
  if (reason === 'agent_not_found') return 404;
  return 409;
}

/**
 * Turns run records into the per-agent rows the retire guard reads (run.agentId). A run can involve several agents,
 * so it yields one row per agent that might be working on it: the coordinator, the team members, every agent on the
 * handoff path, and an agent that is waiting on an approval. This over-includes on purpose, so the guard fails safe.
 */
export function agentRunsFromRecords(runs: readonly RunRecord[]): InboxRun[] {
  const rows: InboxRun[] = [];
  for (const run of runs) {
    const agentIds = new Set<string>();
    if (run.team) {
      if (typeof run.team.coordinator === 'string') agentIds.add(run.team.coordinator);
      for (const member of run.team.members ?? []) agentIds.add(member);
    }
    for (const entry of run.path ?? []) agentIds.add(entry);
    const pending = run.pendingApproval;
    if (pending && pending.actorKind === 'agent') agentIds.add(pending.actorKey);
    for (const agentId of agentIds) {
      if (agentId.trim() === '') continue;
      rows.push({ id: run.id, companyId: run.companyId, agentId, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt });
    }
  }
  return rows;
}

export function createWorkforceAdminRouter(deps: WorkforceAdminDeps, guards: WorkforceAdminGuards): Router {
  const router = Router();
  // apiRateLimiter runs after authentication and company scope, so its default key is the session user (req.userId).
  const chain: RequestHandler[] = [guards.authenticate, guards.requireAdmin, guards.requireCompanyScope, setScopedCompany, apiRateLimiter];
  const managerChain: RequestHandler[] = [
    guards.authenticate,
    guards.requireManager ?? guards.requireAdmin,
    guards.requireCompanyScope,
    setScopedCompany,
    apiRateLimiter,
  ];

  router.get(REVIEW_INBOX_PATH, ...chain, async (req: Request, res: Response, next: NextFunction) => {
    if (!deps.getApprovals || !deps.getRuns) {
      unavailable(res, deps.getApprovals ? 'getRuns' : 'getApprovals');
      return;
    }
    const companyId = scopedCompanyId(res);
    try {
      const [approvals, runs] = await Promise.all([deps.getApprovals(companyId), deps.getRuns(companyId)]);
      const items = buildReviewInbox({ companyId, approvals: approvals ?? [], runs: runs ?? [], toolCalls: [] });
      res.json({ items });
    } catch (error) {
      next(error);
    }
  });

  const transition = (action: 'pause' | 'resume'): RequestHandler => async (req, res, next) => {
    if (!deps.controls) {
      unavailable(res, 'controls');
      return;
    }
    if (!deps.isRosterAgent) {
      unavailable(res, 'isRosterAgent');
      return;
    }
    const actor = sessionActor(req);
    if (!actor) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const companyId = scopedCompanyId(res);
    const agentId = req.params.agentId as string;
    try {
      // Only an agent on the caller's roster can be paused or resumed. Anything else is reported as not found.
      if ((await deps.isRosterAgent(companyId, agentId)) !== true) {
        res.status(404).json({ error: 'agent_not_found' });
        return;
      }
      // Defence in depth: a resume never reopens an agent the roster records as retired.
      if (action === 'resume' && deps.roster) {
        const agent = await deps.roster.getAgent(companyId, agentId);
        if (agent?.status === 'retired') {
          res.status(409).json({ error: 'agent_retired' });
          return;
        }
      }
      const result = action === 'pause'
        ? pauseAgent(deps.controls.state, companyId, agentId, actor)
        : resumeAgent(deps.controls.state, companyId, agentId, actor);
      if (!result.ok) {
        res.status(409).json({ error: result.reason });
        return;
      }
      deps.controls.state = result.state;
      res.json({ agentId: result.entry.agentId, status: result.entry.status, changed: result.entry.changed });
    } catch (error) {
      next(error);
    }
  };

  router.post(AGENT_PAUSE_PATH, ...chain, transition('pause'));
  router.post(AGENT_RESUME_PATH, ...chain, transition('resume'));

  // Create an agent from a catalogue role. The company comes from the session; any companyId in the body is ignored.
  // The autonomy tier defaults to assist, the most restrictive tier, when it is omitted.
  router.post(AGENTS_PATH, ...managerChain, async (req: Request, res: Response, next: NextFunction) => {
    if (!deps.roster) {
      unavailable(res, 'roster');
      return;
    }
    if (!sessionActor(req)) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const body = objectBody(req);
    if (!body) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const input: CreateAgentInput = {
      companyId: scopedCompanyId(res),
      agentId: body.agentId as string,
      roleId: body.roleId as string,
      teamId: body.teamId as string | null | undefined,
      channels: body.channels as CreateAgentInput['channels'],
      permissions: body.permissions as string[] | undefined,
      autonomy: (body.autonomy ?? 'assist') as CreateAgentInput['autonomy'],
    };
    try {
      const result: RosterResult = await deps.roster.createAgent(input);
      if (!result.ok) {
        res.status(rosterRefusalStatus(result.reason)).json({ error: result.reason });
        return;
      }
      res.status(201).json({ agent: result.agent });
    } catch (error) {
      next(error);
    }
  });

  // Configure an agent. Only teamId, channels, permissions and autonomy may change, and autonomy stays at or below the role's tier.
  router.patch(AGENT_PATH, ...managerChain, async (req: Request, res: Response, next: NextFunction) => {
    if (!deps.roster) {
      unavailable(res, 'roster');
      return;
    }
    if (!sessionActor(req)) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const patch = objectBody(req);
    if (!patch) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    try {
      const result: RosterResult = await deps.roster.configureAgent(
        scopedCompanyId(res),
        req.params.agentId as string,
        patch as AgentPatch,
      );
      if (!result.ok) {
        res.status(rosterRefusalStatus(result.reason)).json({ error: result.reason });
        return;
      }
      res.json({ agent: result.agent });
    } catch (error) {
      next(error);
    }
  });

  // Retire an agent. Terminal. Order: roster lookup, then controls.ts (which closes the work gate at once), then the roster record.
  // If controls already retired the agent (for example after a failed roster write), the roster write is retried.
  router.post(AGENT_RETIRE_PATH, ...managerChain, async (req: Request, res: Response, next: NextFunction) => {
    if (!deps.roster) {
      unavailable(res, 'roster');
      return;
    }
    if (!deps.controls) {
      unavailable(res, 'controls');
      return;
    }
    const actor = sessionActor(req);
    if (!actor || actor.kind !== 'human') {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const companyId = scopedCompanyId(res);
    const agentId = req.params.agentId as string;
    const retireInRoster = deps.roster.retireAgent;
    const getRuns = deps.getRuns;
    if (!retireInRoster) {
      unavailable(res, 'retireAgent');
      return;
    }
    if (!getRuns) {
      unavailable(res, 'getRuns');
      return;
    }
    try {
      // The guarded roster retirement refuses (agent_running, run_check_unavailable, agent_not_found, agent_retired)
      // before anything is written. A throwing run store makes the check fail closed.
      const isRunning = async (cid: string, aid: string): Promise<boolean> => {
        const runs = await getRuns(cid);
        return runs.some((run) => run.agentId === aid && !(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status));
      };
      const updated = await retireInRoster(companyId, agentId, { actor: actor.userId, isRunning });
      if (!updated.ok) {
        res.status(rosterRefusalStatus(updated.reason)).json({ error: updated.reason });
        return;
      }

      // Then the control state, so work is refused at once. An already-retired control entry is not an error.
      const control = retireAgent(deps.controls.state, companyId, agentId, actor);
      if (!control.ok && control.reason !== 'agent_retired') {
        res.status(409).json({ error: control.reason });
        return;
      }
      if (control.ok) deps.controls.state = control.state;

      const changed = control.ok ? control.entry.changed : deps.controls.state.agents.get(companyId)?.get(agentId)?.changed;
      res.json({ agentId, status: 'retired', changed: changed ?? null });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
