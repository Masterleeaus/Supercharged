/**
 * Route logic for the staff reply and handoff layer, kept free of Express so it can run under node:test.
 * agent-router.ts maps these handlers onto Express.
 *
 * Tenancy: the company id and staff id come only from the injected authenticate function. The request's
 * params, query and body are never read for tenancy, and their schemas are strict.
 */
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import type {
  AgentConversationService,
  AgentInboxService,
  CustomerDelivery,
} from "./contracts.ts";
import { parseEmptyBody, parseIdParam, parseInboxQuery, parseStaffReplyBody } from "./validation.ts";

export type StaffRole = "admin" | "manager" | "agent";

export const READ_ROLES: readonly StaffRole[] = ["admin", "manager", "agent"];
export const WRITE_ROLES: readonly StaffRole[] = ["admin", "agent"];

export interface StaffIdentity {
  companyId: string;
  staffId: string;
  role: string;
}

/** The request shape the handlers read. The Express adapter fills it from req. */
export interface AgentHttpRequest {
  params: Record<string, string | undefined>;
  query: unknown;
  body: unknown;
  headers: Record<string, string | undefined>;
  /** The verified user, set by the auth middleware in front of the agent mount (req.user). Never from headers or body. */
  user?: unknown;
}

export interface AgentHttpResponse {
  status: number;
  body: unknown;
}

/** Resolves the caller from the request. Return null, or throw, to reject the request with 401. */
export type AuthenticateFn = (req: AgentHttpRequest) => Promise<StaffIdentity | null> | StaffIdentity | null;

/**
 * Plan check for staff replies (PHP planAllowsHumanAgent). Must return exactly true to allow a reply.
 * Any other value, a throw, or no function at all refuses the reply.
 */
export type HasHumanAgentsFn = (companyId: string) => boolean | Promise<boolean>;

export interface AgentHandlersDeps {
  inbox: AgentInboxService;
  conversations: AgentConversationService;
  authenticate: AuthenticateFn;
  /** Out-of-scope transport by default. Use NOOP_CUSTOMER_DELIVERY when none is wired. */
  delivery: CustomerDelivery;
  /** Plan gate for staff replies. Absent means every reply is refused with 403. */
  hasHumanAgents?: HasHumanAgentsFn;
  /** Receives unexpected errors. They are never sent to the client. */
  onError?: (err: unknown) => void;
}

export interface AgentHandlers {
  listInbox(req: AgentHttpRequest): Promise<AgentHttpResponse>;
  getConversation(req: AgentHttpRequest): Promise<AgentHttpResponse>;
  postStaffReply(req: AgentHttpRequest): Promise<AgentHttpResponse>;
  takeOver(req: AgentHttpRequest): Promise<AgentHttpResponse>;
  handBack(req: AgentHttpRequest): Promise<AgentHttpResponse>;
  closeTicket(req: AgentHttpRequest): Promise<AgentHttpResponse>;
}

interface Scope {
  companyId: string;
  staffId: string;
}

const UNAUTHENTICATED: AgentHttpResponse = { status: 401, body: { error: "Unauthenticated" } };
const FORBIDDEN: AgentHttpResponse = { status: 403, body: { error: "Forbidden" } };
const NOT_FOUND: AgentHttpResponse = { status: 404, body: { error: "Conversation not found" } };
const BAD_ID: AgentHttpResponse = { status: 400, body: { error: "Invalid id" } };
const PLAN_REFUSED: AgentHttpResponse = { status: 403, body: { error: "Plan does not include human agents" } };

function invalid(issues: unknown): AgentHttpResponse {
  return { status: 400, body: { error: "Invalid input", issues } };
}

export function createAgentHandlers(deps: AgentHandlersDeps): AgentHandlers {
  /** Fails closed: no function, a non-true result, or a throw all refuse the reply. */
  async function planAllowsHumanAgents(companyId: string): Promise<boolean> {
    if (typeof deps.hasHumanAgents !== "function") return false;
    try {
      return (await deps.hasHumanAgents(companyId)) === true;
    } catch (err: unknown) {
      deps.onError?.(err);
      return false;
    }
  }

  /**
   * Authenticates, checks the role and the company scope, then runs the handler. An unexpected error
   * becomes a 500 with a generic message, and the detail goes to onError.
   */
  async function guarded(
    req: AgentHttpRequest,
    roles: readonly StaffRole[],
    run: (scope: Scope) => Promise<AgentHttpResponse>,
  ): Promise<AgentHttpResponse> {
    let identity: StaffIdentity | null;
    try {
      identity = await deps.authenticate(req);
    } catch {
      return UNAUTHENTICATED;
    }
    if (!identity || typeof identity !== "object") return UNAUTHENTICATED;
    if (typeof identity.staffId !== "string" || parseIdParam(identity.staffId) === null) {
      return UNAUTHENTICATED;
    }

    try {
      const companyId = requireCompanyId(identity.companyId);
      if (!roles.includes(identity.role as StaffRole)) return FORBIDDEN;
      return await run({ companyId, staffId: identity.staffId });
    } catch (err: unknown) {
      if (err instanceof ChatbotError) {
        return { status: err.status, body: { error: err.message } };
      }
      deps.onError?.(err);
      return { status: 500, body: { error: "Internal error" } };
    }
  }

  return {
    listInbox(req) {
      return guarded(req, READ_ROLES, async ({ companyId }) => {
        const parsed = parseInboxQuery(req.query);
        if (!parsed.ok) return invalid(parsed.issues);
        const page = await deps.inbox.listInbox(companyId, parsed.value);
        return { status: 200, body: page };
      });
    },

    getConversation(req) {
      return guarded(req, READ_ROLES, async ({ companyId }) => {
        const id = parseIdParam(req.params.id);
        if (!id) return BAD_ID;
        const found = await deps.conversations.getConversation(companyId, id);
        if (!found) return NOT_FOUND;
        return { status: 200, body: found };
      });
    },

    postStaffReply(req) {
      return guarded(req, WRITE_ROLES, async ({ companyId, staffId }) => {
        // Plan gate first: a company without human agents gets no reply or note, and nothing is stored.
        if (!(await planAllowsHumanAgents(companyId))) return PLAN_REFUSED;
        const id = parseIdParam(req.params.id);
        if (!id) return BAD_ID;
        const parsed = parseStaffReplyBody(req.body);
        if (!parsed.ok) return invalid(parsed.issues);

        const { message, isInternalNote } = parsed.value;
        // Persist first, as the PHP controller does. The message exists even if delivery fails.
        const saved = await deps.conversations.appendStaffMessage(companyId, {
          conversationId: id,
          staffId,
          message,
          isInternalNote,
        });
        if (!saved) return NOT_FOUND;

        // Internal notes never reach the customer channel. This is the only place a staff message is sent.
        let deliveredToCustomer = false;
        let deliveryFailed = false;
        if (!isInternalNote) {
          try {
            await deps.delivery.deliver({ companyId, conversationId: id, message: saved });
            deliveredToCustomer = true;
          } catch (err: unknown) {
            deliveryFailed = true;
            deps.onError?.(err);
          }
        }

        return {
          status: 201,
          body: { message: saved, deliveredToCustomer, deliveryFailed },
        };
      });
    },

    takeOver(req) {
      return guarded(req, WRITE_ROLES, async ({ companyId, staffId }) => {
        const id = parseIdParam(req.params.id);
        if (!id) return BAD_ID;
        const body = parseEmptyBody(req.body);
        if (!body.ok) return invalid(body.issues);
        const conversation = await deps.conversations.setHandler(companyId, id, "human", staffId);
        if (!conversation) return NOT_FOUND;
        return { status: 200, body: { conversation } };
      });
    },

    handBack(req) {
      return guarded(req, WRITE_ROLES, async ({ companyId, staffId }) => {
        const id = parseIdParam(req.params.id);
        if (!id) return BAD_ID;
        const body = parseEmptyBody(req.body);
        if (!body.ok) return invalid(body.issues);
        const conversation = await deps.conversations.setHandler(companyId, id, "ai", staffId);
        if (!conversation) return NOT_FOUND;
        return { status: 200, body: { conversation } };
      });
    },

    closeTicket(req) {
      return guarded(req, WRITE_ROLES, async ({ companyId, staffId }) => {
        const id = parseIdParam(req.params.id);
        if (!id) return BAD_ID;
        const body = parseEmptyBody(req.body);
        if (!body.ok) return invalid(body.issues);
        const conversation = await deps.conversations.setTicketStatus(companyId, id, "closed", staffId);
        if (!conversation) return NOT_FOUND;
        return { status: 200, body: { conversation } };
      });
    },
  };
}
