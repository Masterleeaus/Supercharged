/**
 * Express wiring for the staff reply and handoff routes. Thin by design: every route calls one handler from
 * agent-handlers.ts and writes its result. Mount it behind the same session middleware the chatbot module uses.
 *
 * Routes (relative to the mount path):
 *   GET   /inbox                       list conversations (admin, manager, agent)
 *   GET   /conversations/:id           staff view, internal notes included (admin, manager, agent)
 *   POST  /conversations/:id/messages  staff reply or internal note (admin, agent)
 *   POST  /conversations/:id/takeover  agent takes over from AI (admin, agent)
 *   POST  /conversations/:id/handback  hands the chat back to AI (admin, agent)
 *   POST  /conversations/:id/close     closes the ticket (admin, agent)
 *
 * With the feature flag off, every path answers 404.
 */
import { Router, type Request, type Response } from "express";
import {
  createAgentHandlers,
  type AgentHandlers,
  type AgentHttpRequest,
  type AgentHttpResponse,
  type AuthenticateFn,
  type HasHumanAgentsFn,
} from "./agent-handlers.ts";
import type { AgentConversationService, AgentInboxService, CustomerDelivery } from "./contracts.ts";
import { NOOP_CUSTOMER_DELIVERY } from "./contracts.ts";
import { isAgentRoutesEnabled } from "./flags.ts";
import { AGENT_ROUTE_PATHS } from "./route-table.ts";

export { AGENT_ROUTE_PATHS };

export interface AgentRouterOptions {
  inbox: AgentInboxService;
  conversations: AgentConversationService;
  /** Resolves the caller. Company and staff identity come only from here. */
  authenticate: AuthenticateFn;
  /** Defaults to a no-op. The channel transports are out of scope for this slice. */
  delivery?: CustomerDelivery;
  /** Plan gate for staff replies. Absent means every reply is refused with 403. */
  hasHumanAgents?: HasHumanAgentsFn;
  onError?: (err: unknown) => void;
  /** Defaults to the DESK_CHATBOT_AGENT_ROUTES environment flag, which is off unless set to "true". */
  enabled?: boolean;
}

function toHttpRequest(req: Request): AgentHttpRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = Array.isArray(value) ? value[0] : value;
  }
  return {
    params: req.params as Record<string, string | undefined>,
    query: req.query,
    body: req.body as unknown,
    headers,
  };
}

function send(res: Response, result: AgentHttpResponse): void {
  res.status(result.status).json(result.body);
}

function adapt(handler: (req: AgentHttpRequest) => Promise<AgentHttpResponse>) {
  return (req: Request, res: Response): void => {
    // Handlers never reject: every error is mapped to a response inside them.
    handler(toHttpRequest(req)).then(
      (result) => send(res, result),
      () => send(res, { status: 500, body: { error: "Internal error" } }),
    );
  };
}

export function createAgentRouter(options: AgentRouterOptions): Router {
  const router = Router();
  const enabled = options.enabled ?? isAgentRoutesEnabled();

  if (!enabled) {
    router.use((_req, res) => {
      res.status(404).json({ error: "Not found" });
    });
    return router;
  }

  const handlers: AgentHandlers = createAgentHandlers({
    inbox: options.inbox,
    conversations: options.conversations,
    authenticate: options.authenticate,
    delivery: options.delivery ?? NOOP_CUSTOMER_DELIVERY,
    hasHumanAgents: options.hasHumanAgents,
    onError: options.onError,
  });

  router.get("/inbox", adapt((r) => handlers.listInbox(r)));
  router.get("/conversations/:id", adapt((r) => handlers.getConversation(r)));
  router.post("/conversations/:id/messages", adapt((r) => handlers.postStaffReply(r)));
  router.post("/conversations/:id/takeover", adapt((r) => handlers.takeOver(r)));
  router.post("/conversations/:id/handback", adapt((r) => handlers.handBack(r)));
  router.post("/conversations/:id/close", adapt((r) => handlers.closeTicket(r)));

  return router;
}
