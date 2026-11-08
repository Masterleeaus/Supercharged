/**
 * Read route for the workforce roster.
 *
 *   GET /api/workforce/agents     the caller company's roster agents
 *
 * The chain runs in this order: authenticate, requireCompanyScope, requireApprover, setScopedCompany.
 * requireApprover is passed in by the caller and must allow admin and manager only. Members are refused
 * with 403 before the roster is read.
 *
 * Company scope comes only from the verified session (req.user.companyId, through getCompanyScope),
 * copied to res.locals.companyId. Query, params, body and headers are never read for tenancy, so a
 * companyId sent by the client has no effect.
 *
 * Each item is a read-only projection: id, roleId, status and name. Nothing else from the roster is
 * returned, so permissions, channels and autonomy stay out of this response.
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { getCompanyScope } from '../middleware/company-scope.ts';
import type { AgentStatus, RosterAgent } from '../workforce/roster.ts';

export const WORKFORCE_AGENTS_PATH = '/api/workforce/agents';

/** A roster agent as this route reads it. `name` is optional because RosterAgent does not carry one yet. */
export type RosterAgentLike = Pick<RosterAgent, 'agentId' | 'roleId' | 'status'> & { readonly name?: string | null };

export interface WorkforceRosterDeps {
  /**
   * Lists the agents of one company. Only the company passed in is ever queried.
   * The caller wires this to listAgents(roster, companyId) from server/workforce/roster.ts.
   */
  listAgents?: (companyId: string) => Promise<readonly RosterAgentLike[]> | readonly RosterAgentLike[];
}

export interface WorkforceRosterGuards {
  authenticate: RequestHandler;
  requireCompanyScope: RequestHandler;
  /** Admin or manager only. Passed in so the real role middleware is wired by the caller. */
  requireApprover: RequestHandler;
}

export interface WorkforceRosterItem {
  id: string;
  roleId: string;
  status: AgentStatus;
  name: string;
}

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

function toItem(agent: RosterAgentLike): WorkforceRosterItem {
  return {
    id: agent.agentId,
    roleId: agent.roleId,
    status: agent.status,
    // No display name exists on the roster yet, so the agent id is used when none is supplied.
    name: typeof agent.name === 'string' && agent.name.trim() !== '' ? agent.name : agent.agentId,
  };
}

export function createWorkforceRosterRouter(deps: WorkforceRosterDeps, guards: WorkforceRosterGuards): Router {
  const router = Router();
  const chain: RequestHandler[] = [guards.authenticate, guards.requireCompanyScope, guards.requireApprover, setScopedCompany];

  router.get(WORKFORCE_AGENTS_PATH, ...chain, async (_req: Request, res: Response, next: NextFunction) => {
    if (!deps.listAgents) {
      res.status(503).json({ error: 'dependency_not_configured', dependency: 'listAgents' });
      return;
    }
    const companyId = res.locals.companyId as string;
    try {
      const agents = await deps.listAgents(companyId);
      res.json({ items: (agents ?? []).map(toItem) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
